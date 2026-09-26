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
    enrollment: "none",
    rateLimit: { perMinute: 120, burst: 600 },
    trustProxy: false,
  });
});

it("reads overrides from the environment", () => {
  const config = loadConfig({ PORT: "9000", DATA_DIR: "/data", OPERATOR: "Mine", MAX_MACHINES: "3" });
  expect(config).toMatchObject({ port: 9000, dbPath: "/data/sync.db", operator: "Mine", maxMachines: 3 });
});

it("reads enrollment, rate limit, and proxy settings", () => {
  const config = loadConfig({
    ENROLLMENT: "required",
    RATE_LIMIT_PER_MINUTE: "0",
    RATE_LIMIT_BURST: "5",
    TRUST_PROXY: "true",
  });
  expect(config).toMatchObject({ enrollment: "required", rateLimit: { perMinute: 0, burst: 5 }, trustProxy: true });
});

it("rejects invalid numbers", () => {
  expect(() => loadConfig({ MAX_MACHINES: "zero" })).toThrow(/MAX_MACHINES/);
});

it("rejects an unknown enrollment mode or proxy flag", () => {
  expect(() => loadConfig({ ENROLLMENT: "open" })).toThrow(/ENROLLMENT/);
  expect(() => loadConfig({ TRUST_PROXY: "yes" })).toThrow(/TRUST_PROXY/);
});
