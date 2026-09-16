import { z } from "zod";

const Schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_OWNER_URL: z.string().optional(),
  REDIS_URL: z.string().min(1),
  PUBLIC_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  NODE_AUTH_SKEW_MS: z.coerce.number().default(60_000),
  SAMPLE_INTERVAL_MS: z.coerce.number().default(5_000),
  PAIRING_CODE_TTL_MS: z.coerce.number().default(15 * 60_000),
});

// Fail at boot with a readable message rather than at the first request
// with an undefined.
export const env = Schema.parse(process.env);
export type Env = z.infer<typeof Schema>;
