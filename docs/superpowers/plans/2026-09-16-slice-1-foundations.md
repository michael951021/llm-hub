# Model Hub Slice 1: Foundations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the agent on a Mac and an NVIDIA box, and see both machines — with correct, honestly-computed memory numbers — in a browser, behind a real account.

**Architecture:** A pnpm/Turbo monorepo containing a TypeScript control plane (Fastify + ConnectRPC + Drizzle/Postgres), a React SPA, and a Go node agent, with protobuf schemas shared between them via Buf. The agent dials out and holds a bidirectional stream; it enrolls once with a pairing code, authenticates every connection with an Ed25519 signature, reports its device inventory, and pushes memory samples every five seconds. The control plane computes each device's schedulable budget with pure, heavily-tested functions and serves it to the Fleet page.

**Tech Stack:** Node 22, TypeScript 5.6+, Fastify 5, ConnectRPC, Drizzle ORM, Postgres 16 (TimescaleDB image), Redis 7, Better Auth, Vite + React 18, TanStack Query/Router, Tailwind + shadcn/ui, Vitest, Go 1.23, `go-nvml`, `gopsutil`, `kardianos/service`, GoReleaser, Buf.

**Spec:** `docs/superpowers/specs/2026-09-16-local-ai-cluster-orchestrator-design.md`

## Global Constraints

- **Node 22** (`.nvmrc` pins it); **pnpm** workspaces + **Turborepo**; **Go 1.23+**.
- **Postgres 16** using the `timescale/timescaledb:latest-pg16` image from the start, so later slices need no environment change. **Hypertables are NOT created in this slice** — telemetry storage belongs to slice 8. Devices carry only their latest sample.
- **Every tenant table carries `org_id` and has row-level security enabled.** The application connects as a non-owner role that cannot bypass RLS. This is §12 of the spec and is far cheaper to do now than to retrofit.
- **Agent identity is Ed25519.** The private key never leaves the node; the control plane stores only the public key. No API keys or bearer tokens for agents, ever (spec §7.3, §9.3).
- **All generated protobuf code is committed** to the repo, so a clean checkout builds without Buf installed.
- Device memory arithmetic lives in **one place** — `packages/core/src/memory.ts` — as pure functions. No memory math in route handlers, the agent, or the UI.
- **Deferred to later slices, deliberately:** model runtimes and inference (slice 2), the scheduler (slice 3), peer/direct transport and mTLS node certificates (slice 9), notarized installers and fleet self-update (slice 10). Do not build them here.

---

## File Structure

```
model-hub/
├── package.json                    workspace root, scripts
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .nvmrc                          "22"
├── docker-compose.yml              postgres (timescale) + redis
├── .github/workflows/ci.yml
│
├── proto/
│   ├── buf.yaml                    lint + breaking config
│   ├── buf.gen.yaml                TS + Go codegen targets
│   └── modelhub/v1/
│       ├── common.proto            HostInfo, Device, DeviceSample, enums
│       ├── node.proto              NodeService: Enroll, Connect
│       └── fleet.proto             FleetService: ListNodes, GetNode, CreatePairingCode
│
├── packages/
│   ├── proto-ts/                   generated TS (committed)
│   ├── core/
│   │   └── src/memory.ts           budget math — the only place it exists
│   │   └── src/memory.test.ts
│   └── db/
│       ├── src/schema/auth.ts      Better Auth tables
│       ├── src/schema/fleet.ts     nodes, devices, pairing_codes
│       ├── src/client.ts           pool + withOrg() transaction helper
│       ├── drizzle.config.ts
│       └── migrations/
│
├── apps/
│   ├── control-plane/
│   │   └── src/
│   │       ├── main.ts             entrypoint
│   │       ├── app.ts              Fastify assembly
│   │       ├── env.ts              validated config
│   │       ├── auth/               Better Auth wiring, session guards
│   │       ├── rpc/
│   │       │   ├── node-service.ts     Enroll + Connect stream
│   │       │   ├── fleet-service.ts    ListNodes/GetNode/CreatePairingCode
│   │       │   └── node-auth.ts        Ed25519 interceptor + replay cache
│   │       ├── domain/
│   │       │   ├── pairing.ts          code mint/redeem
│   │       │   ├── nodes.ts            enroll, upsert inventory, samples
│   │       │   └── views.ts            NodeView/DeviceView assembly
│   │       └── jobs/offline-sweeper.ts
│   └── web/
│       └── src/
│           ├── main.tsx, router.tsx, api.ts
│           ├── routes/sign-in.tsx, sign-up.tsx, fleet.tsx, node-detail.tsx
│           └── components/NodeCard.tsx, DeviceMemoryBar.tsx, AddNodeDialog.tsx
│
└── agent/                          Go module
    ├── go.mod
    ├── .goreleaser.yaml
    ├── cmd/agent/main.go           CLI: enroll | run | status
    ├── gen/                        generated Go protobuf (committed)
    └── internal/
        ├── config/                 paths, config file, identity storage
        ├── inventory/              DeviceProbe interface + cpu/nvml/metal/fake
        ├── transport/              Connect client, auth header, reconnect loop
        └── version/
```

**Why these boundaries.** `packages/core` is pure and dependency-free so the memory math can be tested exhaustively and later reused by the scheduler unchanged. `packages/db` owns schema and the RLS-scoped connection helper so no app can accidentally query unscoped. In the agent, `inventory` knows nothing about the network and `transport` knows nothing about GPUs — which is what lets the whole connect loop be tested against a fake probe with no hardware.

---

## Task 1: Monorepo skeleton and local environment

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.nvmrc`, `docker-compose.yml`, `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `pnpm test`, `pnpm build`, `pnpm dev` scripts at the root; `docker compose up -d` providing Postgres on `localhost:5433` and Redis on `localhost:6380` (non-default ports, so a developer's existing local services are never shadowed).

- [ ] **Step 1: Create the workspace root**

`package.json`:
```json
{
  "name": "model-hub",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "db:up": "docker compose up -d",
    "db:down": "docker compose down"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`.nvmrc`:
```
22
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {}
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 2: Add the local services**

`docker-compose.yml`:
```yaml
services:
  db:
    image: timescale/timescaledb:latest-pg16
    environment:
      POSTGRES_USER: modelhub_owner
      POSTGRES_PASSWORD: devpassword
      POSTGRES_DB: modelhub
    ports: ["5433:5432"]
    volumes: ["modelhub-pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U modelhub_owner -d modelhub"]
      interval: 2s
      timeout: 3s
      retries: 20
  redis:
    image: redis:7-alpine
    ports: ["6380:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 20
volumes:
  modelhub-pgdata:
```

`.env.example`:
```
DATABASE_URL=postgres://modelhub_app:devpassword@localhost:5433/modelhub
DATABASE_OWNER_URL=postgres://modelhub_owner:devpassword@localhost:5433/modelhub
REDIS_URL=redis://localhost:6380
PUBLIC_URL=http://localhost:5173
PORT=3000
BETTER_AUTH_SECRET=dev-only-change-me-in-production-0123456789abcdef
```

Append to `.gitignore`:
```
.env
.turbo/
coverage/
agent/dist/
```

- [ ] **Step 3: Verify the toolchain runs**

Run:
```bash
pnpm install
docker compose up -d
docker compose ps
```
Expected: both services report `healthy` within ~20 seconds.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: monorepo skeleton with postgres and redis"
```

---

## Task 2: Protobuf schemas and code generation

**Files:**
- Create: `proto/buf.yaml`, `proto/buf.gen.yaml`, `proto/modelhub/v1/common.proto`, `proto/modelhub/v1/node.proto`, `proto/modelhub/v1/fleet.proto`
- Create: `packages/proto-ts/package.json`, `packages/proto-ts/src/index.ts`
- Test: `packages/proto-ts/src/generated.test.ts`

**Interfaces:**
- Consumes: Task 1's workspace.
- Produces: generated TS under `packages/proto-ts/src/gen/modelhub/v1/` (importable as `@modelhub/proto`), generated Go under `agent/gen/modelhub/v1/` (package `modelhubv1`). Message names used by every later task: `HostInfo`, `Device`, `DeviceSample`, `DeviceKind`, `MemoryPressure`, `EnrollRequest/Response`, `AgentMessage`, `ServerMessage`, `NodeView`, `DeviceView`.

- [ ] **Step 1: Define the shared messages**

`proto/modelhub/v1/common.proto`:
```proto
syntax = "proto3";
package modelhub.v1;

option go_package = "github.com/modelhub/agent/gen/modelhub/v1;modelhubv1";

message HostInfo {
  string hostname = 1;
  string platform = 2;              // "darwin" | "linux" | "windows"
  string arch = 3;                  // "arm64" | "amd64"
  string os_version = 4;
  string agent_version = 5;
  uint64 total_memory_bytes = 6;
  uint32 cpu_cores = 7;
}

enum DeviceKind {
  DEVICE_KIND_UNSPECIFIED = 0;
  DEVICE_KIND_CPU = 1;
  DEVICE_KIND_CUDA = 2;
  DEVICE_KIND_METAL = 3;
}

enum MemoryPressure {
  MEMORY_PRESSURE_UNSPECIFIED = 0;
  MEMORY_PRESSURE_NORMAL = 1;
  MEMORY_PRESSURE_WARN = 2;
  MEMORY_PRESSURE_CRITICAL = 3;
}

// Static facts about a device. Reported once per connection.
message Device {
  string local_id = 1;              // stable within the node: "cuda:0", "metal:0", "cpu:0"
  DeviceKind kind = 2;
  uint32 index = 3;
  string name = 4;
  uint64 total_bytes = 5;
  string driver_version = 6;
  string compute_capability = 7;
  uint64 wired_limit_bytes = 8;     // metal only; 0 elsewhere
}

// Changing facts about a device. Reported on an interval.
message DeviceSample {
  string local_id = 1;
  uint64 used_bytes = 2;            // everything in use: ours plus foreign
  uint64 managed_bytes = 3;         // what our own shards hold; always 0 in slice 1
  double utilization = 4;           // 0..1
  double temperature_c = 5;
  double power_watts = 6;
  MemoryPressure pressure = 7;
  int64 sampled_at_unix_ms = 8;
}
```

- [ ] **Step 2: Define the two services**

`proto/modelhub/v1/node.proto`:
```proto
syntax = "proto3";
package modelhub.v1;

import "modelhub/v1/common.proto";

option go_package = "github.com/modelhub/agent/gen/modelhub/v1;modelhubv1";

// Called by agents. Enroll is unauthenticated (the pairing code is the
// credential); Connect requires the Ed25519 node-auth header.
service NodeService {
  rpc Enroll(EnrollRequest) returns (EnrollResponse);
  rpc Connect(stream AgentMessage) returns (stream ServerMessage);
}

message EnrollRequest {
  string pairing_code = 1;
  bytes public_key = 2;             // Ed25519 public key, exactly 32 bytes
  string node_name = 3;
  HostInfo host = 4;
}

message EnrollResponse {
  string node_id = 1;
  string org_id = 2;
  string org_name = 3;
}

message AgentMessage {
  oneof payload {
    Hello hello = 1;
    InventoryReport inventory = 2;
    SampleBatch samples = 3;
  }
}

message Hello {
  string agent_version = 1;
  HostInfo host = 2;
}

message InventoryReport { repeated Device devices = 1; }
message SampleBatch { repeated DeviceSample samples = 1; }

message ServerMessage {
  oneof payload {
    HelloAck hello_ack = 1;
    AgentConfig config = 2;
  }
}

message HelloAck {
  string node_id = 1;
  uint32 sample_interval_ms = 2;
}

message AgentConfig { uint32 sample_interval_ms = 1; }
```

`proto/modelhub/v1/fleet.proto`:
```proto
syntax = "proto3";
package modelhub.v1;

import "modelhub/v1/common.proto";

option go_package = "github.com/modelhub/agent/gen/modelhub/v1;modelhubv1";

// Called by the browser with a session cookie. Every method is org-scoped.
service FleetService {
  rpc ListNodes(ListNodesRequest) returns (ListNodesResponse);
  rpc GetNode(GetNodeRequest) returns (GetNodeResponse);
  rpc CreatePairingCode(CreatePairingCodeRequest) returns (CreatePairingCodeResponse);
}

message ListNodesRequest {}
message ListNodesResponse { repeated NodeView nodes = 1; }
message GetNodeRequest { string node_id = 1; }
message GetNodeResponse { NodeView node = 1; }

message CreatePairingCodeRequest { string node_name = 1; }
message CreatePairingCodeResponse {
  string code = 1;
  int64 expires_at_unix_ms = 2;
}

message NodeView {
  string id = 1;
  string name = 2;
  string status = 3;                // "online" | "degraded" | "offline"
  HostInfo host = 4;
  int64 last_seen_unix_ms = 5;
  repeated DeviceView devices = 6;
}

// A device with its budget already computed by the control plane.
// The browser never does memory arithmetic.
message DeviceView {
  string id = 1;
  string local_id = 2;
  DeviceKind kind = 3;
  string name = 4;
  uint64 total_bytes = 5;
  uint64 managed_bytes = 6;
  uint64 foreign_bytes = 7;
  uint64 headroom_bytes = 8;
  uint64 available_bytes = 9;
  double utilization = 10;
  MemoryPressure pressure = 11;
  bool schedulable = 12;
}
```

- [ ] **Step 3: Configure Buf for both targets**

`proto/buf.yaml`:
```yaml
version: v2
modules:
  - path: .
lint:
  use: [STANDARD]
breaking:
  use: [FILE]
```

`proto/buf.gen.yaml`:
```yaml
version: v2
clean: true
plugins:
  - remote: buf.build/bufbuild/es
    out: ../packages/proto-ts/src/gen
    opt: [target=ts]
  - remote: buf.build/protocolbuffers/go
    out: ../agent/gen
    opt: [paths=source_relative]
  - remote: buf.build/connectrpc/go
    out: ../agent/gen
    opt: [paths=source_relative]
```

`packages/proto-ts/package.json`:
```json
{
  "name": "@modelhub/proto",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "generate": "cd ../../proto && buf generate",
    "lint": "cd ../../proto && buf lint",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@bufbuild/protobuf": "^2.2.0",
    "@connectrpc/connect": "^2.0.0"
  }
}
```

`packages/proto-ts/src/index.ts`:
```ts
export * from "./gen/modelhub/v1/common_pb.js";
export * from "./gen/modelhub/v1/node_pb.js";
export * from "./gen/modelhub/v1/fleet_pb.js";
```

- [ ] **Step 4: Write the test that proves generation worked**

`packages/proto-ts/src/generated.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { DeviceKind, DeviceSchema, MemoryPressure } from "./index.js";

describe("generated protobuf", () => {
  it("round-trips a Device through binary encoding", () => {
    const device = create(DeviceSchema, {
      localId: "cuda:0",
      kind: DeviceKind.CUDA,
      index: 0,
      name: "NVIDIA GeForce RTX 4090",
      totalBytes: 25_769_803_776n,
    });

    const decoded = fromBinary(DeviceSchema, toBinary(DeviceSchema, device));

    expect(decoded.localId).toBe("cuda:0");
    expect(decoded.kind).toBe(DeviceKind.CUDA);
    expect(decoded.totalBytes).toBe(25_769_803_776n);
  });

  it("exposes the memory pressure enum", () => {
    expect(MemoryPressure.CRITICAL).toBeDefined();
  });
});
```

- [ ] **Step 5: Generate and verify**

Run:
```bash
cd proto && buf lint && buf generate && cd ..
pnpm --filter @modelhub/proto test
```
Expected: lint clean, generation writes files into `packages/proto-ts/src/gen/` and `agent/gen/`, and both tests PASS.

If `buf` is not installed: `brew install bufbuild/buf/buf` (macOS) or see https://buf.build/docs/installation.

- [ ] **Step 6: Commit, including generated code**

```bash
git add proto packages/proto-ts agent/gen
git commit -m "feat: protobuf schemas for node and fleet services"
```

---

## Task 3: Database schema with row-level security

**Files:**
- Create: `packages/db/package.json`, `packages/db/drizzle.config.ts`, `packages/db/src/schema/auth.ts`, `packages/db/src/schema/fleet.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/client.ts`, `packages/db/src/index.ts`
- Create: `packages/db/migrations/0001_roles_and_rls.sql`
- Test: `packages/db/src/rls.test.ts`

**Interfaces:**
- Consumes: Task 1's Postgres.
- Produces: `db` (Drizzle instance, app role), `withOrg(orgId, fn)` which runs `fn` inside a transaction with `app.current_org_id` set, and the tables `nodes`, `devices`, `pairingCodes`. Every later task that touches tenant data goes through `withOrg`.

- [ ] **Step 1: Define the fleet schema**

`packages/db/package.json`:
```json
{
  "name": "@modelhub/db",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "migrate": "drizzle-kit migrate",
    "generate": "drizzle-kit generate",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "drizzle-orm": "^0.36.0",
    "postgres": "^3.4.4"
  },
  "devDependencies": { "drizzle-kit": "^0.28.0" }
}
```

`packages/db/src/schema/auth.ts` — Better Auth's tables. Generate them rather than hand-writing:
```bash
pnpm --filter @modelhub/control-plane exec better-auth generate --output ../../packages/db/src/schema/auth.ts
```
That command runs in Task 5 once Better Auth is configured. For now, create the minimal `organization` table this task's foreign keys need; Task 5 replaces the file wholesale with the generated version, keeping this table's shape:
```ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

`packages/db/src/schema/fleet.ts`:
```ts
import {
  bigint, boolean, doublePrecision, index, integer, jsonb, pgTable,
  text, timestamp, uniqueIndex, uuid, customType,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (v) => Buffer.from(v),
  fromDriver: (v) => new Uint8Array(v),
});

export const nodes = pgTable("nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("offline"), // online | degraded | offline
  platform: text("platform").notNull().default(""),
  arch: text("arch").notNull().default(""),
  osVersion: text("os_version").notNull().default(""),
  agentVersion: text("agent_version").notNull().default(""),
  hostname: text("hostname").notNull().default(""),
  totalMemoryBytes: bigint("total_memory_bytes", { mode: "bigint" }).notNull().default(0n),
  cpuCores: integer("cpu_cores").notNull().default(0),
  publicKey: bytea("public_key").notNull(),
  siteId: text("site_id"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOrg: index("nodes_org_idx").on(t.orgId),
  byKey: uniqueIndex("nodes_public_key_idx").on(t.publicKey),
}));

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Denormalized from nodes so the RLS policy is a simple column comparison
  // rather than a subquery on every row.
  orgId: text("org_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  localId: text("local_id").notNull(),
  kind: text("kind").notNull(),                       // cpu | cuda | metal
  index: integer("index").notNull().default(0),
  name: text("name").notNull().default(""),
  totalBytes: bigint("total_bytes", { mode: "bigint" }).notNull().default(0n),
  wiredLimitBytes: bigint("wired_limit_bytes", { mode: "bigint" }).notNull().default(0n),
  driverVersion: text("driver_version").notNull().default(""),
  computeCapability: text("compute_capability").notNull().default(""),
  interactive: boolean("interactive").notNull().default(false),
  lastUsedBytes: bigint("last_used_bytes", { mode: "bigint" }).notNull().default(0n),
  lastManagedBytes: bigint("last_managed_bytes", { mode: "bigint" }).notNull().default(0n),
  lastUtilization: doublePrecision("last_utilization").notNull().default(0),
  lastPressure: text("last_pressure").notNull().default("normal"),
  lastSampleAt: timestamp("last_sample_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byNodeLocal: uniqueIndex("devices_node_local_idx").on(t.nodeId, t.localId),
  byOrg: index("devices_org_idx").on(t.orgId),
}));

export const pairingCodes = pgTable("pairing_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull().unique(),
  nodeName: text("node_name").notNull().default(""),
  createdBy: text("created_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedByNodeId: uuid("used_by_node_id").references(() => nodes.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOrg: index("pairing_codes_org_idx").on(t.orgId),
}));
```

`packages/db/src/schema/index.ts`:
```ts
export * from "./auth.js";
export * from "./fleet.js";
```

- [ ] **Step 2: Write the failing RLS test**

`packages/db/src/rls.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, ownerDb, withOrg } from "./client.js";
import { nodes, organization } from "./schema/index.js";

const orgA = `org_${randomUUID().slice(0, 8)}`;
const orgB = `org_${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await ownerDb.insert(organization).values([
    { id: orgA, name: "Org A", slug: orgA },
    { id: orgB, name: "Org B", slug: orgB },
  ]);
  await ownerDb.insert(nodes).values([
    { orgId: orgA, name: "a-node", publicKey: new Uint8Array(32).fill(1) },
    { orgId: orgB, name: "b-node", publicKey: new Uint8Array(32).fill(2) },
  ]);
});

afterAll(async () => {
  await ownerDb.delete(organization).where(sql`id in (${orgA}, ${orgB})`);
});

