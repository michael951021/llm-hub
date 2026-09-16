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

      {data && data.nodes.length === 0 && (
        <p className="rounded border border-dashed p-8 text-center text-sm text-slate-500">
          No machines yet. Add one to see its GPUs and memory here.
        </p>
      )}

      {data?.nodes.map((node) => <NodeCard key={node.id} node={node} />)}
    </div>
  );
}
