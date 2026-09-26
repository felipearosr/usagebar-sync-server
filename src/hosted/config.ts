import { dirname, join } from "node:path";
import { loadConfig, type ServerConfig } from "../config.js";

export type HostedConfig = {
  /** The Sync Server settings, with enrollment always `required`. */
  server: ServerConfig;
  /** HTTPS origin customers paste into the app, with no trailing slash. Also the site's own address. */
  publicUrl: string;
  hostedDbPath: string;
  stripe: {
    secretKey: string;
    webhookSecret: string;
    priceId: string;
    /** Stripe's customer portal login link, where customers manage or cancel. Optional. */
    portalUrl: string | null;
    /** Stripe API base URL. Only changed to point at a local mock such as stripe-mock. */
    apiBase: string;
  };
  plan: {
    maxMachines: number;
    trialDays: number;
    graceDays: number;
    /** Display text for the price, for example "$3 / month". Optional. */
    priceLabel: string | null;
  };
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for the hosted plan`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return value;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function publicUrl(env: NodeJS.ProcessEnv): string {
  const raw = required(env, "PUBLIC_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_URL is not a URL: "${raw}"`);
  }
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("PUBLIC_URL must use https:// (http:// only for localhost)");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("PUBLIC_URL must be an origin with no path");
  return url.origin;
}

/**
 * Reads the hosted plan's settings. Stripe keys must be test-mode keys unless `STRIPE_ALLOW_LIVE=true`, so a
 * misconfigured development machine can't charge anyone.
 */
export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const server: ServerConfig = { ...loadConfig(env), enrollment: "required" };
  if (!env.OPERATOR) server.operator = "UsageBar Hosted Sync";

  const secretKey = required(env, "STRIPE_SECRET_KEY");
  const live = !/^(sk|rk)_test_/.test(secretKey);
  if (live && env.STRIPE_ALLOW_LIVE !== "true") {
    throw new Error(
      "STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_). Set STRIPE_ALLOW_LIVE=true to use a live key.",
    );
  }

  return {
    server,
    publicUrl: publicUrl(env),
    hostedDbPath:
      env.HOSTED_DB_PATH || (server.dbPath === ":memory:" ? ":memory:" : join(dirname(server.dbPath), "hosted.db")),
    stripe: {
      secretKey,
      webhookSecret: required(env, "STRIPE_WEBHOOK_SECRET"),
      priceId: required(env, "STRIPE_PRICE_ID"),
      portalUrl: env.STRIPE_PORTAL_URL || null,
      apiBase: env.STRIPE_API_BASE || "https://api.stripe.com",
    },
    plan: {
      maxMachines: integer(env, "PLAN_MAX_MACHINES", server.maxMachines, 1),
      trialDays: integer(env, "TRIAL_DAYS", 14, 1),
      graceDays: integer(env, "RENEWAL_GRACE_DAYS", 3, 0),
      priceLabel: env.PLAN_PRICE || null,
    },
  };
}
