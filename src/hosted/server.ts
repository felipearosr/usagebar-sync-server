import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { clientKey } from "../app.js";
import { startServer, type FetchHandler, type RunningServer } from "../server.js";
import type { SqliteStore } from "../store.js";
import { Billing } from "./billing.js";
import { loadHostedConfig, type HostedConfig } from "./config.js";
import { combine, createSite } from "./site.js";
import { HostedStore } from "./store.js";
import { StripeClient, type StripeApi } from "./stripe.js";

export type HostedDeps = {
  /** The Sync Server's handler, served under `/v1`. */
  sync: FetchHandler;
  syncStore: SqliteStore;
  hostedStore: HostedStore;
  stripe: StripeApi;
  clock?: () => Date;
  /** The socket's remote address, for rate limiting. */
  remoteAddress?: (c: Context) => string | undefined;
};

/** The whole hosted deployment as one handler: the Sync Server under `/v1`, the website everywhere else. */
export function createHostedHandler(config: HostedConfig, deps: HostedDeps): FetchHandler {
  const clock = deps.clock ?? (() => new Date());
  const billing = new Billing({
    stripe: deps.stripe,
    syncStore: deps.syncStore,
    hostedStore: deps.hostedStore,
    plan: config.plan,
    clock,
  });
  const site = createSite({
    billing,
    stripe: deps.stripe,
    priceId: config.stripe.priceId,
    webhookSecret: config.stripe.webhookSecret,
    rateLimit: config.server.rateLimit,
    clientKey: (c) => clientKey(c, config.server.trustProxy, deps.remoteAddress),
    clock,
    site: {
      publicUrl: config.publicUrl,
      operator: config.server.operator,
      maxMachines: config.plan.maxMachines,
      retentionDays: config.server.retentionDays,
      trialDays: config.plan.trialDays,
      priceLabel: config.plan.priceLabel,
      portalUrl: config.stripe.portalUrl,
    },
  });
  return combine(deps.sync, (request, env) => site.fetch(request, env as object));
}

/**
 * Runs the hosted plan: the Sync Server with enrollment required, plus the website that sells Enrollment Tokens.
 * Both share one process and one Sync Server database, so a token minted by the site is usable at once.
 */
export async function startHostedServer(
  config: HostedConfig,
  stripe: StripeApi = new StripeClient(config.stripe.secretKey, fetch, config.stripe.apiBase),
  clock: () => Date = () => new Date(),
): Promise<RunningServer> {
  if (config.hostedDbPath !== ":memory:") mkdirSync(dirname(config.hostedDbPath), { recursive: true });
  const hostedStore = new HostedStore(config.hostedDbPath);
  return startServer(config.server, (sync, syncStore) => ({
    fetch: createHostedHandler(config, {
      sync,
      syncStore,
      hostedStore,
      stripe,
      clock,
      remoteAddress: (c) => getConnInfo(c).remote.address,
    }),
    close: () => hostedStore.close(),
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = loadHostedConfig();
  const server = await startHostedServer(config);
  const mode = config.stripe.secretKey.includes("_test_") ? "test" : "LIVE";
  console.log(
    `Hosted Sync listening on ${config.server.host}:${server.port} as ${config.publicUrl} (Stripe ${mode} mode)`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void server.close().then(() => process.exit(0)));
  }
}
