# Model Hub — Local-AI Cluster Manager, Scheduler, and Orchestrator

**Status:** Design approved in principle; pending review
**Date:** 2026-09-16
**Author:** Design session (brainstorming → spec)

---

## 1. Purpose

Model Hub answers one question that no existing tool answers well:

> **Where should my AI workloads run, and how should my compute be allocated?**

Flow builders (Langflow, Flowise, n8n) let you wire models together but treat
compute as somebody else's problem — a model is a URL. Cluster schedulers
(Kubernetes, Ray, Slurm) allocate compute well but know nothing about prompts,
token streams, or the shape of an LLM graph.

Model Hub sits in the gap. You install an agent on each machine you own; the
machines join a fleet; you draw a flow in a browser; the system decides which
physical device each step runs on, loads and evicts models to fit, queues work
when demand exceeds supply, and streams the answer back through one API
endpoint.

The motivating example, stated concretely:

> A request arrives at one endpoint. Claude Opus 5 decomposes it into four
> subtasks. Those four subtasks fan out in parallel to four different local
> models spread across a Mac Studio and a 4090 box. Their outputs are gathered
> and reduced into one answer. Every placement decision — which model landed on
> which GPU, what got evicted to make room, how long each step waited — is
> visible and adjustable.

### 1.1 Design principles

1. **Compute is a first-class citizen.** Every node in a flow resolves to a
   real device with a real memory budget and a real queue. The UI never
   pretends otherwise.
2. **Simple by default, deep on demand.** A new user sees boxes and arrows. One
   toggle reveals placement constraints, fallback policies, and predicted-wait
   expressions. Nothing advanced is *required* to get a working endpoint.
3. **Every automatic decision is explainable.** The scheduler records why it
   chose a device, with the scores. An opaque scheduler is an untrustworthy
   scheduler.
4. **Modularity is structural, not aspirational.** Runtimes, providers,
   transports, placement strategies, and flow node types are all plugin
   interfaces with more than one implementation from day one. If there is only
   one implementation, the abstraction is unproven.
5. **Degrade, never block.** Direct peer streaming is an optimization; relay is
   the contract. A user whose network is hostile gets a slower system, not a
   broken one.

### 1.2 Non-goals

- **Not a training or fine-tuning platform.** Inference only. Batch jobs and
  training runs are a different scheduler with different constraints.
- **Not a model host.** We do not ship or serve weights. We orchestrate
  runtimes that do (Ollama, vLLM, llama.cpp, MLX, LM Studio).
- **Not a general workflow engine.** No cron, no human-in-the-loop approvals,
  no arbitrary business-process automation. LLM graphs specifically.
- **Not a model-parallelism implementation.** We orchestrate distributed model
  deployments; we do not implement model parallelism ourselves. The scheduler
  may allocate multiple GPUs, across one or more nodes, to a single deployment,
  and it selects and configures the parallelism strategy — tensor (TP),
  pipeline (PP), expert (EP), or whatever else the runtime supports. The actual
  model partitioning and collective communication are delegated entirely to the
  runtime (vLLM today; others as they gain the capability). We decide *which
  devices and which strategy*; the runtime decides *how the tensors move*.
- **No billing in v1.** The tenant model must not preclude it; the code must not
  contain it.

---

## 2. Vocabulary

These terms are used precisely throughout. Getting them wrong is how this kind
of system turns to mud.

| Term | Meaning |
|---|---|
| **Org** | A tenant. Owns nodes, models, flows, endpoints, members, keys. The isolation boundary for everything. |
| **Node** | One physical or virtual machine running the agent. Belongs to exactly one org. |
| **Device** | A schedulable compute unit inside a node: a CUDA GPU, an Apple unified-memory GPU, or the CPU. Has a memory budget. |
| **Runtime** | A process that serves inference: an Ollama daemon, a vLLM server, a llama.cpp server, an MLX server. Managed or discovered. |
| **Model** | A logical artifact in the org's catalog, e.g. `qwen3-30b-a3b:q4`. Identified by name + quantization, not by where it lives. |
| **Replica** | One servable instance of a Model, served by one Runtime, occupying a **DeviceSet** of one or more Devices. The unit of routing, queueing, and lifecycle. |
| **Shard** | The portion of a Replica resident on a single Device. The unit of **memory accounting**. A single-device Replica has exactly one Shard. |
| **DeviceSet** | The ordered set of Devices a Replica occupies, together with its ParallelismPlan. May span Nodes within one Site. |
| **ParallelismPlan** | The `{tp, pp, ep, dp}` degrees and runtime launch configuration the scheduler chose for a Replica. Selected by us, executed by the Runtime. |
| **Pool** | A named, logical model the user references in flows: "fast-local", "big-reasoner". Backed by 1..N replicas, possibly of different Models, with a routing policy. **Flows reference pools, never devices.** |
| **Provider** | An external API treated as an unlimited pool: Anthropic, OpenAI, an OpenAI-compatible URL. |
| **Flow** | A DAG the user draws. Versioned. Compiles to a Plan. |
| **Endpoint** | A published, addressable Flow version with a slug, auth, and rate limits. What clients actually call. |
| **Run** | One execution of an Endpoint. Contains Steps. |
| **Step** | One node's execution within a Run. The unit of retry, timing, and tracing. |
| **Lease** | A time-bounded grant from the scheduler authorizing a Step to execute on a Replica. Expires; must be renewed for long generations. |

The single most important sentence in this document:

> **A flow node names a Pool. The scheduler maps Pool → Replica → DeviceSet.
> The user may constrain that mapping but never performs it by hand.**

This is what makes "change how much each node splits its outputs and to who" a
policy edit rather than a graph rewrite, and it is what lets the same flow run
on one laptop or on twelve machines.

---

## 3. Architecture

### 3.1 Topology

```
                        ┌──────────────────────────────┐
                        │  Browser SPA (React)         │
                        │  Flows · Fleet · Runs         │
                        └───────────┬──────────────────┘
                          Connect-Web RPC + SSE
                                    │
┌───────────────────────────────────▼───────────────────────────────────┐
│  CONTROL PLANE  (Node 22 / TypeScript, horizontally scalable)         │
│                                                                       │
│   Gateway          Executor         Scheduler        Registry         │
│   ───────          ────────         ─────────        ────────         │
│   public API       compiles Flow    accounting       nodes/devices    │
│   authn/authz      runs Steps       placement        replicas         │
│   rate limits      streams SSE      admission        telemetry        │
│   OpenAI-compat    retries/policy   lifecycle        health           │
│                                                                       │
│           Postgres 16 + TimescaleDB          Redis                    │
│           (truth, runs, telemetry)           (leases, queues, pubsub) │
└───────────────────────────────────┬───────────────────────────────────┘
                     gRPC bidi / HTTP2 — agent dials OUT
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────▼────────┐         ┌────────▼───────┐         ┌─────────▼──────┐
│  AGENT (Go)    │         │  AGENT (Go)    │         │  AGENT (Go)    │
│  Mac Studio    │◄───────►│  4090 box      │◄───────►│  laptop        │
│  M2 Ultra 128G │  peer   │  2× RTX 4090   │  peer   │  M3 Pro 36G    │
│  MLX · Ollama  │  data   │  vLLM · Ollama │  data   │  Ollama        │
└────────────────┘  plane  └────────────────┘  plane  └────────────────┘
```

### 3.2 Control-plane / data-plane split

The chosen architecture is **centralized control, distributed data**.

**Control plane decides and observes.** It compiles flows, scores placements,
issues leases, sequences steps, applies policy, retries, and records
everything. It is the only component that knows the whole fleet. It is
stateless across replicas — all state is in Postgres and Redis — so it can be
redeployed mid-run without losing work.

**Data plane moves bytes, by the cheapest available route.** Three transports,
tried in order, all interchangeable behind one `Transport` interface:

| Transport | When | Mechanism |
|---|---|---|
| **Direct peer** | Two adjacent steps land on the same site (same org, same LAN, mutually reachable) | Agent A POSTs its output stream straight to Agent B over mTLS, authorized by a control-plane-signed grant. The control plane receives only metadata. |
| **Direct client** | The caller is reachable from the node, or vice versa | Control plane returns a signed, short-lived stream URL; the client reads tokens straight from the node. |
| **Relay** | Always available; the default and the fallback | Bytes ride the agent's existing outbound gRPC stream through the control plane. Works behind any NAT with zero configuration. |

