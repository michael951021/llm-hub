# Codebase Guide

Navigation reference for an agent making changes to Model Hub. Read this before touching code; it tells you where things live, which boundaries are load-bearing, and how to avoid the traps that have already bitten this codebase once.

## 1. Orientation

Model Hub is a local-AI cluster manager: a Go agent installs on machines you own, discovers their CPU/GPU devices, and streams inventory to a TypeScript control plane, which a React app displays. This repo is **slice 1 of 10** — enroll, authenticate, stream inventory, display. No model execution or scheduling yet; that's later slices.

The shape, in five lines:

1. An operator signs in to the web app (`apps/web`) and mints a **pairing code** from `FleetService.CreatePairingCode`.
2. `modelhub-agent enroll --code ...` (`agent/`) calls `NodeService.Enroll`, trading the code for a node identity (an Ed25519 keypair, stored locally) and an org membership.
3. `modelhub-agent run` opens a long-lived bidirectional stream (`NodeService.Connect`), authenticating each connection with a signed header, and reports host facts, device inventory, and periodic samples.
4. The control plane (`apps/control-plane`) verifies the signature, persists everything under Postgres row-level security scoped to the node's org, and computes each device's memory budget server-side.
5. The web app polls `FleetService.ListNodes` and renders the fleet; it never does memory arithmetic itself.

Monorepo layout: pnpm workspaces + Turborepo. `packages/*` are shared TS libraries, `apps/*` are the control plane and web app, `agent/` is the Go binary, `proto/` is the protobuf wire contract, `e2e/` is the cross-language end-to-end suite.

## 2. Where does X live

| Concern | Location |
|---|---|
| Memory budget arithmetic | `packages/core/src/memory.ts` (`computeBudget`) — the only place this math exists |
| Node authentication (verify) | `apps/control-plane/src/rpc/node-auth.ts` (`authenticateNode`) |
| Node authentication (build header) | `agent/internal/transport/auth.go` (`AuthHeader`) — must stay byte-for-byte in sync with the TS verifier |
| Database schema | `packages/db/src/schema/fleet.ts` (nodes/devices/pairing_codes), `packages/db/src/schema/auth.ts` (Better Auth tables, generated) |
| Migrations | `packages/db/migrations/*.sql` + `meta/*.json`; generate with `drizzle-kit generate`, apply with `drizzle-kit migrate` |
| Row-level security policy | `packages/db/migrations/0001_roles_and_rls.sql` |
| Wire contract (protobuf source) | `proto/modelhub/v1/*.proto` |
| Generated TS wire types | `packages/proto-ts/src/gen/modelhub/v1/*_pb.ts` — committed, never hand-edit |
| Generated Go wire types | `agent/gen/modelhub/v1/*.pb.go`, `agent/gen/modelhub/v1/modelhubv1connect/*.go` — committed, never hand-edit |
| Agent's hardware probes | `agent/internal/inventory/probe_cpu.go` (CPU, all platforms), `probe_darwin.go` (Metal, `//go:build darwin`), `probe_nvml.go` (CUDA, `//go:build nvml`) / `probe_nvml_stub.go` (`//go:build !nvml`), `probe_other.go` (non-darwin no-op), `probe_fake.go` (synthetic, used in tests and `--fake-probe`) |
| Probe registration | `agent/internal/inventory/inventory.go` (`DefaultProbes()`) |
| Reconnect / sample loop | `agent/internal/transport/session.go` (`Session.Run`, `connectOnce`) |
| Node identity storage | `agent/internal/config/identity.go` (OS keychain, falls back to a 0600 file) |
| Agent local config file | `agent/internal/config/config.go`, `paths.go` |
| Agent CLI entrypoints | `agent/cmd/agent/main.go` |
| Agent as an OS service | `agent/internal/service/service.go` (launchd/systemd/Windows via `kardianos/service`) |
| Enrollment / inventory domain logic | `apps/control-plane/src/domain/nodes.ts` |
| Pairing codes | `apps/control-plane/src/domain/pairing.ts` |
| Server-computed device/node view (budget mapping) | `apps/control-plane/src/domain/views.ts` (`buildDeviceView` calls `computeBudget`) |
| RPC handlers (agent-facing) | `apps/control-plane/src/rpc/node-service.ts` |
| RPC handlers (browser-facing) | `apps/control-plane/src/rpc/fleet-service.ts` |
| Route registration / listener split | `apps/control-plane/src/rpc/index.ts` (`browserRoutes` vs `agentRoutes`), `app.ts` (HTTP/1.1), `agent-app.ts` (h2c HTTP/2) |
| DB client, `withOrg`, `ownerDb` | `packages/db/src/client.ts` |
| Browser session / org resolution | `apps/control-plane/src/auth/session.ts` (`requireSession`), `auth.ts` (Better Auth config, self-heal hook) |
| Liveness sweeper (degraded/offline) | `apps/control-plane/src/jobs/offline-sweeper.ts` (`sweepOfflineNodes`, `startOfflineSweeper`) |
| Environment validation | `apps/control-plane/src/env.ts` (zod schema parsed at import; fails at boot, not first request) |
| Fleet page (web) | `apps/web/src/routes/fleet.tsx`, `components/NodeCard.tsx`, `components/DeviceMemoryBar.tsx` |
| Browser RPC client | `apps/web/src/api.ts` (`fleetClient`, same-origin, credentials included) |
| Pure formatting helpers (web) | `apps/web/src/format.ts` — explicitly *not* where budget math lives |
| CI | `.github/workflows/ci.yml` (three jobs: `typescript`, `go`, `proto`) |
| Process entrypoint (control plane) | `apps/control-plane/src/main.ts` — starts both listeners plus the sweeper |
| Redis client | `apps/control-plane/src/redis.ts` (nonce replay cache) |

