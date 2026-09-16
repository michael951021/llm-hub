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
        after: async (user) => {
          const slug = `org-${randomBytes(6).toString("hex")}`;
          await auth.api.createOrganization({
            body: { name: `${user.name || user.email}'s fleet`, slug, userId: user.id },
          });
        },
      },
    },
  },
});
