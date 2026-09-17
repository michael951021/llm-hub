# Model Hub Control Plane — UML

The control plane is `apps/control-plane` (Fastify + Connect RPC + Drizzle
over Postgres + Redis) and `apps/web` (a React SPA served separately by
Vite in dev). Together they authenticate agents, record what a fleet
reports, and let a signed-in browser see it. Slice 1 stops at enroll /
authenticate / stream / display — no model execution.

---

## 1. Deployment / component view

```mermaid
flowchart TB
    subgraph Browser["Browser — React SPA (apps/web)"]
        SPA["fleetClient (Connect-Web)\nauthClient (Better Auth fetch)"]
    end

    subgraph AgentProc["Go Agent process (installed on owned hardware)"]
        AgentClient["NodeServiceClient\n(agent/internal/transport)"]
    end

    subgraph CP["apps/control-plane — one Node.js process (main.ts)"]
        BuildApp["buildApp()\nFastify, plain HTTP/1.1, no TLS\nlistens on PORT (3000)"]
        BuildAgentApp["buildAgentApp()\nFastify, http2: true (cleartext h2c)\nlistens on AGENT_PORT (3001)"]
        Sweeper["offline-sweeper job\n(setInterval, same process)"]
    end

    PG[("Postgres\n(timescaledb/pg16)")]
    Redis[("Redis")]

    SPA -- "HTTP/1.1, cookies, same-origin\n/api/auth/*, /api/me, FleetService" --> BuildApp
    AgentClient -- "h2c HTTP/2, bidi stream\nAuthorization: ModelHubNode ...\nNodeService.Enroll / .Connect" --> BuildAgentApp

    BuildApp -- "db (RLS, role modelhub_app)\nownerDb (bypass, for /api/auth self-heal)" --> PG
    BuildAgentApp -- "db (RLS) for withOrg()\nownerDb for enroll/auth (no org yet)" --> PG
    BuildApp --> Redis
    BuildAgentApp -- "node-auth nonce replay cache" --> Redis
    Sweeper --> PG
```

**What this tells you.** This is two separate Fastify *instances* in one
process, not one server with two routes — and that split is forced, not
stylistic. `NodeService.Connect` is a true bidirectional stream, which needs
real HTTP/2 framing; `buildAgentApp()` gets that cheaply in dev by serving
cleartext h2c (`http2: true`, no TLS). Browsers, unlike this repo's own Go
agent, **cannot** speak h2c at all — HTTP/2 in a browser requires
TLS/ALPN negotiation — so the browser-facing `buildApp()` has to stay plain
HTTP/1.1. One port genuinely cannot serve both audiences; that's why
`AGENT_PORT` (3001) and `PORT` (3000) exist as two independent listeners in
one `main.ts`, both created and torn down together on `SIGINT`/`SIGTERM`.

---

## 2. Module structure

```mermaid
flowchart TD
    subgraph leaf["Infra leaves"]
        env["env.ts\nzod-validated process.env"]
        redis["redis.ts\nioredis client"]
    end

    subgraph auth["src/auth/*"]
        authTs["auth.ts\nBetter Auth config,\nensurePersonalOrganization()"]
        session["session.ts\nrequireSession() + self-heal"]
    end

    subgraph domain["src/domain/*  (SQL lives here — no Connect)"]
        nodesD["nodes.ts\nenrollNode, recordInventory,\nrecordSamples, markNodeOnline"]
        pairingD["pairing.ts\nmintPairingCode, redeemPairingCode,\nhashCode"]
        viewsD["views.ts\nbuildNodeView / buildDeviceView"]
    end

    subgraph rpc["src/rpc/*  (wire mapping lives here — no SQL, one exception noted below)"]
        fleetSvc["fleet-service.ts\nFleetService handlers"]
        nodeSvc["node-service.ts\nNodeService handlers"]
        nodeAuth["node-auth.ts\nauthenticateNode()"]
        rpcIndex["index.ts\nbrowserRoutes / agentRoutes"]
    end

    subgraph jobs["src/jobs/*"]
        sweeperJ["offline-sweeper.ts"]
    end

    subgraph servers["src/app.ts, agent-app.ts, main.ts"]
        appTs["app.ts / agent-app.ts\nmount routes on Fastify"]
        mainTs["main.ts\nboots both servers + sweeper"]
    end

    authTs --> env
    session --> authTs
    pairingD --> env
    nodesD --> pairingD

    fleetSvc --> session
    fleetSvc --> pairingD
    fleetSvc --> viewsD
    nodeSvc --> nodesD
    nodeSvc --> pairingD
    nodeSvc --> nodeAuth
    nodeSvc --> env
    nodeAuth --> env
    nodeAuth --> redis
    rpcIndex --> fleetSvc
    rpcIndex --> nodeSvc
    sweeperJ --> env

    appTs --> rpcIndex
    appTs --> authTs
    appTs --> session
    appTs --> env
    appTs --> redis
    mainTs --> appTs
    mainTs --> sweeperJ

    subgraph pkgs["workspace packages"]
        core["@modelhub/core\nmemory.ts: computeBudget()"]
        db["@modelhub/db\nschema + client: db, ownerDb, withOrg()"]
        proto["@modelhub/proto\ngenerated Connect services + messages"]
    end

    viewsD --> core
    nodesD --> db
    pairingD --> db
    authTs --> db
    nodeAuth --> db
    sweeperJ --> db
    fleetSvc --> db
    fleetSvc --> proto
    nodeSvc --> proto
```

