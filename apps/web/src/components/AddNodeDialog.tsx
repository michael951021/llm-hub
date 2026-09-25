import { useState } from "react";
import { fleetClient } from "../api.js";

// The agent dials the control plane's h2c listener (AGENT_PORT), not the
// origin this page was served from.
const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? "http://localhost:3001";

export function AddNodeDialog() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const res = await fleetClient.createPairingCode({ nodeName: name });
      setCode(res.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate a pairing code");
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
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        </div>
      ) : (
        <div className="mt-3 space-y-3 text-sm">
          <p>Install the agent on that machine, then run:</p>
          <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
{`modelhub-agent enroll \\
  --code ${code} \\
  --server ${AGENT_URL}`}
          </pre>
          <p className="text-xs text-slate-500">
            This code works once and expires in 15 minutes.
          </p>
        </div>
      )}

      <button onClick={() => { setOpen(false); setCode(null); setError(null); }} className="mt-3 text-sm text-slate-600">
        Close
      </button>
    </div>
  );
}