describe("row-level security", () => {
  it("shows an org only its own nodes", async () => {
    const rows = await withOrg(orgA, (tx) => tx.select().from(nodes));
    expect(rows.map((r) => r.name)).toEqual(["a-node"]);
  });

  it("hides other orgs' nodes even from an explicit query", async () => {
    const rows = await withOrg(orgB, (tx) =>
      tx.select().from(nodes).where(sql`${nodes.orgId} = ${orgA}`),
    );
    expect(rows).toEqual([]);
  });

  it("refuses to write a row belonging to another org", async () => {
    await expect(
      withOrg(orgA, (tx) =>
        tx.insert(nodes).values({
          orgId: orgB,
          name: "smuggled",
          publicKey: new Uint8Array(32).fill(3),
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("returns nothing when no org is set", async () => {
    const rows = await db.select().from(nodes);
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to watch it fail**

Run: `pnpm --filter @modelhub/db test`
Expected: FAIL — `./client.js` does not exist yet.

- [ ] **Step 4: Write the client with the org-scoped helper**

`packages/db/src/client.ts`:
```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema/index.js";

const appUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_OWNER_URL ?? appUrl;
if (!appUrl) throw new Error("DATABASE_URL is required");

// The application connection. This role cannot bypass RLS, so a query that
// forgets withOrg() returns nothing rather than everything.
export const appSql = postgres(appUrl, { max: 10 });
export const db = drizzle(appSql, { schema });

// The owner connection. Migrations and tests only — never request handling.
export const ownerSql = postgres(ownerUrl!, { max: 2 });
export const ownerDb = drizzle(ownerSql, { schema });

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs fn inside a transaction scoped to one organization. Every tenant query
 * in the application goes through here; RLS does the rest.
 */
export async function withOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
```

`packages/db/src/index.ts`:
```ts
export * from "./client.js";
export * from "./schema/index.js";
```

- [ ] **Step 5: Write the migration that creates the role and the policies**

`packages/db/drizzle.config.ts`:
```ts
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_OWNER_URL! },
} satisfies Config;
```

Generate the table migration, then add the RLS migration by hand:
```bash
pnpm --filter @modelhub/db generate
```

`packages/db/migrations/0001_roles_and_rls.sql`:
```sql
-- The application role. Deliberately NOT the table owner: an owner would
-- bypass RLS silently, which defeats the point.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelhub_app') THEN
    CREATE ROLE modelhub_app LOGIN PASSWORD 'devpassword';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO modelhub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO modelhub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO modelhub_app;

ALTER TABLE nodes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY nodes_org_isolation ON nodes
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));

CREATE POLICY devices_org_isolation ON devices
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));

CREATE POLICY pairing_codes_org_isolation ON pairing_codes
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
```

- [ ] **Step 6: Apply the migrations and run the test**

Run:
```bash
docker compose up -d
set -a && source .env && set +a
pnpm --filter @modelhub/db migrate
pnpm --filter @modelhub/db test
```
Expected: all four RLS tests PASS. The fourth — no org set, no rows — is the one that proves the app role really is restricted.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat: fleet schema with org-scoped row-level security"
```

---

## Task 4: Device memory budget math

This is the most important code in the slice and the reason the Fleet page can
be trusted. It is pure, has no dependencies, and is tested exhaustively.

**Files:**
- Create: `packages/core/package.json`, `packages/core/src/memory.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/memory.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `computeBudget(input: MemoryInput): MemoryBudget` and the exported constants `HEADROOM_FRAC`, `HEADROOM_MIN_BYTES`, `OS_RESERVE_FRAC`, `OS_RESERVE_MIN_BYTES`, `INTERACTIVE_RESERVE_FRAC`. Task 11 (Fleet API) is the only consumer in this slice; the scheduler reuses it unchanged in slice 3.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/memory.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeBudget, HEADROOM_MIN_BYTES } from "./memory.js";

const GiB = 1024 ** 3;

describe("computeBudget — cuda", () => {
  it("subtracts foreign memory, our own memory, and headroom", () => {
    const b = computeBudget({
      kind: "cuda",
      totalBytes: 24 * GiB,
      usedBytes: 10 * GiB,     // 6 ours + 4 someone else's
      managedBytes: 6 * GiB,
    });

    expect(b.foreignBytes).toBe(4 * GiB);
    expect(b.headroomBytes).toBe(Math.floor(24 * GiB * 0.08));
    expect(b.availableBytes).toBe(24 * GiB - 4 * GiB - 6 * GiB - b.headroomBytes);
    expect(b.schedulable).toBe(true);
  });

  it("applies the headroom floor on small devices", () => {
    const b = computeBudget({
      kind: "cuda", totalBytes: 4 * GiB, usedBytes: 0, managedBytes: 0,
    });
    expect(b.headroomBytes).toBe(HEADROOM_MIN_BYTES);
  });

  it("never reports negative availability when foreign memory floods the device", () => {
    const b = computeBudget({
      kind: "cuda", totalBytes: 24 * GiB, usedBytes: 24 * GiB, managedBytes: 0,
    });
    expect(b.foreignBytes).toBe(24 * GiB);
    expect(b.availableBytes).toBe(0);
  });

  it("clamps foreign to zero when our accounting briefly exceeds the driver's", () => {
    // Can happen between a load completing and the next NVML sample.
    const b = computeBudget({
      kind: "cuda", totalBytes: 24 * GiB, usedBytes: 2 * GiB, managedBytes: 3 * GiB,
    });
    expect(b.foreignBytes).toBe(0);
  });
});

describe("computeBudget — metal unified memory", () => {
  it("honors the wired limit and the OS reserve, whichever binds first", () => {
    const b = computeBudget({
      kind: "metal",
      totalBytes: 128 * GiB,
      usedBytes: 20 * GiB,
      managedBytes: 16 * GiB,
      wiredLimitBytes: 96 * GiB,
      pressure: "normal",
    });

    // OS reserve is max(8 GiB, 15% of 128 GiB) = 19.2 GiB, so the ceiling is
    // min(96 GiB, 128 - 19.2 GiB) = 96 GiB — the wired limit binds.
    expect(b.foreignBytes).toBe(4 * GiB);
    expect(b.availableBytes).toBe(96 * GiB - 16 * GiB - 4 * GiB);
  });

  it("falls back to 75% of physical memory when no wired limit is reported", () => {
    const b = computeBudget({
      kind: "metal", totalBytes: 32 * GiB, usedBytes: 0, managedBytes: 0,
      pressure: "normal",
    });
    // ceiling = min(0.75 × 32 GiB = 24 GiB, 32 GiB − max(8 GiB, 4.8 GiB) = 24 GiB)
    expect(b.availableBytes).toBe(24 * GiB);
  });

  it("reserves far more on a machine flagged interactive", () => {
    const shared = {
      kind: "metal" as const, totalBytes: 36 * GiB, usedBytes: 0,
      managedBytes: 0, pressure: "normal" as const,
    };
    const normal = computeBudget(shared);
    const daily = computeBudget({ ...shared, interactive: true });
    expect(daily.availableBytes).toBeLessThan(normal.availableBytes);
  });

  it("is unschedulable under memory pressure warn", () => {
    const b = computeBudget({
      kind: "metal", totalBytes: 64 * GiB, usedBytes: 0, managedBytes: 0,
      pressure: "warn",
    });
    expect(b.schedulable).toBe(false);
    expect(b.availableBytes).toBe(0);
  });

  it("is unschedulable under memory pressure critical", () => {
    const b = computeBudget({
      kind: "metal", totalBytes: 64 * GiB, usedBytes: 0, managedBytes: 0,
      pressure: "critical",
    });
    expect(b.schedulable).toBe(false);
  });
});

describe("computeBudget — cpu", () => {
  it("reserves system memory for the operating system", () => {
    const b = computeBudget({
      kind: "cpu", totalBytes: 64 * GiB, usedBytes: 8 * GiB, managedBytes: 0,
    });
    const reserve = Math.max(8 * GiB, Math.floor(64 * GiB * 0.15));
    expect(b.availableBytes).toBe(64 * GiB - 8 * GiB - reserve);
  });
});

describe("computeBudget — invariants", () => {
  const cases = [
    { kind: "cuda" as const, totalBytes: 24 * GiB },
    { kind: "metal" as const, totalBytes: 96 * GiB },
    { kind: "cpu" as const, totalBytes: 128 * GiB },
  ];

  it("never returns availability above total, or below zero", () => {
    for (const c of cases) {
      for (const used of [0, 1, 7, 23, 95, 128]) {
        const b = computeBudget({
          ...c, usedBytes: Math.min(used * GiB, c.totalBytes), managedBytes: 0,
        });
        expect(b.availableBytes).toBeGreaterThanOrEqual(0);
        expect(b.availableBytes).toBeLessThanOrEqual(c.totalBytes);
      }
    }
  });

  it("returns a zero budget for a device reporting no memory at all", () => {
    const b = computeBudget({
      kind: "cuda", totalBytes: 0, usedBytes: 0, managedBytes: 0,
    });
    expect(b.availableBytes).toBe(0);
    expect(b.schedulable).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to watch them fail**

Run: `pnpm --filter @modelhub/core test`
Expected: FAIL — `./memory.js` does not exist.

- [ ] **Step 3: Implement the math**

`packages/core/package.json`:
```json
{
  "name": "@modelhub/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }
}
```

`packages/core/src/memory.ts`:
```ts
export type DeviceKind = "cpu" | "cuda" | "metal";
export type MemoryPressure = "normal" | "warn" | "critical";

export interface MemoryInput {
  kind: DeviceKind;
  /** Physical memory on the device; system RAM for cpu and metal. */
  totalBytes: number;
  /** Everything currently in use on the device — ours plus everyone else's. */
  usedBytes: number;
  /** What our own replicas hold. Zero until slice 2 loads anything. */
  managedBytes: number;
  /** macOS only: iogpu.wired_limit_mb, when the system reports one. */
  wiredLimitBytes?: number;
  /** macOS only. Absent is treated as "normal". */
  pressure?: MemoryPressure;
  /** Someone's daily-driver machine: reserve much more for them. */
  interactive?: boolean;
}

export interface MemoryBudget {
  totalBytes: number;
  managedBytes: number;
  /** Memory held by processes that are not ours. The critical term. */
  foreignBytes: number;
  headroomBytes: number;
  availableBytes: number;
  schedulable: boolean;
}

/** Fragmentation and driver context overhead, as a fraction of device memory. */
export const HEADROOM_FRAC = 0.08;
export const HEADROOM_MIN_BYTES = 512 * 1024 ** 2;

/** Memory left to the operating system on shared-memory devices. */
export const OS_RESERVE_FRAC = 0.15;
export const OS_RESERVE_MIN_BYTES = 8 * 1024 ** 3;

/** Reserve on a machine someone actually uses. */
export const INTERACTIVE_RESERVE_FRAC = 0.30;

/** Apple's practical ceiling when the system reports no explicit wired limit. */
export const METAL_DEFAULT_CEILING_FRAC = 0.75;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function computeBudget(input: MemoryInput): MemoryBudget {
  const { kind, totalBytes, usedBytes, managedBytes } = input;
  const pressure = input.pressure ?? "normal";

  // Our own accounting can briefly exceed the driver's view — for instance
  // between a load finishing and the next sample. Clamp rather than go negative.
  const foreignBytes = clamp(usedBytes - managedBytes, 0, totalBytes);

  if (totalBytes <= 0) {
    return {
      totalBytes: 0, managedBytes: 0, foreignBytes: 0,
      headroomBytes: 0, availableBytes: 0, schedulable: false,
    };
  }

  // Memory pressure is a scheduling signal, not just telemetry: at warn we
  // stop placing here, and at critical the agent is already evicting.
  const schedulable = pressure === "normal";

  let headroomBytes: number;
  let ceiling: number;

  switch (kind) {
    case "cuda": {
      headroomBytes = Math.max(HEADROOM_MIN_BYTES, Math.floor(totalBytes * HEADROOM_FRAC));
      ceiling = totalBytes;
      break;
    }
    case "metal": {
      const reserveFrac = input.interactive ? INTERACTIVE_RESERVE_FRAC : OS_RESERVE_FRAC;
      const osReserve = Math.max(OS_RESERVE_MIN_BYTES, Math.floor(totalBytes * reserveFrac));
      const wiredLimit = input.wiredLimitBytes && input.wiredLimitBytes > 0
        ? input.wiredLimitBytes
        : Math.floor(totalBytes * METAL_DEFAULT_CEILING_FRAC);
      headroomBytes = 0; // The OS reserve already plays this role here.
      ceiling = Math.min(wiredLimit, totalBytes - osReserve);
      break;
    }
    case "cpu": {
      const reserveFrac = input.interactive ? INTERACTIVE_RESERVE_FRAC : OS_RESERVE_FRAC;
      headroomBytes = Math.max(OS_RESERVE_MIN_BYTES, Math.floor(totalBytes * reserveFrac));
      ceiling = totalBytes;
      break;
    }
  }

  const raw = ceiling - foreignBytes - managedBytes - headroomBytes;
  const availableBytes = schedulable ? clamp(raw, 0, totalBytes) : 0;

  return { totalBytes, managedBytes, foreignBytes, headroomBytes, availableBytes, schedulable };
}
```

`packages/core/src/index.ts`:
```ts
export * from "./memory.js";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @modelhub/core test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat: device memory budget math for cuda, metal, and cpu"
```

---

## Task 5: Control plane skeleton with validated configuration

**Files:**
- Create: `apps/control-plane/package.json`, `apps/control-plane/src/env.ts`, `apps/control-plane/src/app.ts`, `apps/control-plane/src/main.ts`, `apps/control-plane/src/redis.ts`
- Test: `apps/control-plane/src/app.test.ts`

**Interfaces:**
- Consumes: `@modelhub/db`.
- Produces: `buildApp(): Promise<FastifyInstance>` for tests to drive with `app.inject()`, `env` (a validated config object), and `redis` (a shared ioredis client).

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/app.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

let app: FastifyInstance;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });

describe("control plane", () => {
  it("reports healthy when its dependencies are reachable", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", database: "ok", redis: "ok" });
  });

  it("returns a structured 404 for an unknown route", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `pnpm --filter @modelhub/control-plane test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement config, redis, and the app**

`apps/control-plane/package.json`:
```json
{
  "name": "@modelhub/control-plane",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc",
    "start": "node dist/main.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@connectrpc/connect": "^2.0.0",
    "@connectrpc/connect-fastify": "^2.0.0",
    "@modelhub/core": "workspace:*",
    "@modelhub/db": "workspace:*",
    "@modelhub/proto": "workspace:*",
    "better-auth": "^1.1.0",
    "fastify": "^5.1.0",
    "ioredis": "^5.4.1",
    "zod": "^3.23.8"
  },
  "devDependencies": { "tsx": "^4.19.0" }
}
```

`apps/control-plane/src/env.ts`:
```ts
import { z } from "zod";

const Schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_OWNER_URL: z.string().optional(),
  REDIS_URL: z.string().min(1),
  PUBLIC_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  NODE_AUTH_SKEW_MS: z.coerce.number().default(60_000),
  SAMPLE_INTERVAL_MS: z.coerce.number().default(5_000),
  PAIRING_CODE_TTL_MS: z.coerce.number().default(15 * 60_000),
});

// Fail at boot with a readable message rather than at the first request
// with an undefined.
export const env = Schema.parse(process.env);
export type Env = z.infer<typeof Schema>;
```

`apps/control-plane/src/redis.ts`:
```ts
import Redis from "ioredis";
import { env } from "./env.js";

export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
```

`apps/control-plane/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "@modelhub/db";
import { redis } from "./redis.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: "not_found", path: req.url });
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "request failed");
    const status = err.statusCode ?? 500;
    reply.code(status).send({
      error: status >= 500 ? "internal_error" : (err.code ?? "request_error"),
      message: status >= 500 ? "internal error" : err.message,
    });
  });

  app.get("/healthz", async (_req, reply) => {
    const [database, redisStatus] = await Promise.all([
      db.execute(sql`select 1`).then(() => "ok").catch(() => "error"),
      redis.ping().then(() => "ok").catch(() => "error"),
    ]);
    const status = database === "ok" && redisStatus === "ok" ? "ok" : "degraded";
    reply.code(status === "ok" ? 200 : 503);
    return { status, database, redis: redisStatus };
  });

  return app;
}
```

`apps/control-plane/src/main.ts`:
```ts
import { buildApp } from "./app.js";
import { env } from "./env.js";

const app = await buildApp();
await app.listen({ port: env.PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info("shutting down");
    void app.close().then(() => process.exit(0));
  });
}
```

- [ ] **Step 4: Run the test**

Run:
```bash
set -a && source .env && set +a
pnpm --filter @modelhub/control-plane test
```
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane
git commit -m "feat: control plane skeleton with health check and validated config"
```

---

## Task 6: Accounts and organizations

**Files:**
- Create: `apps/control-plane/src/auth/auth.ts`, `apps/control-plane/src/auth/session.ts`
- Modify: `apps/control-plane/src/app.ts` (mount the auth handler), `packages/db/src/schema/auth.ts` (replace with generated tables)
- Test: `apps/control-plane/src/auth/session.test.ts`

**Interfaces:**
- Consumes: Task 5's `buildApp`, Task 3's `db`.
- Produces: `auth` (the Better Auth instance), and `requireSession(req): Promise<{ userId: string; orgId: string }>` which throws a 401-shaped error when there is no valid session, and a 403-shaped error when the user has no active organization. Tasks 7 and 11 use `requireSession`.

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/auth/session.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

let app: FastifyInstance;
const email = `t${Date.now()}@example.com`;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });

async function signUp() {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery", name: "Test User" },
  });
  expect(res.statusCode).toBeLessThan(400);
  const cookie = res.headers["set-cookie"];
  return Array.isArray(cookie) ? cookie.join("; ") : String(cookie);
}

describe("sessions and organizations", () => {
  it("rejects an unauthenticated request to a guarded route", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("creates a personal organization on sign-up", async () => {
    const cookie = await signUp();
    const res = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe(email);
    expect(body.org.id).toMatch(/^org_/);
    expect(body.org.name).toBeTruthy();
  });

  it("rejects a forged session cookie", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: "better-auth.session_token=not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `pnpm --filter @modelhub/control-plane test src/auth`
Expected: FAIL — `/api/auth/*` and `/api/me` are not mounted.

- [ ] **Step 3: Configure Better Auth with organizations**

`apps/control-plane/src/auth/auth.ts`:
```ts
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { randomBytes } from "node:crypto";
import { db } from "@modelhub/db";
import { env } from "../env.js";

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.PUBLIC_URL,
  basePath: "/api/auth",
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  trustedOrigins: [env.PUBLIC_URL],
  plugins: [organization()],
  databaseHooks: {
    user: {
      create: {
        // Every user lands in an organization immediately. A user without an
        // org has nothing to look at, and every tenant row needs an org_id.
        after: async (user) => {
          const slug = `org_${randomBytes(6).toString("hex")}`;
          await auth.api.createOrganization({
            body: { name: `${user.name || user.email}'s fleet`, slug, userId: user.id },
          });
        },
      },
    },
  },
});
```

Generate the auth tables into the db package and migrate:
```bash
pnpm --filter @modelhub/control-plane exec better-auth generate \
  --config src/auth/auth.ts --output ../../packages/db/src/schema/auth.ts
pnpm --filter @modelhub/db generate
pnpm --filter @modelhub/db migrate
```
The generated file must still export a table named `organization` with an `id` column, because `packages/db/src/schema/fleet.ts` references it. If the generated name differs, update the import in `fleet.ts` rather than editing generated output.

- [ ] **Step 4: Add the session guard and mount everything**

`apps/control-plane/src/auth/session.ts`:
```ts
import type { FastifyRequest } from "fastify";
import { auth } from "./auth.js";

export interface SessionContext {
  userId: string;
  orgId: string;
}

class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

function toHeaders(req: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}

/** Throws 401 without a session, 403 with a session but no active org. */
export async function requireSession(req: FastifyRequest): Promise<SessionContext> {
  const headers = toHeaders(req);
  const session = await auth.api.getSession({ headers });
  if (!session?.user) throw new HttpError(401, "unauthenticated", "sign in required");

  let orgId = session.session.activeOrganizationId ?? null;
  if (!orgId) {
    const orgs = await auth.api.listOrganizations({ headers });
    orgId = orgs[0]?.id ?? null;
  }
  if (!orgId) throw new HttpError(403, "no_organization", "user has no organization");

  return { userId: session.user.id, orgId };
}
```

In `apps/control-plane/src/app.ts`, add these imports and routes before `return app`:
```ts
import { auth } from "./auth/auth.js";
import { requireSession } from "./auth/session.js";

  // Better Auth owns every /api/auth/* route.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req, reply) => {
      const url = new URL(req.url, env.PUBLIC_URL);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
      }
      const response = await auth.handler(
        new Request(url, {
          method: req.method,
          headers,
          body: req.method === "GET" ? undefined : JSON.stringify(req.body),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(await response.text());
    },
  });

  app.get("/api/me", async (req) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
    }
    const { orgId } = await requireSession(req);
    const session = await auth.api.getSession({ headers });
    const orgs = await auth.api.listOrganizations({ headers });
    const org = orgs.find((o) => o.id === orgId);
    return {
      user: { id: session!.user.id, email: session!.user.email, name: session!.user.name },
      org: { id: orgId, name: org?.name ?? "" },
    };
  });
