import {
  bigint, boolean, doublePrecision, index, integer, jsonb, pgTable,
  text, timestamp, uniqueIndex, uuid, customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./auth";

// postgres.js does not consistently hand back a Buffer for bytea columns —
// depending on version/config it may deliver a Uint8Array directly. Accept
// either shape rather than assuming Buffer, or a 32-byte Ed25519 public key
// can silently come back wrong.
const bytea = customType<{ data: Uint8Array; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (v) => Buffer.from(v),
  fromDriver: (v) => (v instanceof Uint8Array ? v : new Uint8Array(v)),
});

export const nodes = pgTable("nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("offline"), // online | degraded | offline
  platform: text("platform").notNull().default(""),
  arch: text("arch").notNull().default(""),
  osVersion: text("os_version").notNull().default(""),
  agentVersion: text("agent_version").notNull().default(""),
  hostname: text("hostname").notNull().default(""),
  totalMemoryBytes: bigint("total_memory_bytes", { mode: "bigint" }).notNull().default(sql`0`),
  cpuCores: integer("cpu_cores").notNull().default(0),
  publicKey: bytea("public_key").notNull(),
  siteId: text("site_id"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOrg: index("nodes_org_idx").on(t.orgId),
  byKey: uniqueIndex("nodes_public_key_idx").on(t.publicKey),
}));

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Denormalized from nodes so the RLS policy is a simple column comparison
  // rather than a subquery on every row.
  orgId: text("org_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  localId: text("local_id").notNull(),
  kind: text("kind").notNull(),                       // cpu | cuda | metal
  index: integer("index").notNull().default(0),
  name: text("name").notNull().default(""),
  totalBytes: bigint("total_bytes", { mode: "bigint" }).notNull().default(sql`0`),
  wiredLimitBytes: bigint("wired_limit_bytes", { mode: "bigint" }).notNull().default(sql`0`),
  driverVersion: text("driver_version").notNull().default(""),
  computeCapability: text("compute_capability").notNull().default(""),
  interactive: boolean("interactive").notNull().default(false),
  lastUsedBytes: bigint("last_used_bytes", { mode: "bigint" }).notNull().default(sql`0`),
  lastManagedBytes: bigint("last_managed_bytes", { mode: "bigint" }).notNull().default(sql`0`),
  lastUtilization: doublePrecision("last_utilization").notNull().default(0),
  lastPressure: text("last_pressure").notNull().default("normal"),
  lastSampleAt: timestamp("last_sample_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byNodeLocal: uniqueIndex("devices_node_local_idx").on(t.nodeId, t.localId),
  byOrg: index("devices_org_idx").on(t.orgId),
}));

export const pairingCodes = pgTable("pairing_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull().unique(),
  nodeName: text("node_name").notNull().default(""),
  createdBy: text("created_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedByNodeId: uuid("used_by_node_id").references(() => nodes.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOrg: index("pairing_codes_org_idx").on(t.orgId),
}));
