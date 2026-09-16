/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Where the agent's h2c NodeService listens (AGENT_PORT, default 3001).
  // Browser traffic never reaches this port — it is HTTP/1.1-only and
  // cannot speak h2c — so this is for display in the pairing command only.
  readonly VITE_AGENT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