Transport selection is per-edge, decided at plan-compile time, and re-decided
on failure. **Relay is the contract; direct is an optimization.** A failure to
establish a direct route is never a run failure — it is a log line and a
downgrade.

### 3.3 Why not a durable workflow engine

Temporal, Restate, and friends are the textbook answer for "execute a graph
with retries and timers." We are deliberately not using one:

- Our runs are seconds long and stream continuously. Payload-through-history
  models fight token streaming.
- Scheduling decisions need sub-100ms latency; activity round-trips do not fit
  in that budget.
- The scheduler already owns authoritative state about replicas and queues. A
  workflow engine would become a second, competing source of truth about the
  same facts.

Instead: run state lives in Postgres (`runs`, `run_steps`), advanced by an
in-process executor, with a transactional outbox for crash recovery. Runs are
resumable at step boundaries. A step that was mid-stream when the control plane
died is marked `interrupted` and retried per its policy — we do not attempt to
resume a partially emitted token stream.

**Accepted cost:** we own retry, timeout, and resume semantics ourselves. This
is roughly 800 lines of carefully tested executor code. It is worth it.

---

## 4. Technology choices

The rule: **borrow anything that is a solved commodity; build anything that is
the product.** Versions are pinned at implementation time, not from memory.

### 4.1 Borrowed

**Transport and schema**

| Need | Choice | Rationale |
|---|---|---|
| Agent ↔ control plane | **ConnectRPC** (`connectrpc.com/connect` Go, `@connectrpc/connect` TS) + **Buf** for protobuf | One `.proto` generates the Go client and the TS server. Bidi streaming over HTTP/2 gives outbound-dial NAT traversal without a hand-rolled WebSocket framing layer. |
| Browser ↔ control plane | Connect-Web, plus **SSE** for token streams | SSE survives proxies and reconnects natively; it is the only genuinely hot browser path. |
| Peer data plane | Plain HTTP/2 POST + mTLS + signed grant | An agent streaming to a peer is just an HTTP client. No new protocol. |

**Control plane**

| Need | Choice | Rationale |
|---|---|---|
| HTTP server | **Fastify** + `fastify-type-provider-zod` | Connect mounts as a plugin; Zod schemas generate the OpenAPI doc for the public API. |
| Database access | **Drizzle ORM**, Postgres 16 | The scheduler writes real SQL (`FOR UPDATE SKIP LOCKED`, lateral joins). Drizzle stays out of the way where Prisma would fight. |
| Timeseries | **TimescaleDB** extension | Telemetry lives in the same Postgres; continuous aggregates produce the dashboard rollups. One database until it demonstrably hurts. |
| Jobs / pubsub / leases | **Redis** + **BullMQ** | BullMQ for model pulls, evictions, health sweeps, fleet upgrades. Raw Redis for lease TTLs and telemetry fan-out. **Not** in the request-routing path. |
| Auth, orgs, API keys | **Better Auth** (organization plugin) | Self-hostable, gives orgs/invites/sessions/keys without a vendor. Swappable for Clerk/WorkOS behind our own `AuthProvider` interface. |
| Anthropic + OpenAI providers | **`@anthropic-ai/sdk`** directly; `openai` for OpenAI | Deliberately *not* a cross-provider shim. We already need a provider-adapter interface for local runtimes; cloud providers are one more implementation of it. Using the official SDK keeps adaptive thinking, structured outputs, and prompt caching fully available. |
| Sandboxed expressions | **`quickjs-emscripten`** | Policy expressions and Transform nodes run in a WASM QuickJS isolate with memory and instruction limits. Safer than `isolated-vm` (no native addon, no host FFI surface) and fast enough for sub-millisecond predicates. |
| Tracing and metrics | **OpenTelemetry** SDK, both sides | Run traces and system metrics in one vocabulary; export anywhere. |
| Secrets at rest | Envelope encryption, AES-256-GCM, `node:crypto`, key from KMS or env | Small and standard; no dependency warranted. |

**Agent (Go)**

| Need | Choice | Rationale |
|---|---|---|
| NVIDIA inventory | **`NVIDIA/go-nvml`** | Authoritative VRAM totals/used, utilization, per-process accounting, MIG awareness, ECC state. |
| Host inventory | **`shirou/gopsutil`** | CPU, RAM, disk, load, per-process stats across all three OSes. |
| Apple Silicon | Thin **cgo shim** → Metal `recommendedMaxWorkingSetSize` + `currentAllocatedSize`; `sysctl hw.memsize`, `iogpu.wired_limit_mb` | No mature Go binding exists. ~80 lines of Objective-C, isolated behind the `Device` interface and build-tagged `darwin`. |
| Service install | **`kardianos/service`** | One API over launchd, systemd, and Windows SCM. |
| Packaging + self-update | **GoReleaser** + **`minio/selfupdate`**, Ed25519-signed manifests | Notarized `.pkg`, `.deb`/`.rpm`, MSI. Fleet upgrade is a real operational problem; it is solved on day one, not year two. |
| Tray / local UI | **`getlantern/systray`** + a localhost setup page on `127.0.0.1:7777` | The "app portion" is a daemon with a menubar icon and a pairing page. Not Electron, not Wails. |

**Web app**

| Need | Choice |
|---|---|
| Canvas | **React Flow (xyflow)** — the foundation Langflow uses, for the same reasons |
| UI kit | **shadcn/ui** + Tailwind + Radix |
| Data / state | **TanStack Query** + Zustand; **TanStack Router**; **Vite** |
| Charts | **uPlot** for high-frequency telemetry; Recharts for summaries |
| Forms | `react-hook-form` + Zod (schemas shared with the server) |

**Repo and CI**

pnpm workspaces + Turborepo for the TypeScript side; a Go module in the same
repo; Buf for protobuf generation and breaking-change detection; GitHub Actions;
GoReleaser for agent artifacts.

### 4.2 Built, because it is the product

1. **Resource accounting** — a memory model that is honest about both discrete
   VRAM and Apple unified memory (§5).
2. **Placement and lifecycle engine** — which replica exists on which device,
   what gets loaded, what gets evicted, what stays warm (§6).
3. **Admission and routing** — queue depth, predicted wait, per-tenant fairness
   (§6.5).
4. **Flow semantics** — dynamic fan-out, gather/reduce, and policy edges (§8).
5. **Progressive-disclosure UX** — the thing that stops all of the above from
   looking like Kubernetes (§10).

---

## 5. Domain model and resource accounting

### 5.1 Entities

```
Org ─┬─ Member, ApiKey, Setting
     ├─ Node ─┬─ Device ──┐
     │        └─ Runtime ─┴─► ReplicaShard ──► Replica   (N shards : 1 replica;
     ├─ Model ──────────────────────▲                     shards may span nodes
     │                              │                     within one site)
     ├─ Pool ───── PoolMember ──────┴─► Model | Provider
     ├─ Provider (external API credential)
     ├─ Flow ───── FlowVersion ───── Endpoint
     └─ Run ────── RunStep ────── PlacementDecision
```

Schema sketch for the load-bearing tables (Drizzle; abbreviated):

```ts
nodes:      id, org_id, name, platform, arch, agent_version, site_id,
            status('online'|'draining'|'offline'), public_key,
            last_seen_at, capabilities jsonb

devices:    id, node_id, kind('cuda'|'metal'|'cpu'), index, name,
            total_bytes, reserved_bytes, perf_class, compute_caps jsonb

runtimes:   id, node_id, kind('ollama'|'vllm'|'llamacpp'|'mlx'|'lmstudio'),
            managed bool, endpoint_url, version, status, config jsonb

models:     id, org_id, ref, quantization, params_b, family,
            profile jsonb   -- ModelProfile (§5.3)

replicas:   id, model_id, runtime_id, leader_node_id, site_id,
            status('loading'|'ready'|'degraded'|'draining'|'evicting'|'failed'),
            span('single'|'multi-gpu'|'multi-node'),
            parallelism jsonb,      -- ParallelismPlan {tp,pp,ep,dp,launch}
            kv_bytes_per_slot, max_slots,
            pinned bool, loaded_at, last_used_at, lease_epoch

replica_shards: id, replica_id, device_id, rank, role('leader'|'worker'),
            resident_bytes, status
            -- Memory is accounted per shard. A replica's footprint is the sum
            -- of its shards, which may sit on different devices and nodes.

pools:      id, org_id, name, strategy('weighted'|'least-wait'|'cost-aware'|'failover'),
            policy jsonb
pool_members: pool_id, model_id | provider_id, weight, constraints jsonb

flows:      id, org_id, name, current_version_id
flow_versions: id, flow_id, version, graph jsonb, compiled_plan jsonb,
            created_by, created_at
endpoints:  id, org_id, flow_version_id, slug, auth_mode, rate_limit jsonb

runs:       id, org_id, endpoint_id, status, started_at, ended_at,
            input jsonb, output jsonb, usage jsonb, error jsonb
run_steps:  id, run_id, node_key, attempt, status, replica_id,
            started_at, ended_at, queued_ms, prefill_ms, decode_ms,
            tokens_in, tokens_out, cost_usd, error jsonb
placement_decisions: id, run_step_id, chosen_replica_id, scores jsonb,
            rejected jsonb, strategy, decided_at
```

