import { join } from "node:path";
import type { AppConfig } from "./app.js";

export type ServerConfig = AppConfig & {
  host: string;
  port: number;
  dbPath: string;
};

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOST || "0.0.0.0",
    port: integer(env, "PORT", 8787, 0),
    dbPath: env.DB_PATH || join(env.DATA_DIR || "data", "sync.db"),
    operator: env.OPERATOR || "Self-hosted Sync Server",
    maxBlobBytes: integer(env, "MAX_BLOB_BYTES", 65536, 1),
    retentionDays: integer(env, "RETENTION_DAYS", 400, 1),
    maxMachines: integer(env, "MAX_MACHINES", 10, 1),
  };
}