```

`HttpError` already carries `statusCode`, which Task 5's `setErrorHandler`
reads, so 401 and 403 surface correctly with no extra wiring.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @modelhub/control-plane test`
Expected: all auth tests and the Task 5 health tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane packages/db
git commit -m "feat: email accounts with an organization created on sign-up"
```

---

## Task 7: Pairing codes

**Files:**
- Create: `apps/control-plane/src/domain/pairing.ts`
- Test: `apps/control-plane/src/domain/pairing.test.ts`

**Interfaces:**
- Consumes: `withOrg`, `pairingCodes`, `env.PAIRING_CODE_TTL_MS`.
- Produces:
  - `mintPairingCode(orgId: string, userId: string, nodeName: string): Promise<{ code: string; expiresAt: Date }>`
  - `redeemPairingCode(code: string): Promise<{ orgId: string; nodeName: string; pairingCodeId: string }>` — throws `PairingCodeError` when unknown, expired, or already used.
  Task 8 calls `redeemPairingCode`; Task 11 calls `mintPairingCode`.

- [ ] **Step 1: Write the failing tests**

`apps/control-plane/src/domain/pairing.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ownerDb, organization, pairingCodes } from "@modelhub/db";
import { eq } from "drizzle-orm";
import { mintPairingCode, redeemPairingCode, PairingCodeError } from "./pairing.js";

const orgId = `org_${randomUUID().slice(0, 8)}`;
const userId = `user_${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await ownerDb.insert(organization).values({ id: orgId, name: "T", slug: orgId });
});

describe("pairing codes", () => {
  it("mints a human-typeable code", async () => {
    const { code, expiresAt } = await mintPairingCode(orgId, userId, "mac-studio");
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("never stores the code itself", async () => {
    const { code } = await mintPairingCode(orgId, userId, "n1");
    const rows = await ownerDb.select().from(pairingCodes).where(eq(pairingCodes.orgId, orgId));
    for (const row of rows) expect(row.codeHash).not.toContain(code);
  });

  it("redeems a valid code once and returns its org", async () => {
    const { code } = await mintPairingCode(orgId, userId, "four-ninety");
    const result = await redeemPairingCode(code);
    expect(result.orgId).toBe(orgId);
    expect(result.nodeName).toBe("four-ninety");
  });

  it("refuses a second redemption of the same code", async () => {
    const { code } = await mintPairingCode(orgId, userId, "n2");
    await redeemPairingCode(code);
    await expect(redeemPairingCode(code)).rejects.toThrow(PairingCodeError);
  });

  it("refuses an unknown code", async () => {
    await expect(redeemPairingCode("ZZZZ-ZZZZ")).rejects.toThrow(PairingCodeError);
  });

  it("refuses an expired code", async () => {
    const { code } = await mintPairingCode(orgId, userId, "n3");
    const hash = (await import("./pairing.js")).hashCode(code);
    await ownerDb.update(pairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pairingCodes.codeHash, hash));
    await expect(redeemPairingCode(code)).rejects.toThrow(/expired/i);
  });

  it("is case-insensitive and tolerates a missing dash", async () => {
    const { code } = await mintPairingCode(orgId, userId, "n4");
    const mangled = code.toLowerCase().replace("-", "");
    const result = await redeemPairingCode(mangled);
    expect(result.orgId).toBe(orgId);
  });
});
```

- [ ] **Step 2: Run to watch it fail**

Run: `pnpm --filter @modelhub/control-plane test src/domain/pairing`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/control-plane/src/domain/pairing.ts`:
```ts
import { createHash, randomInt } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { ownerDb, pairingCodes, withOrg } from "@modelhub/db";
import { env } from "../env.js";

export class PairingCodeError extends Error {
  statusCode = 400;
  code = "invalid_pairing_code";
}

// No I, O, 0, or 1: these get misread when someone types a code off a screen.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${pick()}-${pick()}`;
}

/** Codes are short-lived and single-use, so a plain SHA-256 is the right tool. */
export function hashCode(code: string): string {
  return createHash("sha256").update(normalize(code)).digest("hex");
}

export function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function mintPairingCode(
  orgId: string, userId: string, nodeName: string,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + env.PAIRING_CODE_TTL_MS);

  await withOrg(orgId, (tx) =>
    tx.insert(pairingCodes).values({
      orgId, codeHash: hashCode(code), nodeName, createdBy: userId, expiresAt,
    }),
  );

  return { code, expiresAt };
}

/**
 * Redeemed by an unauthenticated agent, so this runs on the owner connection —
 * there is no org context yet; the code IS the credential that establishes one.
 * The update is conditional on used_at being null, which makes redemption
 * atomic: two agents racing the same code produce exactly one winner.
 */
export async function redeemPairingCode(
  code: string,
): Promise<{ orgId: string; nodeName: string; pairingCodeId: string }> {
  const hash = hashCode(code);

  const claimed = await ownerDb
    .update(pairingCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(pairingCodes.codeHash, hash), isNull(pairingCodes.usedAt)))
    .returning();

  if (claimed.length === 0) {
    const existing = await ownerDb.select().from(pairingCodes)
      .where(eq(pairingCodes.codeHash, hash)).limit(1);
    throw new PairingCodeError(
      existing.length > 0 ? "pairing code already used" : "unknown pairing code",
    );
  }

  const row = claimed[0]!;
  if (row.expiresAt.getTime() < Date.now()) {
    // Release it so the expiry message is stable if the agent retries.
    await ownerDb.update(pairingCodes).set({ usedAt: null })
      .where(eq(pairingCodes.id, row.id));
    throw new PairingCodeError("pairing code expired");
  }

  return { orgId: row.orgId, nodeName: row.nodeName, pairingCodeId: row.id };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @modelhub/control-plane test src/domain/pairing`
Expected: all seven PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/domain
git commit -m "feat: single-use, expiring pairing codes"
```

---

## Task 8: Node enrollment RPC

**Files:**
- Create: `apps/control-plane/src/domain/nodes.ts`, `apps/control-plane/src/rpc/node-service.ts`, `apps/control-plane/src/rpc/index.ts`
- Modify: `apps/control-plane/src/app.ts` (mount Connect)
- Test: `apps/control-plane/src/rpc/enroll.test.ts`

**Interfaces:**
- Consumes: `redeemPairingCode`, `withOrg`, generated `NodeService`.
- Produces: `enrollNode(input): Promise<{ nodeId: string; orgId: string; orgName: string }>` in `domain/nodes.ts`, and a mounted `POST /modelhub.v1.NodeService/Enroll`. Task 15 (the Go agent) calls this endpoint.

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/rpc/enroll.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ownerDb, organization, nodes } from "@modelhub/db";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { mintPairingCode } from "../domain/pairing.js";

let app: FastifyInstance;
const orgId = `org_${randomUUID().slice(0, 8)}`;

function newPublicKey(): Uint8Array {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32)); // raw 32-byte key
}

beforeAll(async () => {
  await ownerDb.insert(organization).values({ id: orgId, name: "Fleet", slug: orgId });
  app = await buildApp();
});
afterAll(async () => { await app.close(); });

async function enroll(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/modelhub.v1.NodeService/Enroll",
    headers: { "content-type": "application/json" },
    payload: body,
  });
}

