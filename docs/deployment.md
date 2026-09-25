# Deployment

Model Hub slice 1 has real, working automation for local development and CI,
and no production deployment story yet. This document says plainly, layer by
layer, what exists in this repository today versus what an operator still
has to build or decide before running this in production.

## 1. What exists now

- **`docker-compose.yml`** — local Postgres (`timescale/timescaledb:latest-pg16`,
  host port `5433`) and Redis (`redis:7-alpine`, host port `6380`), each with
  a healthcheck. This is dev-only tooling; there is no production Compose
  file or Kubernetes manifest in this repo.
- **`.github/workflows/ci.yml`** — a three-job GitHub Actions workflow
  (`typescript`, `go`, `proto`). See §3 for what each actually does.
- **`agent/.goreleaser.yaml`** — GoReleaser config that cross-compiles the
  agent for darwin/linux/windows × amd64/arm64, plus a Linux-only CUDA
  variant, into `.tar.gz`/`.zip` archives with checksums. See §4.6.
- **A system-service installer built into the agent itself** —
  `modelhub-agent install`/`uninstall` (via `github.com/kardianos/service`)
  registers/removes a launchd job, systemd unit, or Windows service, and
  `scripts/install.sh` is a small convenience wrapper that unpacks a release
  archive to `/usr/local/bin`. Full detail: `docs/install.md`.
- **The two-listener server topology** — `buildApp()` (plain HTTP/1.1,
  `PORT`/`3000`, everything browser-facing) and `buildAgentApp()` (cleartext
  h2c HTTP/2, `AGENT_PORT`/`3001`, `NodeService` only). This is a
  *development* shape, not a production one — see §4.1.

What does **not** exist: TLS termination anywhere, a production Postgres/
Redis provisioning story, a secrets manager integration, a container image
or build pipeline for the control plane / web app, a CD workflow, or any
agent distribution beyond raw GoReleaser archives (no notarization, no
signed update manifests, no rollout tooling).

## 2. Local deployment

Fully covered in the root `README.md` — clone, `pnpm install`, copy
`.env.example`, generate the two required secrets, `docker compose up -d`,
migrate, then run the control plane / web app / agent. See:

- README → **First-run setup** and **Running the three pieces**
- README → **The five-minute walkthrough** (sign up, pair, enroll with
  `--fake-probe`, watch the node appear)

Nothing further to add here; this document starts at CI.

## 3. CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request, as three independent jobs:

- **`typescript`** — spins up Postgres and Redis as service containers
  (identical images/ports to `docker-compose.yml`), installs with
  `pnpm install --frozen-lockfile`, runs `pnpm --filter @modelhub/db migrate`,
  then `pnpm typecheck`, then `pnpm test`. `pnpm test` is `turbo run test`,
  which discovers and runs **every** workspace package's `test` script,
  including `@modelhub/e2e` — so the full end-to-end suite (real compiled Go
  agent binary against the real control plane and database) runs in this job
  too, not as a separate step. This job also installs a Go toolchain
  (`actions/setup-go`, pinned to `1.24` to match `agent/go.mod`'s toolchain
  directive), specifically because the e2e suite shells out to `go build`.
  All required env vars (`BETTER_AUTH_SECRET`, `PAIRING_CODE_PEPPER`, etc.)
  are set inline in the job as CI-only dummy values.
