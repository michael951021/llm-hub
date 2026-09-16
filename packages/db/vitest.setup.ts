import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// src/client.ts reads process.env at module load and throws on a missing
// DATABASE_URL, so the repo-root .env must be loaded before any test file
// imports ./client.js (directly or transitively). This setup file runs
// before test files are collected, which guarantees that ordering
// regardless of whether the caller (a shell, or turbo with strict env
// mode) has already forwarded the repo's .env into process.env. Mirrors
// apps/control-plane/vitest.setup.ts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../.env") });
