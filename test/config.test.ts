import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

it("uses self-hosting defaults", () => {
  expect(loadConfig({})).toEqual({
    host: "0.0.0.0",
    port: 8787,
    dbPath: "data/sync.db",
    operator: "Self-hosted Sync Server",
    maxBlobBytes: 65536,
    retentionDays: 400,
    maxMachines: 10,
  });
});

it("reads overrides from the environment", () => {
  const config = loadConfig({ PORT: "9000", DATA_DIR: "/data", OPERATOR: "Mine", MAX_MACHINES: "3" });
  expect(config).toMatchObject({ port: 9000, dbPath: "/data/sync.db", operator: "Mine", maxMachines: 3 });
});

it("rejects invalid numbers", () => {
  expect(() => loadConfig({ MAX_MACHINES: "zero" })).toThrow(/MAX_MACHINES/);
});