## 3. Layering rules that must not be broken

- **`packages/core` is pure and dependency-free.** No imports beyond TS/vitest devDependencies (`packages/core/package.json`). It is the *only* place memory-budget arithmetic exists (`computeBudget` in `memory.ts`). If you find yourself subtracting bytes anywhere else, that logic belongs here instead.
- **`domain/*` holds SQL, `rpc/*` holds wire mapping — not SQL.** `apps/control-plane/src/domain/{nodes,pairing}.ts` own every Drizzle query and transaction. `apps/control-plane/src/rpc/{node-service,fleet-service}.ts` translate between Connect requests/responses and domain calls, mapping domain errors (`EnrollmentError`, `PairingCodeError`, `NodeAuthError`) to `ConnectError` codes. **Exception observed in the code as it stands:** `fleet-service.ts`'s `listNodes` and `getNode` run `tx.select()` directly against `withOrg` rather than delegating to a domain function (only `createPairingCode` delegates, to `mintPairingCode`). Follow the intended pattern for new code — put new queries in `domain/`, not in the RPC handler — but don't be surprised when you find `fleet-service.ts` diverging from it.
- **The agent's `internal/transport` is the only network-aware Go package.** `internal/inventory` probes know nothing about the network (that's what makes them unit-testable without hardware); `internal/config` does local file/keychain I/O only. All HTTP/Connect/h2c traffic goes through `internal/transport`.
- **The browser never computes a memory budget.** Every byte figure the web app renders (`managedBytes`, `foreignBytes`, `headroomBytes`, `availableBytes`) is computed once, server-side, in `views.ts`'s `buildDeviceView` via `computeBudget`, and travels the wire as an already-final `DeviceView`. `DeviceMemoryBar.tsx` only turns bytes into a percentage width and a formatted string (see its own header comment). If a change requires the browser to add, subtract, or clamp a byte value, put that logic in `views.ts` instead and add a field to `DeviceView` in `fleet.proto`.
- **Generated code is committed and must never be hand-edited.** `packages/proto-ts/src/gen/**` and `agent/gen/**` are produced by `buf generate` from `proto/modelhub/v1/*.proto` (see `proto/buf.gen.yaml`). Edit the `.proto` files and regenerate; a hand-edit will be silently overwritten (or worse, drift from the Go side, which is generated from the same source).

