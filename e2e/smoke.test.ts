import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "../apps/control-plane/src/app.js";
import { buildAgentApp } from "../apps/control-plane/src/agent-app.js";

// This file's own location, not process.cwd() (which is e2e/ when pnpm
// runs "vitest run" via --filter, but could be the repo root if invoked
// differently) -- so the path to the agent module is stable regardless of
// how the test runner was launched.
const __dirname = dirname(fileURLToPath(import.meta.url));
const agentModuleDir = join(__dirname, "..", "agent");

const KEYCHAIN_SERVICE = "com.modelhub.agent";
const KEYCHAIN_ACCOUNT = "node-key";
const CLEAR_KEYCHAIN_ENV = "MODELHUB_E2E_CLEAR_KEYCHAIN";

/**
 * Guards against this suite colliding with (or silently destroying) a real
 * node identity stored in this machine's OS keychain.
 *
 * config.NewIdentity() (agent/internal/config/identity.go) deliberately
 * prefers the OS keychain over a config-dir-scoped file, keyed by a fixed
 * service/account (KEYCHAIN_SERVICE / KEYCHAIN_ACCOUNT) -- not by
 * MODELHUB_CONFIG_DIR. That's correct production behavior (one real
 * machine should have one real node identity), but it means this test's
 * MODELHUB_CONFIG_DIR scratch directory does NOT isolate identity storage
 * on a machine with a working keychain: the compiled binary reads and
 * writes the same real keychain entry every run. A CI container is fresh
 * every time and never hits this (no darwin, no keychain, no leftover
 * entry). A developer's Mac can hit it two ways: this suite's own earlier
 * run, or a real identity from manually running `modelhub-agent enroll`
 * during other testing -- and this code has no way to tell those apart.
 *
 * So this does NOT delete anything by default. If an entry exists, it
 * fails loudly with the exact command to clear it by hand. Only when
 * MODELHUB_E2E_CLEAR_KEYCHAIN=1 is set does it delete -- and even then it
 * warns first, naming exactly what it's about to destroy, and lets a
 * deletion failure surface instead of swallowing it.
 *
 * This guard is a stopgap for the collision, not a fix for it: Task 19
 * scopes the keychain identity by config directory, after which this
 * entry no longer collides across runs and this whole function becomes
 * vestigial. Whoever lands that task should remove it.
 */
function guardMacKeychainIdentity(): void {
  if (process.platform !== "darwin") return;

  const exists = (() => {
    try {
      execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false; // no entry -- nothing to guard against
    }
  })();
  if (!exists) return;

  if (process.env[CLEAR_KEYCHAIN_ENV] !== "1") {
    throw new Error(
      `A macOS keychain entry already exists for service "${KEYCHAIN_SERVICE}", account ` +
        `"${KEYCHAIN_ACCOUNT}". This is where the real modelhub-agent binary stores its node ` +
        `identity (see agent/internal/config/identity.go), and it is NOT scoped by ` +
        `MODELHUB_CONFIG_DIR -- so this e2e suite would reuse whatever key is already there, ` +
        `and the server would reject it as "already enrolled". This could be a leftover from ` +
        `an earlier run of this suite, or a real identity from manually enrolling an agent. ` +
        `This test will not delete it silently.\n\n` +
        `If you're sure it's safe to discard (e.g. it's just this suite's own leftover), ` +
        `either clear it by hand:\n` +
        `  security delete-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT}\n` +
        `or re-run with MODELHUB_E2E_CLEAR_KEYCHAIN=1 to have this suite clear it for you.`,
    );
  }

  console.warn(
    `[e2e] MODELHUB_E2E_CLEAR_KEYCHAIN=1: deleting macOS keychain entry ` +
      `service="${KEYCHAIN_SERVICE}" account="${KEYCHAIN_ACCOUNT}" before enrolling.`,
  );
  execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT], {
    stdio: "inherit",
  });
}

// There are two listeners in the control plane (see agent-app.ts): buildApp
// is plain HTTP/1.1 and serves /healthz, /api/auth/*, /api/me, and
// FleetService -- everything a browser-shaped fetch can reach. buildAgentApp
// is cleartext HTTP/2 (h2c) and serves NodeService (Enroll, Connect) -- the
// only thing the compiled Go agent binary speaks. A browser-shaped fetch
// cannot talk to the h2c listener at all, so this test drives each app on
// its own ephemeral port and points the right client at each.
let app: Awaited<ReturnType<typeof buildApp>>;
let agentApp: Awaited<ReturnType<typeof buildAgentApp>>;
let agent: ChildProcess | undefined;
let baseUrl: string;
let agentBaseUrl: string;
let cookie: string;
let agentDir: string;

