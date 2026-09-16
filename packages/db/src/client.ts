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