## 4. Conventions a change must follow

- **Tests live next to the code they test**, `*.test.ts(x)` in TS, `*_test.go` in Go, run per-package with `vitest run` / `go test`. There is no separate top-level test tree.
- **Every TS package that touches `process.env` loads `.env` via a `vitest.setup.ts`.** `apps/control-plane`, `packages/db`, and `e2e` each have a `vitest.config.ts` with `setupFiles: ["./vitest.setup.ts"]`, and that setup file calls `dotenv`'s `config()` against the repo-root `.env` *before* any test file can import a module that parses `process.env` at load time (`env.ts`, `client.ts`). If you add a new package that reads env vars in module scope, copy this pattern — otherwise tests fail non-deterministically based on import order.
- **Workspace version pins: `typescript ^5.6.0`, `vitest ^2.1.0`, everywhere.** Every `package.json` in the monorepo pins these identically. This is not incidental: Task 4's initial implementation of `packages/core` pinned `typescript ^7.0.2` and `vitest ^5.0.0`, which silently pulled in a second, incompatible toolchain (~800 extra `pnpm-lock.yaml` lines — rolldown, vite 8, lightningcss, `@oxc-project/types`) before being caught and corrected back to the shared pins. When you add a new package or bump a devDependency, match the existing pin — don't let a package manager "helpfully" resolve to latest.
- **Every test that inserts an `organization` row must supply `createdAt` explicitly.** `packages/db/src/schema/auth.ts`'s `organization` table has `createdAt: timestamp(...).notNull()` with **no `.defaultNow()`** (unlike every other Better-Auth-generated table, which does have one) — Better Auth's own insert path always sets it explicitly, so the generated schema doesn't need a DB-side default, but a direct test insert via `ownerDb.insert(organization).values(...)` will fail without it. See the comment repeated in `rls.test.ts`, `pairing.test.ts`, `enroll.test.ts`, and `node-auth.test.ts` — all four supply `createdAt: new Date()`.

## 5. Traps

