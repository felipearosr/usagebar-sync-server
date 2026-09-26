import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { runAdmin } from "../src/admin.js";
import { createApp, type AppConfig } from "../src/app.js";
import { SqliteStore } from "../src/store.js";

const now = new Date("2026-09-23T14:05:12Z");

let store: SqliteStore;
let out: string[];
let err: string[];

const run = (...argv: string[]) => runAdmin(argv, store, { out: (l) => out.push(l), err: (l) => err.push(l) }, now);

beforeEach(() => {
  store = new SqliteStore(":memory:");
  out = [];
  err = [];
});

describe("token create", () => {
  it("prints a token that the server accepts for enrollment", async () => {
    expect(run("token", "create", "--max-machines", "3", "--days", "14", "--note", "trial")).toBe(0);
    const [token] = out;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [stored] = store.listEnrollmentTokens();
    expect(stored).toMatchObject({ maxMachines: 3, expiresAt: "2026-10-07T14:05:12Z", note: "trial", groupId: null });

    const config: AppConfig = {
      operator: "Test",
      maxBlobBytes: 65536,
      retentionDays: 400,
      maxMachines: 10,
      enrollment: "required",
      rateLimit: { perMinute: 0, burst: 1 },
      trustProxy: false,
    };
    const app = createApp({ store, config, clock: () => now });
    const authKey = randomBytes(32);
    const res = await app.request("/v1/groups", {
      method: "POST",
      headers: { authorization: `Enrollment ${token}` },
      body: JSON.stringify({
        groupId: randomBytes(16).toString("base64url"),
        authKeyHash: createHash("sha256").update(authKey).digest("base64url"),
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      limits: { maxMachines: 3, retentionDays: 400, expiresAt: "2026-10-07T14:05:12Z" },
    });
  });

  it("never stores the token itself", () => {
    run("token", "create");
    const [token] = out;
    expect(JSON.stringify(store.listEnrollmentTokens())).not.toContain(token);
  });

  it("normalizes --expires-at to RFC 3339 UTC", () => {
    expect(run("token", "create", "--expires-at", "2026-12-31T12:00:00+02:00")).toBe(0);
    expect(store.listEnrollmentTokens()[0]?.expiresAt).toBe("2026-12-31T10:00:00Z");
  });

  it.each([
    [["--max-machines", "0"]],
    [["--days", "1.5"]],
    [["--expires-at", "soon"]],
    [["--days", "1", "--expires-at", "2027-01-01T00:00:00Z"]],
    [["--bogus"]],
  ])("rejects bad options %j", (args) => {
    expect(run("token", "create", ...args)).toBe(2);
    expect(err.length).toBeGreaterThan(0);
    expect(store.listEnrollmentTokens()).toEqual([]);
  });
});

describe("token list and revoke", () => {
  it("lists tokens as a table and as JSON", () => {
    run("token", "create", "--note", "alice");
    out = [];
    expect(run("token", "list")).toBe(0);
    expect(out[0]).toMatch(/^ID\s+MAX MACHINES\s+EXPIRES\s+GROUP\s+CREATED\s+NOTE$/);
    expect(out[1]).toContain("alice");

    out = [];
    run("token", "list", "--json");
    expect(JSON.parse(out.join("\n"))).toHaveLength(1);
  });

  it("revokes an unused token but keeps a used one", () => {
    run("token", "create");
    const { tokenId } = store.listEnrollmentTokens()[0]!;
    expect(run("token", "revoke", tokenId)).toBe(0);
    expect(store.listEnrollmentTokens()).toEqual([]);
    expect(run("token", "revoke", tokenId)).toBe(2);

    out = [];
    run("token", "create");
    const token = Buffer.from(out[0]!, "base64url");
    store.createGroup({
      groupId: randomBytes(16).toString("base64url"),
      authKeyHash: randomBytes(32),
      defaultLimits: { maxMachines: 10, retentionDays: 400, expiresAt: null },
      tokenHash: createHash("sha256").update(token).digest(),
      now: "2026-09-23T14:05:12Z",
    });
    const used = store.listEnrollmentTokens()[0]!;
    expect(used.groupId).not.toBeNull();
    expect(run("token", "revoke", used.tokenId)).toBe(2);
    expect(store.listEnrollmentTokens()).toHaveLength(1);
  });

  it("prints usage for help and fails on unknown commands", () => {
    expect(run("--help")).toBe(0);
    expect(out.join("\n")).toContain("token create");
    expect(run("group", "list")).toBe(2);
  });
});
