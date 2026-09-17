import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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

/**
 * Reproduces the keychain account name the compiled agent will use for a
 * given config directory, so this suite can delete its own entry afterwards.
 *
 * Must stay in step with keyringAccount() in
 * agent/internal/config/identity.go: "node-key-" + the first 8 bytes of the
 * SHA-256 of the resolved absolute config dir, hex-encoded (16 hex chars).
 * Go's filepath.Abs only cleans a path that is already absolute, and
 * mkdtempSync returns one — it does not resolve macOS's /var -> /private/var
 * symlink — so the exact string handed to MODELHUB_CONFIG_DIR is the string
 * that gets hashed, and hashing it here gives the same account name.
 */
function keychainAccountFor(dir: string): string {
  return `node-key-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`;
}

/**
 * Removes the keychain entry this run created.
 *
 * Task 19 scoped the agent's keychain account by config directory, which is
 * what made the old cross-run collision guard unnecessary — but it also means
 * every run of this suite, with its own fresh temp dir, writes a *new* login
 * keychain entry that nothing ever removed. On a developer's Mac that is one
 * permanent entry per run, forever. Nothing else on the machine can be
 * holding this account name (it is derived from a temp dir that exists only
 * for this run), so deleting it is unambiguous and needs no confirmation.
 *
 * Non-fatal: a failure here must not turn a passing suite red, and there is
 * nothing to do on Linux or in CI, where there is no keychain at all.
 */
function cleanUpMacKeychainIdentity(dir: string): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccountFor(dir)],
      { stdio: "ignore" },
    );
  } catch {
    // No entry (the agent fell back to a file, or never got that far), or
    // the keychain is locked. Neither is worth failing the suite over.
  }
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
  // beforeAll can throw before app/agentApp/agentDir are ever assigned (a
  // failed `go build`, a port that would not bind) -- guard each teardown
  // step so that case reports its real cause instead of a follow-on
  // "Cannot read properties of undefined" here.
  await Promise.all([app?.close(), agentApp?.close()]);
  if (agentDir) {
    cleanUpMacKeychainIdentity(agentDir);
    rmSync(agentDir, { recursive: true, force: true });
  }
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