- **Two listeners, two ports, two clients.** `buildApp()` (`apps/control-plane/src/app.ts`) is plain HTTP/1.1 on `PORT` (default 3000) and serves `/healthz`, `/api/auth/*`, `/api/me`, and `FleetService` — everything the browser reaches. `buildAgentApp()` (`agent-app.ts`) is cleartext HTTP/2 (h2c) on `AGENT_PORT` (default 3001) and serves `NodeService` (`Enroll`, `Connect`) — everything the Go agent reaches. Browsers cannot speak h2c without TLS/ALPN, so these cannot be collapsed into one port in dev. The web app's `fleetClient` (`apps/web/src/api.ts`) points at `window.location.origin` (port 3000, proxied from 5173); the Go agent's `transport.NewNodeClient` must point at `AGENT_PORT`'s URL (`--server` flag / `VITE_AGENT_URL`). Pointing either client at the wrong port fails in a way that looks like an auth or routing bug.
- **`withOrg` vs. `ownerDb` — the asymmetry is deliberate, not an oversight.** `withOrg(orgId, fn)` runs inside a transaction with `app.current_org_id` set, going through the `modelhub_app` role, which RLS restricts to that org's rows (`packages/db/src/client.ts`, policy in `migrations/0001_roles_and_rls.sql`). `ownerDb` bypasses RLS entirely. It is used only where there is genuinely no org context yet to scope by: `node-auth.ts`'s node lookup (the org is the *output* of authentication, not an input), `pairing.ts`'s `redeemPairingCode` (the code itself establishes the org), `nodes.ts`'s pre-insert duplicate-key check (deliberately global — one physical machine must not enroll into two tenants), and `offline-sweeper.ts` (fleet-wide, touches only a status column, no tenant data to leak). Every *other* tenant-data read or write must go through `withOrg`. Reaching for `ownerDb` out of convenience defeats the entire point of RLS.
- **Build-tagged Go files, and `-tags nvml` compiles anywhere.** `probe_nvml.go` (`//go:build nvml`) links against `github.com/NVIDIA/go-nvml`, which dlopens the NVIDIA driver at runtime rather than linking it at compile time — so `go build -tags nvml` succeeds even on a machine with no NVIDIA driver installed; `nvml.Init()` just returns a non-success code at runtime and `newCUDAProbes()` returns `nil`. CI's `go` job (`.github/workflows/ci.yml`) does **not** build with `-tags nvml` — it runs plain `go vet ./... && go test ./... -race`, which compiles `probe_nvml_stub.go` instead. The `-tags nvml` build only happens in `agent/.goreleaser.yaml`'s `agent-cuda` release target. A change to `probe_nvml.go` is not exercised by CI at all — verify it compiles locally with `go build -tags nvml ./...` before relying on it.
- **The agent's keychain account is scoped by config directory, and the e2e suite relies on it.** `config.NewIdentity()` (`agent/internal/config/identity.go`) stores the node's private key in the OS keychain under service `com.modelhub.agent` and account `node-key-<first 16 hex chars of sha256(abs config dir)>` — not a single fixed account. That is what lets `e2e/smoke.test.ts` point `MODELHUB_CONFIG_DIR` at a fresh temp directory and get a genuinely isolated identity on a developer's Mac, instead of colliding with a real one from `modelhub-agent enroll`. The suite reproduces the same account name in TypeScript (`keychainAccountFor`) and deletes its entry in `afterAll`; if you change the derivation in Go, change it there too or every run leaks a login-keychain entry. CI never hits any of this (fresh Linux container, no keychain).
- **`app.inject()` bypasses the network entirely.** Every control-plane unit test (`app.test.ts`, `fleet.test.ts`, `enroll.test.ts`, `session.test.ts`) drives Fastify's `app.inject()`, which dispatches directly into route handlers in-process — no socket, no HTTP/2 framing, no TLS, no real header serialization. A green suite here proves the handler logic is correct; it proves **nothing** about whether the wire protocol actually works end-to-end (h2c negotiation, real header encoding, Connect's binary framing). Only `connect.test.ts` (which opens a real `Http2SessionManager` against a listening port) and `e2e/smoke.test.ts` (which spawns the compiled Go binary) exercise the real network path. If you're validating a wire-format change, `app.inject()` tests are the wrong tool to trust.

## 6. How to make a typical change

**Recipe A — add a field to an existing RPC** (e.g. add a field to `NodeView` or `EnrollRequest`):
1. Edit the message in `proto/modelhub/v1/*.proto`.
2. Regenerate: `pnpm --filter @modelhub/proto generate` (runs `buf generate` from `proto/`, rewrites `packages/proto-ts/src/gen/**` and `agent/gen/**`). Never hand-edit the generated files.
3. If the field needs server-side data or computation, add it in `apps/control-plane/src/domain/{nodes,views,pairing}.ts` (whichever owns the relevant query/shape).
4. Wire it through the RPC handler in `apps/control-plane/src/rpc/{node-service,fleet-service}.ts`.
5. If the Go agent sends or reads the field, update `agent/internal/transport/session.go` (or `enroll.go`) mapping functions.
6. Update consumers: `apps/web/src/api.ts` callers / components if browser-facing.
7. Add/extend tests at the layer you changed (`domain` unit test, `rpc/*.test.ts`, and `connect.test.ts` or `enroll.test.ts` if it crosses the wire).

