// Generated from apps/control-plane/src/auth/auth.ts's Better Auth config.
//
// better-auth 1.7.5 ships no `better-auth` CLI binary, and the separately
// published `@better-auth/cli` package hasn't caught up past 1.4.x, so
// `better-auth generate` (as originally sketched for this step) isn't a
// runnable command for the version pinned in this workspace. This file was
// produced instead by driving @better-auth/drizzle-adapter's internal
// generateDrizzleSchema() directly against the real `auth` config -- the
// same function the CLI would have called -- via a one-off script. See
// task-6-report.md for the full explanation.
//
// One block from that generator's raw output was dropped: a trailing
// `authRelations = defineRelationsPart(...)` export. That's Drizzle's
// relations-v2 API, which needs drizzle-orm >=0.45; this workspace pins
// drizzle-orm ^0.36.0 (packages/db/package.json, set in Task 3) and
// `defineRelationsPart` does not exist in 0.36.4. It isn't needed here:
// every foreign key below is already expressed with a plain `.references()`
// column reference, which is all fleet.ts and the RLS layer use.
//
// To regenerate after changing the Better Auth config, rerun the generator
// script against the updated auth.ts and reapply the diff by hand (the
// relations block still needs to be dropped the same way).
import { pgTable, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").$onUpdate(() => new Date()).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  // Added by the organization plugin. requireSession() falls back to the
  // user's first organization when this is unset.
  activeOrganizationId: text("active_organization_id"),
}, (table) => [
  index("session_userId_idx").on(table.userId),
]);

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").$onUpdate(() => new Date()).notNull(),
}, (table) => [
  index("account_userId_idx").on(table.userId),
]);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  index("verification_identifier_idx").on(table.identifier),
]);

// fleet.ts's nodes/devices/pairing_codes tables reference this table's `id`
// column. RLS is deliberately NOT enabled on this table (or any other table
// in this file) -- Better Auth needs unrestricted access to its own tables.
export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
}, (table) => [
  uniqueIndex("organization_slug_uidx").on(table.slug),
]);

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: text("role").default("member").notNull(),
  createdAt: timestamp("created_at").notNull(),
}, (table) => [
  index("member_organizationId_idx").on(table.organizationId),
  index("member_userId_idx").on(table.userId),
]);

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").default("pending").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  inviterId: text("inviter_id").notNull().references(() => user.id, { onDelete: "cascade" }),
}, (table) => [
  index("invitation_organizationId_idx").on(table.organizationId),
  index("invitation_email_idx").on(table.email),
]);
