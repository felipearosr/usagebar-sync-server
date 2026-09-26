import { join } from "node:path";
import { ENROLLMENT_MODES, type AppConfig, type EnrollmentMode } from "./app.js";

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

function enrollmentMode(env: NodeJS.ProcessEnv): EnrollmentMode {
  const raw = env.ENROLLMENT || "none";
  if (!(ENROLLMENT_MODES as readonly string[]).includes(raw)) {
    throw new Error(`ENROLLMENT must be one of ${ENROLLMENT_MODES.join(", ")}, got "${raw}"`);
  }
  return raw as EnrollmentMode;
}

function boolean(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = (env[name] ?? "").toLowerCase();
  if (raw === "" || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  throw new Error(`${name} must be true or false, got "${env[name]}"`);
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
    enrollment: enrollmentMode(env),
    rateLimit: {
      perMinute: integer(env, "RATE_LIMIT_PER_MINUTE", 120, 0),
      burst: integer(env, "RATE_LIMIT_BURST", 600, 1),
    },
    trustProxy: boolean(env, "TRUST_PROXY"),
  };
}