async function rpc(method: string, body: unknown) {
  const res = await fetch(`${baseUrl}/modelhub.v1.FleetService/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Runs a child process to completion without blocking this process's event
 * loop. This matters specifically for `enroll`: buildApp()/buildAgentApp()
 * run in *this* Node process (Task 18 imports the app builders directly
 * rather than shelling out to a dev server), so the Fastify h2c server the
 * agent is about to dial lives on this same event loop. execFileSync would
 * synchronously block that event loop for the whole life of the child
 * process -- including while the agent is waiting on a response from the
 * very server this process is supposed to be running -- which deadlocks
 * until the Go http2.Transport's own liveness timers (ReadIdleTimeout 30s +
 * PingTimeout 15s, see agent/internal/transport/client.go) give up and the
 * child exits with a connection-lost error 45 seconds later. Using
 * node:child_process's async spawn plus an awaited exit event keeps the
 * event loop free to service that request while this test waits for the
 * child. stdio stays inherited, exactly as execFileSync would, so a
 * failure's stdout/stderr still show up inline.
 */
function run(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`${binary} ${args.join(" ")} exited ${exitCode ?? `signal ${signal}`}`));
    });
  });
}

beforeAll(async () => {
  guardMacKeychainIdentity();

  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  agentApp = await buildAgentApp();
  await agentApp.listen({ port: 0, host: "127.0.0.1" });
  const agentAddress = agentApp.server.address();
  agentBaseUrl = `http://127.0.0.1:${typeof agentAddress === "object" && agentAddress ? agentAddress.port : 0}`;

  const email = `e2e${Date.now()}@example.com`;
  const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "E2E" }),
  });
  cookie = signUp.headers.getSetCookie().join("; ");

  agentDir = mkdtempSync(join(tmpdir(), "modelhub-e2e-"));
  execFileSync("go", ["build", "-o", join(agentDir, "modelhub-agent"), "./cmd/agent"], {
    cwd: agentModuleDir,
    stdio: "inherit",
  });
}, 120_000);

afterAll(async () => {
  agent?.kill("SIGTERM");
  // beforeAll can throw before app/agentApp/agentDir are ever assigned
  // (e.g. guardMacKeychainIdentity() refusing to proceed) -- guard each
  // teardown step so that case reports its real cause instead of a
  // follow-on "Cannot read properties of undefined" here.
  await Promise.all([app?.close(), agentApp?.close()]);
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
});

describe("slice 1 end to end", () => {
  it("enrolls an agent and shows it on the fleet with live memory numbers", async () => {
    const { code } = await rpc("CreatePairingCode", { nodeName: "e2e-box" });
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const env = { ...process.env, MODELHUB_CONFIG_DIR: agentDir };
    const binary = join(agentDir, "modelhub-agent");

    // The agent's --server flag must point at the h2c NodeService
    // listener (agentBaseUrl), not the browser-facing HTTP/1.1 one
    // (baseUrl) that CreatePairingCode was just called against above --
    // Enroll and Connect are only served on buildAgentApp(). This must be
    // the async `run` helper, not execFileSync -- see its comment above.
    await run(
      binary,
      ["enroll", "--code", code, "--server", agentBaseUrl, "--name", "e2e-box"],
      env,
    );

    // stdio is inherited deliberately: if enrollment or the connect loop
    // fails, the agent's own log lines (including the Go-side error from
    // a rejected Authorization header) appear inline in this test's
    // output rather than being swallowed.
    agent = spawn(binary, ["run", "--fake-probe"], { env, stdio: "inherit" });

    // Two sample intervals is enough for inventory and at least one sample.
    let nodes: { nodes: Array<Record<string, any>> } = { nodes: [] };
    for (let attempt = 0; attempt < 30; attempt++) {
      nodes = await rpc("ListNodes", {});
      if (nodes.nodes[0]?.devices?.length > 0 && nodes.nodes[0].status === "online") break;
      await sleep(500);
    }

    expect(nodes.nodes).toHaveLength(1);
    const node = nodes.nodes[0]!;
    expect(node.name).toBe("e2e-box");
    // "online" here can only be reached by way of authenticateNode()
    // accepting the agent's real Ed25519-signed Authorization header --
    // built in Go with base64.RawURLEncoding and verified in TypeScript
    // with node:crypto.verify() -- over the real h2c NodeService.Connect
    // stream, followed by the server recording the Hello and Inventory
    // messages that same stream carried. There is no other path from a
    // freshly enrolled node to this combination of status and devices.
    expect(node.status).toBe("online");
    expect(node.devices.length).toBeGreaterThan(0);

    const device = node.devices[0]!;
    expect(Number(device.totalBytes)).toBeGreaterThan(0);
    expect(Number(device.availableBytes)).toBeGreaterThan(0);
    expect(Number(device.availableBytes)).toBeLessThan(Number(device.totalBytes));
    expect(device.schedulable).toBe(true);
  }, 120_000);

  // This test proves the *other* half of sweepOfflineNodes' behavior (the
  // control-plane unit suite already proves the threshold math itself in
  // isolation) -- that a node which really did stop heartbeating, through
  // the real agent process being killed, really does flip to offline.
  //
  // sweepOfflineNodes(now) takes its clock as a parameter specifically so
  // callers can avoid waiting out the real 30s OFFLINE_AFTER_MS threshold
  // (see apps/control-plane/src/jobs/offline-sweeper.ts) -- so rather than
  // sleeping past it, this passes a `now` far enough past the node's real
  // last heartbeat that the offline cutoff has certainly elapsed. This is
  // not shortening the threshold under test (OFFLINE_AFTER_MS is untouched
  // and still 30s in the comparison); it is choosing which wall-clock
  // instant stands in for "the moment the sweep runs", exactly the
  // dependency the function was already built to accept.
  it("marks the node offline after the agent stops", async () => {
    agent?.kill("SIGTERM");
    agent = undefined;
    // Give the killed process a moment to actually exit and stop holding
    // its stream open before the sweep runs. Generous on purpose: this is
    // the only sleep left in this test (the 30s liveness wait itself is
    // avoided via the injected clock below), and a slower CI runner should
    // not make this test flaky.
    await sleep(1_000);

    const { sweepOfflineNodes, OFFLINE_AFTER_MS } = await import(
      "../apps/control-plane/src/jobs/offline-sweeper.js"
    );
    const wellPastOffline = new Date(Date.now() + OFFLINE_AFTER_MS + 1_000);
    await sweepOfflineNodes(wellPastOffline);

    const nodes = await rpc("ListNodes", {});
    expect(nodes.nodes[0].status).toBe("offline");
  }, 30_000);
});