**What this tells you — the layering rule, and its one honest exception.**
`domain/*` is where every `select`/`insert`/`update`/transaction lives, and
it imports nothing from `@connectrpc/connect` or the generated proto types —
it takes and returns plain interfaces (`EnrollInput`, `DeviceRow`, `NodeRow`).
`rpc/*` is where every Connect handler and wire-shape mapping lives, and it
imports no SQL — **with one exception, stated plainly rather than smoothed
over**: `rpc/node-auth.ts` runs its own `ownerDb.select(...).from(nodes)`
directly rather than going through `domain/nodes.ts`, because the query it
needs (look up a node by ID, get back its public key) doesn't correspond to
any domain operation the rest of the app needs, and it also owns the Redis
nonce-replay check that has no natural home in `domain/*` either. Every
other `rpc/*` file honors the rule. `domain/views.ts` is the only file that
touches `@modelhub/core`: `computeBudget()` runs exactly once, server-side,
on the read path (see §7).

---

## 3. Data model

Two related schemas, split because they carry very different trust levels
(see the RLS diagram, §4). `organization` is the bridge between them.

### 3a. Better Auth's own tables — no row-level security

```mermaid
classDiagram
    class user {
        id text PK
        name text
        email text UNIQUE
        emailVerified boolean
        image text?
        createdAt timestamp
        updatedAt timestamp
    }
    class session {
        id text PK
        expiresAt timestamp
        token text UNIQUE
        userId text FK
        activeOrganizationId text?
        ipAddress text?
        userAgent text?
    }
    class account {
        id text PK
        accountId text
        providerId text
        userId text FK
        password text?
        accessToken text?
        refreshToken text?
    }
    class verification {
        id text PK
        identifier text
        value text
        expiresAt timestamp
    }
    class organization {
        id text PK "org_&lt;hex&gt;, custom generateId"
        name text
        slug text UNIQUE
        logo text?
        metadata text?
    }
    class member {
        id text PK
        organizationId text FK
        userId text FK
        role text
    }
    class invitation {
        id text PK
        organizationId text FK
        email text
        role text?
        status text
        inviterId text FK
    }

    user "1" --> "many" session : userId
    user "1" --> "many" account : userId
    organization "1" --> "many" member : organizationId
    user "1" --> "many" member : userId
    organization "1" --> "many" invitation : organizationId
    user "1" --> "many" invitation : inviterId
```

### 3b. Fleet tables — row-level security enabled