describe("NodeService.Enroll", () => {
  it("creates a node bound to the code's organization", async () => {
    const { code } = await mintPairingCode(orgId, "user_1", "mac-studio");
    const publicKey = newPublicKey();

    const res = await enroll({
      pairingCode: code,
      publicKey: Buffer.from(publicKey).toString("base64"),
      nodeName: "mac-studio",
      host: {
        hostname: "mac-studio.local", platform: "darwin", arch: "arm64",
        osVersion: "15.0", agentVersion: "0.1.0",
        totalMemoryBytes: "137438953472", cpuCores: 24,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orgId).toBe(orgId);
    expect(body.nodeId).toBeTruthy();

    const [row] = await ownerDb.select().from(nodes).where(eq(nodes.id, body.nodeId));
    expect(row!.orgId).toBe(orgId);
    expect(row!.platform).toBe("darwin");
    expect(Buffer.from(row!.publicKey)).toEqual(Buffer.from(publicKey));
  });

  it("rejects an invalid pairing code", async () => {
    const res = await enroll({
      pairingCode: "ZZZZ-ZZZZ",
      publicKey: Buffer.from(newPublicKey()).toString("base64"),
      nodeName: "nope",
      host: { hostname: "h", platform: "linux", arch: "amd64" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("rejects a public key that is not 32 bytes", async () => {
    const { code } = await mintPairingCode(orgId, "user_1", "bad-key");
    const res = await enroll({
      pairingCode: code,
      publicKey: Buffer.from(new Uint8Array(16)).toString("base64"),
      nodeName: "bad-key",
      host: { hostname: "h", platform: "linux", arch: "amd64" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("rejects a public key already registered to another node", async () => {
    const publicKey = newPublicKey();
    const first = await mintPairingCode(orgId, "user_1", "n1");
    const second = await mintPairingCode(orgId, "user_1", "n2");
    const payload = (code: string) => ({
      pairingCode: code,
      publicKey: Buffer.from(publicKey).toString("base64"),
      nodeName: "dup",
      host: { hostname: "h", platform: "linux", arch: "amd64" },
    });

    expect((await enroll(payload(first.code))).statusCode).toBe(200);
    expect((await enroll(payload(second.code))).statusCode).toBeGreaterThanOrEqual(400);
  });
});
```

- [ ] **Step 2: Run to watch it fail**

Run: `pnpm --filter @modelhub/control-plane test src/rpc/enroll`
Expected: FAIL — 404, the route is not mounted.

- [ ] **Step 3: Implement the domain function**

`apps/control-plane/src/domain/nodes.ts`:
```ts
import { eq } from "drizzle-orm";
import { ownerDb, nodes, organization, withOrg } from "@modelhub/db";
import { redeemPairingCode } from "./pairing.js";

export class EnrollmentError extends Error {
  statusCode = 400;
  code = "enrollment_failed";
}

export interface EnrollInput {
  pairingCode: string;
  publicKey: Uint8Array;
  nodeName: string;
  host: {
    hostname: string; platform: string; arch: string;
    osVersion: string; agentVersion: string;
    totalMemoryBytes: bigint; cpuCores: number;
  };
}

export async function enrollNode(
  input: EnrollInput,
): Promise<{ nodeId: string; orgId: string; orgName: string }> {
  if (input.publicKey.length !== 32) {
    throw new EnrollmentError("public key must be a 32-byte Ed25519 key");
  }

  const { orgId, nodeName } = await redeemPairingCode(input.pairingCode);

  const existing = await ownerDb.select({ id: nodes.id }).from(nodes)
    .where(eq(nodes.publicKey, input.publicKey)).limit(1);
  if (existing.length > 0) {
    throw new EnrollmentError("this key is already enrolled; re-install to get a new identity");
  }

  const [inserted] = await withOrg(orgId, (tx) =>
    tx.insert(nodes).values({
      orgId,
      name: input.nodeName || nodeName || input.host.hostname || "node",
      status: "offline",
      platform: input.host.platform,
      arch: input.host.arch,
      osVersion: input.host.osVersion,
      agentVersion: input.host.agentVersion,
      hostname: input.host.hostname,
      totalMemoryBytes: input.host.totalMemoryBytes,
      cpuCores: input.host.cpuCores,
      publicKey: input.publicKey,
    }).returning({ id: nodes.id }),
  );

  const [org] = await ownerDb.select({ name: organization.name })
    .from(organization).where(eq(organization.id, orgId)).limit(1);

  return { nodeId: inserted!.id, orgId, orgName: org?.name ?? "" };
}
```

- [ ] **Step 4: Implement the service and mount Connect**

`apps/control-plane/src/rpc/node-service.ts`:
```ts
import type { ConnectRouter } from "@connectrpc/connect";
import { NodeService } from "@modelhub/proto";
import { enrollNode } from "../domain/nodes.js";

export function registerNodeService(router: ConnectRouter): void {
  router.service(NodeService, {
    async enroll(req) {
      const result = await enrollNode({
        pairingCode: req.pairingCode,
        publicKey: req.publicKey,
        nodeName: req.nodeName,
        host: {
          hostname: req.host?.hostname ?? "",
          platform: req.host?.platform ?? "",
          arch: req.host?.arch ?? "",
          osVersion: req.host?.osVersion ?? "",
          agentVersion: req.host?.agentVersion ?? "",
          totalMemoryBytes: req.host?.totalMemoryBytes ?? 0n,
          cpuCores: req.host?.cpuCores ?? 0,
        },
      });
      return {
        nodeId: result.nodeId,
        orgId: result.orgId,
        orgName: result.orgName,
      };
    },
  });
}
```

`apps/control-plane/src/rpc/index.ts`:
```ts
import type { ConnectRouter } from "@connectrpc/connect";
import { registerNodeService } from "./node-service.js";

export function routes(router: ConnectRouter): void {
  registerNodeService(router);
}
```

In `apps/control-plane/src/app.ts`, add before `return app`:
```ts
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { routes } from "./rpc/index.js";

  await app.register(fastifyConnectPlugin, { routes });
```
Fastify must accept a large enough body for inventory reports; also set
`bodyLimit: 4 * 1024 * 1024` in the `Fastify({ ... })` options.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @modelhub/control-plane test src/rpc/enroll`
Expected: all four PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane
git commit -m "feat: node enrollment over ConnectRPC"
```

---

## Task 9: Ed25519 node authentication

**Files:**
- Create: `apps/control-plane/src/rpc/node-auth.ts`
- Test: `apps/control-plane/src/rpc/node-auth.test.ts`

**Interfaces:**
- Consumes: `redis`, `ownerDb`, `nodes`, `env.NODE_AUTH_SKEW_MS`.
- Produces:
  - `buildNodeAuthHeader(nodeId, privateKey): string` — used by tests and, in Go, mirrored by Task 15.
  - `authenticateNode(headerValue: string | undefined): Promise<{ nodeId: string; orgId: string }>` — throws `NodeAuthError` on any failure.
  Task 10 calls `authenticateNode` at the top of the Connect stream.

**Header format** (implemented identically in Go in Task 15):
```
Authorization: ModelHubNode <nodeId>.<unixMillis>.<nonceBase64Url>.<signatureBase64Url>
signature = Ed25519(privateKey, "<nodeId>.<unixMillis>.<nonceBase64Url>")
```

- [ ] **Step 1: Write the failing tests**

`apps/control-plane/src/rpc/node-auth.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign, randomUUID, type KeyObject } from "node:crypto";
import { ownerDb, organization, nodes } from "@modelhub/db";
import { authenticateNode, NodeAuthError } from "./node-auth.js";

const orgId = `org_${randomUUID().slice(0, 8)}`;
let nodeId: string;
let privateKey: KeyObject;

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

function header(id: string, key: KeyObject, atMs = Date.now(), nonce = randomUUID()): string {
  const n = b64u(Buffer.from(nonce));
  const payload = `${id}.${atMs}.${n}`;
  const sig = b64u(sign(null, Buffer.from(payload), key));
  return `ModelHubNode ${payload}.${sig}`;
}

beforeAll(async () => {
  const pair = generateKeyPairSync("ed25519");
  privateKey = pair.privateKey;
  const der = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;

  await ownerDb.insert(organization).values({ id: orgId, name: "Auth", slug: orgId });
  const [row] = await ownerDb.insert(nodes).values({
    orgId, name: "signer", publicKey: new Uint8Array(der.subarray(der.length - 32)),
  }).returning({ id: nodes.id });
  nodeId = row!.id;
});

describe("node authentication", () => {
  it("accepts a correctly signed header", async () => {
    const ctx = await authenticateNode(header(nodeId, privateKey));
    expect(ctx).toEqual({ nodeId, orgId });
  });

  it("rejects a missing header", async () => {
    await expect(authenticateNode(undefined)).rejects.toThrow(NodeAuthError);
  });

  it("rejects a signature made with the wrong key", async () => {
    const { privateKey: other } = generateKeyPairSync("ed25519");
    await expect(authenticateNode(header(nodeId, other))).rejects.toThrow(/signature/i);
  });

  it("rejects a timestamp outside the skew window", async () => {
    const stale = Date.now() - 10 * 60_000;
    await expect(authenticateNode(header(nodeId, privateKey, stale))).rejects.toThrow(/timestamp/i);
  });

  it("rejects a replayed nonce", async () => {
    const nonce = randomUUID();
    const h = header(nodeId, privateKey, Date.now(), nonce);
    await authenticateNode(h);
    await expect(authenticateNode(h)).rejects.toThrow(/replay/i);
  });

  it("rejects an unknown node id", async () => {
    await expect(
      authenticateNode(header(randomUUID(), privateKey)),
    ).rejects.toThrow(NodeAuthError);
  });

  it("rejects a malformed header", async () => {
    await expect(authenticateNode("ModelHubNode garbage")).rejects.toThrow(NodeAuthError);
  });
});
```

- [ ] **Step 2: Run to watch it fail**

Run: `pnpm --filter @modelhub/control-plane test src/rpc/node-auth`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/control-plane/src/rpc/node-auth.ts`:
```ts
import { createPublicKey, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import { ownerDb, nodes } from "@modelhub/db";
import { env } from "../env.js";
import { redis } from "../redis.js";

export class NodeAuthError extends Error {
  statusCode = 401;
  code = "node_unauthenticated";
}

const PREFIX = "ModelHubNode ";

// Node's crypto verifies Ed25519 against a KeyObject, so wrap the raw 32 bytes
// in the fixed SPKI prefix for Ed25519 rather than pulling in a dependency.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function toKeyObject(raw: Uint8Array) {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

export async function authenticateNode(
  headerValue: string | undefined,
): Promise<{ nodeId: string; orgId: string }> {
  if (!headerValue || !headerValue.startsWith(PREFIX)) {
    throw new NodeAuthError("missing node authorization header");
  }

  const parts = headerValue.slice(PREFIX.length).split(".");
  if (parts.length !== 4) throw new NodeAuthError("malformed node authorization header");
  const [nodeId, millis, nonce, signature] = parts as [string, string, string, string];

  const at = Number(millis);
  if (!Number.isFinite(at)) throw new NodeAuthError("malformed timestamp");
  if (Math.abs(Date.now() - at) > env.NODE_AUTH_SKEW_MS) {
    throw new NodeAuthError("timestamp outside the accepted window");
  }

  const [row] = await ownerDb
    .select({ id: nodes.id, orgId: nodes.orgId, publicKey: nodes.publicKey })
    .from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!row) throw new NodeAuthError("unknown node");

  const ok = verify(
    null,
    Buffer.from(`${nodeId}.${millis}.${nonce}`),
    toKeyObject(row.publicKey),
    Buffer.from(signature, "base64url"),
  );
  if (!ok) throw new NodeAuthError("invalid signature");

  // One nonce, one use. TTL is twice the skew window, which is exactly how long
  // a nonce could still be inside it.
  const fresh = await redis.set(
    `nodeauth:${nodeId}:${nonce}`, "1", "PX", env.NODE_AUTH_SKEW_MS * 2, "NX",
  );
  if (fresh !== "OK") throw new NodeAuthError("replayed authorization header");

  return { nodeId: row.id, orgId: row.orgId };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @modelhub/control-plane test src/rpc/node-auth`
Expected: all seven PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/rpc/node-auth.ts apps/control-plane/src/rpc/node-auth.test.ts
git commit -m "feat: Ed25519 node authentication with replay protection"
```

---

## Task 10: The Connect stream — inventory, samples, and liveness

**Files:**
- Modify: `apps/control-plane/src/domain/nodes.ts` (add inventory and sample handling), `apps/control-plane/src/rpc/node-service.ts` (add `connect`)
- Create: `apps/control-plane/src/jobs/offline-sweeper.ts`
- Modify: `apps/control-plane/src/app.ts` (start the sweeper)
- Test: `apps/control-plane/src/rpc/connect.test.ts`

**Interfaces:**
- Consumes: `authenticateNode`, `withOrg`, `devices`, `nodes`.
- Produces:
  - `recordInventory(orgId, nodeId, devices): Promise<void>` — upserts devices and deletes ones the node no longer reports.
  - `recordSamples(orgId, nodeId, samples): Promise<void>` — updates each device's latest sample and the node's `lastSeenAt`.
  - `sweepOfflineNodes(now?: Date): Promise<number>` — marks nodes `degraded` after 15s and `offline` after 30s of silence, returning how many changed.
  - A working `NodeService.Connect` bidi stream.

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/rpc/connect.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { eq } from "drizzle-orm";
import { ownerDb, organization, nodes, devices } from "@modelhub/db";
import { NodeService, DeviceKind, MemoryPressure } from "@modelhub/proto";
import { buildApp } from "../app.js";
import { sweepOfflineNodes } from "../jobs/offline-sweeper.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let nodeId: string;
let privateKey: KeyObject;
const orgId = `org_${randomUUID().slice(0, 8)}`;

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

function authHeader(): string {
  const nonce = b64u(Buffer.from(randomUUID()));
  const payload = `${nodeId}.${Date.now()}.${nonce}`;
  return `ModelHubNode ${payload}.${b64u(sign(null, Buffer.from(payload), privateKey))}`;
}

beforeAll(async () => {
  const pair = generateKeyPairSync("ed25519");
  privateKey = pair.privateKey;
  const der = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;

  await ownerDb.insert(organization).values({ id: orgId, name: "Stream", slug: orgId });
  const [row] = await ownerDb.insert(nodes).values({
    orgId, name: "streamer", publicKey: new Uint8Array(der.subarray(der.length - 32)),
  }).returning({ id: nodes.id });
  nodeId = row!.id;

  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => { await app.close(); });

function client() {
  return createClient(
    NodeService,
    createConnectTransport({ baseUrl, httpVersion: "2" }),
  );
}

async function* agentMessages() {
  yield {
    payload: {
      case: "hello" as const,
      value: {
        agentVersion: "0.1.0",
        host: {
          hostname: "test-box", platform: "linux", arch: "amd64",
          osVersion: "6.8", agentVersion: "0.1.0",
          totalMemoryBytes: 68_719_476_736n, cpuCores: 16,
        },
      },
    },
  };
  yield {
    payload: {
      case: "inventory" as const,
      value: {
        devices: [{
          localId: "cuda:0", kind: DeviceKind.CUDA, index: 0,
          name: "NVIDIA GeForce RTX 4090", totalBytes: 25_769_803_776n,
          driverVersion: "560.35", computeCapability: "8.9", wiredLimitBytes: 0n,
        }],
      },
    },
  };
  yield {
    payload: {
      case: "samples" as const,
      value: {
        samples: [{
          localId: "cuda:0", usedBytes: 4_294_967_296n, managedBytes: 0n,
          utilization: 0.42, temperatureC: 61, powerWatts: 120,
          pressure: MemoryPressure.NORMAL, sampledAtUnixMs: BigInt(Date.now()),
        }],
      },
    },
  };
}

describe("NodeService.Connect", () => {
  it("rejects a stream with no node authorization", async () => {
    await expect(async () => {
      for await (const _ of client().connect(agentMessages())) break;
    }).rejects.toThrow();
  });

  it("acknowledges hello, stores inventory, and records samples", async () => {
    const stream = client().connect(agentMessages(), {
      headers: { authorization: authHeader() },
    });

    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value?.payload.case).toBe("helloAck");
    expect(first.value?.payload.value.nodeId).toBe(nodeId);

    // Let the remaining messages drain.
    await new Promise((r) => setTimeout(r, 300));

    const [device] = await ownerDb.select().from(devices).where(eq(devices.nodeId, nodeId));
    expect(device!.localId).toBe("cuda:0");
    expect(device!.kind).toBe("cuda");
    expect(device!.totalBytes).toBe(25_769_803_776n);
    expect(device!.lastUsedBytes).toBe(4_294_967_296n);
    expect(device!.lastUtilization).toBeCloseTo(0.42, 2);

    const [node] = await ownerDb.select().from(nodes).where(eq(nodes.id, nodeId));
    expect(node!.status).toBe("online");
    expect(node!.lastSeenAt).not.toBeNull();
  });

  it("removes devices the node stops reporting", async () => {
    await ownerDb.insert(devices).values({
      orgId, nodeId, localId: "cuda:9", kind: "cuda", name: "ghost", totalBytes: 1n,
    });
    const stream = client().connect(agentMessages(), {
      headers: { authorization: authHeader() },
    });
    for await (const _ of stream) break;
    await new Promise((r) => setTimeout(r, 300));

    const rows = await ownerDb.select().from(devices).where(eq(devices.nodeId, nodeId));
    expect(rows.map((r) => r.localId)).toEqual(["cuda:0"]);
  });

  it("marks a silent node degraded, then offline", async () => {
    await ownerDb.update(nodes)
      .set({ status: "online", lastSeenAt: new Date(Date.now() - 20_000) })
      .where(eq(nodes.id, nodeId));
    await sweepOfflineNodes();
    let [row] = await ownerDb.select().from(nodes).where(eq(nodes.id, nodeId));
    expect(row!.status).toBe("degraded");

    await ownerDb.update(nodes)
      .set({ lastSeenAt: new Date(Date.now() - 40_000) })
      .where(eq(nodes.id, nodeId));
    await sweepOfflineNodes();
    [row] = await ownerDb.select().from(nodes).where(eq(nodes.id, nodeId));
    expect(row!.status).toBe("offline");
  });
});
```

Add `@connectrpc/connect-node` to `apps/control-plane`'s devDependencies.

- [ ] **Step 2: Run to watch it fail**

Run: `pnpm --filter @modelhub/control-plane test src/rpc/connect`
Expected: FAIL — `connect` is unimplemented and the sweeper does not exist.

- [ ] **Step 3: Implement inventory and sample recording**

In `apps/control-plane/src/domain/nodes.ts`, merge these two imports into the
existing import block at the top of the file, then append everything below them:
```ts
import { and, notInArray } from "drizzle-orm";
import { devices } from "@modelhub/db";

const KIND_NAMES: Record<number, string> = { 1: "cpu", 2: "cuda", 3: "metal" };
const PRESSURE_NAMES: Record<number, string> = { 1: "normal", 2: "warn", 3: "critical" };

export interface InventoryDevice {
  localId: string; kind: number; index: number; name: string;
  totalBytes: bigint; wiredLimitBytes: bigint;
  driverVersion: string; computeCapability: string;
}

export async function recordInventory(
  orgId: string, nodeId: string, reported: InventoryDevice[],
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    for (const d of reported) {
      await tx.insert(devices).values({
        orgId, nodeId,
        localId: d.localId,
        kind: KIND_NAMES[d.kind] ?? "cpu",
        index: d.index,
        name: d.name,
        totalBytes: d.totalBytes,
        wiredLimitBytes: d.wiredLimitBytes,
        driverVersion: d.driverVersion,
        computeCapability: d.computeCapability,
      }).onConflictDoUpdate({
        target: [devices.nodeId, devices.localId],
        set: {
          kind: KIND_NAMES[d.kind] ?? "cpu",
          index: d.index,
          name: d.name,
          totalBytes: d.totalBytes,
          wiredLimitBytes: d.wiredLimitBytes,
          driverVersion: d.driverVersion,
          computeCapability: d.computeCapability,
        },
      });
    }

    // A device that vanished — a GPU pulled out, or a driver that stopped
    // enumerating it — must stop being schedulable rather than linger.
    const keep = reported.map((d) => d.localId);
    await tx.delete(devices).where(
      keep.length > 0
        ? and(eq(devices.nodeId, nodeId), notInArray(devices.localId, keep))
        : eq(devices.nodeId, nodeId),
    );
  });
}

export interface SampleInput {
  localId: string; usedBytes: bigint; managedBytes: bigint;
  utilization: number; pressure: number; sampledAtUnixMs: bigint;
}

export async function recordSamples(
  orgId: string, nodeId: string, samples: SampleInput[],
): Promise<void> {
  if (samples.length === 0) return;
  await withOrg(orgId, async (tx) => {
    for (const s of samples) {
      await tx.update(devices).set({
        lastUsedBytes: s.usedBytes,
        lastManagedBytes: s.managedBytes,
        lastUtilization: s.utilization,
        lastPressure: PRESSURE_NAMES[s.pressure] ?? "normal",
        lastSampleAt: new Date(Number(s.sampledAtUnixMs)),
      }).where(and(eq(devices.nodeId, nodeId), eq(devices.localId, s.localId)));
    }
    await tx.update(nodes)
      .set({ lastSeenAt: new Date(), status: "online" })
      .where(eq(nodes.id, nodeId));
  });
}

export async function markNodeOnline(
  orgId: string, nodeId: string, host: EnrollInput["host"],
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.update(nodes).set({
      status: "online",
      lastSeenAt: new Date(),
      agentVersion: host.agentVersion,
      platform: host.platform,
      arch: host.arch,
      osVersion: host.osVersion,
      hostname: host.hostname,
      totalMemoryBytes: host.totalMemoryBytes,
      cpuCores: host.cpuCores,
    }).where(eq(nodes.id, nodeId)),
  );
}
```

- [ ] **Step 4: Implement the stream handler**

Replace `apps/control-plane/src/rpc/node-service.ts`'s `registerNodeService` body so it registers both methods:
```ts
import type { ConnectRouter, HandlerContext } from "@connectrpc/connect";
import { NodeService } from "@modelhub/proto";
import {
  enrollNode, markNodeOnline, recordInventory, recordSamples,
} from "../domain/nodes.js";
import { authenticateNode } from "./node-auth.js";
import { env } from "../env.js";

export function registerNodeService(router: ConnectRouter): void {
  router.service(NodeService, {
    async enroll(req) {
      const result = await enrollNode({
        pairingCode: req.pairingCode,
        publicKey: req.publicKey,
        nodeName: req.nodeName,
        host: {
          hostname: req.host?.hostname ?? "",
          platform: req.host?.platform ?? "",
          arch: req.host?.arch ?? "",
          osVersion: req.host?.osVersion ?? "",
          agentVersion: req.host?.agentVersion ?? "",
          totalMemoryBytes: req.host?.totalMemoryBytes ?? 0n,
          cpuCores: req.host?.cpuCores ?? 0,
        },
      });
      return { nodeId: result.nodeId, orgId: result.orgId, orgName: result.orgName };
    },

    async *connect(requests: AsyncIterable<any>, ctx: HandlerContext) {
      // Authenticate before touching anything the stream sends.
      const { nodeId, orgId } = await authenticateNode(
        ctx.requestHeader.get("authorization") ?? undefined,
      );

      yield {
        payload: {
          case: "helloAck" as const,
          value: { nodeId, sampleIntervalMs: env.SAMPLE_INTERVAL_MS },
        },
      };

      for await (const message of requests) {
        switch (message.payload?.case) {
          case "hello":
            await markNodeOnline(orgId, nodeId, {
              hostname: message.payload.value.host?.hostname ?? "",
              platform: message.payload.value.host?.platform ?? "",
              arch: message.payload.value.host?.arch ?? "",
              osVersion: message.payload.value.host?.osVersion ?? "",
              agentVersion: message.payload.value.agentVersion ?? "",
              totalMemoryBytes: message.payload.value.host?.totalMemoryBytes ?? 0n,
              cpuCores: message.payload.value.host?.cpuCores ?? 0,
            });
            break;
          case "inventory":
            await recordInventory(orgId, nodeId, message.payload.value.devices ?? []);
            break;
          case "samples":
            await recordSamples(orgId, nodeId, message.payload.value.samples ?? []);
            break;
        }
      }
    },
  });
}
```

- [ ] **Step 5: Implement the offline sweeper**

`apps/control-plane/src/jobs/offline-sweeper.ts`:
```ts
import { and, lt, ne, sql } from "drizzle-orm";
import { ownerDb, nodes } from "@modelhub/db";

/** Three missed heartbeats. */
export const DEGRADED_AFTER_MS = 15_000;
/** Six missed heartbeats. */
export const OFFLINE_AFTER_MS = 30_000;

export async function sweepOfflineNodes(now: Date = new Date()): Promise<number> {
  // Runs on the owner connection: this is a fleet-wide job with no single org
  // context, and it only ever changes a status column.
  const offline = await ownerDb.update(nodes)
    .set({ status: "offline" })
    .where(and(
      ne(nodes.status, "offline"),
      lt(nodes.lastSeenAt, new Date(now.getTime() - OFFLINE_AFTER_MS)),
    )).returning({ id: nodes.id });

  const degraded = await ownerDb.update(nodes)
    .set({ status: "degraded" })
    .where(and(
      sql`${nodes.status} = 'online'`,
      lt(nodes.lastSeenAt, new Date(now.getTime() - DEGRADED_AFTER_MS)),
    )).returning({ id: nodes.id });

  return offline.length + degraded.length;
}

export function startOfflineSweeper(intervalMs = 5_000): () => void {
  const timer = setInterval(() => { void sweepOfflineNodes(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
```

In `apps/control-plane/src/main.ts`, after `listen`, add:
```ts
import { startOfflineSweeper } from "./jobs/offline-sweeper.js";

const stopSweeper = startOfflineSweeper();
```
and call `stopSweeper()` inside the shutdown handler before `app.close()`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @modelhub/control-plane test src/rpc/connect`
Expected: all four PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane
git commit -m "feat: agent connect stream with inventory, samples, and liveness"
```

---

## Task 11: Fleet API

**Files:**
- Create: `apps/control-plane/src/domain/views.ts`, `apps/control-plane/src/rpc/fleet-service.ts`
- Modify: `apps/control-plane/src/rpc/index.ts`
- Test: `apps/control-plane/src/rpc/fleet.test.ts`

**Interfaces:**
- Consumes: `computeBudget` from `@modelhub/core`, `requireSession`, `mintPairingCode`.
- Produces: `buildNodeView(row, deviceRows): NodeView` and the three `FleetService` methods. The web app (Tasks 19–20) is the only consumer.

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/rpc/fleet.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ownerDb, organization, nodes, devices } from "@modelhub/db";
import { buildApp } from "../app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let orgId: string;
const GiB = 1024 ** 3;

beforeAll(async () => {
  app = await buildApp();

  const email = `fleet${Date.now()}@example.com`;
  const signUp = await app.inject({
    method: "POST", url: "/api/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery", name: "Fleet Owner" },
  });
  const raw = signUp.headers["set-cookie"];
  cookie = Array.isArray(raw) ? raw.join("; ") : String(raw);

  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
  orgId = me.json().org.id;

  const [node] = await ownerDb.insert(nodes).values({
    orgId, name: "4090-box", status: "online", platform: "linux", arch: "amd64",
    publicKey: new Uint8Array(32).fill(7), lastSeenAt: new Date(),
  }).returning({ id: nodes.id });

  await ownerDb.insert(devices).values({
    orgId, nodeId: node!.id, localId: "cuda:0", kind: "cuda", index: 0,
    name: "NVIDIA GeForce RTX 4090",
    totalBytes: BigInt(24 * GiB),
    lastUsedBytes: BigInt(10 * GiB),
    lastManagedBytes: BigInt(6 * GiB),
    lastUtilization: 0.5, lastPressure: "normal", lastSampleAt: new Date(),
  });
});

afterAll(async () => { await app.close(); });

async function rpc(method: string, body: unknown, withCookie = true) {
  return app.inject({
    method: "POST",
    url: `/modelhub.v1.FleetService/${method}`,
    headers: {
      "content-type": "application/json",
      ...(withCookie ? { cookie } : {}),
    },
    payload: body as Record<string, unknown>,
  });
}

describe("FleetService", () => {
  it("requires a session", async () => {
    const res = await rpc("ListNodes", {}, false);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("returns nodes with budgets already computed", async () => {
    const res = await rpc("ListNodes", {});
    expect(res.statusCode).toBe(200);

    const [node] = res.json().nodes;
    expect(node.name).toBe("4090-box");
    expect(node.status).toBe("online");

    const [device] = node.devices;
    expect(device.name).toBe("NVIDIA GeForce RTX 4090");
    // 24 total − 4 foreign − 6 ours − 8% headroom
    const headroom = Math.floor(24 * GiB * 0.08);
    expect(Number(device.foreignBytes)).toBe(4 * GiB);
    expect(Number(device.headroomBytes)).toBe(headroom);
    expect(Number(device.availableBytes)).toBe(24 * GiB - 4 * GiB - 6 * GiB - headroom);
    expect(device.schedulable).toBe(true);
  });

  it("mints a pairing code for the session's org", async () => {
    const res = await rpc("CreatePairingCode", { nodeName: "mac-studio" });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(Number(res.json().expiresAtUnixMs)).toBeGreaterThan(Date.now());
  });

  it("does not leak another organization's nodes", async () => {
    const otherOrg = `org_${randomUUID().slice(0, 8)}`;
    await ownerDb.insert(organization).values({ id: otherOrg, name: "Other", slug: otherOrg });
    await ownerDb.insert(nodes).values({
      orgId: otherOrg, name: "not-yours", publicKey: new Uint8Array(32).fill(8),
    });

    const res = await rpc("ListNodes", {});
    expect(res.json().nodes.map((n: { name: string }) => n.name)).not.toContain("not-yours");
  });
});
```

- [ ] **Step 2: Run to watch it fail**

Run: `pnpm --filter @modelhub/control-plane test src/rpc/fleet`
Expected: FAIL — the service is not registered.

- [ ] **Step 3: Implement the view assembly**

`apps/control-plane/src/domain/views.ts`:
```ts
import { computeBudget, type DeviceKind, type MemoryPressure } from "@modelhub/core";

const KIND_ENUM: Record<string, number> = { cpu: 1, cuda: 2, metal: 3 };
const PRESSURE_ENUM: Record<string, number> = { normal: 1, warn: 2, critical: 3 };

export interface DeviceRow {
  id: string; localId: string; kind: string; name: string;
  totalBytes: bigint; wiredLimitBytes: bigint; interactive: boolean;
  lastUsedBytes: bigint; lastManagedBytes: bigint;
  lastUtilization: number; lastPressure: string;
}

export interface NodeRow {
  id: string; name: string; status: string;
  hostname: string; platform: string; arch: string;
  osVersion: string; agentVersion: string;
  totalMemoryBytes: bigint; cpuCores: number;
  lastSeenAt: Date | null;
}

export function buildDeviceView(d: DeviceRow) {
  const budget = computeBudget({
    kind: d.kind as DeviceKind,
    totalBytes: Number(d.totalBytes),
    usedBytes: Number(d.lastUsedBytes),
    managedBytes: Number(d.lastManagedBytes),
    wiredLimitBytes: Number(d.wiredLimitBytes),
    pressure: d.lastPressure as MemoryPressure,
    interactive: d.interactive,
  });

  return {
    id: d.id,
    localId: d.localId,
    kind: KIND_ENUM[d.kind] ?? 0,
    name: d.name,
    totalBytes: BigInt(budget.totalBytes),
    managedBytes: BigInt(budget.managedBytes),
    foreignBytes: BigInt(budget.foreignBytes),
    headroomBytes: BigInt(budget.headroomBytes),
    availableBytes: BigInt(budget.availableBytes),
    utilization: d.lastUtilization,
    pressure: PRESSURE_ENUM[d.lastPressure] ?? 1,
    schedulable: budget.schedulable,
  };
}

export function buildNodeView(n: NodeRow, deviceRows: DeviceRow[]) {
  return {
    id: n.id,
    name: n.name,
    status: n.status,
    lastSeenUnixMs: BigInt(n.lastSeenAt?.getTime() ?? 0),
    host: {
      hostname: n.hostname, platform: n.platform, arch: n.arch,
      osVersion: n.osVersion, agentVersion: n.agentVersion,
      totalMemoryBytes: n.totalMemoryBytes, cpuCores: n.cpuCores,
    },
    devices: deviceRows.map(buildDeviceView),
  };
}
```

- [ ] **Step 4: Implement the service**

`apps/control-plane/src/rpc/fleet-service.ts`:
```ts
import type { ConnectRouter, HandlerContext } from "@connectrpc/connect";
import { ConnectError, Code } from "@connectrpc/connect";
import { asc, eq } from "drizzle-orm";
import { withOrg, nodes, devices } from "@modelhub/db";
import { FleetService } from "@modelhub/proto";
import { requireSession } from "../auth/session.js";
import { mintPairingCode } from "../domain/pairing.js";
import { buildNodeView } from "../domain/views.js";

// Connect hands us its own context; requireSession wants something header-shaped.
function asRequest(ctx: HandlerContext) {
  const headers: Record<string, string> = {};
  ctx.requestHeader.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return { headers } as never;
}

async function session(ctx: HandlerContext) {
  try {
    return await requireSession(asRequest(ctx));
  } catch {
    throw new ConnectError("sign in required", Code.Unauthenticated);
  }
}

export function registerFleetService(router: ConnectRouter): void {
  router.service(FleetService, {
    async listNodes(_req, ctx) {
      const { orgId } = await session(ctx);
      return withOrg(orgId, async (tx) => {
        const nodeRows = await tx.select().from(nodes).orderBy(asc(nodes.name));
        const deviceRows = await tx.select().from(devices).orderBy(asc(devices.localId));
        return {
          nodes: nodeRows.map((n) =>
            buildNodeView(n, deviceRows.filter((d) => d.nodeId === n.id)),
          ),
        };
      });
    },

    async getNode(req, ctx) {
      const { orgId } = await session(ctx);
      return withOrg(orgId, async (tx) => {
        const [node] = await tx.select().from(nodes).where(eq(nodes.id, req.nodeId)).limit(1);
        if (!node) throw new ConnectError("node not found", Code.NotFound);
        const deviceRows = await tx.select().from(devices)
          .where(eq(devices.nodeId, node.id)).orderBy(asc(devices.localId));
        return { node: buildNodeView(node, deviceRows) };
      });
    },

    async createPairingCode(req, ctx) {
      const { orgId, userId } = await session(ctx);
      const { code, expiresAt } = await mintPairingCode(orgId, userId, req.nodeName);
      return { code, expiresAtUnixMs: BigInt(expiresAt.getTime()) };
    },
  });
}
```

Update `apps/control-plane/src/rpc/index.ts`:
```ts
import type { ConnectRouter } from "@connectrpc/connect";
import { registerNodeService } from "./node-service.js";
import { registerFleetService } from "./fleet-service.js";

export function routes(router: ConnectRouter): void {
  registerNodeService(router);
  registerFleetService(router);
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @modelhub/control-plane test`
Expected: every control-plane test PASSES, including the four new fleet tests.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane
git commit -m "feat: fleet API serving nodes with computed memory budgets"
```

---

## Task 12: Go agent skeleton — config, identity, CLI

**Files:**
- Create: `agent/go.mod`, `agent/internal/version/version.go`, `agent/internal/config/paths.go`, `agent/internal/config/config.go`, `agent/internal/config/identity.go`, `agent/cmd/agent/main.go`
- Test: `agent/internal/config/config_test.go`, `agent/internal/config/identity_test.go`

**Interfaces:**
- Consumes: Task 2's generated Go code under `agent/gen`.
- Produces:
  - `config.Dir() string`, `config.Load(dir) (*Config, error)`, `(*Config).Save(dir) error` with fields `ServerURL`, `NodeID`, `OrgID`, `NodeName`.
  - `config.Identity` interface with a single method `LoadOrCreate() (ed25519.PrivateKey, error)`; constructors `config.NewFileIdentity(dir)` and `config.NewIdentity(dir)` (keyring, falling back to a 0600 file).
  - `version.Version` string, set by ldflags.
  Tasks 14 and 15 consume all of these.

- [ ] **Step 1: Write the failing tests**

`agent/internal/config/config_test.go`:
```go
package config

import (
	"path/filepath"
	"testing"
)

func TestConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()

	want := &Config{
		ServerURL: "https://hub.example.com",
		NodeID:    "3f9b1e2a-0000-4000-8000-000000000000",
		OrgID:     "org_abc123",
		NodeName:  "mac-studio",
	}
	if err := want.Save(dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if *got != *want {
		t.Fatalf("round trip mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestLoadMissingFileReturnsEmptyConfig(t *testing.T) {
	got, err := Load(filepath.Join(t.TempDir(), "absent"))
	if err != nil {
		t.Fatalf("Load on missing dir should not error, got %v", err)
	}
	if got.NodeID != "" {
		t.Fatalf("expected an empty config, got %+v", got)
	}
}

func TestSaveRefusesWorldReadablePermissions(t *testing.T) {
	dir := t.TempDir()
	c := &Config{ServerURL: "https://hub.example.com"}
	if err := c.Save(dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	mode, err := fileMode(filepath.Join(dir, configFileName))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode.Perm() != 0o600 {
		t.Fatalf("config permissions = %v, want 0600", mode.Perm())
	}
}
```

`agent/internal/config/identity_test.go`:
```go
package config

import (
	"bytes"
	"crypto/ed25519"
	"path/filepath"
	"testing"
)

func TestFileIdentityGeneratesAndPersists(t *testing.T) {
	dir := t.TempDir()
	id := NewFileIdentity(dir)

	key, err := id.LoadOrCreate()
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	if len(key) != ed25519.PrivateKeySize {
		t.Fatalf("key size = %d, want %d", len(key), ed25519.PrivateKeySize)
	}

	again, err := NewFileIdentity(dir).LoadOrCreate()
	if err != nil {
		t.Fatalf("second LoadOrCreate: %v", err)
	}
	if !bytes.Equal(key, again) {
		t.Fatal("LoadOrCreate generated a new key instead of loading the stored one")
	}
}

func TestFileIdentityIsNotReadableByOthers(t *testing.T) {
	dir := t.TempDir()
	if _, err := NewFileIdentity(dir).LoadOrCreate(); err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	mode, err := fileMode(filepath.Join(dir, identityFileName))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode.Perm() != 0o600 {
		t.Fatalf("identity permissions = %v, want 0600", mode.Perm())
	}
}

func TestFileIdentityRejectsCorruptKeyMaterial(t *testing.T) {
	dir := t.TempDir()
	if err := writeFile(filepath.Join(dir, identityFileName), []byte("not-a-key")); err != nil {
		t.Fatalf("writeFile: %v", err)
	}
	if _, err := NewFileIdentity(dir).LoadOrCreate(); err == nil {
		t.Fatal("expected an error for corrupt key material, got nil")
	}
}
```

- [ ] **Step 2: Run to watch them fail**

Run: `cd agent && go test ./internal/config/`
Expected: FAIL — the package does not compile; nothing is defined.

- [ ] **Step 3: Implement the module and config**

`agent/go.mod`:
```
module github.com/modelhub/agent

go 1.23

require (
	connectrpc.com/connect v1.17.0
	github.com/NVIDIA/go-nvml v0.12.4-0
	github.com/kardianos/service v1.2.2
	github.com/shirou/gopsutil/v4 v4.24.9
	github.com/spf13/cobra v1.8.1
	github.com/zalando/go-keyring v0.2.5
	golang.org/x/net v0.30.0
	google.golang.org/protobuf v1.35.1
)
```

`go-nvml` is only compiled under the `nvml` build tag (Task 13) and
`kardianos/service` is only used by Task 19, but both are declared now so
`go mod tidy` is run once rather than three times. Pin whatever versions
`go mod tidy` resolves — the numbers above are a starting point, not gospel.

`agent/internal/version/version.go`:
```go
package version

// Version is overwritten at build time:
//   -ldflags "-X github.com/modelhub/agent/internal/version.Version=1.2.3"
var Version = "0.0.0-dev"
```

`agent/internal/config/paths.go`:
```go
package config

import (
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

const (
	configFileName   = "config.json"
	identityFileName = "identity.key"
)

// Dir returns the directory holding this agent's configuration and identity.
// A system service writes to a machine-wide path; a developer running the
// binary by hand writes under their own config directory.
func Dir() string {
	if custom := os.Getenv("MODELHUB_CONFIG_DIR"); custom != "" {
		return custom
	}
	if os.Geteuid() == 0 {
		switch runtime.GOOS {
		case "windows":
			return filepath.Join(os.Getenv("ProgramData"), "ModelHub")
		default:
			return "/etc/modelhub"
		}
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return ".modelhub"
	}
	return filepath.Join(base, "modelhub")
}

func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	// Write to a temp file then rename, so a crash never leaves a truncated
	// config or a half-written private key behind.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func fileMode(path string) (fs.FileMode, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Mode(), nil
}
```

`agent/internal/config/config.go`:
```go
package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

type Config struct {
	ServerURL string `json:"server_url"`
	NodeID    string `json:"node_id"`
	OrgID     string `json:"org_id"`
	NodeName  string `json:"node_name"`
}

// Enrolled reports whether this agent has an identity the server knows about.
func (c *Config) Enrolled() bool {
	return c.NodeID != "" && c.ServerURL != ""
}

func Load(dir string) (*Config, error) {
	data, err := os.ReadFile(filepath.Join(dir, configFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return &Config{}, nil
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) Save(dir string) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writeFile(filepath.Join(dir, configFileName), data)
}
```

`agent/internal/config/identity.go`:
```go
package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/zalando/go-keyring"
)

const keyringService = "com.modelhub.agent"

type Identity interface {
	// LoadOrCreate returns the stored private key, generating and persisting
	// one on first use.
	LoadOrCreate() (ed25519.PrivateKey, error)
}

type fileIdentity struct{ dir string }

func NewFileIdentity(dir string) Identity { return &fileIdentity{dir: dir} }

func (f *fileIdentity) LoadOrCreate() (ed25519.PrivateKey, error) {
	path := filepath.Join(f.dir, identityFileName)
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		return decodeKey(strings.TrimSpace(string(data)))
	case errors.Is(err, fs.ErrNotExist):
		_, priv, genErr := ed25519.GenerateKey(rand.Reader)
		if genErr != nil {
			return nil, genErr
		}
		encoded := base64.StdEncoding.EncodeToString(priv)
		if writeErr := writeFile(path, []byte(encoded)); writeErr != nil {
			return nil, writeErr
		}
		return priv, nil
	default:
		return nil, err
	}
}

type keyringIdentity struct {
	account  string
	fallback Identity
}

// NewIdentity prefers the OS keychain and falls back to a 0600 file when no
// keychain is available — a headless Linux box, or a locked login keyring.
func NewIdentity(dir string) Identity {
	return &keyringIdentity{account: "node-key", fallback: NewFileIdentity(dir)}
}

func (k *keyringIdentity) LoadOrCreate() (ed25519.PrivateKey, error) {
	stored, err := keyring.Get(keyringService, k.account)
	if err == nil {
		return decodeKey(stored)
	}
	if !errors.Is(err, keyring.ErrNotFound) {
		return k.fallback.LoadOrCreate()
	}

	_, priv, genErr := ed25519.GenerateKey(rand.Reader)
	if genErr != nil {
		return nil, genErr
	}
	if setErr := keyring.Set(keyringService, k.account, base64.StdEncoding.EncodeToString(priv)); setErr != nil {
		return k.fallback.LoadOrCreate()
	}
	return priv, nil
}

func decodeKey(encoded string) (ed25519.PrivateKey, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("stored identity is not valid base64: %w", err)
	}
	if len(raw) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("stored identity is %d bytes, want %d", len(raw), ed25519.PrivateKeySize)
	}
	return ed25519.PrivateKey(raw), nil
}
```

- [ ] **Step 4: Add the CLI entrypoint**

`agent/cmd/agent/main.go`:
```go
package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/modelhub/agent/internal/config"
	"github.com/modelhub/agent/internal/version"
)

func main() {
	root := &cobra.Command{
		Use:     "modelhub-agent",
		Short:   "Model Hub node agent",
		Version: version.Version,
	}

	root.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show this node's enrollment status",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load(config.Dir())
			if err != nil {
				return err
			}
			if !cfg.Enrolled() {
				fmt.Fprintln(cmd.OutOrStdout(), "not enrolled — run: modelhub-agent enroll --code XXXX-XXXX --server <url>")
				return nil
			}
			fmt.Fprintf(cmd.OutOrStdout(), "node %s (%s) enrolled to org %s at %s\n",
				cfg.NodeName, cfg.NodeID, cfg.OrgID, cfg.ServerURL)
			return nil
		},
	})

	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
```

- [ ] **Step 5: Run the tests**

Run:
```bash
cd agent && go mod tidy && go test ./internal/config/ -v && go build ./... && cd ..
```
Expected: all six tests PASS and the binary builds.

- [ ] **Step 6: Commit**

```bash
git add agent
git commit -m "feat(agent): config, Ed25519 identity storage, and CLI skeleton"
```

---

## Task 13: Device probes

**Files:**
- Create: `agent/internal/inventory/inventory.go`, `agent/internal/inventory/probe_cpu.go`, `agent/internal/inventory/probe_fake.go`, `agent/internal/inventory/probe_darwin.go`, `agent/internal/inventory/probe_nvml.go`, `agent/internal/inventory/probe_nvml_stub.go`, `agent/internal/inventory/host.go`
- Test: `agent/internal/inventory/conformance_test.go`, `agent/internal/inventory/probe_fake_test.go`

**Interfaces:**
- Consumes: `gopsutil`.
- Produces:
  - Types `Kind`, `Pressure`, `Device`, `Sample`, `HostInfo`.
  - `Probe` interface: `Name() string`, `Discover(context.Context) ([]Device, error)`, `Sample(context.Context, Device) (Sample, error)`.
  - `Collect(ctx, probes) (*Inventory, error)`, where `Inventory` has a
    `Devices []Device` field and a `SampleAll(ctx) ([]Sample, error)` method.
  - `DefaultProbes() []Probe` and `Host(ctx) (HostInfo, error)`.
  Task 15 consumes `DefaultProbes`, `Collect`, `Inventory.SampleAll`, and `Host`.

**Scope note — deliberate deviation from spec §4.1.** Slice 1 reads Apple
unified memory through `sysctl` and `gopsutil` only; the Metal cgo shim for
`recommendedMaxWorkingSetSize` and `currentAllocatedSize` lands in slice 2, when
`managedBytes` first becomes non-zero and the distinction starts to matter.
Until then, system-wide used memory is the honest number on a Mac.

- [ ] **Step 1: Write the failing conformance test**

`agent/internal/inventory/conformance_test.go`:
```go
package inventory

import (
	"context"
	"errors"
	"testing"
)

// Every probe must satisfy these, including the real hardware ones. Run this
// suite against whatever probes are compiled into the current build.
func TestProbeConformance(t *testing.T) {
	probes := append([]Probe{NewFakeProbe(2)}, DefaultProbes()...)

	for _, p := range probes {
		t.Run(p.Name(), func(t *testing.T) {
			ctx := context.Background()

			devices, err := p.Discover(ctx)
			if err != nil {
				t.Fatalf("Discover: %v", err)
			}

			seen := map[string]bool{}
			for _, d := range devices {
				if d.LocalID == "" {
					t.Error("device has an empty LocalID")
				}
				if seen[d.LocalID] {
					t.Errorf("duplicate LocalID %q within one probe", d.LocalID)
				}
				seen[d.LocalID] = true

				if d.TotalBytes == 0 {
					t.Errorf("%s reports zero total bytes", d.LocalID)
				}
				if d.Kind != KindCPU && d.Kind != KindCUDA && d.Kind != KindMetal {
					t.Errorf("%s has unknown kind %q", d.LocalID, d.Kind)
				}

				s, err := p.Sample(ctx, d)
				if err != nil {
					t.Fatalf("Sample(%s): %v", d.LocalID, err)
				}
				if s.LocalID != d.LocalID {
					t.Errorf("sample LocalID = %q, want %q", s.LocalID, d.LocalID)
				}
				if s.UsedBytes > d.TotalBytes {
					t.Errorf("%s used %d > total %d", d.LocalID, s.UsedBytes, d.TotalBytes)
				}
				if s.Utilization < 0 || s.Utilization > 1 {
					t.Errorf("%s utilization %v outside [0,1]", d.LocalID, s.Utilization)
				}
				if s.SampledAt.IsZero() {
					t.Errorf("%s sample has no timestamp", d.LocalID)
				}
			}
		})
	}
}

func TestCollectKeepsLocalIDsUniqueAcrossProbes(t *testing.T) {
	inv, err := Collect(context.Background(), []Probe{NewFakeProbe(2), NewFakeProbe(2)})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(inv.Devices) != 4 {
		t.Fatalf("expected 4 devices from two probes, got %d", len(inv.Devices))
	}
	seen := map[string]bool{}
	for _, d := range inv.Devices {
		if seen[d.LocalID] {
			t.Fatalf("Collect produced a duplicate LocalID %q across probes", d.LocalID)
		}
		seen[d.LocalID] = true
	}
}

func TestSampleAllReturnsOneSamplePerDevice(t *testing.T) {
	inv, err := Collect(context.Background(), []Probe{NewFakeProbe(3)})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	samples, err := inv.SampleAll(context.Background())
	if err != nil {
		t.Fatalf("SampleAll: %v", err)
	}
	if len(samples) != 3 {
		t.Fatalf("expected 3 samples, got %d", len(samples))
	}
}

func TestSampleAllSkipsAFailingProbeWithoutLosingTheRest(t *testing.T) {
	good := NewFakeProbe(1)
	bad := NewFakeProbe(1)
	bad.SampleErr = errors.New("gpu fell off the bus")

	inv, err := Collect(context.Background(), []Probe{good, bad})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	samples, err := inv.SampleAll(context.Background())
	if err != nil {
		t.Fatalf("SampleAll should tolerate a failing probe, got %v", err)
	}
	if len(samples) != 1 {
		t.Fatalf("expected the healthy device to still report, got %d samples", len(samples))
	}
}

func TestHostReportsUsableFacts(t *testing.T) {
	h, err := Host(context.Background())
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	if h.Hostname == "" {
		t.Error("hostname is empty")
	}
	if h.TotalMemoryBytes == 0 {
		t.Error("total memory is zero")
	}
	if h.CPUCores == 0 {
		t.Error("cpu cores is zero")
	}
	if h.Platform == "" || h.Arch == "" {
		t.Error("platform or arch is empty")
	}
}
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd agent && go test ./internal/inventory/`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: Implement the core types and the fake probe**

`agent/internal/inventory/inventory.go`:
```go
package inventory

import (
	"context"
	"fmt"
	"time"
)

type Kind string

const (
	KindCPU   Kind = "cpu"
	KindCUDA  Kind = "cuda"
	KindMetal Kind = "metal"
)

type Pressure string

const (
	PressureNormal   Pressure = "normal"
	PressureWarn     Pressure = "warn"
	PressureCritical Pressure = "critical"
)

// Device holds facts that do not change while the machine is running.
type Device struct {
	LocalID           string
	Kind              Kind
	Index             int
	Name              string
	TotalBytes        uint64
	WiredLimitBytes   uint64 // macOS only
	DriverVersion     string
	ComputeCapability string
}

// Sample holds facts that change constantly.
type Sample struct {
	LocalID      string
	UsedBytes    uint64 // ours plus everyone else's
	ManagedBytes uint64 // ours; always 0 until slice 2 loads a model
	Utilization  float64
	TemperatureC float64
	PowerWatts   float64
	Pressure     Pressure
	SampledAt    time.Time
}

type HostInfo struct {
	Hostname         string
	Platform         string
	Arch             string
	OSVersion        string
	TotalMemoryBytes uint64
	CPUCores         int
}

// Probe discovers and samples one class of device. Implementations know
// nothing about the network; that separation is what makes the whole connect
// loop testable without hardware.
type Probe interface {
	Name() string
	Discover(ctx context.Context) ([]Device, error)
	Sample(ctx context.Context, d Device) (Sample, error)
}

// Inventory is the result of one discovery pass: the devices found, plus which
// probe owns each one. Discovery happens once per connection; sampling then
// runs every few seconds against this map rather than re-enumerating hardware.
type Inventory struct {
	Devices []Device
	owner   map[string]Probe
}

func Collect(ctx context.Context, probes []Probe) (*Inventory, error) {
	inv := &Inventory{owner: map[string]Probe{}}
	for _, p := range probes {
		devices, err := p.Discover(ctx)
		if err != nil {
			return nil, fmt.Errorf("probe %s: %w", p.Name(), err)
		}
		for _, d := range devices {
			if _, dup := inv.owner[d.LocalID]; dup {
				return nil, fmt.Errorf("probe %s produced duplicate device id %q", p.Name(), d.LocalID)
			}
			inv.owner[d.LocalID] = p
			inv.Devices = append(inv.Devices, d)
		}
	}
	return inv, nil
}

// SampleAll samples every device, tolerating a probe that fails: one GPU that
// has fallen off the bus must not stop the node reporting the others.
func (i *Inventory) SampleAll(ctx context.Context) ([]Sample, error) {
	samples := make([]Sample, 0, len(i.Devices))
	for _, d := range i.Devices {
		p, ok := i.owner[d.LocalID]
		if !ok {
			continue
		}
		s, err := p.Sample(ctx, d)
		if err != nil {
			continue
		}
		samples = append(samples, s)
	}
	return samples, nil
}
```

`agent/internal/inventory/probe_fake.go`:
```go
package inventory

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"
)

var fakeProbeSeq atomic.Int64

// FakeProbe stands in for hardware in tests and in `--fake-probe` mode, which
// is how the end-to-end test runs a real agent in CI with no GPU present.
type FakeProbe struct {
	id        int64
	count     int
	Used      uint64
	Press     Pressure
	DevKind   Kind
	SampleErr error // set in tests to simulate a probe that has stopped working
}

func NewFakeProbe(count int) *FakeProbe {
	return &FakeProbe{
		id:      fakeProbeSeq.Add(1),
		count:   count,
		Used:    2 << 30,
		Press:   PressureNormal,
		DevKind: KindCUDA,
	}
}

func (f *FakeProbe) Name() string { return fmt.Sprintf("fake-%d", f.id) }

func (f *FakeProbe) Discover(context.Context) ([]Device, error) {
	devices := make([]Device, 0, f.count)
	for i := 0; i < f.count; i++ {
		devices = append(devices, Device{
			LocalID:    fmt.Sprintf("%s:%d", f.Name(), i),
			Kind:       f.DevKind,
			Index:      i,
			Name:       "Fake Accelerator",
			TotalBytes: 24 << 30,
		})
	}
	return devices, nil
}

func (f *FakeProbe) Sample(_ context.Context, d Device) (Sample, error) {
	if f.SampleErr != nil {
		return Sample{}, f.SampleErr
	}
	return Sample{
		LocalID:     d.LocalID,
		UsedBytes:   f.Used,
		Utilization: 0.25,
		Pressure:    f.Press,
		SampledAt:   time.Now(),
	}, nil
}
```

- [ ] **Step 4: Implement the CPU probe and host facts**

`agent/internal/inventory/probe_cpu.go`:
```go
package inventory

import (
	"context"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
)

type cpuProbe struct{}

func NewCPUProbe() Probe { return &cpuProbe{} }

func (c *cpuProbe) Name() string { return "cpu" }

func (c *cpuProbe) Discover(context.Context) ([]Device, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return nil, err
	}
	name := runtime.GOARCH + " CPU"
	if infos, err := cpu.Info(); err == nil && len(infos) > 0 && infos[0].ModelName != "" {
		name = infos[0].ModelName
	}
	return []Device{{
		LocalID:    "cpu:0",
		Kind:       KindCPU,
		Index:      0,
		Name:       name,
		TotalBytes: vm.Total,
	}}, nil
}

func (c *cpuProbe) Sample(_ context.Context, d Device) (Sample, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return Sample{}, err
	}
	util := 0.0
	if pct, err := cpu.Percent(0, false); err == nil && len(pct) > 0 {
		util = pct[0] / 100
	}
	return Sample{
		LocalID:     d.LocalID,
		UsedBytes:   vm.Total - vm.Available,
		Utilization: clamp01(util),
		Pressure:    PressureNormal,
		SampledAt:   time.Now(),
	}, nil
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
```

`agent/internal/inventory/host.go`:
```go
package inventory

import (
	"context"
	"os"
	"runtime"

	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
)

func Host(ctx context.Context) (HostInfo, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return HostInfo{}, err
	}

	hostname, _ := os.Hostname()
	osVersion := ""
	if info, err := host.InfoWithContext(ctx); err == nil {
		if hostname == "" {
			hostname = info.Hostname
		}
		osVersion = info.PlatformVersion
	}

	return HostInfo{
		Hostname:         hostname,
		Platform:         runtime.GOOS,
		Arch:             runtime.GOARCH,
		OSVersion:        osVersion,
		TotalMemoryBytes: vm.Total,
		CPUCores:         runtime.NumCPU(),
	}, nil
}
```

- [ ] **Step 5: Implement the platform probes and the probe registry**

`agent/internal/inventory/probe_darwin.go` (build tag restricts it to macOS):
```go
//go:build darwin

package inventory

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/mem"
)

// metalProbe reports Apple unified memory. Slice 1 reads sysctl only; the Metal
// cgo shim for recommendedMaxWorkingSetSize arrives in slice 2, when our own
// allocations first need to be distinguished from everyone else's.
type metalProbe struct{}

func newPlatformProbes() []Probe { return []Probe{&metalProbe{}} }

func (m *metalProbe) Name() string { return "metal" }

func (m *metalProbe) Discover(context.Context) ([]Device, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(sysctlString("machdep.cpu.brand_string"))
	if name == "" {
		name = "Apple Silicon GPU"
	}
	return []Device{{
		LocalID:         "metal:0",
		Kind:            KindMetal,
		Index:           0,
		Name:            name,
		TotalBytes:      vm.Total,
		WiredLimitBytes: wiredLimitBytes(),
	}}, nil
}

func (m *metalProbe) Sample(_ context.Context, d Device) (Sample, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return Sample{}, err
	}
	return Sample{
		LocalID:   d.LocalID,
		UsedBytes: vm.Total - vm.Available,
		Pressure:  memoryPressure(),
		SampledAt: time.Now(),
	}, nil
}

func sysctlString(key string) string {
	out, err := exec.Command("sysctl", "-n", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// iogpu.wired_limit_mb is 0 or absent unless an administrator has set it.
func wiredLimitBytes() uint64 {
	mb, err := strconv.ParseUint(sysctlString("iogpu.wired_limit_mb"), 10, 64)
	if err != nil || mb == 0 {
		return 0
	}
	return mb * 1024 * 1024
}

// kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical.
func memoryPressure() Pressure {
	switch sysctlString("kern.memorystatus_vm_pressure_level") {
	case "2":
		return PressureWarn
	case "4":
		return PressureCritical
	default:
		return PressureNormal
	}
}
```

`agent/internal/inventory/probe_nvml.go` (compiled only with `-tags nvml`, because it needs the NVIDIA driver libraries present at build time):
```go
//go:build nvml

package inventory

import (
	"context"
	"fmt"
	"time"

	"github.com/NVIDIA/go-nvml/pkg/nvml"
)

type nvmlProbe struct{ driverVersion string }

func newCUDAProbes() []Probe {
	if ret := nvml.Init(); ret != nvml.SUCCESS {
		// No driver on this machine: not an error, just no CUDA devices.
		return nil
	}
	version, _ := nvml.SystemGetDriverVersion()
	return []Probe{&nvmlProbe{driverVersion: version}}
}

func (n *nvmlProbe) Name() string { return "cuda" }

func (n *nvmlProbe) Discover(context.Context) ([]Device, error) {
	count, ret := nvml.DeviceGetCount()
	if ret != nvml.SUCCESS {
		return nil, fmt.Errorf("nvml device count: %v", nvml.ErrorString(ret))
	}

	devices := make([]Device, 0, count)
	for i := 0; i < count; i++ {
		handle, ret := nvml.DeviceGetHandleByIndex(i)
		if ret != nvml.SUCCESS {
			continue
		}
		name, _ := handle.GetName()
		memory, ret := handle.GetMemoryInfo()
		if ret != nvml.SUCCESS {
			continue
		}
		major, minor, _ := handle.GetCudaComputeCapability()

		devices = append(devices, Device{
			LocalID:           fmt.Sprintf("cuda:%d", i),
			Kind:              KindCUDA,
			Index:             i,
			Name:              name,
			TotalBytes:        memory.Total,
			DriverVersion:     n.driverVersion,
			ComputeCapability: fmt.Sprintf("%d.%d", major, minor),
		})
	}
	return devices, nil
}

func (n *nvmlProbe) Sample(_ context.Context, d Device) (Sample, error) {
	handle, ret := nvml.DeviceGetHandleByIndex(d.Index)
	if ret != nvml.SUCCESS {
		return Sample{}, fmt.Errorf("nvml handle %d: %v", d.Index, nvml.ErrorString(ret))
	}
	memory, ret := handle.GetMemoryInfo()
	if ret != nvml.SUCCESS {
		return Sample{}, fmt.Errorf("nvml memory %d: %v", d.Index, nvml.ErrorString(ret))
	}

	util := 0.0
	if u, ret := handle.GetUtilizationRates(); ret == nvml.SUCCESS {
		util = float64(u.Gpu) / 100
	}
	temp := 0.0
	if t, ret := handle.GetTemperature(nvml.TEMPERATURE_GPU); ret == nvml.SUCCESS {
		temp = float64(t)
	}
	power := 0.0
	if p, ret := handle.GetPowerUsage(); ret == nvml.SUCCESS {
		power = float64(p) / 1000
	}

	return Sample{
		LocalID:      d.LocalID,
		UsedBytes:    memory.Used,
		Utilization:  clamp01(util),
		TemperatureC: temp,
		PowerWatts:   power,
		Pressure:     PressureNormal,
		SampledAt:    time.Now(),
	}, nil
}
```

`agent/internal/inventory/probe_nvml_stub.go`:
```go
//go:build !nvml

package inventory

// Builds without the nvml tag have no CUDA support. The stub keeps
// DefaultProbes identical across platforms.
func newCUDAProbes() []Probe { return nil }
```

Add a non-darwin counterpart so `newPlatformProbes` always exists —
`agent/internal/inventory/probe_other.go`:
```go
//go:build !darwin

package inventory

func newPlatformProbes() []Probe { return nil }
```

Append to `agent/internal/inventory/inventory.go`:
```go
// DefaultProbes returns every probe available in this build, on this machine.
// The CPU probe is always present: a node with no accelerator is still a node.
func DefaultProbes() []Probe {
	probes := []Probe{NewCPUProbe()}
	probes = append(probes, newPlatformProbes()...)
	probes = append(probes, newCUDAProbes()...)
	return probes
}
```

- [ ] **Step 6: Run the tests**

Run:
```bash
cd agent && go test ./internal/inventory/ -v && cd ..
```
Expected: PASS. On a Mac, the `metal` subtest runs against real sysctl output; on Linux without the `nvml` tag, only `cpu` and `fake` run.

On the 4090 box, also verify the real CUDA path:
```bash
cd agent && go test -tags nvml ./internal/inventory/ -v -run TestProbeConformance
```
Expected: a `cuda` subtest appears and passes, reporting your actual VRAM.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/inventory
git commit -m "feat(agent): device probes for cpu, apple unified memory, and nvml"
```

---

## Task 14: Agent enrollment command

**Files:**
- Create: `agent/internal/transport/client.go`, `agent/internal/transport/enroll.go`
- Modify: `agent/cmd/agent/main.go` (add the `enroll` command)
- Test: `agent/internal/transport/enroll_test.go`

**Interfaces:**
- Consumes: `config.Config`, `config.Identity`, `inventory.Host`, generated `modelhubv1connect.NodeServiceClient`.
- Produces:
  - `transport.NewNodeClient(serverURL string) modelhubv1connect.NodeServiceClient`
  - `transport.Enroll(ctx, serverURL, code, nodeName string, priv ed25519.PrivateKey, host inventory.HostInfo) (*EnrollResult, error)` where `EnrollResult` has `NodeID`, `OrgID`, `OrgName`.
  Task 15 uses `NewNodeClient`.

- [ ] **Step 1: Write the failing test**

`agent/internal/transport/enroll_test.go`:
```go
package transport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"

	modelhubv1 "github.com/modelhub/agent/gen/modelhub/v1"
	"github.com/modelhub/agent/gen/modelhub/v1/modelhubv1connect"
	"github.com/modelhub/agent/internal/inventory"
)

type stubNodeService struct {
	modelhubv1connect.UnimplementedNodeServiceHandler
	lastRequest *modelhubv1.EnrollRequest
	err         error
}

func (s *stubNodeService) Enroll(
	_ context.Context, req *connect.Request[modelhubv1.EnrollRequest],
) (*connect.Response[modelhubv1.EnrollResponse], error) {
	if s.err != nil {
		return nil, s.err
	}
	s.lastRequest = req.Msg
	return connect.NewResponse(&modelhubv1.EnrollResponse{
		NodeId:  "node-123",
		OrgId:   "org_abc",
		OrgName: "Test Fleet",
	}), nil
}

func newStubServer(t *testing.T, stub *stubNodeService) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(modelhubv1connect.NewNodeServiceHandler(stub))
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server.URL
}

func TestEnrollSendsKeyAndHostFacts(t *testing.T) {
	stub := &stubNodeService{}
	url := newStubServer(t, stub)

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	host := inventory.HostInfo{
		Hostname: "mac-studio", Platform: "darwin", Arch: "arm64",
		OSVersion: "15.0", TotalMemoryBytes: 137438953472, CPUCores: 24,
	}

	result, err := Enroll(context.Background(), url, "ABCD-EFGH", "mac-studio", priv, host)
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	if result.NodeID != "node-123" || result.OrgID != "org_abc" {
		t.Fatalf("unexpected result %+v", result)
	}

	got := stub.lastRequest
	if got.PairingCode != "ABCD-EFGH" {
		t.Errorf("pairing code = %q", got.PairingCode)
	}
	if len(got.PublicKey) != ed25519.PublicKeySize {
		t.Fatalf("public key is %d bytes, want %d", len(got.PublicKey), ed25519.PublicKeySize)
	}
	if string(got.PublicKey) != string(pub) {
		t.Error("the enrolled public key does not match the generated private key")
	}
	if got.Host.GetHostname() != "mac-studio" || got.Host.GetCpuCores() != 24 {
		t.Errorf("host facts not forwarded: %+v", got.Host)
	}
}

func TestEnrollSurfacesServerRejection(t *testing.T) {
	stub := &stubNodeService{err: connect.NewError(connect.CodeInvalidArgument, nil)}
	url := newStubServer(t, stub)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)

	if _, err := Enroll(context.Background(), url, "BAD-CODE", "n", priv, inventory.HostInfo{}); err == nil {
		t.Fatal("expected an error when the server rejects the code, got nil")
	}
}
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd agent && go test ./internal/transport/`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Implement the client and enrollment**

`agent/internal/transport/client.go`:
```go
package transport

import (
	"net/http"
	"time"

	"golang.org/x/net/http2"

	"github.com/modelhub/agent/gen/modelhub/v1/modelhubv1connect"
)

// httpClient is shared by every RPC. There is no overall timeout on purpose:
// the Connect stream is expected to stay open for hours, and liveness is
// handled by HTTP/2 pings instead.
//
// AllowHTTP plus a custom dialer lets the same client speak h2c to a local
// http:// control plane and real TLS to a deployed https:// one.
func httpClient() *http.Client {
	return &http.Client{
		Transport: &http2.Transport{
			AllowHTTP: true,
			DialTLSContext: func(
				ctx context.Context, network, addr string, cfg *tls.Config,
			) (net.Conn, error) {
				if cfg == nil {
					var d net.Dialer
					return d.DialContext(ctx, network, addr)
				}
				return tls.Dial(network, addr, cfg)
			},
			ReadIdleTimeout: 30 * time.Second,
			PingTimeout:     15 * time.Second,
		},
	}
}

func NewNodeClient(serverURL string) modelhubv1connect.NodeServiceClient {
	return modelhubv1connect.NewNodeServiceClient(httpClient(), serverURL)
}
```
Imports: `context`, `crypto/tls`, `net`, `net/http`, `time`,
`golang.org/x/net/http2`, and the generated `modelhubv1connect` package.

`agent/internal/transport/enroll.go`:
```go
package transport

import (
	"context"
	"crypto/ed25519"
	"fmt"

	"connectrpc.com/connect"

	modelhubv1 "github.com/modelhub/agent/gen/modelhub/v1"
	"github.com/modelhub/agent/internal/inventory"
	"github.com/modelhub/agent/internal/version"
)

type EnrollResult struct {
	NodeID  string
	OrgID   string
	OrgName string
}

func hostProto(h inventory.HostInfo) *modelhubv1.HostInfo {
	return &modelhubv1.HostInfo{
		Hostname:         h.Hostname,
		Platform:         h.Platform,
		Arch:             h.Arch,
		OsVersion:        h.OSVersion,
		AgentVersion:     version.Version,
		TotalMemoryBytes: h.TotalMemoryBytes,
		CpuCores:         uint32(h.CPUCores),
	}
}

func Enroll(
	ctx context.Context,
	serverURL, pairingCode, nodeName string,
	priv ed25519.PrivateKey,
	host inventory.HostInfo,
) (*EnrollResult, error) {
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("identity is not an Ed25519 key")
	}

	res, err := NewNodeClient(serverURL).Enroll(ctx, connect.NewRequest(&modelhubv1.EnrollRequest{
		PairingCode: pairingCode,
		PublicKey:   pub,
		NodeName:    nodeName,
		Host:        hostProto(host),
	}))
	if err != nil {
		return nil, fmt.Errorf("enroll rejected: %w", err)
	}

	return &EnrollResult{
		NodeID:  res.Msg.GetNodeId(),
		OrgID:   res.Msg.GetOrgId(),
		OrgName: res.Msg.GetOrgName(),
	}, nil
}
```

- [ ] **Step 4: Wire up the CLI command**

Add to `agent/cmd/agent/main.go`, inside `main()` before `root.Execute()`:
```go
	var (
		enrollCode   string
		enrollServer string
		enrollName   string
	)
	enrollCmd := &cobra.Command{
		Use:   "enroll",
		Short: "Join this machine to a Model Hub organization",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			dir := config.Dir()

			priv, err := config.NewIdentity(dir).LoadOrCreate()
			if err != nil {
				return fmt.Errorf("could not load this node's identity: %w", err)
			}

			host, err := inventory.Host(ctx)
			if err != nil {
				return fmt.Errorf("could not read host facts: %w", err)
			}
			name := enrollName
			if name == "" {
				name = host.Hostname
			}

			result, err := transport.Enroll(ctx, enrollServer, enrollCode, name, priv, host)
			if err != nil {
				return err
			}

			cfg := &config.Config{
				ServerURL: enrollServer,
				NodeID:    result.NodeID,
				OrgID:     result.OrgID,
				NodeName:  name,
			}
			if err := cfg.Save(dir); err != nil {
				return fmt.Errorf("enrolled, but could not save the config: %w", err)
			}

			fmt.Fprintf(cmd.OutOrStdout(), "enrolled %q into %s\n", name, result.OrgName)
			return nil
		},
	}
	enrollCmd.Flags().StringVar(&enrollCode, "code", "", "pairing code from the web app (required)")
	enrollCmd.Flags().StringVar(&enrollServer, "server", "https://app.modelhub.local", "control plane URL")
	enrollCmd.Flags().StringVar(&enrollName, "name", "", "name for this node (defaults to the hostname)")
	_ = enrollCmd.MarkFlagRequired("code")
	root.AddCommand(enrollCmd)
```
Add the imports `fmt`, `github.com/modelhub/agent/internal/inventory`, and
`github.com/modelhub/agent/internal/transport`. Also switch `root.Execute()` to
`root.ExecuteContext(context.Background())` so `cmd.Context()` is non-nil.

- [ ] **Step 5: Run the tests**

Run: `cd agent && go test ./internal/transport/ -v && go build ./... && cd ..`
Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add agent
git commit -m "feat(agent): enroll command"
```

---

## Task 15: Agent connect loop

**Files:**
- Create: `agent/internal/transport/auth.go`, `agent/internal/transport/session.go`
- Modify: `agent/cmd/agent/main.go` (add the `run` command)
- Test: `agent/internal/transport/auth_test.go`, `agent/internal/transport/session_test.go`

**Interfaces:**
- Consumes: everything from Tasks 12–14.
- Produces:
  - `transport.AuthHeader(nodeID string, priv ed25519.PrivateKey, now time.Time) string` — must produce exactly what Task 9's `authenticateNode` accepts.
  - `transport.Session` with `Run(ctx) error`, which connects, reports inventory, samples on the server-provided interval, and reconnects with jittered backoff until the context is cancelled.

- [ ] **Step 1: Write the failing tests**

`agent/internal/transport/auth_test.go`:
```go
package transport

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAuthHeaderMatchesTheServerFormat(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.UnixMilli(1_700_000_000_000)

	header := AuthHeader("node-abc", priv, now)

	if !strings.HasPrefix(header, "ModelHubNode ") {
		t.Fatalf("header does not carry the scheme: %q", header)
	}
	parts := strings.Split(strings.TrimPrefix(header, "ModelHubNode "), ".")
	if len(parts) != 4 {
		t.Fatalf("expected 4 dot-separated parts, got %d", len(parts))
	}

	if parts[0] != "node-abc" {
		t.Errorf("node id = %q", parts[0])
	}
	if ms, err := strconv.ParseInt(parts[1], 10, 64); err != nil || ms != now.UnixMilli() {
		t.Errorf("timestamp = %q, want %d", parts[1], now.UnixMilli())
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		t.Fatalf("signature is not base64url: %v", err)
	}
	payload := strings.Join(parts[:3], ".")
	if !ed25519.Verify(pub, []byte(payload), signature) {
		t.Fatal("signature does not verify against the signed payload")
	}
}

func TestAuthHeaderUsesAFreshNonceEveryTime(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now()

	first := AuthHeader("node-abc", priv, now)
	second := AuthHeader("node-abc", priv, now)

	if first == second {
		t.Fatal("two headers with the same timestamp were identical; the nonce is not fresh")
	}
}
```

`agent/internal/transport/session_test.go`:
```go
package transport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	modelhubv1 "github.com/modelhub/agent/gen/modelhub/v1"
	"github.com/modelhub/agent/gen/modelhub/v1/modelhubv1connect"
	"github.com/modelhub/agent/internal/inventory"
)

type recordingNodeService struct {
	modelhubv1connect.UnimplementedNodeServiceHandler

	mu          sync.Mutex
	connects    int
	hellos      int
	inventories int
	samples     int
	authHeaders []string
	dropAfter   int // close the stream after this many connections, to test reconnect
}

func (r *recordingNodeService) snapshot() (connects, hellos, inventories, samples int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.connects, r.hellos, r.inventories, r.samples
}

func (r *recordingNodeService) Connect(
	ctx context.Context,
	stream *connect.BidiStream[modelhubv1.AgentMessage, modelhubv1.ServerMessage],
) error {
	r.mu.Lock()
	r.connects++
	current := r.connects
	r.authHeaders = append(r.authHeaders, stream.RequestHeader().Get("Authorization"))
	r.mu.Unlock()

	if err := stream.Send(&modelhubv1.ServerMessage{
		Payload: &modelhubv1.ServerMessage_HelloAck{
			HelloAck: &modelhubv1.HelloAck{NodeId: "node-abc", SampleIntervalMs: 50},
		},
	}); err != nil {
		return err
	}

	for {
		msg, err := stream.Receive()
		if err != nil {
			return nil
		}
		r.mu.Lock()
		switch msg.GetPayload().(type) {
		case *modelhubv1.AgentMessage_Hello:
			r.hellos++
		case *modelhubv1.AgentMessage_Inventory:
			r.inventories++
		case *modelhubv1.AgentMessage_Samples:
			r.samples++
		}
		shouldDrop := r.dropAfter > 0 && current <= r.dropAfter && r.samples >= current
		r.mu.Unlock()

		if shouldDrop {
			return nil // hang up; the agent must reconnect
		}
	}
}

func newSession(t *testing.T, svc *recordingNodeService) (*Session, func()) {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(modelhubv1connect.NewNodeServiceHandler(svc))
	server := httptest.NewServer(mux)

	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	s := &Session{
		ServerURL:  server.URL,
		NodeID:     "node-abc",
		PrivateKey: priv,
		Probes:     []inventory.Probe{inventory.NewFakeProbe(2)},
		MinBackoff: 10 * time.Millisecond,
		MaxBackoff: 50 * time.Millisecond,
	}
	return s, server.Close
}

func TestSessionReportsInventoryThenSamples(t *testing.T) {
	svc := &recordingNodeService{}
	session, closeServer := newSession(t, svc)
	defer closeServer()

	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	_ = session.Run(ctx)

	connects, hellos, inventories, samples := svc.snapshot()
	if connects == 0 {
		t.Fatal("agent never connected")
	}
	if hellos == 0 {
		t.Error("agent never sent hello")
	}
	if inventories == 0 {
		t.Error("agent never reported inventory")
	}
	if samples < 2 {
		t.Errorf("expected repeated samples on the 50ms interval, got %d", samples)
	}

	svc.mu.Lock()
	header := svc.authHeaders[0]
	svc.mu.Unlock()
	if header == "" {
		t.Error("agent connected without an authorization header")
	}
}

func TestSessionReconnectsAfterTheServerHangsUp(t *testing.T) {
	svc := &recordingNodeService{dropAfter: 2}
	session, closeServer := newSession(t, svc)
	defer closeServer()

	ctx, cancel := context.WithTimeout(context.Background(), 900*time.Millisecond)
	defer cancel()
	_ = session.Run(ctx)

	connects, _, _, _ := svc.snapshot()
	if connects < 2 {
		t.Fatalf("expected the agent to reconnect, saw %d connections", connects)
	}
}

func TestSessionStopsWhenTheContextIsCancelled(t *testing.T) {
	svc := &recordingNodeService{}
	session, closeServer := newSession(t, svc)
	defer closeServer()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- session.Run(ctx) }()

	time.Sleep(150 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return within 2s of cancellation")
	}
}
```

- [ ] **Step 2: Run to watch them fail**

Run: `cd agent && go test ./internal/transport/`
Expected: FAIL — `AuthHeader` and `Session` are undefined.

- [ ] **Step 3: Implement the auth header**

`agent/internal/transport/auth.go`:
```go
package transport

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"
)

// AuthHeader builds the value the control plane's authenticateNode expects:
//
//	ModelHubNode <nodeID>.<unixMillis>.<nonce>.<signature>
//
// where the signature covers the first three fields joined by dots. Keep this
// byte-for-byte in step with apps/control-plane/src/rpc/node-auth.ts.
func AuthHeader(nodeID string, priv ed25519.PrivateKey, now time.Time) string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	nonce := base64.RawURLEncoding.EncodeToString(raw)

	payload := fmt.Sprintf("%s.%d.%s", nodeID, now.UnixMilli(), nonce)
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, []byte(payload)))

	return "ModelHubNode " + payload + "." + signature
}
```

Note for Task 9's TypeScript side: it decodes the signature with `base64url`,
which Node accepts with or without padding, so the Go `RawURLEncoding` output
verifies correctly.

- [ ] **Step 4: Implement the session loop**

`agent/internal/transport/session.go`:
```go
package transport

import (
	"context"
	"crypto/ed25519"
	"errors"
	"log/slog"
	"math/rand"
	"time"

	modelhubv1 "github.com/modelhub/agent/gen/modelhub/v1"
	"github.com/modelhub/agent/internal/inventory"
	"github.com/modelhub/agent/internal/version"
)

type Session struct {
	ServerURL  string
	NodeID     string
	PrivateKey ed25519.PrivateKey
	Probes     []inventory.Probe
	Logger     *slog.Logger

	MinBackoff time.Duration
	MaxBackoff time.Duration
}

func (s *Session) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// Run connects and keeps reconnecting until ctx is cancelled. It only returns
// an error for conditions that will never resolve on their own.
func (s *Session) Run(ctx context.Context) error {
	backoff := s.MinBackoff
	if backoff <= 0 {
		backoff = time.Second
	}
	maxBackoff := s.MaxBackoff
	if maxBackoff <= 0 {
		maxBackoff = 30 * time.Second
	}

	for {
		if ctx.Err() != nil {
			return nil
		}

		err := s.connectOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			s.logger().Warn("connection ended", "error", err, "retry_in", backoff)
		} else {
			s.logger().Info("connection closed by server", "retry_in", backoff)
		}

		// Full jitter: without it, a fleet that loses the control plane all
		// reconnects in lockstep the moment it returns.
		wait := time.Duration(rand.Int63n(int64(backoff) + 1))
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}

		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func (s *Session) connectOnce(ctx context.Context) error {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	stream := NewNodeClient(s.ServerURL).Connect(streamCtx)
	stream.RequestHeader().Set("Authorization", AuthHeader(s.NodeID, s.PrivateKey, time.Now()))

	host, err := inventory.Host(streamCtx)
	if err != nil {
		return err
	}
	if err := stream.Send(&modelhubv1.AgentMessage{
		Payload: &modelhubv1.AgentMessage_Hello{
			Hello: &modelhubv1.Hello{AgentVersion: version.Version, Host: hostProto(host)},
		},
	}); err != nil {
		return err
	}

	// The first server message tells us how often to sample.
	first, err := stream.Receive()
	if err != nil {
		return err
	}
	interval := 5 * time.Second
	if ack := first.GetHelloAck(); ack != nil && ack.GetSampleIntervalMs() > 0 {
		interval = time.Duration(ack.GetSampleIntervalMs()) * time.Millisecond
	}

	inv, err := inventory.Collect(streamCtx, s.Probes)
	if err != nil {
		return err
	}
	if err := stream.Send(&modelhubv1.AgentMessage{
		Payload: &modelhubv1.AgentMessage_Inventory{
			Inventory: &modelhubv1.InventoryReport{Devices: devicesProto(inv.Devices)},
		},
	}); err != nil {
		return err
	}

	// Drain server messages so a mid-stream config update is applied and a
	// server hang-up cancels the sampler promptly.
	go func() {
		for {
			msg, err := stream.Receive()
			if err != nil {
				cancel()
				return
			}
			if cfg := msg.GetConfig(); cfg != nil && cfg.GetSampleIntervalMs() > 0 {
				s.logger().Info("server changed the sample interval", "ms", cfg.GetSampleIntervalMs())
			}
		}
	}()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-streamCtx.Done():
			return stream.CloseRequest()
		case <-ticker.C:
			samples, err := inv.SampleAll(streamCtx)
			if err != nil {
				return err
			}
			if len(samples) == 0 {
				continue
			}
			if err := stream.Send(&modelhubv1.AgentMessage{
				Payload: &modelhubv1.AgentMessage_Samples{
					Samples: &modelhubv1.SampleBatch{Samples: samplesProto(samples)},
				},
			}); err != nil {
				if errors.Is(err, context.Canceled) {
					return nil
				}
				return err
			}
		}
	}
}

func devicesProto(devices []inventory.Device) []*modelhubv1.Device {
	out := make([]*modelhubv1.Device, 0, len(devices))
	for _, d := range devices {
		out = append(out, &modelhubv1.Device{
			LocalId:           d.LocalID,
			Kind:              kindProto(d.Kind),
			Index:             uint32(d.Index),
			Name:              d.Name,
			TotalBytes:        d.TotalBytes,
			WiredLimitBytes:   d.WiredLimitBytes,
			DriverVersion:     d.DriverVersion,
			ComputeCapability: d.ComputeCapability,
		})
	}
	return out
}

func samplesProto(samples []inventory.Sample) []*modelhubv1.DeviceSample {
	out := make([]*modelhubv1.DeviceSample, 0, len(samples))
	for _, s := range samples {
		out = append(out, &modelhubv1.DeviceSample{
			LocalId:         s.LocalID,
			UsedBytes:       s.UsedBytes,
			ManagedBytes:    s.ManagedBytes,
			Utilization:     s.Utilization,
			TemperatureC:    s.TemperatureC,
			PowerWatts:      s.PowerWatts,
			Pressure:        pressureProto(s.Pressure),
			SampledAtUnixMs: s.SampledAt.UnixMilli(),
		})
	}
	return out
}

func kindProto(k inventory.Kind) modelhubv1.DeviceKind {
	switch k {
	case inventory.KindCUDA:
		return modelhubv1.DeviceKind_DEVICE_KIND_CUDA
	case inventory.KindMetal:
		return modelhubv1.DeviceKind_DEVICE_KIND_METAL
	case inventory.KindCPU:
		return modelhubv1.DeviceKind_DEVICE_KIND_CPU
	default:
		return modelhubv1.DeviceKind_DEVICE_KIND_UNSPECIFIED
	}
}

func pressureProto(p inventory.Pressure) modelhubv1.MemoryPressure {
	switch p {
	case inventory.PressureWarn:
		return modelhubv1.MemoryPressure_MEMORY_PRESSURE_WARN
	case inventory.PressureCritical:
		return modelhubv1.MemoryPressure_MEMORY_PRESSURE_CRITICAL
	default:
		return modelhubv1.MemoryPressure_MEMORY_PRESSURE_NORMAL
	}
}
```

- [ ] **Step 5: Add the `run` command**

Add to `agent/cmd/agent/main.go`:
```go
	var fakeProbe bool
	runCmd := &cobra.Command{
		Use:   "run",
		Short: "Run the agent in the foreground",
		RunE: func(cmd *cobra.Command, _ []string) error {
			dir := config.Dir()
			cfg, err := config.Load(dir)
			if err != nil {
				return err
			}
			if !cfg.Enrolled() {
				return fmt.Errorf("this node is not enrolled; run: modelhub-agent enroll --code XXXX-XXXX --server <url>")
			}

			priv, err := config.NewIdentity(dir).LoadOrCreate()
			if err != nil {
				return err
			}

			probes := inventory.DefaultProbes()
			if fakeProbe {
				// Used by CI, which has no GPU and no Mac.
				probes = []inventory.Probe{inventory.NewFakeProbe(2)}
			}

			session := &transport.Session{
				ServerURL:  cfg.ServerURL,
				NodeID:     cfg.NodeID,
				PrivateKey: priv,
				Probes:     probes,
			}
			return session.Run(cmd.Context())
		},
	}
	runCmd.Flags().BoolVar(&fakeProbe, "fake-probe", false, "report synthetic devices instead of real hardware")
	root.AddCommand(runCmd)
```

Make `main()` cancel the context on SIGINT/SIGTERM:
```go
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := root.ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
```
with imports `context`, `os/signal`, and `syscall`.

- [ ] **Step 6: Run the tests**

Run: `cd agent && go test ./... -v && cd ..`
Expected: every Go test PASSES, including the three session tests.

- [ ] **Step 7: Commit**

```bash
git add agent
git commit -m "feat(agent): authenticated connect loop with reconnect and sampling"
```

---

## Task 16: Web app shell and authentication

**Files:**
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/api.ts`, `apps/web/src/auth.ts`, `apps/web/src/router.tsx`, `apps/web/src/routes/sign-in.tsx`, `apps/web/src/routes/sign-up.tsx`, `apps/web/src/routes/root.tsx`, `apps/web/src/index.css`, `apps/web/tailwind.config.ts`
- Test: `apps/web/src/routes/sign-in.test.tsx`

**Interfaces:**
- Consumes: `@modelhub/proto`, the control plane's `/api/auth/*` and Connect endpoints.
- Produces: `fleetClient` (a typed Connect client), `authClient` (Better Auth's React client), `useSession()`, and a router where `/` requires a session and redirects to `/sign-in` otherwise. Task 17 mounts the Fleet page into this router.

- [ ] **Step 1: Scaffold the app**

`apps/web/package.json`:
```json
{
  "name": "@modelhub/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@connectrpc/connect": "^2.0.0",
    "@connectrpc/connect-web": "^2.0.0",
    "@modelhub/proto": "workspace:*",
    "@tanstack/react-query": "^5.59.0",
    "@tanstack/react-router": "^1.78.0",
    "better-auth": "^1.1.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "jsdom": "^25.0.1",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.0",
    "vite": "^5.4.10"
  }
}
```

`apps/web/vite.config.ts`:
```ts
// vitest's defineConfig, not vite's — vite's does not accept the `test` key.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in dev so the session cookie works without CORS.
    proxy: {
      "/api": "http://localhost:3000",
      "/modelhub.v1.FleetService": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
```

`apps/web/src/test-setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Model Hub</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the failing test**

`apps/web/src/routes/sign-in.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignInForm } from "./sign-in.js";

const signIn = vi.fn();

beforeEach(() => { signIn.mockReset(); });

describe("SignInForm", () => {
  it("submits the email and password", async () => {
    signIn.mockResolvedValue({ error: null });
    render(<SignInForm onSignIn={signIn} />);

    await userEvent.type(screen.getByLabelText(/email/i), "me@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter22hunter22");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(signIn).toHaveBeenCalledWith("me@example.com", "hunter22hunter22");
  });

  it("shows the server's message when sign-in fails", async () => {
    signIn.mockResolvedValue({ error: { message: "Invalid email or password" } });
    render(<SignInForm onSignIn={signIn} />);

    await userEvent.type(screen.getByLabelText(/email/i), "me@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
  });

  it("disables the button while the request is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    signIn.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<SignInForm onSignIn={signIn} />);

    await userEvent.type(screen.getByLabelText(/email/i), "me@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter22hunter22");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
    resolve({ error: null });
  });
});
```

- [ ] **Step 3: Run to watch it fail**

Run: `pnpm --filter @modelhub/web test`
Expected: FAIL — `./sign-in.js` does not exist.

- [ ] **Step 4: Implement the clients and the sign-in form**

`apps/web/src/api.ts`:
```ts
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { FleetService } from "@modelhub/proto";

// Same-origin: the session cookie rides along, and there is no CORS to manage.
const transport = createConnectTransport({
  baseUrl: window.location.origin,
  credentials: "include",
});

export const fleetClient = createClient(FleetService, transport);
```

`apps/web/src/auth.ts`:
```ts
import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  plugins: [organizationClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
```

`apps/web/src/routes/sign-in.tsx`:
```tsx
import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { signIn } from "../auth.js";

export interface SignInResult {
  error: { message?: string } | null;
}

export function SignInForm({
  onSignIn,
}: {
  onSignIn: (email: string, password: string) => Promise<SignInResult>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await onSignIn(email, password);
    setBusy(false);
    if (result.error) setError(result.error.message ?? "Could not sign in");
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-24 w-full max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Sign in to Model Hub</h1>

      <div className="space-y-1">
        <label htmlFor="email" className="block text-sm">Email</label>
        <input
          id="email" type="email" value={email} required
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded border px-3 py-2"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className="block text-sm">Password</label>
        <input
          id="password" type="password" value={password} required
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded border px-3 py-2"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">{error}</p>
      )}

      <button
        type="submit" disabled={busy}
        className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function SignInRoute() {
  const navigate = useNavigate();
  return (
    <SignInForm
      onSignIn={async (email, password) => {
        const result = await signIn.email({ email, password });
        if (!result.error) await navigate({ to: "/" });
        return { error: result.error ?? null };
      }}
    />
  );
}
```

`apps/web/src/routes/sign-up.tsx` — the same shape, calling `signUp.email({ email, password, name })` and navigating to `/` on success. Copy `SignInForm` and change the heading to "Create your Model Hub account", add a `name` field, and rename the exports to `SignUpForm` / `SignUpRoute`.

`apps/web/src/routes/root.tsx`:
```tsx
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useSession, signOut } from "../auth.js";

export function RootLayout() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isPending && !session) void navigate({ to: "/sign-in" });
  }, [isPending, session, navigate]);

  if (isPending) return <p className="p-8 text-sm text-slate-500">Loading…</p>;
  if (!session) return null;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <nav className="flex gap-4 text-sm">
          <Link to="/" className="font-semibold">Fleet</Link>
        </nav>
        <button onClick={() => void signOut()} className="text-sm text-slate-600">
          Sign out
        </button>
      </header>
      <main className="p-6"><Outlet /></main>
    </div>
  );
}
```

`apps/web/src/router.tsx`:
```tsx
import {
  createRootRoute, createRoute, createRouter, Outlet,
} from "@tanstack/react-router";
import { RootLayout } from "./routes/root.js";
import { SignInRoute } from "./routes/sign-in.js";
import { SignUpRoute } from "./routes/sign-up.js";
import { FleetRoute } from "./routes/fleet.js";

const rootRoute = createRootRoute({ component: Outlet });

const signInRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/sign-in", component: SignInRoute,
});
const signUpRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/sign-up", component: SignUpRoute,
});
const appRoute = createRoute({
  getParentRoute: () => rootRoute, id: "app", component: RootLayout,
});
const fleetRoute = createRoute({
  getParentRoute: () => appRoute, path: "/", component: FleetRoute,
});

const routeTree = rootRoute.addChildren([
  signInRoute, signUpRoute, appRoute.addChildren([fleetRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
```

`apps/web/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router.js";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2_000, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

`apps/web/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`apps/web/tailwind.config.ts`:
```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @modelhub/web test`
Expected: the three sign-in tests PASS. (`FleetRoute` is imported by the router
but does not exist yet — create `apps/web/src/routes/fleet.tsx` exporting
`export function FleetRoute() { return null; }` as a one-line stand-in that
Task 17 replaces.)

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): app shell with sign-in and sign-up"
```

---

## Task 17: Fleet page

**Files:**
- Create: `apps/web/src/components/DeviceMemoryBar.tsx`, `apps/web/src/components/NodeCard.tsx`, `apps/web/src/components/AddNodeDialog.tsx`, `apps/web/src/format.ts`
- Modify: `apps/web/src/routes/fleet.tsx` (replace the stand-in)
- Test: `apps/web/src/components/DeviceMemoryBar.test.tsx`, `apps/web/src/components/NodeCard.test.tsx`, `apps/web/src/format.test.ts`

**Interfaces:**
- Consumes: `fleetClient.listNodes()`, `fleetClient.createPairingCode()`, and the `NodeView` / `DeviceView` types.
- Produces: the Fleet page at `/`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatBytes, formatRelativeTime } from "./format.js";

describe("formatBytes", () => {
  it("uses binary units with one decimal place", () => {
    expect(formatBytes(0n)).toBe("0 B");
    expect(formatBytes(1024n)).toBe("1.0 KiB");
    expect(formatBytes(BigInt(24 * 1024 ** 3))).toBe("24.0 GiB");
    expect(formatBytes(BigInt(1.5 * 1024 ** 3))).toBe("1.5 GiB");
  });
});

describe("formatRelativeTime", () => {
  it("describes recent timestamps in seconds", () => {
    const now = Date.now();
    expect(formatRelativeTime(BigInt(now - 3_000), now)).toBe("3s ago");
  });

  it("describes older timestamps in minutes", () => {
    const now = Date.now();
    expect(formatRelativeTime(BigInt(now - 120_000), now)).toBe("2m ago");
  });

  it("handles a node that has never reported", () => {
    expect(formatRelativeTime(0n, Date.now())).toBe("never");
  });
});
```

`apps/web/src/components/DeviceMemoryBar.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeviceMemoryBar } from "./DeviceMemoryBar.js";

const GiB = 1024 ** 3;

const device = {
  id: "d1", localId: "cuda:0", kind: 2, name: "NVIDIA GeForce RTX 4090",
  totalBytes: BigInt(24 * GiB),
  managedBytes: BigInt(6 * GiB),
  foreignBytes: BigInt(4 * GiB),
  headroomBytes: BigInt(2 * GiB),
  availableBytes: BigInt(12 * GiB),
  utilization: 0.5, pressure: 1, schedulable: true,
};

describe("DeviceMemoryBar", () => {
  it("shows managed, foreign, and available as distinct, labeled segments", () => {
    render(<DeviceMemoryBar device={device} />);

    expect(screen.getByTestId("segment-managed")).toHaveAttribute("data-bytes", String(6 * GiB));
    expect(screen.getByTestId("segment-foreign")).toHaveAttribute("data-bytes", String(4 * GiB));
    expect(screen.getByTestId("segment-available")).toHaveAttribute("data-bytes", String(12 * GiB));
  });

  it("states the available capacity in words", () => {
    render(<DeviceMemoryBar device={device} />);
    expect(screen.getByText(/12\.0 GiB available/)).toBeInTheDocument();
  });

  it("explains why a device is not schedulable", () => {
    render(<DeviceMemoryBar device={{ ...device, schedulable: false, pressure: 2 }} />);
    expect(screen.getByText(/under memory pressure/i)).toBeInTheDocument();
  });

  it("does not divide by zero on a device reporting no memory", () => {
    render(<DeviceMemoryBar device={{ ...device, totalBytes: 0n, availableBytes: 0n }} />);
    expect(screen.getByTestId("segment-available")).toHaveStyle({ width: "0%" });
  });
});
```

`apps/web/src/components/NodeCard.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NodeCard } from "./NodeCard.js";

const node = {
  id: "n1", name: "4090-box", status: "online",
  lastSeenUnixMs: BigInt(Date.now() - 2_000),
  host: {
    hostname: "tower", platform: "linux", arch: "amd64",
    osVersion: "6.8", agentVersion: "0.1.0",
    totalMemoryBytes: BigInt(64 * 1024 ** 3), cpuCores: 16,
  },
  devices: [],
};

describe("NodeCard", () => {
  it("shows the node name, platform, and status", () => {
    render(<NodeCard node={node} />);
    expect(screen.getByText("4090-box")).toBeInTheDocument();
    expect(screen.getByText(/linux/)).toBeInTheDocument();
    expect(screen.getByText("online")).toBeInTheDocument();
  });

  it("marks an offline node and says when it was last seen", () => {
    render(<NodeCard node={{ ...node, status: "offline", lastSeenUnixMs: BigInt(Date.now() - 300_000) }} />);
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(screen.getByText(/5m ago/)).toBeInTheDocument();
  });

  it("says so plainly when a node reports no devices", () => {
    render(<NodeCard node={node} />);
    expect(screen.getByText(/no devices reported/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to watch them fail**

Run: `pnpm --filter @modelhub/web test`
Expected: FAIL — the three modules do not exist.

- [ ] **Step 3: Implement formatting**

`apps/web/src/format.ts`:
```ts
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export function formatBytes(bytes: bigint): string {
  let value = Number(bytes);
  if (value < 1024) return `${value} B`;

  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

export function formatRelativeTime(unixMs: bigint, now: number = Date.now()): string {
  if (unixMs === 0n) return "never";
  const seconds = Math.max(0, Math.round((now - Number(unixMs)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
```

- [ ] **Step 4: Implement the memory bar**

`apps/web/src/components/DeviceMemoryBar.tsx`:
```tsx
import { formatBytes } from "../format.js";

export interface DeviceViewLike {
  id: string;
  localId: string;
  kind: number;
  name: string;
  totalBytes: bigint;
  managedBytes: bigint;
  foreignBytes: bigint;
  headroomBytes: bigint;
  availableBytes: bigint;
  utilization: number;
  pressure: number;
  schedulable: boolean;
}

function percent(part: bigint, whole: bigint): string {
  if (whole === 0n) return "0%";
  return `${(Number(part) / Number(whole)) * 100}%`;
}

// The three segments are deliberately distinct. "Memory someone else is using"
// and "memory we are using" are different facts, and a user who sees them
// separated understands their machine in a way a single bar never conveys.
const SEGMENTS = [
  { key: "managed", label: "Model Hub", className: "bg-sky-500" },
  { key: "foreign", label: "Other processes", className: "bg-amber-500" },
  { key: "headroom", label: "Reserved headroom", className: "bg-slate-300" },
  { key: "available", label: "Available", className: "bg-emerald-500" },
] as const;

export function DeviceMemoryBar({ device }: { device: DeviceViewLike }) {
  const values: Record<string, bigint> = {
    managed: device.managedBytes,
    foreign: device.foreignBytes,
    headroom: device.headroomBytes,
    available: device.availableBytes,
  };

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{device.name}</span>
        <span className="text-slate-500">{device.localId}</span>
      </div>

      <div className="flex h-3 w-full overflow-hidden rounded bg-slate-200">
        {SEGMENTS.map((segment) => (
          <div
            key={segment.key}
            data-testid={`segment-${segment.key}`}
            data-bytes={String(values[segment.key])}
            title={`${segment.label}: ${formatBytes(values[segment.key]!)}`}
            className={segment.className}
            style={{ width: percent(values[segment.key]!, device.totalBytes) }}
          />
        ))}
      </div>

      <p className="text-xs text-slate-600">
        {formatBytes(device.availableBytes)} available of {formatBytes(device.totalBytes)}
        {device.foreignBytes > 0n && ` · ${formatBytes(device.foreignBytes)} used by other processes`}
      </p>

      {!device.schedulable && (
        <p className="text-xs text-amber-700">
          {device.pressure >= 2
            ? "Not accepting work — the machine is under memory pressure"
            : "Not accepting work"}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Implement the node card and the Fleet page**

`apps/web/src/components/NodeCard.tsx`:
```tsx
import { DeviceMemoryBar, type DeviceViewLike } from "./DeviceMemoryBar.js";
import { formatRelativeTime } from "../format.js";

export interface NodeViewLike {
  id: string;
  name: string;
  status: string;
  lastSeenUnixMs: bigint;
  host: {
    hostname: string; platform: string; arch: string;
    osVersion: string; agentVersion: string;
    totalMemoryBytes: bigint; cpuCores: number;
  };
  devices: DeviceViewLike[];
}

const STATUS_STYLES: Record<string, string> = {
  online: "bg-emerald-100 text-emerald-800",
  degraded: "bg-amber-100 text-amber-800",
  offline: "bg-slate-200 text-slate-600",
};

export function NodeCard({ node }: { node: NodeViewLike }) {
  return (
    <section className="rounded-lg border bg-white p-4 shadow-sm">
      <header className="mb-3 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">{node.name}</h2>
          <p className="text-xs text-slate-500">
            {node.host.platform}/{node.host.arch} · {node.host.cpuCores} cores · agent {node.host.agentVersion || "—"}
          </p>
        </div>
        <div className="text-right">
          <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[node.status] ?? STATUS_STYLES.offline}`}>
            {node.status}
          </span>
          <p className="mt-1 text-xs text-slate-500">
            seen {formatRelativeTime(node.lastSeenUnixMs)}
          </p>
        </div>
      </header>

      {node.devices.length === 0 ? (
        <p className="text-sm text-slate-500">No devices reported yet.</p>
      ) : (
        <div className="space-y-3">
          {node.devices.map((device) => (
            <DeviceMemoryBar key={device.id} device={device} />
          ))}
        </div>
      )}
    </section>
  );
}
```

`apps/web/src/components/AddNodeDialog.tsx`:
```tsx
import { useState } from "react";
import { fleetClient } from "../api.js";

export function AddNodeDialog() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function mint() {
    setBusy(true);
    try {
      const res = await fleetClient.createPairingCode({ nodeName: name });
      setCode(res.code);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded bg-slate-900 px-3 py-2 text-sm text-white">
        Add a machine
      </button>
    );
  }

  return (
    <div className="rounded-lg border bg-white p-4">
      <h3 className="font-semibold">Add a machine</h3>

      {code === null ? (
        <div className="mt-3 space-y-3">
          <input
            aria-label="Machine name" value={name} placeholder="mac-studio"
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border px-3 py-2 text-sm"
          />
          <button
            onClick={() => void mint()} disabled={busy}
            className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate pairing code"}
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-3 text-sm">
          <p>Install the agent on that machine, then run:</p>
          <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
{`modelhub-agent enroll \\
  --code ${code} \\
  --server ${window.location.origin}`}
          </pre>
          <p className="text-xs text-slate-500">
            This code works once and expires in 15 minutes.
          </p>
        </div>
      )}

      <button onClick={() => { setOpen(false); setCode(null); }} className="mt-3 text-sm text-slate-600">
        Close
      </button>
    </div>
  );
}
```

`apps/web/src/routes/fleet.tsx` (replacing the stand-in):
```tsx
import { useQuery } from "@tanstack/react-query";
import { fleetClient } from "../api.js";
import { NodeCard } from "../components/NodeCard.js";
import { AddNodeDialog } from "../components/AddNodeDialog.js";

export function FleetRoute() {
  const { data, isPending, error } = useQuery({
    queryKey: ["fleet", "nodes"],
    queryFn: () => fleetClient.listNodes({}),
    // Samples arrive every 5s; polling at 3s keeps the page visibly live
    // without hammering the control plane. Replaced by a stream in slice 8.
    refetchInterval: 3_000,
  });

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Fleet</h1>
        <AddNodeDialog />
      </div>

      {isPending && <p className="text-sm text-slate-500">Loading your machines…</p>}
      {error && <p role="alert" className="text-sm text-red-600">{String(error)}</p>}

      {data?.nodes.length === 0 && (
        <p className="rounded border border-dashed p-8 text-center text-sm text-slate-500">
          No machines yet. Add one to see its GPUs and memory here.
        </p>
      )}

      {data?.nodes.map((node) => <NodeCard key={node.id} node={node} />)}
    </div>
  );
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @modelhub/web test`
Expected: all ten web tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): fleet page with per-device memory breakdown"
```

---

## Task 18: End-to-end smoke test and CI

This is the task that proves the slice. It runs a real control plane, a real
agent binary, and a real database, with no hardware required.

**Files:**
- Create: `e2e/package.json`, `e2e/smoke.test.ts`, `.github/workflows/ci.yml`
- Modify: root `package.json` (add `test:e2e`)

**Interfaces:**
- Consumes: everything.
- Produces: `pnpm test:e2e`, and a CI pipeline that runs unit, integration, Go, and end-to-end suites.

- [ ] **Step 1: Write the failing end-to-end test**

`e2e/smoke.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "../apps/control-plane/src/app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let agent: ChildProcess | undefined;
let baseUrl: string;
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

beforeAll(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const email = `e2e${Date.now()}@example.com`;
  const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "E2E" }),
  });
  cookie = signUp.headers.getSetCookie().join("; ");

  agentDir = mkdtempSync(join(tmpdir(), "modelhub-e2e-"));
  execFileSync("go", ["build", "-o", join(agentDir, "modelhub-agent"), "./cmd/agent"], {
    cwd: "agent", stdio: "inherit",
  });
}, 120_000);

afterAll(async () => {
  agent?.kill("SIGTERM");
  await app.close();
  rmSync(agentDir, { recursive: true, force: true });
});

describe("slice 1 end to end", () => {
  it("enrolls an agent and shows it on the fleet with live memory numbers", async () => {
    const { code } = await rpc("CreatePairingCode", { nodeName: "e2e-box" });
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const env = { ...process.env, MODELHUB_CONFIG_DIR: agentDir };
    const binary = join(agentDir, "modelhub-agent");

    execFileSync(binary, ["enroll", "--code", code, "--server", baseUrl, "--name", "e2e-box"], { env });

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
    expect(node.status).toBe("online");
    expect(node.devices.length).toBeGreaterThan(0);

    const device = node.devices[0]!;
    expect(Number(device.totalBytes)).toBeGreaterThan(0);
    expect(Number(device.availableBytes)).toBeGreaterThan(0);
    expect(Number(device.availableBytes)).toBeLessThan(Number(device.totalBytes));
    expect(device.schedulable).toBe(true);
  }, 120_000);

  it("marks the node offline after the agent stops", async () => {
    agent?.kill("SIGTERM");
    agent = undefined;

    const { sweepOfflineNodes } = await import("../apps/control-plane/src/jobs/offline-sweeper.js");
    await sleep(31_000);
    await sweepOfflineNodes();

    const nodes = await rpc("ListNodes", {});
    expect(nodes.nodes[0].status).toBe("offline");
  }, 60_000);
});
```

`e2e/package.json`:
```json
{
  "name": "@modelhub/e2e",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run" },
  "devDependencies": {
    "@modelhub/control-plane": "workspace:*",
    "vitest": "^2.1.0"
  }
}
```

Add `"e2e"` to `pnpm-workspace.yaml`'s packages list, and to the root
`package.json` scripts:
```json
"test:e2e": "pnpm --filter @modelhub/e2e test"
```

- [ ] **Step 2: Run it**

Run:
```bash
docker compose up -d
set -a && source .env && set +a
pnpm --filter @modelhub/db migrate
pnpm test:e2e
```
Expected: both tests PASS. If the first fails on a timeout, check the agent's
stdout — it is inherited, so enrollment and connection errors appear inline.

- [ ] **Step 3: Add CI**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push: { branches: [main] }
  pull_request:

jobs:
  typescript:
    runs-on: ubuntu-latest
    services:
      db:
        image: timescale/timescaledb:latest-pg16
        env:
          POSTGRES_USER: modelhub_owner
          POSTGRES_PASSWORD: devpassword
          POSTGRES_DB: modelhub
        ports: ["5433:5432"]
        options: >-
          --health-cmd "pg_isready -U modelhub_owner -d modelhub"
          --health-interval 2s --health-timeout 3s --health-retries 20
      redis:
        image: redis:7-alpine
        ports: ["6380:6379"]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 2s --health-timeout 3s --health-retries 20
    env:
      DATABASE_URL: postgres://modelhub_app:devpassword@localhost:5433/modelhub
      DATABASE_OWNER_URL: postgres://modelhub_owner:devpassword@localhost:5433/modelhub
      REDIS_URL: redis://localhost:6380
      PUBLIC_URL: http://localhost:5173
      BETTER_AUTH_SECRET: ci-secret-0123456789abcdef0123456789abcdef
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: actions/setup-go@v5
        with: { go-version: "1.23" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @modelhub/db migrate
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm test:e2e

  go:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: "1.23" }
      - run: cd agent && go vet ./... && go test ./... -race

  proto:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bufbuild/buf-action@v1
        with: { input: proto }
```

The `proto` job's breaking-change check is what stops slice 2 from silently
shipping a control plane that cannot talk to yesterday's agents.

- [ ] **Step 4: Commit**

```bash
git add e2e .github pnpm-workspace.yaml package.json
git commit -m "test: end-to-end slice 1 smoke test and CI"
```

---

## Task 19: Agent installation

**Files:**
- Create: `agent/.goreleaser.yaml`, `agent/internal/service/service.go`, `scripts/install.sh`, `docs/install.md`
- Modify: `agent/cmd/agent/main.go` (add `install` and `uninstall`)

**Interfaces:**
- Consumes: `kardianos/service`, the `run` command from Task 15.
- Produces: `modelhub-agent install` / `uninstall`, a snapshot build per platform, and a documented install path for the Mac and the NVIDIA box.

**Scope note.** Notarization, signed update manifests, and cohort rollout are
slice 10. This task produces installable binaries and a working system service —
enough to run the fleet, not enough to hand to a stranger.

- [ ] **Step 1: Implement service installation**

`agent/internal/service/service.go`:
```go
package service

import (
	"context"
	"fmt"

	"github.com/kardianos/service"
)

// runner adapts our session loop to kardianos/service's Start/Stop contract.
type runner struct {
	run    func(ctx context.Context) error
	cancel context.CancelFunc
	done   chan struct{}
}

func (r *runner) Start(service.Service) error {
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	r.done = make(chan struct{})
	go func() {
		defer close(r.done)
		_ = r.run(ctx)
	}()
	return nil
}

func (r *runner) Stop(service.Service) error {
	if r.cancel != nil {
		r.cancel()
	}
	if r.done != nil {
		<-r.done
	}
	return nil
}

func config() *service.Config {
	return &service.Config{
		Name:        "modelhub-agent",
		DisplayName: "Model Hub Agent",
		Description: "Reports this machine's compute to Model Hub and runs assigned workloads.",
		Arguments:   []string{"run"},
	}
}

func New(run func(ctx context.Context) error) (service.Service, error) {
	return service.New(&runner{run: run}, config())
}

func Install(run func(ctx context.Context) error) error {
	s, err := New(run)
	if err != nil {
		return err
	}
	if err := s.Install(); err != nil {
		return fmt.Errorf("install failed (try again with sudo): %w", err)
	}
	return s.Start()
}

func Uninstall(run func(ctx context.Context) error) error {
	s, err := New(run)
	if err != nil {
		return err
	}
	_ = s.Stop()
	return s.Uninstall()
}
```

Add to `agent/cmd/agent/main.go` — extract the session construction from the
`run` command into a helper so both paths share it:
```go
	newSession := func(ctx context.Context) (*transport.Session, error) {
		dir := config.Dir()
		cfg, err := config.Load(dir)
		if err != nil {
			return nil, err
		}
		if !cfg.Enrolled() {
			return nil, fmt.Errorf("this node is not enrolled; run: modelhub-agent enroll --code XXXX-XXXX --server <url>")
		}
		priv, err := config.NewIdentity(dir).LoadOrCreate()
		if err != nil {
			return nil, err
		}
		return &transport.Session{
			ServerURL:  cfg.ServerURL,
			NodeID:     cfg.NodeID,
			PrivateKey: priv,
			Probes:     inventory.DefaultProbes(),
		}, nil
	}

	runSession := func(ctx context.Context) error {
		s, err := newSession(ctx)
		if err != nil {
			return err
		}
		return s.Run(ctx)
	}

	root.AddCommand(&cobra.Command{
		Use:   "install",
		Short: "Install and start the agent as a system service",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := svc.Install(runSession); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "installed and started modelhub-agent")
			return nil
		},
	})

	root.AddCommand(&cobra.Command{
		Use:   "uninstall",
		Short: "Stop and remove the agent service",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := svc.Uninstall(runSession); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "removed modelhub-agent")
			return nil
		},
	})
```
with `svc "github.com/modelhub/agent/internal/service"` imported, and the `run`
command's `RunE` reduced to using `runSession` (keeping its `--fake-probe` flag,
which swaps `Probes` after construction).

- [ ] **Step 2: Configure release builds**

`agent/.goreleaser.yaml`:
```yaml
version: 2
project_name: modelhub-agent

builds:
  - id: agent
    main: ./cmd/agent
    binary: modelhub-agent
    env: [CGO_ENABLED=0]
    goos: [darwin, linux, windows]
    goarch: [amd64, arm64]
    ldflags:
      - -s -w -X github.com/modelhub/agent/internal/version.Version={{.Version}}

  # NVML needs cgo and the driver headers, so the CUDA build is Linux-only and
  # produced on a runner that has them.
  - id: agent-cuda
    main: ./cmd/agent
    binary: modelhub-agent
    env: [CGO_ENABLED=1]
    goos: [linux]
    goarch: [amd64]
    tags: [nvml]
    ldflags:
      - -s -w -X github.com/modelhub/agent/internal/version.Version={{.Version}}

archives:
  - id: default
    formats: [tar.gz]
    format_overrides:
      - goos: windows
        formats: [zip]
    name_template: "{{ .ProjectName }}_{{ .Version }}_{{ .Os }}_{{ .Arch }}{{ if eq .ID \"agent-cuda\" }}_cuda{{ end }}"

checksum:
  name_template: checksums.txt

snapshot:
  version_template: "{{ incpatch .Version }}-snapshot"
```

- [ ] **Step 3: Verify a snapshot build**

Run:
```bash
cd agent && goreleaser build --snapshot --clean --single-target && cd ..
./agent/dist/agent_*/modelhub-agent --version
```
Expected: a binary is produced and prints its version.

- [ ] **Step 4: Write the install documentation**

`docs/install.md`:
```markdown
# Installing the Model Hub agent

## macOS (Apple Silicon)

    tar xzf modelhub-agent_*_darwin_arm64.tar.gz
    sudo mv modelhub-agent /usr/local/bin/
    modelhub-agent enroll --code XXXX-XXXX --server https://<your-control-plane>
    sudo modelhub-agent install

The agent runs as a launchd daemon. Check it with `modelhub-agent status`.

## Linux with NVIDIA GPUs

Use the `_cuda` archive — the default build has no NVML support and will report
only the CPU.

    tar xzf modelhub-agent_*_linux_amd64_cuda.tar.gz
    sudo mv modelhub-agent /usr/local/bin/
    modelhub-agent enroll --code XXXX-XXXX --server https://<your-control-plane>
    sudo modelhub-agent install

Verify the GPUs are seen:

    modelhub-agent status
    journalctl -u modelhub-agent -f

## Removing it

    sudo modelhub-agent uninstall
    sudo rm /usr/local/bin/modelhub-agent
    sudo rm -rf /etc/modelhub

## Where things live

| | macOS | Linux | Windows |
|---|---|---|---|
| Config and identity (as root) | `/etc/modelhub` | `/etc/modelhub` | `%ProgramData%\ModelHub` |
| Config and identity (as a user) | `~/Library/Application Support/modelhub` | `~/.config/modelhub` | `%AppData%\modelhub` |
| Service | launchd | systemd | Windows service |

Override any of these with `MODELHUB_CONFIG_DIR`.
```

- [ ] **Step 5: Install on both real machines and confirm the deliverable**

This is the manual checklist that closes the slice. It cannot be automated,
because the whole point is real hardware.

1. Start the control plane and the web app; sign up; create an org.
2. On the Mac: install, enroll, `modelhub-agent install`. Confirm the Fleet page
   shows the machine `online` within 10 seconds, with a `metal:0` device whose
   total memory matches `sysctl hw.memsize` and whose available figure is
   plausible against Activity Monitor.
3. On the NVIDIA box: install the `_cuda` archive, enroll, install the service.
   Confirm a `cuda:N` device per GPU, with total VRAM matching `nvidia-smi`.
4. Open something GPU-hungry on the NVIDIA box. Confirm the *foreign* segment of
   the memory bar grows and available shrinks, within one sample interval.
5. Stop one agent. Confirm it turns `degraded` within ~15s and `offline` within
   ~30s.
6. Restart it. Confirm it returns to `online` without re-enrolling.

- [ ] **Step 6: Commit**

```bash
git add agent scripts docs
git commit -m "feat(agent): system service installation and release builds"
```

---

## Appendix: running the whole thing locally

```bash
# Once
pnpm install
docker compose up -d
cp .env.example .env
set -a && source .env && set +a
pnpm --filter @modelhub/db migrate

# Every time — three terminals
pnpm --filter @modelhub/control-plane dev     # :3000
pnpm --filter @modelhub/web dev               # :5173
cd agent && go run ./cmd/agent run --fake-probe

# Tests
pnpm test          # all TypeScript
cd agent && go test ./...
pnpm test:e2e
```

## Appendix: what slice 1 deliberately does not do

Listed so a reviewer does not mistake an intentional boundary for an omission:

- **No model runtimes and no inference.** `managedBytes` is always zero; nothing
  is ever loaded. Slice 2.
- **No scheduling.** Nothing chooses where work runs, because no work runs. Slice 3.
- **No telemetry history.** Only the latest sample per device is kept; no
  hypertables, no charts, no sparklines. Slice 8.
- **No peer or direct transport, and no node certificates.** The agent talks only
  to the control plane. Slice 9.
- **No API keys, quotas, or rate limits.** There is no public API to protect yet.
  Slices 2 and 10.
- **No Metal cgo shim.** Apple memory comes from sysctl until `managedBytes`
  starts to matter. Slice 2.
- **No agent self-update or notarized installers.** Slice 10.
