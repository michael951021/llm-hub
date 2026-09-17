# Installing the Model Hub agent

The agent is a single static binary (`modelhub-agent`) plus, on Linux boxes
with NVIDIA GPUs, a second build that links against NVML. It enrolls into
your organization once, then runs as a system service (launchd on macOS,
systemd on Linux, the Windows service manager elsewhere) that reports this
machine's compute and stays connected to the control plane.

Slice 1 does not install, manage, or run any model runtimes — there is
nothing on the machine for the agent to set up besides itself and its own
service registration. `managedBytes` is always zero; nothing is ever loaded.
That starts in a later slice.

**`--server` must point at the control plane's *agent* port (`AGENT_PORT`,
default `3001`), not the browser port (`PORT`, default `3000`) that the web
app talks to.** The agent speaks cleartext HTTP/2 (h2c) to a different
listener than your browser does. If you enroll against the browser port,
enrollment fails immediately with a connection or protocol error.

## macOS (Apple Silicon)

    tar xzf modelhub-agent_*_darwin_arm64.tar.gz
    sudo mv modelhub-agent /usr/local/bin/
    modelhub-agent enroll --code XXXX-XXXX --server https://<your-control-plane>:3001
    sudo modelhub-agent install

The agent runs as a launchd daemon. Check it with `modelhub-agent status`.

This node's private key is stored in the macOS keychain (service
`com.modelhub.agent`), in an entry scoped to this node's config directory —
not a single fixed entry shared by every install on the machine. A second
agent instance pointed at a different `MODELHUB_CONFIG_DIR` gets its own
key, and a fresh `enroll` after `uninstall` gets a genuinely new key rather
than reusing the old one (see "Removing it" below).

## Linux with NVIDIA GPUs

Use the `_cuda` archive — the default build has no NVML support and will
report only the CPU.

    tar xzf modelhub-agent_*_linux_amd64_cuda.tar.gz
    sudo mv modelhub-agent /usr/local/bin/
    modelhub-agent enroll --code XXXX-XXXX --server https://<your-control-plane>:3001
    sudo modelhub-agent install

Verify the GPUs are seen:

    modelhub-agent status
    journalctl -u modelhub-agent -f

## Removing it

    sudo modelhub-agent uninstall
    sudo rm /usr/local/bin/modelhub-agent
    sudo rm -rf /etc/modelhub

`modelhub-agent uninstall` does exactly three things, and only these three:

1. Stops and removes the system service registration (the launchd job, the
   systemd unit, or the Windows service).
2. Deletes this node's stored identity — the macOS keychain entry (or its
   file-fallback equivalent on a headless Linux box or a locked keyring),
   scoped to this config directory.
3. Clears the enrollment recorded in `config.json`, so this node reads as
   not enrolled afterwards. The identity and the enrollment have to go
   together: a config that still claims to be enrolled while the key is gone
   would let `install` register a service that can never authenticate, and
   `run` would dial the control plane with the old node ID and be rejected
   forever.

It does **not** remove the installed binary, and it does **not** remove the
config directory itself (the now-blank `config.json`, logs). Those two `rm`
commands above are how you remove them — `uninstall` will tell you plainly
in its own output whether the service removal and the identity removal each
succeeded, so if one half fails you'll see which one and why, rather than a
silent partial cleanup.