```mermaid
classDiagram
    class organization {
        id text PK
        "(same table as 3a — the bridge)"
    }
    class nodes {
        id uuid PK
        orgId text FK
        name text
        status text "online | degraded | offline"
        platform text
        arch text
        osVersion text
        agentVersion text
        hostname text
        totalMemoryBytes bigint
        cpuCores int
        publicKey bytea UNIQUE
        siteId text?
        lastSeenAt timestamp?
        createdAt timestamp
    }
    class devices {
        id uuid PK
        orgId text FK "denormalized from nodes — RLS is a flat column check"
        nodeId uuid FK
        localId text
        kind text "cpu | cuda | metal"
        index int
        name text
        totalBytes bigint
        wiredLimitBytes bigint
        driverVersion text
        computeCapability text
        interactive boolean
        lastUsedBytes bigint
        lastManagedBytes bigint
        lastUtilization double
        lastPressure text
        lastSampleAt timestamp?
        UNIQUE nodeId+localId
    }
    class pairing_codes {
        id uuid PK
        orgId text FK
        codeHash text UNIQUE
        nodeName text
        createdBy text
        expiresAt timestamp
        usedAt timestamp?
        usedByNodeId uuid FK?
        createdAt timestamp
    }

    organization "1" --> "many" nodes : orgId
    organization "1" --> "many" devices : orgId (denormalized)
    organization "1" --> "many" pairing_codes : orgId
    nodes "1" --> "many" devices : nodeId
    nodes "0..1" --> "0..1" pairing_codes : usedByNodeId
```

**Which tables carry RLS, and why.** `nodes`, `devices`, and `pairing_codes`
have `ENABLE ROW LEVEL SECURITY` plus an identical-shaped policy each
(`org_id = current_setting('app.current_org_id', true)`, both `USING` and
`WITH CHECK`) — see `packages/db/migrations/0001_roles_and_rls.sql`. These
are the tables holding tenant secrets or tenant-owned hardware facts: a bug
that forgets to scope a query here should return *nothing*, not another
org's GPUs. `user`, `session`, `account`, `verification`, `organization`,
`member`, and `invitation` carry **no** RLS — they're Better Auth's own
tables, and Better Auth's adapter needs unrestricted access to them to do
things like "find the user by email across all orgs" during sign-in, which
is not an org-scoped operation by nature. `devices.orgId` is deliberately
denormalized from `nodes.orgId` specifically so its RLS policy is a flat
column comparison rather than a subquery joining out to `nodes` on every row.

---

## 4. Database access model: `withOrg()` vs. `ownerDb`

```mermaid
flowchart LR
    subgraph has_org["Caller already has an org context"]
        browserReq["Browser session request\n(FleetService: listNodes, getNode, createPairingCode)"]
        agentStream["Authenticated agent stream\n(NodeService.connect: hello/inventory/samples)"]
        enrollInsert["enrollNode's own insert,\nafter redeemPairingCode resolves the org"]
    end

    subgraph no_org["Caller has no org context yet"]
        enrollCheck["enrollNode's dup public-key check"]
        redeem["redeemPairingCode\n(the code IS what establishes the org)"]
        authNode["authenticateNode\n(node lookup by id — org is the OUTPUT)"]
        sweep["sweepOfflineNodes\n(fleet-wide; touches only status)"]
    end

    has_org --> withOrg["withOrg(orgId, fn)\ndb.transaction as modelhub_app\nSET app.current_org_id (tx-local)\nRLS enforced by Postgres"]
    no_org --> ownerDb["ownerDb\nrole modelhub_owner\nno RLS — bypasses it entirely"]

    withOrg --> PG[("Postgres")]
    ownerDb --> PG
```

**What this tells you.** `withOrg()` is not a query filter bolted on in
application code — it sets a transaction-local Postgres session variable
(`set_config('app.current_org_id', orgId, true)`) and lets the RLS policies
in §3b do the actual enforcement, so even a handler that writes a careless
query still can't cross tenants. `ownerDb` exists for exactly the requests
where that's structurally impossible: enrollment and node authentication
both run *before* an org is known — the pairing code or the node row **is**
how the org gets determined — so there is nothing to scope the RLS session
variable to yet. `packages/db/src/client.ts`'s `db`/`appSql` (RLS-bound,
`DATABASE_URL`) and `ownerDb`/`ownerSql` (RLS-bypassing,
`DATABASE_OWNER_URL`) are two separate connection pools for exactly this
reason — same schema, deliberately different privilege. The offline sweeper
also uses `ownerDb`: it's a fleet-wide background job with no single org
context, and it only ever flips a `status` column, so there's no tenant data
it could leak by bypassing RLS.

---

## 5. Sequence diagrams

### 5a. Sign-up, organization creation, and the self-heal path

