import { auth, ensurePersonalOrganization } from "./auth.js";

export interface SessionContext {
  userId: string;
  orgId: string;
}

export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

// Deliberately typed against a plain `{ headers }` shape rather than
// FastifyRequest: Task 11 calls this from inside a ConnectRPC handler, whose
// context isn't a Fastify request. Any caller that can hand us a Headers
// instance, or a plain object of header name -> string | string[], can use
// this guard.
export interface HeaderSource {
  headers: Headers | Record<string, string | string[] | undefined>;
}

function toHeaders(source: HeaderSource): Headers {
  if (source.headers instanceof Headers) return source.headers;
  const headers = new Headers();
  for (const [key, value] of Object.entries(source.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}

/** Throws 401 without a session, 403 with a session but no active org. */
export async function requireSession(req: HeaderSource): Promise<SessionContext> {
  const headers = toHeaders(req);
  const session = await auth.api.getSession({ headers });
  if (!session?.user) throw new HttpError(401, "unauthenticated", "sign in required");

  let orgId: string | null = session.session.activeOrganizationId ?? null;
  if (!orgId) {
    const orgs = await auth.api.listOrganizations({ headers });
    orgId = orgs[0]?.id ?? null;
  }

  if (!orgId) {
    // Self-heal: the sign-up hook (auth.ts) that normally creates this
    // user's organization runs after the sign-up transaction commits and is
    // deliberately non-fatal, so a transient DB error or slug collision can
    // leave a real, already-committed user with no organization. Fix it
    // here, at the point the invariant actually matters -- a user with no
    // org can't do anything regardless -- rather than leaving them
    // permanently locked out behind a 403 with no recovery path.
    console.warn(
      "[auth] session has no organization; creating one now (self-heal)",
      { userId: session.user.id, email: session.user.email },
    );
    try {
      const org = await ensurePersonalOrganization(session.user);
      orgId = org?.id ?? null;
    } catch (err) {
      console.error("[auth] self-heal organization creation failed", {
        userId: session.user.id,
        email: session.user.email,
        err,
      });
      orgId = null;
    }
  }

  if (!orgId) throw new HttpError(403, "no_organization", "user has no organization");

  return { userId: session.user.id, orgId };
}
