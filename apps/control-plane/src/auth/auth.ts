import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { randomBytes } from "node:crypto";
import { db } from "@modelhub/db";
import { env } from "../env.js";

// Organization ids read as "org_<hex>"; everything else is plain hex. Must
// always return a string: Better Auth uses the value verbatim and does not
// fall back to its own generator.
function generateId({ model }: { model: string }): string {
  const hex = randomBytes(16).toString("hex");
  return model === "organization" ? `org_${hex}` : hex;
}

/**
 * Creates a user's personal organization. Shared by the sign-up hook and
 * requireSession()'s self-heal. Called without headers, so Better Auth takes
 * its "system action" path and trusts body.userId.
 */
export async function ensurePersonalOrganization(user: { id: string; name?: string | null; email: string }) {
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
  advanced: { database: { generateId } },
  plugins: [organization()],
  databaseHooks: {
    user: {
      create: {
        // Every user gets an organization immediately. This hook runs after
        // the sign-up transaction has committed, so throwing would fail a
        // sign-up whose user already exists (and whose email is now taken).
        // Log instead; requireSession() repairs the missing org lazily.
        after: async (user) => {
          try {
            await ensurePersonalOrganization(user);
          } catch (err) {
            console.error("[auth] personal organization creation failed on sign-up", { userId: user.id, err });
          }
        },
      },
    },
  },
});