```mermaid
sequenceDiagram
    actor User
    participant Browser as SignUpForm (apps/web)
    participant AC as authClient
    participant App as buildApp() /api/auth/*
    participant BA as Better Auth
    participant Hook as databaseHooks.user.create.after
    participant Later as a later request<br/>(e.g. GET /api/me)
    participant Sess as requireSession()

    User->>Browser: submits name/email/password
    Browser->>AC: signUp.email({name, email, password})
    AC->>App: POST /api/auth/sign-up/email
    App->>BA: auth.handler(request)
    BA->>BA: create user + account rows (transaction, generateId → hex id)
    BA-->>Hook: queueAfterTransactionHook (runs AFTER commit)
    Hook->>Hook: ensurePersonalOrganization(user)\nslug=org-<hex>, name="<user>'s fleet"
    alt organization created successfully
        Hook->>Hook: organization + member rows inserted
    else creation throws
        Hook->>Hook: caught, logged — NOT rethrown\n(user/account already committed; sign-up must not fail)
    end
    BA-->>App: 200, session cookie set
    App-->>Browser: sign-up succeeds regardless of hook outcome
    Browser->>Browser: navigate to "/"

    Note over Later,Sess: any later authenticated request
    Later->>Sess: requireSession(req)
    Sess->>BA: getSession(headers)
    Sess->>Sess: orgId = session.activeOrganizationId ?? listOrganizations()[0]
    alt orgId found
        Sess-->>Later: {userId, orgId}
    else still no org (hook failed earlier)
        Sess->>Sess: self-heal: ensurePersonalOrganization(session.user) again
        alt self-heal succeeds
            Sess-->>Later: {userId, orgId}
        else self-heal also fails
            Sess-->>Later: throws HttpError(403, "no_organization")
        end
    end
```

**What this tells you.** The org-creation hook is deliberately non-fatal —
it runs after the sign-up transaction has already committed, so throwing
would strand an already-real user behind a failed sign-up call they can't
retry (their email is taken). The fix is deferred to the one place the
invariant actually matters: `requireSession()`, which every authenticated
request already goes through, retries `ensurePersonalOrganization` lazily
using the exact same naming/slug logic — so whichever path fires, the
resulting organization looks the same.

### 5b. Pairing-code mint and redeem

```mermaid
sequenceDiagram
    actor Operator
    participant UI as AddNodeDialog (apps/web)
    participant FC as fleetClient
    participant FS as FleetService.createPairingCode
    participant Pair as domain/pairing.ts

    Operator->>UI: "Generate pairing code"
    UI->>FC: createPairingCode({nodeName})
    FC->>FS: Connect RPC, PORT 3000, session cookie
    FS->>FS: session(ctx) → requireSession → {orgId, userId}
    FS->>Pair: mintPairingCode(orgId, userId, nodeName)
    Pair->>Pair: code = 8 chars from a 32-symbol alphabet (no I/O/0/1)
    Pair->>Pair: withOrg(orgId): insert pairing_codes{codeHash: hashCode(code), expiresAt}
    Pair-->>FS: {code, expiresAt}
    FS-->>UI: {code, expiresAtUnixMs}
    UI-->>Operator: shows code + `modelhub-agent enroll --code ... --server ...`

    Note over Operator: operator runs the agent on a new machine

    participant CLI as modelhub-agent enroll
    participant NS as NodeService.enroll
    participant NodesD as domain/nodes.ts

    Operator->>CLI: enter the code
    CLI->>NS: EnrollRequest{pairingCode, publicKey, nodeName, host}
    NS->>NodesD: enrollNode(input)
    NodesD->>Pair: redeemPairingCode(code)
    Pair->>Pair: hash = hashCode(code) [HMAC-SHA256, keyed by PAIRING_CODE_PEPPER]
    Pair->>Pair: ownerDb UPDATE pairing_codes SET used_at=now()\nWHERE code_hash=hash AND used_at IS NULL — atomic claim
    alt no row updated
        Pair-->>NodesD: throws "already used" or "unknown pairing code"
    else claimed but expired
        Pair->>Pair: release (used_at=null) so retry sees a stable "expired" message
        Pair-->>NodesD: throws "pairing code expired"
    else claimed and valid
        Pair-->>NodesD: {orgId, nodeName, pairingCodeId}
        NodesD->>NodesD: withOrg(orgId): insert nodes row
        NodesD-->>NS: {nodeId, orgId, orgName}
    end
```