`placement_decisions` is not an afterthought — it is the data behind the
"why did this run here?" panel, and the fixture source for scheduler tests.

### 5.2 The memory model

This is where "mixed Mac + NVIDIA" stops being a bullet point and becomes real
work. The two platforms have incompatible notions of "free memory," and a
scheduler that pretends otherwise will either thrash or OOM.

**Every device exposes one common quantity: `available_bytes`.** How it is
computed differs per device kind, and each computation lives in its own
`DeviceProbe` implementation in the agent.

**CUDA (`kind = 'cuda'`)**

```
total        = nvmlDeviceGetMemoryInfo().total
used_total   = nvmlDeviceGetMemoryInfo().used
managed      = Σ resident_bytes of our shards on this device
foreign      = max(0, used_total − managed)      // other people's processes
headroom     = max(HEADROOM_MIN, total × HEADROOM_FRAC)
available    = total − foreign − managed − headroom
```

`foreign` is the critical term. The user's desktop session, a game, someone
else's training job — all of it must be subtracted, continuously, and a sudden
increase in `foreign` must trigger defensive eviction before the allocator
fails. `HEADROOM_FRAC` defaults to 0.08 with a 512 MiB floor; fragmentation and
CUDA context overhead are real and unmodeled otherwise.

**Apple unified memory (`kind = 'metal'`)**

Unified memory is shared with the OS, the window server, and every other app.
There is no such thing as "free VRAM."

```
physmem      = sysctl hw.memsize
wired_limit  = sysctl iogpu.wired_limit_mb × MiB, or default ≈ 0.75 × physmem
os_reserve   = max(OS_RESERVE_MIN, physmem × OS_RESERVE_FRAC)   // 8 GiB / 0.15
managed      = Σ resident_bytes of our shards
foreign_gpu  = Metal currentAllocatedSize − managed
mem_pressure = vm_stat-derived pressure level (normal|warn|critical)

available    = min(wired_limit, physmem − os_reserve) − managed − foreign_gpu
```

Two Mac-specific rules that follow from this:

1. **Memory pressure is a first-class scheduling signal, not just telemetry.**
   When `mem_pressure` reaches `warn`, the device is removed from placement
   candidacy. At `critical`, the agent proactively evicts its least-valuable
   replica rather than letting macOS start swapping — a swapping Mac is
   effectively offline for inference purposes, and the failure is silent and
   dreadful.
2. **Machines people actually use get a personal-use reserve.** A node may be
   flagged `interactive`, raising `OS_RESERVE_FRAC` and refusing placements
   that would exceed a user-set ceiling. Your laptop should not become
   unusable because the scheduler found spare memory.

**CPU (`kind = 'cpu'`)**

Budgeted on system RAM with the same `foreign`/headroom structure, plus a
core-count-derived concurrency cap. Always the last-resort device: assigned a
`perf_class` far below any GPU so the scorer avoids it unless nothing else
fits or a constraint demands it.

### 5.3 Model footprint: estimate, then measure

Placement needs to know what a model *will* cost before loading it. We use a
formula first, then replace it with observation — the formula is a bootstrap,
not a belief.

```
weights_bytes  = params × bytes_per_weight(quantization) × (1 + FORMAT_OVERHEAD)

kv_bytes_per_token = 2 × n_layers × n_kv_heads × head_dim × bytes_per_kv_element
kv_bytes_per_slot  = kv_bytes_per_token × context_length
runtime_overhead   = per-runtime constant (CUDA graphs, activation buffers, …)

footprint(concurrency c) = weights_bytes + runtime_overhead
                         + kv_bytes_per_slot × c
```

`ModelProfile` stores both `estimated` and `measured` variants of every term.
After the first successful load, the agent reports actual resident bytes per
shard and the profile is updated; subsequent placements use the measured value.
Profiles are keyed by
`(model, quantization, runtime_kind, device_kind, parallelism_signature)`
because an MLX load and a vLLM load of the same weights genuinely differ — and
because a TP=2 load is a different measurement from a TP=4 load. Estimating one
degree from another is how you get an OOM thirty seconds into a ninety-second
distributed load.

`max_slots` — the concurrency a replica can accept — falls directly out of this:

```
max_slots = clamp(floor((device_available + weights_already_resident − weights_bytes
                         − runtime_overhead) / kv_bytes_per_slot),
                  1, runtime_max_concurrency)
```

This single number connects memory accounting to queueing (§6.5), which is what
makes "predicted wait" a real measurement rather than a guess. For a sharded
replica it is computed from the *most constrained* shard — a pipeline stage on
a smaller GPU caps the concurrency of the whole deployment.

#### Sharded footprints

When a replica spans a DeviceSet, the scheduler must know what each shard costs,
because feasibility is checked per device. The division depends on the
parallelism strategy, and the three differ enough that one formula will not do:

| Strategy | Weights per shard | KV cache per shard | Interconnect sensitivity |
|---|---|---|---|
| **Tensor (TP=N)** | ≈ `weights / N`, plus replicated terms (embeddings, norms) | ≈ `kv / N` — attention heads are split | **Severe.** An all-reduce on every layer. Wants NVLink or same-node PCIe; over ordinary Ethernet it is routinely *slower* than not sharding at all. |
| **Pipeline (PP=N)** | ≈ `weights / N`, split by layer — rarely even, since layers differ in size | Only the stage's own layers | **Mild.** Point-to-point activations at stage boundaries. Tolerates cross-node links. |
| **Expert (EP=N)** | Dense params replicated + `experts / N` | Replicated — EP does not shard attention | **Moderate.** All-to-all on MoE layers: bandwidth-hungry, but burstier than TP. |

Two rules the placer enforces, derived directly from that last column:

1. **TP does not cross a node boundary** unless the link between those nodes has
   been *measured* above a configured floor, or the user explicitly overrides.
   The default is same-node only.
2. **Cross-node spans prefer pipeline parallelism.** When no single node can
   hold the model, the planner reaches for the standard shape: tensor
   parallelism *within* each node, pipeline parallelism *across* them.

### 5.4 Sites and locality

Each node self-reports a `site_id`: a stable hash of its outbound public IP plus
its private subnet, refined by successful peer connectivity probes. Two nodes on
the same LAN converge on the same site.

Sites matter for exactly three things:

1. **Data-plane routing.** Same-site edges are eligible for direct peer
   streaming; cross-site edges relay.
2. **Placement affinity.** The scorer prefers to co-locate adjacent steps in a
   flow, because a fan-out whose four branches all land on one site keeps every
   intermediate on the LAN.
3. **Multi-node deployment feasibility.** A replica may span nodes only within
   a single site, and only over links that clear its parallelism strategy's
   bandwidth floor (§5.5).

For flows, sites are never a correctness boundary: a flow whose steps scatter
across three sites produces exactly the same answer, more slowly. For
multi-node replicas they *are* a hard constraint — a tensor-parallel deployment
cannot be stretched across the public internet and remain useful.

### 5.5 Interconnect topology

Multi-device placement is only as good as its knowledge of the links between
devices, so the agent reports and the scheduler stores a per-node interconnect
graph.

- **Intra-node:** NVLink / NVSwitch presence and peer groups (NVML
  `nvmlDeviceGetTopologyCommonAncestor` plus P2P capability checks), PCIe
  generation and lane width, NUMA affinity. Apple nodes are single-GPU, so
  intra-node parallelism does not arise there.
