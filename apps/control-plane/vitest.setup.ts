import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// src/env.ts parses process.env at module load and throws on missing
// values, so the repo-root .env must be loaded before any test file
// imports ./env.js (directly or transitively via app.js). This setup
// file runs before test files are collected, which guarantees that
// ordering regardless of whether the caller has sourced .env themselves.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../.env") });