- **`go`** — `cd agent && go vet ./... && go test ./... -race`. Runs on
  whatever platform the runner is (`ubuntu-latest`), so this proves the CPU
  probe and the platform-independent packages; it does not build or run the
  Metal probe (`//go:build darwin`) or the NVML probe (`//go:build nvml`,
  never passed as a build tag here) — see `docs/codebase.md` ("What the tests
  don't cover").
- **`proto`** — `buf lint proto`, and on pull requests only, `buf breaking
  proto --against` the PR's base branch. This is what stops a change from
  silently breaking wire compatibility between the control plane and
  yesterday's compiled agents before it merges.

**What this proves:** that the full local dev loop — install, migrate,
typecheck, unit tests, the real end-to-end agent/control-plane handshake,
and proto compatibility — works from a clean checkout, because every
command in the workflow has been run and passed locally against the same
inputs it uses in CI.

**What this does not prove:** the workflow file itself, `ci.yml`, has never
been executed on GitHub's actual runners. It was validated command-by-command
locally (the exact `pnpm`/`go`/`buf` invocations the file lists), not by
pushing and watching a real Actions run go green. Anything specific to
GitHub's hosted environment — service-container health-check timing, the
pinned action versions actually resolving, environment differences between
a local machine and `ubuntu-latest`, secrets/permissions wiring — is
unverified. Treat the first real push to GitHub as the actual first run of
this CI configuration.

## 4. Production — not yet done

None of the following exists in this repository. This is a concrete list of
what an operator must provide or decide before running Model Hub in
production.

### 4.1 TLS and the listener split

The two-listener design (`buildApp()` on `PORT`, `buildAgentApp()` on
`AGENT_PORT`, both plain-text) is explicitly a **development** shape. It
exists because browsers cannot speak cleartext HTTP/2 (h2c) at all — they
require TLS to negotiate HTTP/2 via ALPN — while the agent's bidirectional
`NodeService.Connect` stream needs real HTTP/2 framing. Splitting into two
plain-text ports sidesteps needing a TLS certificate for local development.

In production, both listeners must sit behind TLS. The clean end state
(see the listener comment in `apps/control-plane/src/server.ts`) is
to collapse this back to **a single TLS-terminated port using ALPN with
`allowHTTP1`**: the TLS handshake negotiates HTTP/2 for agents and falls
back to HTTP/1.1 for browsers, on one hostname and one port, instead of two.
That collapse was deliberately deferred out of this slice because it needs
a real certificate (or a self-signed/mkcert setup) wired into Fastify's
HTTPS options, which adds friction to the zero-cert local dev loop this
slice optimized for. Landing it means: one public port instead of two, one
DNS name instead of needing to expose `AGENT_PORT` separately, and the
agent's `--server` flag pointing at the same hostname the browser uses
(with the protocol negotiated automatically rather than the operator
choosing `:3000` vs `:3001` by hand).

Until that lands, a production deployment must terminate TLS in front of
**both** ports (a reverse proxy or load balancer per listener, or two
separate public endpoints), and must preserve HTTP/2 framing all the way
through to `buildAgentApp()` for the agent-facing one — a proxy that
silently downgrades to HTTP/1.1 will break `NodeService.Connect`.

### 4.2 Postgres: TimescaleDB extension and the two-role split

The dev database image is `timescale/timescaledb:latest-pg16` — Postgres 16
plus the TimescaleDB extension. **Slice 1's schema does not actually create
any hypertables or call `CREATE EXTENSION timescaledb`** (see
`packages/db/migrations/`); devices carry only their latest sample, and
hypertable-backed telemetry history is explicit future-slice scope. A plain
Postgres 16 would run slice 1 today. Match the TimescaleDB image/extension
in production anyway, so a later slice that does need it isn't a surprise
migration against a database that can't support it.

The real, load-bearing production requirement is the **owner vs. app role
split**: migrations (`packages/db/migrations/0001_roles_and_rls.sql`)
create a restricted `modelhub_app` role — deliberately **not** the table
owner — with row-level security enabled on every tenant table (`nodes`,
`devices`, `pairing_codes`), policy-gated on `current_setting('app.current_org_id')`.
The application only ever connects as `modelhub_app` (`DATABASE_URL`);
migrations run as the owning role (`DATABASE_OWNER_URL`), which is never
used to serve a request. **This is the real gotcha for managed Postgres:**
a managed provider that only ever gives you a single superuser connection
string cannot express this split. If the app role ends up owning its own
tables (or connects as the same role that ran migrations), RLS is silently
defeated — Postgres does not enforce row security against a table's owner,
so every query would quietly see every organization's data with no error
and no test able to catch it in that configuration. Provisioning production
Postgres means explicitly creating two roles/credentials (an owner for
migrations, a restricted one for the app) exactly as `docker-compose.yml`
and `0001_roles_and_rls.sql` do locally — not just pointing both
`DATABASE_URL` and `DATABASE_OWNER_URL` at the same managed-superuser
connection string.

### 4.3 Redis

`REDIS_URL` is consumed directly by `ioredis` (`apps/control-plane/src/redis.ts`)
for the node-authentication nonce replay cache (`apps/control-plane/src/rpc/node-auth.ts`).
Any managed Redis reachable at a `redis://` or `rediss://` (TLS) URL works —
there is no other Redis-specific configuration in this repo. Losing Redis
does not lose data permanently (it's a replay cache, not a system of
record), but it does take `/healthz` to `503`/`degraded` and will reject
node authentication.

### 4.4 Secrets: generation, storage, and pepper rotation

`BETTER_AUTH_SECRET` and `PAIRING_CODE_PEPPER` are validated at process
start by `apps/control-plane/src/env.ts` (`z.string().min(32)` each, no
defaults — the process refuses to boot without real values). Generate
independent values per environment (`openssl rand -hex 32` works, as used
locally) and inject them via whatever secret store the deployment platform
provides — nothing in this repo reads a secrets manager directly; it only
reads `process.env`.

**Rotating `PAIRING_CODE_PEPPER` invalidates every outstanding pairing
code.** `hashCode()` (`apps/control-plane/src/domain/pairing.ts`) stores
only `HMAC-SHA256(pepper, code)` — never the plaintext code — specifically
so that someone with read access to `pairing_codes.code_hash` alone (a
backup, a scoped read replica) can't brute-force the ~40-bit codespace
offline without also holding the pepper. That means redemption
(`redeemPairingCode`) re-derives the HMAC with the *current* pepper and
looks up that hash; change the pepper and every not-yet-redeemed code's
stored hash no longer matches anything the new pepper can produce. This is
a deliberate, expected side effect of rotation, not a bug — but it means
rotating the pepper mid-incident will strand any pairing codes an operator
just handed out, and they need to be re-minted afterward.

### 4.5 Running migrations on deploy

`pnpm --filter @modelhub/db migrate` (`drizzle-kit migrate` against
`DATABASE_OWNER_URL`) must run as part of every deploy that ships a new
migration file, before the new application code that depends on it starts
serving traffic. There is no rollback tooling configured (`packages/db/package.json`
has `migrate`/`generate` only) — the expectation is **forward-only**:
fixing a bad migration means writing a new corrective migration, not
reverting the applied one. Plan deploy ordering (migrate-then-deploy vs.
expand/contract for zero-downtime) accordingly; this repo does not
prescribe one.

### 4.6 Serving the web app, and `VITE_AGENT_URL`

`apps/web`'s `build` script (`tsc -b && vite build`) produces a static
bundle; nothing in this repo serves it in production (no Dockerfile, no
static-hosting config). `VITE_AGENT_URL` — the agent-facing URL shown in
the "Add a machine" pairing dialog — is a Vite `import.meta.env` value,
which means it is **baked into the built bundle at build time**, not
read from the runtime environment. The production build must be run with
`VITE_AGENT_URL` already set to the real public agent endpoint; changing
that endpoint later requires rebuilding and redeploying the web bundle, not
just changing a server-side env var. Likewise `PUBLIC_URL` on the control
plane (Better Auth's `baseURL`/`trustedOrigins`) must be the real
production browser origin, not `http://localhost:5173`.

### 4.7 Agent distribution

`agent/.goreleaser.yaml` produces, per tagged release: cross-compiled
archives for darwin/linux/windows × amd64/arm64 (`CGO_ENABLED=0`, no NVML),
plus a Linux-only `_cuda` archive (`CGO_ENABLED=1`, `-tags nvml`, needs
NVIDIA driver headers at build time so it can only be built on a suitable
Linux runner), and a `checksums.txt`. `scripts/install.sh` and
`docs/install.md` cover unpacking and enrolling from those archives.

Explicitly **not** done, and out of scope for this slice (see
`docs/install.md`'s own note and the slice-10 backlog): binary
**notarization** (macOS Gatekeeper will complain on first run of these
unsigned binaries), **signed update manifests**, and **cohort/staged
rollout** of new agent versions across a fleet. Every install today is a
manual, unsigned binary drop.

## 5. Deployment checklist

For a first production deployment, roughly in order:

- [ ] Provision Postgres 16 (TimescaleDB image/extension recommended) with
      **two** roles: an owner for migrations and a restricted app role, and
      apply `packages/db/migrations/0001_roles_and_rls.sql`'s RLS policies
      under that owner — confirm the app role does **not** own the tenant
      tables (§4.2).
- [ ] Provision Redis, reachable via a `redis://`/`rediss://` URL (§4.3).
- [ ] Generate real, independent `BETTER_AUTH_SECRET` and
      `PAIRING_CODE_PEPPER` values (32+ chars each) and store them in the
      platform's secret manager (§4.4).
- [ ] Decide and implement the TLS story: either the single-port
      ALPN/`allowHTTP1` collapse, or TLS termination in front of both
      `PORT` and `AGENT_PORT` with HTTP/2 preserved end-to-end to the agent
      listener (§4.1).
- [ ] Set `PUBLIC_URL` to the real browser-facing origin.
- [ ] Run `pnpm --filter @modelhub/db migrate` against `DATABASE_OWNER_URL`
      as part of the deploy, before the new app version serves traffic
      (§4.5).
- [ ] Build the web app with `VITE_AGENT_URL` already set to the real
      public agent endpoint, then serve the resulting static bundle
      (§4.6).
- [ ] Start the control plane with all of `env.ts`'s required vars set
      (`DATABASE_URL`, `DATABASE_OWNER_URL`, `REDIS_URL`, `PUBLIC_URL`,
      `BETTER_AUTH_SECRET`, `PAIRING_CODE_PEPPER`, plus `PORT`/`AGENT_PORT`
      if the defaults don't fit).
- [ ] Confirm `/healthz` reports `{"status":"ok"}` against the production
      database and Redis.
- [ ] Build and distribute agent binaries with GoReleaser (§4.7); document
      for operators that these are unsigned and need a manual Gatekeeper
      bypass on macOS until notarization exists.
- [ ] Enroll one real node end-to-end against the production control plane
      as a smoke test before calling the deployment done.

## 6. Known gaps and risks

- **No TLS story yet.** Both listeners are plain-text by design in this
  slice (§4.1). Do not expose `PORT`/`AGENT_PORT` directly to the internet
  without a TLS-terminating proxy in front of each, with HTTP/2 preserved
  to the agent listener.
- **CI has never run on GitHub's actual runners.** Every command in
  `ci.yml` was validated locally; the workflow file itself has not been
  executed by GitHub Actions (§3). The first real push is the first real
  test of the workflow, not just the code it runs.
- **The e2e suite's liveness wait is real wall-clock time, not mocked
  throughout.** `e2e/smoke.test.ts` polls `ListNodes` up to 30 times at
  500ms (up to ~15s) waiting for the freshly enrolled agent to report
  `online` with devices — a real dependency on the agent's actual sample
  interval, not an injected clock. (The *offline* half of the same suite
  does inject a clock rather than sleeping out the real 30-second
  `OFFLINE_AFTER_MS` threshold, but the online half does not.) This makes
  the suite genuinely slow and mildly sensitive to a loaded CI runner; see
  `docs/codebase.md` for what the suites do and do not prove, including the
  NVML probe having never executed against real hardware and the web app
  having no browser-automation coverage at all.
- **Nothing in this slice runs models.** There is no model runtime,
  scheduler, or workload execution anywhere in this repository —
  `managedBytes` is always zero because nothing is ever loaded. Every
  number the Fleet page shows is "how much memory exists and is free," not
  "what's running." Do not deploy this expecting it to serve inference;
  that starts in a later slice.
- **Agent distribution is unsigned and unmanaged.** See §4.7 — no
  notarization, no signed update manifests, no rollout control. A
  compromised release pipeline or a tampered download would currently be
  indistinguishable from a legitimate one to an installing operator.
- **The owner/app database role split is a manual provisioning step with a
  silent failure mode.** Getting it wrong doesn't error — it silently
  defeats row-level security (§4.2). There is no automated check in this
  repo that verifies a target database's roles are configured correctly
  before the app starts serving traffic against it.
