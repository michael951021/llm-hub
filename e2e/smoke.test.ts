// Slice 1 end to end: the real Go agent binary against the real control
// plane (both listeners, in this process) and the real database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { OFFLINE_AFTER_MS, sweepOfflineNodes } from "../apps/control-plane/src/jobs/offline-sweeper.js";
import { buildAgentApp, buildApp } from "../apps/control-plane/src/server.js";
import { listen } from "../apps/control-plane/src/test-helpers.js";

const agentModuleDir = fileURLToPath(new URL("../agent", import.meta.url));

let app: Awaited<ReturnType<typeof buildApp>>;
let agentApp: Awaited<ReturnType<typeof buildAgentApp>>;
let agent: ChildProcess | undefined;
let baseUrl: string;       // browser-facing: auth + FleetService
let agentBaseUrl: string;  // agent-facing h2c: NodeService
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
 * Runs a child to completion without blocking the event loop. It must be
 * async: the server the agent dials lives on this process's event loop, so
 * execFileSync would deadlock until the agent's HTTP/2 ping timeout.
 */
function run(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${binary} ${args.join(" ")} exited ${code ?? `on ${signal}`}`));
    });
  });
}

/**
 * On macOS the agent stores its key in the login keychain, under an account
 * derived from the config dir (keyringAccount in agent/internal/config).
 * This run's dir is a fresh temp dir, so its entry is ours alone to delete.
 */
function removeKeychainEntry(dir: string): void {
  if (process.platform !== "darwin") return;
  const account = `node-key-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`;
  try {
    execFileSync("security", ["delete-generic-password", "-s", "com.modelhub.agent", "-a", account], { stdio: "ignore" });
  } catch {
    // No entry (the agent fell back to a file), or a locked keychain: not worth failing over.
  }
}

beforeAll(async () => {
  app = await buildApp();
  baseUrl = await listen(app);
  agentApp = await buildAgentApp();
  agentBaseUrl = await listen(agentApp);

  const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `e2e${Date.now()}@example.com`, password: "correct-horse-battery", name: "E2E" }),
  });
  cookie = signUp.headers.getSetCookie().join("; ");

  agentDir = mkdtempSync(join(tmpdir(), "modelhub-e2e-"));
  execFileSync("go", ["build", "-o", join(agentDir, "modelhub-agent"), "./cmd/agent"], {
    cwd: agentModuleDir, stdio: "inherit",
  });
});

afterAll(async () => {
  agent?.kill("SIGTERM");
  // beforeAll may have failed partway; don't mask its error here.
  await Promise.all([app?.close(), agentApp?.close()]);
  if (agentDir) {
    removeKeychainEntry(agentDir);
    rmSync(agentDir, { recursive: true, force: true });
  }
});

describe("slice 1 end to end", () => {
  it("enrolls an agent and shows it on the fleet with live memory numbers", async () => {
    const { code } = await rpc("CreatePairingCode", { nodeName: "e2e-box" });
    const env = { ...process.env, MODELHUB_CONFIG_DIR: agentDir };
    const binary = join(agentDir, "modelhub-agent");

    await run(binary, ["enroll", "--code", code, "--server", agentBaseUrl, "--name", "e2e-box"], env);
    agent = spawn(binary, ["run", "--fake-probe"], { env, stdio: "inherit" });

    // "online" with devices is only reachable through the real Ed25519
    // header (signed in Go, verified in TypeScript) on the real h2c stream.
    let nodes: Array<Record<string, any>> = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      ({ nodes } = await rpc("ListNodes", {}));
      if (nodes[0]?.status === "online" && nodes[0].devices?.length > 0) break;
      await sleep(500);
    }

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ name: "e2e-box", status: "online" });
    const device = nodes[0]!.devices[0]!;
    expect(Number(device.availableBytes)).toBeGreaterThan(0);
    expect(Number(device.availableBytes)).toBeLessThan(Number(device.totalBytes));
    expect(device.schedulable).toBe(true);
  });

  it("marks the node offline after the agent stops", async () => {
    agent?.kill("SIGTERM");
    agent = undefined;
    await sleep(1_000);

    // Inject the sweep's clock rather than wait out the real threshold.
    await sweepOfflineNodes(new Date(Date.now() + OFFLINE_AFTER_MS + 1_000));
    expect((await rpc("ListNodes", {})).nodes[0].status).toBe("offline");
  }, 30_000);
});
