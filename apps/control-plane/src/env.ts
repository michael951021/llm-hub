import { z } from "zod";

const Schema = z.object({
  PORT: z.coerce.number().default(3000),
  // Browsers can't speak the cleartext HTTP/2 the agent stream needs, and
  // agents don't need a browser session — so the agent-facing Connect
  // services (NodeService) listen on their own port, separate from PORT.
  AGENT_PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().min(1),
  DATABASE_OWNER_URL: z.string().optional(),
  REDIS_URL: z.string().min(1),
  PUBLIC_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  NODE_AUTH_SKEW_MS: z.coerce.number().default(60_000),
  SAMPLE_INTERVAL_MS: z.coerce.number().default(5_000),
  PAIRING_CODE_TTL_MS: z.coerce.number().default(15 * 60_000),
  PAIRING_CODE_PEPPER: z.string().min(32),
});

// Fail at boot with a readable message rather than at the first request
// with an undefined.
export const env = Schema.parse(process.env);
export type Env = z.infer<typeof Schema>;