- **Inter-node:** **measured, never assumed.** Agents in the same site
  periodically run a short bandwidth-and-latency probe against their peers,
  piggy-backed on the data-plane connection they already hold, and report an
  EWMA. It is cheap, it is honest, and it catches the machine that is
  nominally on the LAN but actually on Wi-Fi.

Links are classified into tiers — `nvlink`, `pcie`, `lan-fast` (≥10 GbE), `lan`
(1 GbE), `wan` — and each parallelism strategy declares the minimum tier it will
accept. This is what turns "don't run tensor parallelism over Wi-Fi" from
folklore into a scheduler constraint.

---

## 6. The scheduler

The scheduler is four cooperating concerns. They are separated because they
change at different rates and are tested differently.

```
  request → [Admission] → [Router] → [Placer] → [Lifecycle]
             can we take   which      which      what should be
             this at all?  replica?   device?    loaded at all?
```

### 6.1 Interfaces

Modularity here is structural. Each concern is an interface with at least two
implementations from the start, so the seams are real:

```ts
interface PlacementStrategy {
  name: string;
  /** Enumerate candidate DeviceSets — one device, several on one node, or
   *  several across nodes in one site — that could host this model. */
  propose(m: ModelSpec, fleet: FleetState, ctx: PlacementContext): DeviceSetCandidate[];
  score(candidate: DeviceSetCandidate, ctx: PlacementContext): ScoreBreakdown;
}

/** Chooses HOW a model is split across a DeviceSet. Returns null when the
 *  runtime cannot serve this model on this shape at all. */
interface ParallelismPlanner {
  name: string;
  plan(m: ModelSpec, set: DeviceSetCandidate, rt: RuntimeCapabilities): ParallelismPlan | null;
}

interface RoutingStrategy {
  name: string;
  select(replicas: ReplicaState[], ctx: RoutingContext): ReplicaState | null;
}

interface EvictionPolicy {
  name: string;
  /** Returns whole replicas. Evicting a sharded replica frees memory on every
   *  device it occupies — eviction is never partial. */
  choose(device: DeviceState, need: number, ctx: EvictionContext): Replica[];
}
```

Shipped implementations: placement — `balanced` (default) and `pack`
(consolidate onto fewest devices, useful for leaving a machine free);
parallelism — `single` (tp=1, the default and the only one needed for models
that fit on one device), `tp-within-node`, and `tp-in-pp-across` (tensor
parallelism inside each node, pipeline parallelism between them); routing —
`weighted`, `least-wait`, `cost-aware`, `failover`; eviction — `lru-cost-aware`
(default) and `strict-lru`.

Pools and flow nodes select strategies by name. Adding a fifth routing strategy
must require touching exactly one file plus a registry entry.

### 6.2 Placement scoring

Placement answers: *given that we need a replica of Model M and none suitable
exists, on which **set** of devices should it be created, and under which
parallelism plan?*

```
candidates = enumerateDeviceSets(model, fleet)   # 1 device → N on one node
  |> map(set => [set, parallelismPlanner.plan(model, set, runtimeCaps)])
  |> filter(plan != null)      # runtime can actually serve this shape
  |> filter(feasible)          # every shard fits its device, possibly after
                               # eviction; link tier clears the plan's floor
  |> map(score)
  |> maxBy(total)
```

Enumeration is bounded, not exhaustive: single devices first, then same-node
groups at power-of-two sizes (TP degrees essentially always are), and cross-node
groups only when no single node can hold the model at all. A twenty-device fleet
yields tens of candidates, not millions.

Feasibility is hard filtering, applied per shard *and* per set: device kind
supported by the runtime, required capabilities present, org/node/device
constraints from the pool and the flow node, no node in the set draining,
memory pressure acceptable on **every** device, `available + evictable ≥
shard_footprint` for **every** shard, and the set's weakest link at or above the
parallelism plan's declared tier floor (§5.5).

Scoring is a weighted sum over normalized [0,1] terms:

| Term | Meaning | Default weight |
|---|---|---|
| `residency` | Model already loaded here → no load cost | 0.30 |
| `wait` | Inverse predicted queue wait on this device | 0.25 |
| `fit` | Post-placement memory utilization near a target band (~0.75); penalizes both waste and cramming | 0.15 |
| `perf` | Device performance class vs. the model's needs | 0.15 |
| `locality` | Same site (and same node) as the upstream step | 0.10 |
| `evictionCost` | Negative: value of what must be evicted, weighted by reload time | −0.20 |
| `interactive` | Negative: penalty for a machine flagged as someone's daily driver | −0.10 |
| `parallelismCost` | Negative: collective-communication overhead on the critical path, scaled by the set's weakest link tier | −0.15 |
| `setWidth` | Negative: mild per-extra-device penalty, so a model that fits on one GPU is not needlessly spread across three | −0.08 |

Weights are org-configurable and expressible as a named profile
("latency-first", "consolidate", "keep-my-laptop-free").

**Gang scheduling.** A multi-device replica is all-or-nothing: either every
shard is admitted or none is. The placer reserves memory on every device in the
set inside a single Postgres transaction before any load begins, and releases
the whole reservation if any shard fails. Two guards against the classic
distributed-scheduling failure where two half-allocated deployments deadlock
each other:

- **Reservations are acquired in a global device order**, so concurrent
  placements take locks in the same sequence and cannot wait circularly.
- **Reservations expire.** One that has not become a running shard within its
  TTL is released, and the placement attempt fails cleanly instead of holding
  memory hostage.

The full `ScoreBreakdown` for the winner **and every rejected candidate** is
persisted to `placement_decisions`. That record is the UI's explanation and the test
suite's fixture.

### 6.3 Lifecycle: load, warm, evict

The lifecycle controller runs a reconciliation loop (~1 Hz, plus event-driven
wakeups) comparing *desired* replica set to *actual*.

Desired state comes from three sources:
- **Pins and reservations** — explicit user intent: "keep `qwen3-30b` warm on
  the 4090, never evict." Always honored; capacity is deducted before anything
  else is considered.
- **Demand** — an EWMA of requests per pool over 1/5/15-minute windows, plus
  the queue right now.
- **Predictive warming** — when a run's plan is compiled, downstream pools are
  known before they are needed. A fan-out to four pools warms all four while
  the planner step is still generating. This is the single largest latency win
  available and it is free: the information already exists in the plan.

Eviction is cost-aware and hysteretic:

```
value(replica) = recency × frequency × reload_cost × pin_multiplier
```

Guardrails, all of which exist to prevent thrash:
- `MIN_RESIDENCY` (default 90s) — a replica cannot be evicted before this
  unless memory pressure is critical.
- Never evict to make room for a model whose demand signal is weaker than the
  victim's.
- Evictions are rate-limited per device per minute.
- A model evicted twice within a window is marked `contended`, surfaced in the
  UI as "these two models are fighting over the 4090," with the honest
  suggestion to pin one or add capacity.

Loading is a BullMQ job with progress events (pull → verify → load → warm →
ready), streamed to the UI. First-token warmup after load is explicit: we send
a tiny synthetic prompt so that `ready` means *actually ready*, not "the
process started."

A distributed load adds a rendezvous. The control plane designates rank 0 as
leader and sends every participating agent the same plan plus its own rank; the
leader starts the runtime's distributed launcher (for vLLM, its Ray-based
multi-node path) and the workers join. The replica reaches `ready` only when the
leader reports the whole group serving. The rendezvous window is generous but
finite: a worker that fails to join in time aborts the entire load and releases
every reservation.

Eviction of a sharded replica is likewise atomic — all shards drain and release
together, and the freed memory on every device becomes available in one step.
Partially-evicted is not a state this system can be in.

### 6.4 Queueing and predicted wait

Each replica has a queue with `max_slots` concurrent slots (§5.3). Service time
is estimated from live EWMAs the agent reports per replica:

```
prefill_ms  ≈ tokens_in / prefill_rate_tps
decode_ms   ≈ expected_tokens_out / decode_rate_tps
service_ms  ≈ prefill_ms + decode_ms

predicted_wait_ms = (queued_work_ms / max_slots) + in_flight_remaining_ms
```

`expected_tokens_out` uses a per-(pool, endpoint) rolling p50 with a
conservative floor, refined as the endpoint accumulates history.