If `uninstall` is run when no service was ever installed, the service half
fails (there's nothing to remove) and is reported as such — the identity
half still runs, so `enroll`-only nodes still get their key cleaned up.

There are no model runtimes to clean up in this slice — nothing else was
installed by the agent besides itself and its service registration.

## Where things live

| | macOS | Linux | Windows |
|---|---|---|---|
| Config and identity (as root) | `/etc/modelhub` | `/etc/modelhub` | `%ProgramData%\ModelHub` |
| Config and identity (as a user) | `~/Library/Application Support/modelhub` | `~/.config/modelhub` | `%AppData%\modelhub` |
| Private key | macOS keychain (falls back to a 0600 file in the config dir) | a 0600 file in the config dir | Windows Credential Manager (falls back to a file) |
| Service | launchd | systemd | Windows service |

Override any of these with `MODELHUB_CONFIG_DIR`.

## Building a release

Release builds are produced with [GoReleaser](https://goreleaser.com) from
`agent/.goreleaser.yaml`:

    cd agent
    goreleaser release --clean        # tagged release, all platforms
    goreleaser build --snapshot --clean --single-target   # local sanity check

The CUDA build (`agent-cuda`, the `_cuda` archive) needs `CGO_ENABLED=1` and
the NVIDIA driver headers, so it can only be produced on a Linux runner that
has them — it will not cross-compile from macOS or from a Linux box without
the driver installed. The plain `agent` build (`CGO_ENABLED=0`, no NVML) is
a pure cross-compile and builds cleanly for darwin/linux/windows ×
amd64/arm64 from any machine with the Go toolchain.

Notarization, signed update manifests, and cohort rollout are out of scope
for this slice — see the slice-10 backlog. These are unsigned binaries;
macOS Gatekeeper will complain on first run (right-click → Open, or
`xattr -d com.apple.quarantine` after you've verified the binary yourself).

## Manual verification checklist

This is the closing artifact for slice 1. It has **not** been performed —
running it requires the real control plane, a real Mac, and a real
multi-GPU Linux box, none of which are available in the environment this
task was implemented in. Whoever has hardware access should work through it
top to bottom and record the actual results.

Each step lists the exact command(s) to run, what a pass looks like, and
what a failure looks like, so a result doesn't depend on judgment calls.

### 1. Bring up the control plane and create an org

    pnpm install
    docker compose up -d
    cp .env.example .env
    set -a && source .env && set +a
    pnpm --filter @modelhub/db migrate
    pnpm --filter @modelhub/control-plane dev     # :3000 browser, AGENT_PORT :3001 agent
    pnpm --filter @modelhub/web dev               # :5173

Open the web app, sign up, and create an org. Get a pairing code from the
fleet page for a new node.

**Pass:** you have a pairing code (`XXXX-XXXX`) and the org's Fleet page open
in a browser tab, so you can watch nodes appear live.
**Fail looks like:** `pnpm --filter @modelhub/db migrate` errors — check
`docker compose ps` shows Postgres healthy first.

### 2. Install and enroll on the Mac

    tar xzf modelhub-agent_*_darwin_arm64.tar.gz
    sudo mv modelhub-agent /usr/local/bin/
    modelhub-agent enroll --code XXXX-XXXX --server http://<control-plane-host>:3001
    sudo modelhub-agent install
    modelhub-agent status

**Pass:** `status` prints `node <name> (<id>) enrolled to org ... at ...`,
and within 10 seconds the Fleet page shows this machine `online` with one
device `metal:0`. Its total memory matches `sysctl hw.memsize` (bytes), and
the available figure is in the right ballpark against Activity Monitor's
memory pressure (not required to match exactly — just plausible, e.g. not
zero and not larger than total).
**Fail looks like:** the node never goes `online` — check
`sudo launchctl list | grep modelhub-agent` shows a 0 exit status, and check
the enroll `--server` URL used port 3001, not 3000 (see the port note
above).

### 3. Install and enroll on the NVIDIA box

    tar xzf modelhub-agent_*_linux_amd64_cuda.tar.gz
    sudo mv modelhub-agent /usr/local/bin/
    modelhub-agent enroll --code XXXX-XXXX --server http://<control-plane-host>:3001
    sudo modelhub-agent install
    modelhub-agent status
    journalctl -u modelhub-agent -f

**Pass:** the Fleet page shows a `cuda:N` device for each physical GPU
(`nvidia-smi -L` gives the count), and each device's total VRAM matches
`nvidia-smi --query-gpu=memory.total --format=csv`.
**Fail looks like:** no `cuda:*` devices appear and only a CPU device shows
up — confirms the `_cuda` archive wasn't used, or the driver isn't loaded
(`nvidia-smi` itself fails).

### 4. GPU memory pressure reflects in the memory bar

On the NVIDIA box, start something that allocates GPU memory (e.g. load any
model into a framework that reserves VRAM, or run a small CUDA allocation
script) while watching the Fleet page's device card for that GPU.

**Pass:** within one sample interval, the *foreign* segment of the memory
bar (memory Model Hub didn't allocate — since this slice never loads
models, all of this GPU's used memory is "foreign" by definition) grows,
and the available figure shrinks by a corresponding amount. Stop the
workload and confirm it recovers.
**Fail looks like:** the bar doesn't move — check the sample interval
hasn't been overridden to something long, and check `nvidia-smi` itself
shows the memory used (rules out an agent-side bug vs. the workload not
actually allocating GPU memory).

### 5. Node goes degraded, then offline, when stopped

Pick either node and stop the service:

    # macOS
    sudo launchctl unload /Library/LaunchDaemons/modelhub-agent.plist
    # Linux
    sudo systemctl stop modelhub-agent

**Pass:** the Fleet page shows the node `degraded` within about 15 seconds
of the last sample, then `offline` within about 30 seconds.
**Fail looks like:** the node vanishes from the list instead of showing
`degraded`/`offline` (a control-plane bug, not an install bug — but worth
flagging), or it never transitions at all (check the control plane's
liveness sweep is actually running).

### 6. Restart returns to online without re-enrolling

    # macOS
    sudo launchctl load /Library/LaunchDaemons/modelhub-agent.plist
    # Linux
    sudo systemctl start modelhub-agent
    modelhub-agent status

**Pass:** `status` still reports the same node ID as step 2/3 (no
re-enrollment happened — the enrollment survived the stop), and the Fleet
page returns to `online` within 10 seconds.
**Fail looks like:** `status` reports "not enrolled" — the enrollment in
`config.json` is gone (something ran `uninstall`, or the config dir was
deleted); re-enroll. Note that `status` reads `config.json` only and never
touches the private key, so it reports "enrolled" even when the key itself
has been lost. That case shows up in the service's log instead, as `this
node's config says it is enrolled as node <id>, but its identity is
missing` — the fix is the same, re-enroll. The remaining failure is the node
staying `offline` while the log shows the server rejecting the reconnect as
an unrecognized node.

### 7. NVML device identity survives a reboot (multi-GPU box only)

This checks a fix that has never executed on real hardware: Task 13 switched
the CUDA `LocalID` from NVML's enumeration index to `GetUUID()`, specifically
because NVIDIA does not guarantee enumeration order is stable across a
reboot — and the control plane deletes any device a node stops reporting.
If `LocalID` silently changed on every reboot, every GPU would look like it
was replaced each time the machine restarted.

Before rebooting:

    nvidia-smi --query-gpu=index,uuid --format=csv,noheader

Record the UUID for each GPU (or check the agent's own reported `LocalID`
values via the Fleet page's device list for that node — they should be the
full NVML UUID string, not a small integer).

**Pass (part 1):** every GPU has a non-empty UUID, and it takes the
expected NVML form (`GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) rather than
being empty or a bare number.

Reboot the box, let the agent's service auto-start, and wait for it to
report:

    sudo reboot
    # after it comes back up:
    nvidia-smi --query-gpu=index,uuid --format=csv,noheader
    modelhub-agent status

Compare the post-reboot UUIDs to the pre-reboot list, and compare the
Fleet page's per-node device `LocalID`s before and after.

**Pass (part 2):** the set of UUIDs is identical before and after, and the
Fleet page shows the *same* devices (same `LocalID`s, same count) after the
reboot rather than the old ones going stale/removed and new ones appearing
in their place.
**Fail looks like:** the Fleet page shows a fresh set of `cuda:*` devices
post-reboot with different `LocalID`s while the old ones disappear — this
would mean `GetUUID()` isn't actually being used, or isn't stable on this
driver version, and is a real regression worth its own bug report.
