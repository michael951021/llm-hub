/**
 * Matches the canonical textual form of a UUID.
 *
 * Several columns — `nodes.id` above all — are Postgres `uuid`, and an
 * `eq()` comparison against a non-uuid string does not return zero rows: the
 * driver raises SQLSTATE 22P02 (`invalid input syntax for type uuid`). That
 * surfaces as an unmapped 500 rather than the 404/401 the caller should see,
 * so any id that arrives from outside has to be shape-checked here before it
 * reaches a query. Shared rather than copied so the two call sites
 * (rpc/node-auth.ts, rpc/fleet-service.ts) cannot drift apart.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
