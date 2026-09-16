import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  plugins: [organizationClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
