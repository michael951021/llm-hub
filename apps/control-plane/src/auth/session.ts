import { auth, ensurePersonalOrganization } from "./auth.js";

/** An error Fastify's error handler turns into `{ error: code, message }` with this status. */
export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

export interface SessionContext {
  userId: string;
  orgId: string;
  user: { id: string; email: string; name: string };
}

/** Throws 401 without a session, 403 if the user has no organization and one can't be created. */
export async function requireSession(headers: Headers): Promise<SessionContext> {
  const session = await auth.api.getSession({ headers });
  if (!session?.user) throw new HttpError(401, "unauthenticated", "sign in required");
  const { user } = session;

  const orgId = session.session.activeOrganizationId
    ?? (await auth.api.listOrganizations({ headers }))[0]?.id
    ?? (await selfHealOrganization(user));
  if (!orgId) throw new HttpError(403, "no_organization", "user has no organization");

  return { userId: user.id, orgId, user };
}

// The sign-up hook that creates a user's organization is non-fatal (see
// auth.ts), so a real user can end up with none. Repair it here, where it
// matters, rather than locking them out behind a permanent 403.
async function selfHealOrganization(user: SessionContext["user"]): Promise<string | undefined> {
  console.warn("[auth] session has no organization; creating one (self-heal)", { userId: user.id });
  try {
    return (await ensurePersonalOrganization(user))?.id;
  } catch (err) {
    console.error("[auth] self-heal organization creation failed", { userId: user.id, err });
    return undefined;
  }
}
