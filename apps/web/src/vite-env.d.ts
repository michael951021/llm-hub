/// <reference types="vite/client" />

interface ImportMetaEnv {
  // The agent-facing URL printed in the pairing command (AGENT_PORT).
  readonly VITE_AGENT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
