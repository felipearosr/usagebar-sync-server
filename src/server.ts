import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createApp } from "./app.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { SqliteStore } from "./store.js";

/** How often the retention sweep (protocol §7) runs. It also runs once at startup. */
const RETENTION_SWEEP_MS = 60 * 60 * 1000;

export type RunningServer = { url: string; port: number; close: () => Promise<void> };

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = new SqliteStore(config.dbPath);
  const app = createApp({ store, config, remoteAddress: (c) => getConnInfo(c).remote.address });

  const sweep = () => {
    try {
      const deleted = store.pruneExpiredDays(new Date().toISOString().slice(0, 10));
      if (deleted > 0) console.log(`Retention: deleted ${deleted} day blob(s)`);
    } catch (err) {
      console.error("Retention sweep failed", err);
    }
  };
  sweep();
  const sweeper = setInterval(sweep, RETENTION_SWEEP_MS);
  sweeper.unref();

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;

  return {
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => {
          clearInterval(sweeper);
          store.close();
          if (err) reject(err);
          else resolve();
        }),
      ),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = loadConfig();
  const server = await startServer(config);
  console.log(`Sync Server listening on ${config.host}:${server.port} (db: ${config.dbPath})`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void server.close().then(() => process.exit(0)));
  }
}