**What this tells you.** The code's confidentiality rests on
`PAIRING_CODE_PEPPER`, an application secret never stored alongside
`code_hash` — a leak of the `pairing_codes` table alone (backup, scoped
read-only breach) isn't enough to brute-force the ~40-bit codespace offline.
Redemption is race-safe by construction: the `UPDATE ... WHERE used_at IS
NULL ... RETURNING` is the atomicity boundary, not an application-level
check-then-act.

### 5c. Node authentication (`authenticateNode`)

```mermaid
sequenceDiagram
    participant Agent as agent (transport.Session)
    participant NS as NodeService.connect
    participant Auth as rpc/node-auth.ts
    participant PG as Postgres (ownerDb)
    participant Redis

    Agent->>Agent: AuthHeader(nodeID, priv, now)\n"ModelHubNode <nodeId>.<unixMs>.<nonce>.<sig>"
    Agent->>NS: opens Connect stream, sets Authorization header
    NS->>Auth: authenticateNode(headerValue) — BEFORE reading any stream message
    Auth->>Auth: parse "ModelHubNode " prefix, split into 4 dot-separated parts
    Auth->>Auth: validate nodeId matches UUID shape (else a bad id would\nreach Postgres as a raw driver error, not "unknown node")
    Auth->>Auth: |now - millis| <= NODE_AUTH_SKEW_MS ?
    Auth->>PG: ownerDb.select id, orgId, publicKey from nodes where id=nodeId
    PG-->>Auth: row (or none → "unknown node")
    Auth->>Auth: toKeyObject(publicKey) — wrap raw 32 bytes in fixed Ed25519 SPKI prefix
    Auth->>Auth: crypto.verify(payload, signature, keyObject)
    Auth->>Redis: SET nodeauth:<nodeId>:<nonce> "1" PX 2*SKEW NX
    alt SET returns OK (nonce unused)
        Redis-->>Auth: fresh
        Auth-->>NS: {nodeId, orgId}
    else SET fails (nonce already seen)
        Redis-->>Auth: not fresh
        Auth-->>NS: throws NodeAuthError("replayed authorization header")
    end
```

**What this tells you.** Every failure mode short-circuits to
`NodeAuthError` (mapped to HTTP 401) before anything downstream runs — the
generator function in `node-service.ts` calls `authenticateNode` as its very
first line, so a rejected caller can never cause a single database write.
The nonce replay cache lives in Redis, not an in-process `Map`, because the
control plane is meant to run as multiple stateless replicas; the TTL is
`2 × NODE_AUTH_SKEW_MS`, exactly long enough to cover a nonce presented at
the edge of the skew window on a retry.

### 5d. Fleet page read

```mermaid
sequenceDiagram
    actor User
    participant Route as FleetRoute (React Query, refetchInterval 3s)
    participant FC as fleetClient
    participant FS as FleetService.listNodes
    participant Views as domain/views.ts
    participant Core as "@modelhub/core computeBudget()"
    participant PG as Postgres (withOrg)

    User->>Route: opens "/"
    Route->>FC: listNodes({})
    FC->>FS: Connect RPC, PORT 3000, session cookie
    FS->>FS: session(ctx) → requireSession → {orgId}
    FS->>PG: withOrg(orgId): select * from nodes, select * from devices
    PG-->>FS: nodeRows, deviceRows
    FS->>Views: buildNodeView(node, deviceRows.filter(nodeId))
    loop each device
        Views->>Core: computeBudget({kind, totalBytes, usedBytes, managedBytes, wiredLimitBytes, pressure, interactive})
        Core-->>Views: {totalBytes, managedBytes, foreignBytes, headroomBytes, availableBytes, schedulable}
    end
    Views-->>FS: NodeView[] (devices fully budgeted)
    FS-->>FC: ListNodesResponse
    FC-->>Route: React Query cache updated
    Route->>Route: renders NodeCard per node → DeviceMemoryBar per device
```

**What this tells you.** By the time this response leaves the server, every
byte figure the browser will render is already final — see §7 for why that
boundary matters and where it's drawn.

---

## 6. Web app component tree