**Recipe B — add a new device probe** (e.g. a new accelerator kind):
1. Add the `Kind` (if new) to `agent/internal/inventory/inventory.go`.
2. Write the probe as `agent/internal/inventory/probe_<name>.go`, implementing `Discover`/`Sample`/`Name` — use a `//go:build` tag if it needs a platform-specific or optional dependency (follow `probe_nvml.go`'s pattern: real implementation behind the tag, a `!tag` stub returning `nil` so `DefaultProbes()` stays uniform across builds).
3. Register it in `DefaultProbes()` (`inventory.go`) or the relevant platform file (`probe_darwin.go`, `probe_other.go`).
4. `conformance_test.go`'s `TestProbeConformance` picks it up automatically via `DefaultProbes()` — no new test wiring needed for the basic invariants (unique `LocalID`, non-zero `TotalBytes`, valid `Kind`, sample bounds).
5. If the new kind needs new proto fields (e.g. a new pressure signal), extend `proto/modelhub/v1/common.proto` and follow Recipe A from step 2.
6. Add the new `Kind` to `agent/internal/transport/session.go`'s `kindProto` switch, and to the control plane's name maps: `KIND_NAMES` in `domain/nodes.ts` and `KIND_ENUM` in `domain/views.ts`.
7. If the kind needs its own budget math (a new `DeviceKind` case), add it to `computeBudget` in `packages/core/src/memory.ts` and cover it in `memory.test.ts` — this is the *only* place that arithmetic belongs (see Section 3).

**Recipe C — add a browser-facing RPC method** (e.g. a new `FleetService` method):
1. Add the `rpc` and its request/response messages to `proto/modelhub/v1/fleet.proto`.
2. Regenerate (`pnpm --filter @modelhub/proto generate`).
3. Implement the handler in `apps/control-plane/src/rpc/fleet-service.ts`, calling `session(ctx)` for auth/org resolution and either an existing `domain/*` function or a new one (prefer adding to `domain/`, per Section 3's intended layering, even though `listNodes`/`getNode` don't).
4. Register it — it's already covered if you added it to `FleetService` in the proto, since `registerFleetService` wires the whole service via `router.service(FleetService, {...})`.
5. Call it from `apps/web/src/api.ts`'s `fleetClient` in whichever route/component needs it (see `routes/fleet.tsx`'s `useQuery` pattern).
6. Add a test in `apps/control-plane/src/rpc/fleet.test.ts` (session-required, org-isolation, happy path — follow the existing `ListNodes`/`CreatePairingCode` tests) and, if it drives new UI, a component test under `apps/web/src/components/*.test.tsx`.

## 7. Commands

Root (Turborepo orchestrates all packages):
```
pnpm install
pnpm test            # turbo run test — every package's vitest + go test via e2e
pnpm typecheck        # turbo run typecheck
pnpm build            # turbo run build
pnpm lint             # turbo run lint
pnpm db:up / db:down  # docker compose for local Postgres/Redis
```

Per TS package (`packages/core`, `packages/db`, `packages/proto-ts`, `apps/control-plane`, `apps/web`, `e2e`):
```
pnpm --filter <name> test          # vitest run
pnpm --filter <name> typecheck     # tsc --noEmit
```
Package-specific extras:
```
pnpm --filter @modelhub/db migrate      # drizzle-kit migrate (apply)
pnpm --filter @modelhub/db generate     # drizzle-kit generate (new migration from schema)
pnpm --filter @modelhub/proto generate  # buf generate — regenerates TS + Go wire types
pnpm --filter @modelhub/proto lint      # buf lint
pnpm --filter @modelhub/web dev         # vite dev server, port 5173, proxies /api and FleetService to :3000
pnpm --filter @modelhub/control-plane dev  # tsx watch src/main.ts
pnpm test:e2e                           # just the e2e suite (builds and runs the real Go binary)
```

Go agent (`agent/`):
```
cd agent && go vet ./... && go test ./... -race     # what CI's `go` job runs
go build ./cmd/agent                                 # default build, no CUDA
go build -tags nvml ./cmd/agent                       # CUDA build — compiles anywhere (dlopen), not run by CI
```

Proto (`proto/`):
```
pnpm exec buf lint proto
pnpm exec buf breaking proto --against ".git#branch=origin/main,subdir=proto"   # PR-only in CI
```

CI (`.github/workflows/ci.yml`) — three parallel jobs: `typescript` (Postgres + Redis services, runs `pnpm --filter @modelhub/db migrate`, `pnpm typecheck`, `pnpm test` — the last of which also runs the e2e suite, which builds and runs the real Go binary, so this job needs both Node and Go toolchains), `go` (`go vet` + `go test -race`, no `-tags nvml`), `proto` (`buf lint`, plus `buf breaking` on pull requests only).
