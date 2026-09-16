import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// smoke.test.ts imports the control plane's app builders, which import
// ./env.js, which parses process.env at module load and throws on a
// missing value (PAIRING_CODE_PEPPER, DATABASE_URL, ...). The repo-root
// .env must be loaded before that import happens, so this setup file
// loads it first -- mirrors apps/control-plane/vitest.setup.ts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../.env") });