```mermaid
flowchart TD
    root["rootRoute (createRootRoute)\nrenders &lt;Outlet/&gt;"]
    signIn["signInRoute → SignInRoute → SignInForm"]
    signUp["signUpRoute → SignUpRoute → SignUpForm"]
    appRoute["appRoute → RootLayout\n(auth-gated: useSession(); no session → navigate('/sign-in'))"]
    fleetRoute["fleetRoute → FleetRoute\nuseQuery(['fleet','nodes'], fleetClient.listNodes, refetchInterval 3s)"]
    addNode["AddNodeDialog\nmints pairing code, shows enroll command"]
    nodeCard["NodeCard (one per node)"]
    memBar["DeviceMemoryBar (one per device)"]

    root --> signIn
    root --> signUp
    root --> appRoute
    appRoute --> fleetRoute
    fleetRoute --> addNode
    fleetRoute --> nodeCard
    nodeCard --> memBar

    apiTs["api.ts: fleetClient\n(Connect-Web transport, same-origin, credentials: include)"]
    authTsx["auth.ts: authClient, useSession, signIn, signUp, signOut\n(better-auth/react + organization plugin)"]

    fleetRoute -. "uses" .-> apiTs
    addNode -. "uses" .-> apiTs
    appRoute -. "uses (useSession, signOut)" .-> authTsx
    signIn -. "uses (signIn.email)" .-> authTsx
    signUp -. "uses (signUp.email)" .-> authTsx
```

**What this tells you.** `RootLayout` is the single auth gate for the whole
authenticated section of the app — `signInRoute`/`signUpRoute` sit outside
it as siblings of `appRoute`, not children, so they render even with no
session, while everything under `appRoute` (today, just `fleetRoute`) is
unreachable without one. The two clients attach at different altitudes:
`fleetClient` is used directly by leaf components that need fleet data
(`FleetRoute`, `AddNodeDialog`); `authClient`'s `useSession` is used at the
layout level (`RootLayout`) to gate rendering, and again by the two
presentational, dependency-free `*Form` components' route wrappers
(`SignInRoute`, `SignUpRoute`) to call `signIn.email`/`signUp.email`.

---

## 7. The memory-budget boundary

```mermaid
flowchart LR
    subgraph server["apps/control-plane — SERVER SIDE"]
        direction TB
        deviceRow["devices row\n(lastUsedBytes, lastManagedBytes,\nlastUtilization, lastPressure)"]
        buildView["domain/views.ts\nbuildDeviceView()"]
        compute["@modelhub/core\ncomputeBudget()\nHEADROOM_FRAC, OS_RESERVE_FRAC,\nINTERACTIVE_RESERVE_FRAC,\nMETAL_DEFAULT_CEILING_FRAC"]
        deviceView["DeviceView (proto)\nmanagedBytes, foreignBytes,\nheadroomBytes, availableBytes,\nschedulable — ALL PRECOMPUTED"]
    end

    subgraph wire[" "]
        boundary(["Connect RPC over the wire"])
    end

    subgraph browser["apps/web — BROWSER SIDE, format only"]
        direction TB
        memBar["DeviceMemoryBar.tsx\npercent() — a CSS width %,\nnot a budget value"]
        formatTs["format.ts\nformatBytes(), formatRelativeTime()\npure string formatting, zero arithmetic on budgets"]
    end

    deviceRow --> buildView --> compute --> deviceView
    deviceView --> boundary --> memBar
    memBar --> formatTs

    style boundary fill:#c3c2b7,stroke:#333,stroke-width:2px
```

**What this tells you.** `computeBudget()` runs exactly once per device, per
read, entirely inside `domain/views.ts` on the server — every quantity
`DeviceMemoryBar.tsx` displays (`managedBytes`, `foreignBytes`,
`headroomBytes`, `availableBytes`, `schedulable`) crosses the wire already
final. The browser's `percent()` function looks like arithmetic but isn't a
budget calculation — it derives a CSS width from numbers it doesn't own, for
layout only, and `format.ts` does nothing but turn bytes into strings. The
architecture-level reasoning for *why* the formulas look the way they do
(the headroom/OS-reserve/interactive-reserve fractions, the Metal wired-limit
handling) lives in the architecture doc, not here — this diagram exists only
to make the boundary itself visible.