**This number is load-bearing.** It is what `if expected wait > 5s, use …`
evaluates against, it is what `least-wait` routing sorts on, and it is what the
UI displays on every pool chip. A vague estimate makes the whole advanced
feature set dishonest, so: predictions are recorded alongside actuals on every
step, and the ratio is charted. If predicted/actual drifts outside [0.5, 2.0]
at p90, that is a bug with a dashboard, not a tuning opportunity.

### 6.5 Admission control and fairness

Before a run starts:
1. **Auth and rate limit** — per API key and per org, Redis token bucket.
2. **Budget check** — per-run and per-endpoint token/dollar ceilings.
3. **Capacity check** — if every feasible pool's predicted wait exceeds the
   endpoint's `max_queue_ms`, reject immediately with `503` and a `Retry-After`
   rather than accepting work we cannot do. Fast honest failure beats a queue
   that silently grows.

Within an org, fairness across concurrently running flows uses weighted fair
queueing keyed by endpoint, with a per-endpoint concurrency cap. Cross-org
fairness does not exist in v1 because nodes belong to exactly one org — there
is no shared resource to be unfair about. This is a deliberate simplification
that a future shared-capacity feature would have to revisit.

### 6.6 Testing the scheduler

A scheduler cannot be developed against real hardware — the feedback loop is
minutes long and the interesting states (thrash, pressure spikes, node loss
mid-run) are hard to produce on purpose.

Therefore: **a deterministic fleet simulator is part of the product, built
before the scheduler it tests.** It implements the same agent-facing interfaces
with a virtual clock, synthetic token rates, injectable foreign-memory spikes,
and scripted node failures. Scenarios are YAML; assertions are on placement
outcomes and timing.

Scenarios that must exist on day one:

- Cold start: 4 models, 2 devices, verify placement order and warming overlap.
- Thrash trap: two large models, one device, alternating demand → assert
  `MIN_RESIDENCY` and rate limits prevent oscillation.
- Foreign spike: a game opens on the 4090 → assert defensive eviction, not OOM.
- Mac pressure: memory pressure hits `warn` mid-run → assert removal from
  candidacy and graceful in-flight completion.
- Node loss: node disappears mid-fan-out → assert per-branch retry on a
  surviving device and a correct partial-failure policy.
- Fan-out locality: 4 branches, 2 sites → assert branches co-locate to minimize
  cross-site edges.
- Gang scheduling: two 4-GPU placements race for six free GPUs → assert ordered
  reservations, one winner, no deadlock, loser fails cleanly.
- Link-tier refusal: a model needing TP=2 with only a 1 GbE link between
  candidate nodes → assert the cross-node set is rejected and a slower
  single-node placement (or an honest failure) is chosen instead.
- Shard loss: one worker of a TP=4 replica dies → assert the whole replica tears
  down and re-places, with no half-alive deployment left behind.

Every scheduler bug found in production becomes a new simulator scenario before
it is fixed.

---

## 7. The node agent

One Go binary, installed as a system service, that turns a machine into fleet
capacity. Its job description: **inventory the hardware, run the runtimes,
execute leased work, move bytes, and never surprise its owner.**

### 7.1 Internal structure

```
cmd/agent
  internal/
    enroll/      pairing, keypair, cert rotation
    transport/   Connect client, reconnect w/ backoff, stream multiplexing
    inventory/   DeviceProbe implementations (cuda, metal, cpu) + host facts
    runtime/     RuntimeAdapter implementations + supervision
    executor/    lease handling, request execution, streaming
    dataplane/   peer server (accept), peer client (send), grant verification
    telemetry/   sampling, aggregation, batched reporting
    update/      self-update, signature verification, staged rollout
    localui/     127.0.0.1 setup + status page
    tray/        menubar/system-tray (build-tagged)
```

### 7.2 The two interfaces that carry the modularity

```go
type DeviceProbe interface {
    Discover(ctx context.Context) ([]Device, error)
    Sample(ctx context.Context, d *Device) (DeviceSample, error)  // ~1 Hz
}

type RuntimeAdapter interface {
    Kind() string
    Detect(ctx context.Context) ([]RuntimeInstance, error)

    // Capabilities declares which parallelism strategies and degrees this
    // runtime supports, and whether it can span nodes at all. The scheduler
    // never proposes a plan a runtime has not claimed.
    Capabilities() RuntimeCapabilities

    Supports(m ModelSpec, set DeviceSet, p ParallelismPlan) bool
    Pull(ctx context.Context, m ModelSpec, progress chan<- Progress) error

    // Load participates in a possibly-distributed load. Rank 0 is the leader
    // and starts the runtime's own launcher; other ranks join the rendezvous.
    Load(ctx context.Context, req LoadRequest) (ShardHandle, error)

    Unload(ctx context.Context, h ShardHandle) error
    Infer(ctx context.Context, h ShardHandle, req InferRequest) (TokenStream, error)
    Stats(ctx context.Context, h ShardHandle) (ShardStats, error)
}

type RuntimeCapabilities struct {
    TP, PP, EP   DegreeSupport          // supported degrees, e.g. {1,2,4,8}
    MultiNode    bool
    MinLinkTier  map[Strategy]LinkTier  // refuse to plan below this
    LauncherKind string                 // "none" | "ray" | "mpi" | "native"
}

type LoadRequest struct {
    Model      ModelSpec
    Set        DeviceSet       // the whole set, so every rank sees the topology
    Rank       int
    Plan       ParallelismPlan
    Rendezvous RendezvousInfo  // leader address, token, deadline
    Opts       LoadOpts
}
```

