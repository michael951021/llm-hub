import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { randomBytes } from "node:crypto";
import { db } from "@modelhub/db";
import { env } from "../env.js";

// Better Auth's default id generator produces plain random strings with no
// per-model shape. We want organization ids to read as "org_<hex>" (Task 6's
// acceptance test asserts on the prefix, and it also makes org ids easy to
// eyeball in logs/urls). The generic per-field default-value path in
// @better-auth/core (db/adapter/get-id-field.ts) uses whatever this function
// returns as the id verbatim -- it does NOT fall back to the built-in
// generator when the function returns `false` (only one internal session-id
// code path does that fallback). So this function must always return a
// usable string for every model, never `false`.
function generateId({ model }: { model: string }): string {
  const hex = randomBytes(16).toString("hex");
  return model === "organization" ? `org_${hex}` : hex;
}

interface PersonalOrgUser {
  id: string;
  name?: string | null;
  email: string;
}

// Shared by the sign-up hook below and by requireSession()'s self-heal path
// (session.ts), so both use the same naming/slug scheme and both end up
// creating organizations that look the same regardless of which one fired.
// Called with no `headers`, so the endpoint takes its "system action" branch
// (see crud-org.ts: no session in ctx -> falls back to `body.userId`) rather
// than trying to resolve a session that may not be in scope where this runs.
export async function ensurePersonalOrganization(user: PersonalOrgUser) {
  const slug = `org-${randomBytes(6).toString("hex")}`;
  return auth.api.createOrganization({
    body: { name: `${user.name || user.email}'s fleet`, slug, userId: user.id },
  });
}

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.PUBLIC_URL,
  basePath: "/api/auth",
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  trustedOrigins: [env.PUBLIC_URL],
  advanced: {
    database: { generateId },
  },
  plugins: [organization()],
  databaseHooks: {
    user: {
      create: {
        // Every user lands in an organization immediately. A user without an
        // org has nothing to look at, and every tenant row needs an org_id.
        //
        // This hook runs via queueAfterTransactionHook, i.e. AFTER the
        // sign-up transaction that created `user` has already committed
        // (@better-auth/core's transaction.ts). With no
        // `onAfterCommitHookError` configured, an exception here would
        // propagate and fail the client's sign-up call even though the
        // user/account/session rows are already durably in the database --
        // stranding a real user with no organization and no way to retry
        // sign-up (the email is taken). So this must never throw: on
        // failure we log with enough context to find the user, and leave
        // recovery to requireSession()'s self-heal (session.ts), which runs
        // at the point the invariant actually matters -- a user with no org
        // can't do anything anyway, so it's fine to fix it lazily there.
        after: async (user) => {
          try {
            await ensurePersonalOrganization(user);
          } catch (err) {
            console.error(
              "[auth] failed to create personal organization on sign-up; " +
                "requireSession will retry on next request",
              { userId: user.id, email: user.email, err },
            );
          }
        },
      },
    },
  },
});
