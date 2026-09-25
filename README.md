# Model Hub

Model Hub is a local-AI cluster manager. You install an agent on machines
you own, they join a fleet, and a web app shows each machine's GPUs (or
Apple Silicon) and how much memory on each is actually schedulable for
work.

This repository is **slice 1 of 10: the foundations.** It does exactly one
thing end to end: an agent enrolls into an organization, authenticates
every connection with an Ed25519 signature, streams its hardware inventory
(CPU always, plus CUDA or Apple Metal devices when present) every few
seconds, and the web app shows the fleet live. That's it. Slice 1
deliberately does **not** run models, schedule workloads, execute flows,
or move a single tensor — `managedBytes` is always zero, because nothing
in this slice ever loads anything. Those are later slices.

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 22+ (pinned by `.nvmrc`) | `node -v` |
| pnpm | pinned via `packageManager` in `package.json` (`pnpm@12.4.2`) | `pnpm -v` (run `corepack enable` first if you don't have pnpm) |
| Go | 1.24+ (`agent/go.mod`'s toolchain directive) | `go version` |
| Docker (with Compose) | any recent version | `docker --version && docker compose version` |

You do **not** need a GPU. The agent can report synthetic devices with
`--fake-probe` (see the walkthrough below), and CI/most local dev uses
exactly that.

## First-run setup

Run these in order from the repo root:

```bash
git clone <this-repo-url> model-hub && cd model-hub

pnpm install

cp .env.example .env
```

`.env` needs two real secrets before anything will boot —
`BETTER_AUTH_SECRET` and `PAIRING_CODE_PEPPER` each require at least 32
characters and have no default (`apps/control-plane/src/env.ts` validates
this at import and refuses to start otherwise). Generate two independent
values and paste them in:

```bash
openssl rand -hex 32   # -> BETTER_AUTH_SECRET
openssl rand -hex 32   # -> PAIRING_CODE_PEPPER
```

Then bring up Postgres (TimescaleDB image, port **5433**) and Redis (port
**6380**), and apply migrations as the database **owner** role (the app
itself only ever connects as a restricted role that row-level security
constrains — see `docs/deployment.md`):

```bash
docker compose up -d          # or: pnpm db:up
set -a && source .env && set +a
pnpm --filter @modelhub/db migrate
```

`pnpm --filter @modelhub/db migrate` reads `DATABASE_OWNER_URL` from the
process environment (not automatically from `.env`), which is why the
`source .env` step above matters — skip it and migrate fails immediately
with `url: undefined`.

## Running the three pieces

Each of these needs the env vars loaded into its shell
(`set -a && source .env && set +a`, as above) unless your shell already
has them exported.

**Control plane** — two HTTP listeners in one process (see below for why):

```bash
pnpm --filter @modelhub/control-plane dev
```

Prints, once both listeners are up:

```
{"level":30,...,"msg":"Server listening at http://127.0.0.1:3000"}
{"level":30,...,"msg":"Server listening at http://127.0.0.1:3001"}
```

**Web app**:

```bash
pnpm --filter @modelhub/web dev
```

Prints Vite's usual banner, serving on `http://localhost:5173/`. Its dev
server proxies `/api/*` and the `FleetService` RPC path to `:3000` only —
it never talks to `:3001`.

**Agent** (build once, then run against your local control plane):

```bash
cd agent
go build -o modelhub-agent ./cmd/agent
```

See the walkthrough below for `enroll`/`run`; see `docs/install.md` for
installing it as a persistent system service instead of running it in the
foreground.

The control plane runs two listeners: browsers on `:3000` (HTTP/1.1) and
agents on `:3001` (cleartext HTTP/2, which browsers can't speak). See
`docs/codebase.md` §1.

## The five-minute walkthrough

With the control plane (`:3000`/`:3001`) and web app (`:5173`) both
running from the previous section:

1. Open `http://localhost:5173`, and sign up for an account (this also
   creates a personal organization for you automatically — a new user is
   never orgless).
2. On the Fleet page, click **Add a machine**, give it a name, and click
   **Generate pairing code**. You'll get a code like `VLYJ-PAJ9` (good for
   one use, expires in 15 minutes) and the exact enroll command to run,
   pointed at `VITE_AGENT_URL` (the agent port, `:3001` — not the browser
   port).
3. In `agent/`, using the binary you built above, enroll and run it with
   synthetic hardware so it works without a GPU:

   ```bash
   ./modelhub-agent enroll --code VLYJ-PAJ9 --server http://localhost:3001
   ./modelhub-agent run --fake-probe
   ```

   `enroll` prints `enrolled "<name>" into <org>'s fleet`. `--fake-probe`
   is a flag on `run` (not `enroll`) — it swaps in two synthetic devices
   instead of probing real hardware, which is exactly what lets this whole
   walkthrough work on any machine.
4. Within about 10 seconds (two 5-second sample intervals), the machine
   appears on the Fleet page as `online`, with two fake devices and real
   (non-zero) total/available memory numbers for each.

This is precisely what `e2e/smoke.test.ts` automates and asserts on.

## Running the tests

```bash
pnpm test                              # everything: turbo runs every package's tests
pnpm --filter @modelhub/core test      # one package, e.g. the memory-budget math
pnpm --filter @modelhub/control-plane test
pnpm --filter @modelhub/db test
```

Go module:

```bash
cd agent && go vet ./... && go test ./...
```

End-to-end suite (also part of `pnpm test`):

```bash
pnpm --filter @modelhub/e2e test
```

`e2e/smoke.test.ts` builds the real Go agent binary and runs it against
the real control plane and database — it needs `docker compose up -d`,
migrations applied, and a Go toolchain, same as above.

On macOS the e2e agent stores its key in the login keychain under an entry
scoped to the suite's temp directory; the suite deletes it afterwards.

## Repository layout

`apps/control-plane` (Fastify + Connect server), `apps/web` (React SPA),
`agent/` (Go CLI and service), `packages/{core,db,proto-ts}` (memory model,
database, generated contract), `proto/` (the contract), `e2e/`. The full map,
with what each module owns, is in `docs/codebase.md` §2.

## Troubleshooting

**Agent enrollment fails immediately with a connection/protocol error.**
You pointed `--server` at the browser port (`3000`) instead of the agent
port (`3001`). The agent speaks h2c; only `buildAgentApp()` on
`AGENT_PORT` understands it.

**Control plane crashes on startup with a Zod/validation error.** A
required env var is missing or too short — most often `BETTER_AUTH_SECRET`
or `PAIRING_CODE_PEPPER` (both need 32+ characters and have no default).
Check `.env` was copied from `.env.example`, has real values, and is
actually exported into the shell running the process
(`set -a && source .env && set +a`).

**`docker compose ps` shows nothing, or migrate/connect refuses.** Docker
isn't running, or the containers haven't started. Run `docker compose up
-d` and wait for both services to report `healthy`
(`docker compose ps`); the healthchecks poll every 2s.

**`pnpm --filter @modelhub/db migrate` fails with `url: undefined`.**
`DATABASE_OWNER_URL` isn't in the process environment — `drizzle-kit`
does not read `.env` on its own. Run `set -a && source .env && set +a`
first.

**Fleet page never shows a node, or the control plane rejects the
connection as unrecognized.** Migrations were never applied against this
database, or you're pointed at a different Postgres than the one you
migrated. Re-run the migrate step above and confirm `DATABASE_URL` matches
the running container's port (`5433` by default).

## Where to read next

- `docs/codebase.md` — how the code is organized, the four request flows, the
  memory model, tenant isolation, the rules a change must keep, and testing.
- `docs/install.md` — installing the agent on real hardware (macOS, Linux with
  NVIDIA GPUs) as a system service, plus the manual verification checklist.
- `docs/deployment.md` — what is automated today versus what production still
  needs (TLS, managed Postgres/Redis, secrets, agent distribution).
- `docs/superpowers/specs/` — the product design across all ten slices.