Adapters shipped in v1: **Ollama** (HTTP API; `keep_alive` mapped to our
lifecycle control rather than left to Ollama's own timer), **llama.cpp server**,
**vLLM** (OpenAI-compatible; managed as a child process with explicit
`--gpu-memory-utilization`), **MLX** (`mlx_lm.server`, Apple only), and
**LM Studio** (discovery + inference only; its own UI owns loading).

Parallelism support is per-adapter and **declared, never assumed**. vLLM
supports TP and PP and can span nodes through its Ray launcher; llama.cpp can
split layers across machines with its RPC backend, a PP-like shape deferred past
v1; Ollama, MLX, and LM Studio are single-device in v1. Because the scheduler
reads `Capabilities()` and proposes nothing a runtime has not claimed, teaching
an adapter multi-node support later requires no scheduler change at all.

Two orthogonal modes, supported by every adapter:

- **Managed** — we start, configure, supervise, and stop the runtime process.
  Full lifecycle control. The default.
- **Discovered** — the runtime was already running; we inventory what it serves
  and route to it, but never load or unload. Memory it holds counts as
  `foreign`. This is how a user gets value in the first five minutes without
  surrendering control of their machine.

### 7.3 Enrollment and identity

1. User clicks *Add Node*; control plane issues a short-lived pairing code.
2. Agent is installed; its setup page (or `hub enroll <code>`) takes the code.
3. Agent generates an Ed25519 keypair, keeps the private key in the OS keychain
   (Keychain / libsecret / DPAPI) with a file fallback at `0600`.
4. Control plane binds the public key to a node record in the org, and issues a
   short-lived node certificate used for the peer data plane's mTLS.
5. Certificates rotate automatically; a revoked node is refused at connect and
   its outstanding leases are invalidated.

The pairing code is single-use, expires in 15 minutes, and is scoped to one
org. Nodes never move between orgs; re-enrollment creates a new identity.

### 7.4 Leases

Work is authorized by a lease, not by a message. A lease is
`(run_id, step_id, replica_id, slot, expires_at, epoch)`, signed by the control
plane.

- The agent refuses any work whose lease is expired or whose `epoch` is older
  than the replica's current epoch. This is the anti-split-brain mechanism:
  after a control-plane failover, bumping the epoch invalidates every
  in-flight authorization at once.
- Long generations renew mid-stream; a renewal failure aborts the generation
  rather than letting an orphaned run consume a GPU indefinitely.
- Leases are stored in Redis with TTL and mirrored to Postgres only on
  completion.

### 7.5 Being a good guest

The agent runs on machines people use. It must be boringly well-behaved:

- **Owner override always wins.** Local caps on memory, concurrency, and hours
  of availability, settable from the tray or the local page, override anything
  the control plane wants. The control plane is told about the caps and
  schedules within them.
- **Pause and drain** are one click and take effect immediately: no new leases,
  in-flight work finishes or is cancelled per the user's choice.
- **Availability windows** — "only between 22:00 and 07:00", "only on AC
  power", "only when I'm idle for 10 minutes" — are agent-side facts that
  transition the node to `draining` on their own.
- **Resource ceilings are enforced locally**, not merely requested. The agent
  will refuse a load that would breach its own limit even if the scheduler
  told it to.
- **Uninstall is complete** — the service, the binaries, the keys, and any
  runtimes we installed, with a single command.

### 7.6 Fleet upgrade

Agents check a signed manifest, staged by cohort (canary → 10% → rest), with
automatic rollback if a cohort's error rate exceeds a threshold. Version skew
is explicitly supported: the control plane speaks to agents `N` and `N−1`, and
protobuf changes are gated by Buf's breaking-change detection in CI. A fleet
you cannot upgrade safely is a fleet you cannot change.

---

## 8. Flows: the language and the executor

### 8.1 Flow specification

A flow is a versioned JSON document (`flowVersion: 1`) with `nodes` and `edges`.
It is stored in `flow_versions.graph`, round-trips through the canvas losslessly,
and exports as YAML for version control.

Node types in v1:

| Type | Purpose |
|---|---|
| `input` | Entry point. Declares a Zod-expressible input schema. |
| `model` | Call a **pool** (local) or **provider** (external). The workhorse. |
| `prompt` | Template with variable interpolation. |
| `split` | Produce N items from one input: structured-output call, list field, or chunking rule. **Powers dynamic fan-out.** |
| `map` | Run a subgraph once per item, with a concurrency policy. |
| `gather` | Join branches; wait-all, wait-N, or wait-until-deadline. |
| `reduce` | Combine gathered results (concat, rank, or a model call). |
| `route` | Conditional branch on a policy expression. |
| `transform` | Sandboxed JS (QuickJS) for data shaping. |
| `http` | Call an external service. |
| `output` | Exit point; declares the response schema. |

Edges are typed and may carry a `when` predicate. An edge is `data` (carries a
value or a stream handle), `control` (ordering only), or `fallback` (taken when
the source fails or a policy triggers).

**The motivating example, expressed in the language:**

```yaml
flowVersion: 1
nodes:
  - id: in
    type: input
    schema: { task: string }

  - id: planner
    type: model
    target: { provider: anthropic, model: claude-opus-5 }
    params:
      thinking: { type: adaptive }
      effort: high
    output:
      format: json
      schema:
        subtasks:
          type: array
          items: { title: string, prompt: string, kind: string }

  - id: fanout
    type: split
    from: planner.subtasks

  - id: work
    type: map
    over: fanout
    concurrency: { max: 8, strategy: adaptive }
    body:
      - id: worker
        type: model
        target: { pool: local-workers }
        policy:
          route: least-wait
          when:
            - if: "wait_ms > 5000"
              then: { pool: fast-local }
            - if: "wait_ms > 20000 or unavailable"
              then: { provider: anthropic, model: claude-haiku-4-5 }
          timeout_ms: 60000
          retries: { max: 2, backoff: exponential }

  - id: join
    type: gather
    from: work
    mode: wait_all
    partial: { on_failure: continue, min_success: 3 }

  - id: reduce
    type: reduce
    from: join
    via:
      type: model
      target: { provider: anthropic, model: claude-opus-5 }

  - id: out
    type: output
    from: reduce
```

Two things to notice. The `map` node's width is **not fixed at design time** —
it is however many subtasks the planner emitted. And `worker` names a *pool*;
which four machines actually run it, and whether they are the same four next
time, is the scheduler's business.

### 8.2 The policy expression language

Advanced behavior is expressed as predicates over a documented, typed context,
evaluated in the QuickJS sandbox with a 5ms CPU ceiling and no I/O.

Available context:

```
wait_ms, queue_depth, slots_free       — live pool state
tokens_in, est_tokens_out              — this request
cost_per_1k_in, cost_per_1k_out        — the candidate's price
node.site, node.name, device.kind,
device.perf_class, device.available_gb — the candidate placement
run.elapsed_ms, run.budget_remaining_usd, run.tokens_used
attempt, last_error
time.hour, time.weekday
```

Expressions are pure, side-effect-free, and must terminate. If an expression
throws or times out, the `when` clause is treated as false and the event is
surfaced in the run trace — a broken policy degrades to the default path, it
never fails the run.

The UI never *requires* writing an expression: the common cases are a
three-field builder (`wait_ms` / `>` / `5000` → target), with a "switch to
expression" escape hatch that shows the generated code. Round-tripping between
builder and code is supported until an expression becomes too complex for the
builder, at which point the node is marked expression-only.

### 8.3 Compilation

`FlowVersion.graph` → `compiled_plan`, once, at publish time:

1. **Validate** — DAG acyclicity (except `map` bodies, which are subgraphs),
   type-compatible edges, every referenced pool/provider exists and is
   reachable, every expression parses.
2. **Resolve** — pools and providers to concrete candidate sets; static errors
   here are far better than runtime surprises.
3. **Plan** — topological levels, parallelizable groups, predicted warm-set
   (which pools to pre-warm and when), transport hints per edge.
4. **Estimate** — expected cost and latency range, shown in the UI before
   publish. "This flow will cost roughly $0.04 and take 8–20s" is the single
   most useful thing we can tell a user at design time.

Compilation is pure and fast; it runs on every canvas edit (debounced) to power
live validation, and authoritatively at publish.

### 8.4 Execution

The executor is a small state machine over `run_steps` rows.

- **Step lifecycle:** `pending → scheduled → running → (succeeded | failed |
  interrupted)`. Transitions are transactional; an outbox row is written in the
  same transaction as the state change, and a background dispatcher publishes
  events. This is what makes crash recovery correct.
- **Streaming:** model output is a `TokenStream`. If the consumer is another
  step on the same site, the executor issues a direct-peer grant and the bytes
  never touch the control plane. If the consumer is the client, tokens are
  forwarded over SSE. If the consumer is a `gather`, the stream is buffered to
  a size-capped store (memory, spilling to S3-compatible object storage beyond
  a threshold).
- **Backpressure:** a slow consumer propagates. A client that stops reading
  causes the executor to pause the producing replica rather than buffer without
  limit.
- **Cancellation:** client disconnect cancels the run; cancellation propagates
  to every in-flight step, releases leases, and frees slots within one
  heartbeat.
- **Retry:** per-node policy — attempts, backoff, and an optional different
  target on retry ("try the local pool twice, then fall back to the API").
  Retries are new `run_steps` rows with an incremented `attempt`, never
  mutations, so the trace shows the whole history.
- **Deadlines and budgets:** a run carries a wall-clock deadline and a dollar
  budget. Both are checked before each step dispatch and enforced mid-stream
  for long generations.
- **Partial failure:** `gather` declares its own semantics — `wait_all`,
  `min_success: N`, or `best_effort_by: <deadline>`. The four-way fan-out where
  one branch dies should, by default, still produce an answer from three.
- **Idempotency:** clients may pass an idempotency key; replaying it returns
  the original run rather than re-executing.

---

## 9. API surface

### 9.1 Public inference API

Every published endpoint is callable three ways. The first two exist so that
existing client code works without modification; the third exists because the
first two cannot express what this system knows.

**OpenAI-compatible** — `POST /v1/chat/completions` with
`model: "<endpoint-slug>"`, streaming via SSE. Any OpenAI client library, any
existing app, zero changes.

**Anthropic-compatible** — `POST /v1/messages`, same idea, so that clients
written against `@anthropic-ai/sdk` point at us by changing `baseURL`.

**Native** — `POST /v1/endpoints/{slug}/runs`, which returns a far richer SSE
event stream:

```
event: run.started       { run_id, plan_summary }
event: step.scheduled    { step, pool, replica, node, device, predicted_wait_ms }
event: step.started      { step, replica }
event: step.delta        { step, text }
event: step.finished     { step, tokens, ms, cost_usd }
event: placement.decided { step, chosen, scores, rejected }
event: run.finished      { output, usage, cost_usd, timings }
```

The native API is what the web app consumes, and it is the reason the UI can
show a live trace rather than a spinner. It is documented and public — anyone
building on Model Hub gets the same visibility the first-party UI has.

### 9.2 Management API

Typed Connect RPC, generated from protobuf, consumed by both the SPA and any
programmatic client. Services: `Orgs`, `Nodes`, `Devices`, `Models`, `Pools`,
`Providers`, `Flows`, `Endpoints`, `Runs`, `Telemetry`.

An OpenAPI document is generated from the same schemas for REST consumers.

**Everything the UI can do, the API can do.** No management action is
UI-exclusive. This is a hard rule: it keeps the UI honest, makes the system
scriptable, and means infrastructure-as-code is possible without a second
implementation.

### 9.3 Authentication

- **Users:** session cookies (Better Auth), org-scoped roles — `owner`,
  `admin`, `developer`, `viewer`.
- **Programs:** API keys, org-scoped, prefixed and displayed once, hashed at
  rest, with per-key rate limits and optional endpoint allowlists.
- **Agents:** node certificates (§7.3), never API keys.

---

## 10. Web application

The UX problem is the hardest design problem in this project. The system is
genuinely complex — memory budgets, queues, placement scores, policy
expressions — and the failure mode of every tool in this space is exposing all
of it at once.

### 10.1 Three surfaces

**Flows** — the canvas. Where you build and publish.
**Fleet** — your machines, devices, models, and what is resident where.
**Runs** — traces, timings, costs, and failures.

That is the entire top-level navigation. Everything else is reachable from
within these three.

### 10.2 Progressive disclosure

Three levels, controlled by one persistent toggle plus per-node expansion:

**Level 1 — Simple (default).** A model node is a box with: the pool name, a
status chip (`warm` · `cold` · `queued 3` · `unavailable`), and a live wait
estimate. Edges are lines. Publishing asks for a name and gives you a URL.
A user who never leaves this level still gets automatic placement, automatic
loading, failover, and queueing — the defaults are good, and nothing on this
screen says the word "scheduler."

**Level 2 — Advanced (one toggle).** Each node grows a policy panel:
placement constraints (site / node / device class), routing strategy, fallback
rules built with the three-field builder, timeouts, retries, and concurrency.
Edges reveal conditions. The canvas gains a per-node heat overlay showing where
time and money actually go.

**Level 3 — Expert (per-node "..." menu).** Raw expression editor, weight
overrides for the placement scorer, explicit replica pinning, manual transport
selection, and the raw compiled plan as JSON.

The rule that makes this work: **Level 1 is never a lie.** It shows fewer
controls, not a simplified model of reality. The status chip on a simple node
is the same live data the expert view uses. A user who toggles Advanced should
recognize everything they were already looking at, with more detail — never
discover that the simple view was a different system.

### 10.3 The explanation panel

Any step in any run expands into:

> **Why here?** `llama-3.3-70b` ran on `4090-box / GPU 0`.
> Residency 1.00 · Wait 0.82 · Fit 0.71 · Perf 0.90 · Locality 1.00 → **0.89**
> Runner-up: `mac-studio / GPU` → 0.61 (would have required evicting
> `qwen3-30b`, reload cost 47s)
> Queued 120ms · Prefill 310ms · Decode 4.2s · 1,203 tokens · $0.00

This panel is the antidote to magic. A scheduler whose decisions cannot be
interrogated will not be trusted with anyone's hardware, and a user who cannot
see why something was slow cannot fix it.

### 10.4 Fleet view

Each node is a card: device bars showing `managed` / `foreign` / `free` memory
as distinct segments (the distinction matters and users understand it
immediately when shown), resident shards with pin controls — a replica spanning
several devices renders as one object bridging their bars, labeled with its
parallelism plan — live
utilization sparklines, and the node's own caps and availability window.

Fleet-level affordances: drain a node, pause the fleet, pin a model, add
capacity, and a **contention view** that names the actual problem —
"`qwen3-30b` and `llama-3.3-70b` have swapped on GPU 0 eleven times in the last
hour; pin one or reduce concurrency."

### 10.5 Onboarding

The first-run path is the whole product's credibility, and it is five minutes:

1. Sign up, create an org.
2. *Add your first machine* → platform-specific one-liner, copied to clipboard.
3. Agent appears in Fleet within seconds; discovered Ollama models are listed
   without the user having granted anything.
4. *Try it* → a prefilled single-model flow, one click to publish, a live
   response.
5. *Add a second machine* → the same flow, now with a second option, and the
   first genuine placement decision to look at.

Only after that does the product mention fan-out, policies, or pools.

---

## 11. Observability

**Traces.** Every run is an OpenTelemetry trace; every step a span. Attributes
carry pool, replica, node, device, tokens, and cost. Exportable to any OTLP
backend; the built-in Runs view reads the same data from Postgres.

**Metrics.** Agents sample at ~1 Hz and report batched every 5s: per-device
memory (split `managed` / `foreign` / `free`), utilization, temperature, power;
per-replica queue depth, slots in use, prefill and decode rates, error counts.
Stored in TimescaleDB hypertables with continuous aggregates at 1m/5m/1h and a
retention policy (raw 7d, 1m 30d, 1h 1y).

**Costs.** Local inference is not free and pretending otherwise makes the
"local vs. API" comparison useless. Each org sets an energy price and optional
per-node amortization; local step cost is estimated from measured power draw ×
duration. External provider steps use real token pricing. The comparison the
product should be able to make — *this flow costs $0.004 locally and $0.11 on
the API, and is 3× slower* — is only possible if both sides are measured.

**Logs.** Structured JSON, correlated by `run_id` / `step_id` / `node_id`.
Agents ship a bounded, redacted tail; prompt content is never logged at the
agent by default.

**Health.** Node heartbeat every 5s; missed 3 → `degraded`; missed 6 →
`offline` with lease invalidation. Replica health probes catch the case that
matters most: a runtime process that is alive but wedged.

---

## 12. Security and multi-tenancy

**Isolation.** Every table with tenant data carries `org_id`; Postgres
row-level security is enabled and the application connects as a role that
cannot bypass it. Belt and braces, because a cross-tenant leak in a system that
holds people's prompts and runs on their hardware is unrecoverable.

**Transport.** TLS everywhere. Agent → control plane over TLS with certificate
pinning. Peer data plane over mTLS using node certificates, with per-edge
grants that are single-use, expiring, and scoped to `(run_id, edge_id,
peer_node_id)`.

**Secrets.** Provider API keys are envelope-encrypted; the data key lives in
KMS (or an env-provided key for self-hosted). Keys are decrypted only in the
executor at call time and never written to logs, traces, or the agent.

**Untrusted code.** `transform` nodes and policy expressions run in QuickJS
with no I/O, capped memory, and an instruction budget. The agent never executes
user-supplied code — it runs model runtimes and nothing else. This is a
deliberate limit: it means the agent's blast radius is bounded by what the
runtime binaries themselves can do.

**Prompt privacy.** Relay transport means the control plane sees prompt
content. This must be stated plainly in the product, not buried. Mitigations:
prompt logging off by default, configurable retention including
zero-retention mode, and direct transport (which bypasses the control plane
entirely) as the privacy-preserving path for users who can use it. A
self-hosted control plane remains the complete answer for anyone who needs one.

**Abuse.** Per-key and per-org rate limits, run budgets, and a global cap on
concurrent runs per org. Agents refuse work beyond their local caps regardless
of instruction.

---

## 13. Failure modes

| Failure | Behavior |
|---|---|
| Node goes offline mid-step | Lease invalidated; step retried per policy on another replica; if none feasible, step fails and `gather` partial-failure policy applies. |
| Node offline mid-fan-out | Only the affected branches retry; siblings continue. |
| Node hosting one shard of a sharded replica goes offline | The whole replica is marked `failed` and every shard torn down; in-flight steps retry elsewhere per policy. A half-alive distributed deployment is never kept. |
| Rendezvous times out during a distributed load | Load aborts, reservations released on every device, placement retried with the unresponsive node excluded. |
| Inter-node link degrades below the plan's tier floor | Replica marked `degraded`; no new leases routed to it; drained and re-placed once in-flight work finishes. |
| Control plane restarts mid-run | Runs resume at step boundaries from the outbox. In-flight streaming steps are marked `interrupted` and retried. |
| Runtime process crashes | Agent detects, marks replica `failed`, reports, and restarts it if the load was managed. Scheduler re-places. |
| Device OOM | Replica marked `failed`; footprint profile corrected upward with the observed value; device headroom increased adaptively; placement retried elsewhere. |
| Foreign memory spike | Defensive eviction of lowest-value replicas before the allocator fails. |
| Mac memory pressure critical | Device leaves candidacy; proactive eviction; in-flight work allowed to finish. |
| Direct peer connection fails | Silent downgrade to relay; logged; the site's direct-eligibility is re-probed on a backoff. |
| Provider API 429 / refusal | Retry with backoff; `refusal` stop reason routed to the node's fallback target if one is configured. |
| Queue exceeds `max_queue_ms` | Admission rejects with `503` + `Retry-After` rather than accepting unbounded work. |
| Expression throws or times out | `when` evaluates false; default path taken; surfaced in the trace. |
| Agent version too old | Refused at connect with a clear upgrade instruction; node shows as `needs-upgrade` in Fleet. |

---

## 14. Testing strategy

**Unit — pure functions first.** The memory math, the placement scorer, the
eviction chooser, the queue estimator, and the flow compiler are all pure and
all tested in isolation with table-driven cases. These are the functions where
bugs are expensive and reproduction is otherwise hard, so they are deliberately
designed to be pure.

**Simulator — the scheduler's real test bed (§6.6).** Built before the
scheduler. Deterministic virtual clock, scripted fleets, injectable failures.
Every production scheduler bug becomes a scenario.

**Contract — protobuf and adapters.** Buf breaking-change detection in CI.
Every `RuntimeAdapter` runs the same conformance suite against a real runtime
in Docker (tiny models: `qwen3:0.6b`, `smollm2:135m`) so adapters cannot drift
apart in behavior.

**Integration — docker-compose.** Control plane, Postgres, Redis, two agents
with a mock runtime adapter, exercising enrollment, placement, execution, and
failure injection end to end.

**End-to-end — real inference in CI.** A Linux runner with real Ollama and a
tiny model, publishing a flow and calling its endpoint. Slow, few in number,
and the only tests that prove the whole thing actually works.

**Load.** k6 against a simulated fleet, asserting scheduler decision latency
(p99 < 50ms) and correct behavior under admission pressure.

**Manual, on real hardware.** A documented checklist run on the actual Mac +
NVIDIA fleet before each release. Some things — thermal throttling, macOS
memory pressure under real load, driver quirks — cannot be simulated honestly.

---

## 15. Deployment

**Control plane:** container; Postgres 16 + TimescaleDB managed (Neon or
equivalent); Redis managed; object storage S3-compatible (R2) for spilled
intermediates and agent artifacts. Stateless and horizontally scalable; the
executor uses advisory locks so exactly one instance owns a given run.

**Web app:** static build on a CDN.

**Agents:** GoReleaser artifacts on GitHub Releases — notarized `.pkg` (macOS),
`.deb`/`.rpm` and a tarball (Linux), MSI (Windows) — behind a signed manifest
the self-updater reads.

**Environments:** `dev` (docker-compose, local agents), `staging` (full deploy,
canary cohort), `production`.

**Migrations:** Drizzle, forward-only, applied on deploy, backwards-compatible
for one version so a rollback never strands the database.

---

## 16. Build order

The whole architecture is specified above; it is built in ten slices. Each
slice ends at something demonstrable, and each becomes its own implementation
plan. Slices 1–3 are the spine — nothing later is meaningful without them.

| # | Slice | Ends when you can… |
|---|---|---|
| **1** | **Foundations** — monorepo, Buf/proto, control-plane skeleton, auth + orgs, agent enrollment, heartbeat, device inventory, Fleet page | …install the agent on the Mac and the 4090 box and see both machines, with correct memory numbers, in a browser. |
| **2** | **Runtimes and manual placement** — `RuntimeAdapter` (Ollama first), model catalog, explicit load/unload, single-pool OpenAI-compatible endpoint, relay transport | …load a model onto a chosen device from the UI and get a real streaming completion through your own API. |
| **3** | **Scheduler core** — accounting, feasibility, scorer, queue/predicted-wait, admission, **simulator first**, placement explanations; DeviceSet-shaped interfaces with single-device enumeration | …stop choosing devices by hand, and see exactly why the scheduler chose what it chose. |
| **4** | **Lifecycle** — autoload, cost-aware eviction with hysteresis, pins and reservations, predictive warming, contention detection | …leave it alone and have models load, evict, and stay warm sensibly under changing demand. |
| **5** | **Distributed deployments** — interconnect probing and link tiers, DeviceSet enumeration, `ParallelismPlanner`, gang scheduling with ordered expiring reservations, rendezvous + atomic eviction, vLLM TP within a node then PP across nodes | …serve a model too large for any single GPU by having the scheduler pick the devices and the parallelism strategy for you. |
| **6** | **Flow engine** — flow schema, compiler, executor, `run_steps` + outbox, native SSE API, linear → fan-out → dynamic `map`/`gather`/`reduce` | …run the motivating example: Opus 5 splits a task, four local models work in parallel across two machines, results reduce into one answer. |
| **7** | **Canvas** — React Flow editor, Level 1 simple mode, Level 2 advanced policies, the builder→expression escape hatch, publish flow, live validation | …build and publish that flow by drawing it, without writing JSON. |
| **8** | **Observability** — TimescaleDB telemetry, dashboards, run traces, cost model (energy + API), contention view | …answer "what is slow, what is expensive, and what is fighting over the 4090?" |
| **9** | **Direct data plane** — peer mTLS server, signed grants, site detection, transport negotiation, direct-to-client streaming | …keep LAN traffic on the LAN, with automatic relay fallback. |
| **10** | **Hardening** — quotas, rate limits, RLS audit, fleet self-update with cohorts, remaining adapters (MLX, llama.cpp, LM Studio), billing hooks | …hand it to someone who is not you. |

Slices 6 and 7 may proceed in parallel with 4 and 5 once 3 is stable; 9 and 10
are independent of each other.

One sequencing note that is easy to get wrong: slice 3 ships with the
DeviceSet-shaped interfaces of §6.1 already in place, but with enumeration
limited to single devices. Slice 5 then widens the enumerator and adds the
planner — it does not rewrite the scheduler. Building slice 3 against a
single-`Device` interface and generalizing later would mean touching every
strategy, every test fixture, and every persisted `placement_decision`.

---

## 17. Open questions

Deliberately unresolved, to be decided with evidence rather than guessed now:

1. **Better Auth vs. a hosted vendor.** Specified as Better Auth behind an
   `AuthProvider` interface. If self-hosted session security becomes a time
   sink during slice 1, swapping to Clerk or WorkOS should cost a day.
2. **Footprint prediction accuracy.** The formula in §5.3 will be wrong for
   MoE models, speculative decoding, and vision models. The measure-and-correct
   loop is designed for this, but if p90 error exceeds ~15% after slice 4, the
   footprint model needs per-architecture handling rather than one formula.
3. **Pools as an explicit first-class UI object.** The domain model has them
   from the start. Whether users see a "Pools" tab in v1 or only see pools
   implicitly through model nodes is a UX call best made against slice 7's
   first real users.
4. **`gather` semantics for streaming reducers.** Buffering the whole branch
   output before reducing is simple and correct; streaming reduction is better
   for latency. Start buffered; revisit with real traces.
5. **Cross-org shared capacity.** Explicitly out of scope, but it is the
   obvious future ask ("let my friend's box join my fleet"). Nothing in this
   design should make it impossible — worth a check at the end of slice 10.
6. **Windows support depth.** The agent targets Windows, but NVML behavior,
   service installation, and WSL interactions are least understood. Treat
   Windows as best-effort until slice 10.
7. **Choosing the parallelism degree.** The planner will pick TP=2 vs. TP=4
   from footprint and link tier. Whether that heuristic beats simply measuring
   — load each viable degree once, keep the fastest, cache the result per
   `(model, device kind)` — is genuinely unknown. Measurement costs minutes of
   one-time work per model and may just be better. Decide with data in slice 5,
   not now.
8. **Apple Silicon distributed inference.** MLX has a distributed backend, but
   whether multi-Mac serving over Thunderbolt or 10 GbE is worth orchestrating
   is unproven. Apple nodes are single-device in v1; revisit if the fleet makes
   it worth measuring.
