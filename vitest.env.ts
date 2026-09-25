// Test setup shared by every package whose modules validate process.env at
// import time. Loads the repo-root .env when present (it never overrides
// variables already set); CI sets them directly and has no .env.
import { existsSync } from "node:fs";

const envFile = new URL("./.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
