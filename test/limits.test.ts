import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppConfig } from "../src/app.js";
import { SqliteStore } from "../src/store.js";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

function newCredentials() {
  const authKey = randomBytes(32);
  return {
    groupId: b64url(randomBytes(16)),
    authKey: b64url(authKey),
    authKeyHash: b64url(createHash("sha256").update(authKey).digest()),
  };
}
type Creds = ReturnType<typeof newCredentials>;

const newMachineId = () => b64url(randomBytes(16));

const baseConfig: AppConfig = {
  operator: "Test Sync",
  maxBlobBytes: 65536,
  retentionDays: 400,
  maxMachines: 10,
  enrollment: "none",
  rateLimit: { perMinute: 0, burst: 1 },
  trustProxy: false,
};

let now: Date;
let store: SqliteStore;
let app: ReturnType<typeof createApp>;

function setUp(overrides: Partial<AppConfig> = {}, remoteAddress?: () => string) {
  store = new SqliteStore(":memory:");
  app = createApp({ store, config: { ...baseConfig, ...overrides }, clock: () => now, remoteAddress });
}

beforeEach(() => {
  now = new Date("2026-09-23T14:05:12Z");
  setUp();
});

/** Mints a token straight into the store, as the admin CLI does. */
function mintToken(options: { maxMachines?: number | null; expiresAt?: string | null } = {}) {
  const secret = randomBytes(32);
  store.insertEnrollmentToken(
    {
      tokenId: b64url(randomBytes(6)),
      maxMachines: options.maxMachines ?? null,
      expiresAt: options.expiresAt ?? null,
      note: null,
      createdAt: "2026-09-01T00:00:00Z",
    },
    createHash("sha256").update(secret).digest(),
  );
  return b64url(secret);
}

const createGroup = (c: Creds, token?: string) =>
  app.request("/v1/groups", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Enrollment ${token}` } : {}) },
    body: JSON.stringify({ groupId: c.groupId, authKeyHash: c.authKeyHash }),
  });

const bearer = (c: Creds) => ({ authorization: `Bearer ${c.authKey}` });

const putBlob = (c: Creds, machineId: string, name: string, body = new Uint8Array([1])) =>
  app.request(`/v1/groups/${c.groupId}/machines/${machineId}/blobs/${name}`, {
    method: "PUT",
    headers: { ...bearer(c), "content-type": "application/octet-stream" },
    body,
  });

const getBlob = (c: Creds, machineId: string, name: string) =>
  app.request(`/v1/groups/${c.groupId}/machines/${machineId}/blobs/${name}`, { headers: bearer(c) });

const getChanges = (c: Creds) => app.request(`/v1/groups/${c.groupId}/changes`, { headers: bearer(c) });

const del = (c: Creds, path = "") =>
  app.request(`/v1/groups/${c.groupId}${path}`, { method: "DELETE", headers: bearer(c) });

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
}

type Changes = { machines: { machineId: string }[]; blobs: { machineId: string; name: string }[] };
const changes = async (c: Creds) => (await (await getChanges(c)).json()) as Changes;

describe("enrollment modes", () => {
  it.each(["none", "optional", "required"] as const)("advertises %s in /v1/info", async (enrollment) => {
    setUp({ enrollment });
    expect(await (await app.request("/v1/info")).json()).toMatchObject({ enrollment });
  });

  it("ignores the Enrollment header when enrollment is none", async () => {
    const res = await createGroup(newCredentials(), b64url(randomBytes(32)));
    expect(res.status).toBe(201);
  });

  it("requires a token when enrollment is required", async () => {
    setUp({ enrollment: "required" });
    await expectError(await createGroup(newCredentials()), 402, "enrollment_required");
  });

  it("creates a group without a token when enrollment is optional", async () => {
    setUp({ enrollment: "optional" });
    const res = await createGroup(newCredentials());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ limits: { maxMachines: 10, retentionDays: 400, expiresAt: null } });
  });

  it.each(["optional", "required"] as const)("rejects an unknown or malformed token (%s)", async (enrollment) => {
    setUp({ enrollment });
    await expectError(await createGroup(newCredentials(), b64url(randomBytes(32))), 403, "enrollment_invalid");
    await expectError(await createGroup(newCredentials(), "not-a-token"), 403, "enrollment_invalid");
  });

  it("gives the group the token's Machine cap and expiry", async () => {
    setUp({ enrollment: "required" });
    const token = mintToken({ maxMachines: 2, expiresAt: "2026-10-07T00:00:00Z" });
    const res = await createGroup(newCredentials(), token);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      limits: { maxMachines: 2, retentionDays: 400, expiresAt: "2026-10-07T00:00:00Z" },
    });
  });

  it("falls back to the server's Machine cap when the token sets none", async () => {
    setUp({ enrollment: "required" });
    const res = await createGroup(newCredentials(), mintToken());
    expect(await res.json()).toEqual({ limits: { maxMachines: 10, retentionDays: 400, expiresAt: null } });
  });

  it("accepts the Enrollment scheme case-insensitively", async () => {
    setUp({ enrollment: "required" });
    const c = newCredentials();
    const res = await app.request("/v1/groups", {
      method: "POST",
      headers: { authorization: `enrollment ${mintToken()}` },
      body: JSON.stringify({ groupId: c.groupId, authKeyHash: c.authKeyHash }),
    });
    expect(res.status).toBe(201);
  });
});

describe("Enrollment Token binding", () => {
  beforeEach(() => setUp({ enrollment: "required" }));

  it("returns enrollment_used when the token is reused for a different group", async () => {
    const token = mintToken();
    expect((await createGroup(newCredentials(), token)).status).toBe(201);
    await expectError(await createGroup(newCredentials(), token), 403, "enrollment_used");
  });

  it("recreating the same group with the same token is idempotent", async () => {
    const token = mintToken({ maxMachines: 4 });
    const c = newCredentials();
    expect((await createGroup(c, token)).status).toBe(201);
    const again = await createGroup(c, token);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ limits: { maxMachines: 4, retentionDays: 400, expiresAt: null } });
  });

  it("still returns group_exists for the same group ID with a different auth key", async () => {
    const token = mintToken();
    const c = newCredentials();
    await createGroup(c, token);
    await expectError(await createGroup({ ...newCredentials(), groupId: c.groupId }, token), 409, "group_exists");
  });

  it("stays bound to a deleted group", async () => {
    const token = mintToken();
    const c = newCredentials();
    await createGroup(c, token);
    expect((await del(c)).status).toBe(204);
    await expectError(await createGroup(newCredentials(), token), 403, "enrollment_used");
    expect(store.listEnrollmentTokens()[0]?.groupId).toBe(c.groupId);
  });

  it("can't create a group after the token expires", async () => {
    const token = mintToken({ expiresAt: "2026-09-23T14:05:12Z" });
    await expectError(await createGroup(newCredentials(), token), 403, "enrollment_expired");
    expect(store.listEnrollmentTokens()[0]?.groupId).toBeNull();
  });
});

describe("Machine cap", () => {
  it("returns machine_limit for a write that would add a Machine beyond the cap", async () => {
    setUp({ enrollment: "required" });
    const c = newCredentials();
    await createGroup(c, mintToken({ maxMachines: 2 }));
    const [a, b] = [newMachineId(), newMachineId()];
    expect((await putBlob(c, a, "profile")).status).toBe(200);
    expect((await putBlob(c, b, "profile")).status).toBe(200);
    await expectError(await putBlob(c, newMachineId(), "profile"), 403, "machine_limit");
  });

  it("counts retired Machines until they are deleted", async () => {
    setUp({ maxMachines: 2 });
    const c = newCredentials();
    await createGroup(c);
    const [a, b] = [newMachineId(), newMachineId()];
    await putBlob(c, a, "profile");
    await putBlob(c, b, "profile");
    // Retiring is only a group blob; the server can't read it, and the Machine keeps its slot.
    expect((await putBlob(c, "group", "retired")).status).toBe(200);
    await expectError(await putBlob(c, newMachineId(), "profile"), 403, "machine_limit");

    expect((await del(c, `/machines/${a}`)).status).toBe(204);
    expect((await putBlob(c, newMachineId(), "profile")).status).toBe(200);
  });
});

describe("group expiry", () => {
  let c: Creds;
  let token: string;
  const machine = newMachineId();

  beforeEach(async () => {
    setUp({ enrollment: "required" });
    c = newCredentials();
    token = mintToken({ expiresAt: "2026-10-07T00:00:00Z" });
    await createGroup(c, token);
    await putBlob(c, machine, "profile");
  });

  it("accepts writes until expiresAt", async () => {
    now = new Date("2026-10-06T23:59:59Z");
    expect((await putBlob(c, machine, "day-2026-10-06")).status).toBe(200);
  });

  it("rejects writes with enrollment_expired once expiresAt passes", async () => {
    now = new Date("2026-10-07T00:00:00Z");
    await expectError(await putBlob(c, machine, "profile"), 403, "enrollment_expired");
    await expectError(await putBlob(c, "group", "retired"), 403, "enrollment_expired");
  });

  it("keeps reads working for 30 days after expiry", async () => {
    now = new Date("2026-11-05T23:59:59Z");
    expect((await getChanges(c)).status).toBe(200);
    expect((await getBlob(c, machine, "profile")).status).toBe(200);

    now = new Date("2026-11-06T00:00:00Z");
    await expectError(await getChanges(c), 403, "enrollment_expired");
    await expectError(await getBlob(c, machine, "profile"), 403, "enrollment_expired");
  });

  it("still allows deletion after expiry", async () => {
    now = new Date("2027-01-01T00:00:00Z");
    expect((await del(c, `/machines/${machine}`)).status).toBe(204);
    expect((await del(c)).status).toBe(204);
  });

  it("still answers an idempotent recreate after expiry", async () => {
    now = new Date("2026-10-08T00:00:00Z");
    const res = await createGroup(c, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      limits: { maxMachines: 10, retentionDays: 400, expiresAt: "2026-10-07T00:00:00Z" },
    });
  });
});

describe("DELETE", () => {
  it("removes a Machine and all its blobs, leaving others alone", async () => {
    const c = newCredentials();
    await createGroup(c);
    const [a, b] = [newMachineId(), newMachineId()];
    await putBlob(c, a, "profile");
    await putBlob(c, a, "day-2026-09-23");
    await putBlob(c, b, "profile");
    await putBlob(c, "group", "retired");

    expect((await del(c, `/machines/${a}`)).status).toBe(204);
    const body = await changes(c);
    expect(body.machines.map((m) => m.machineId)).toEqual([b]);
    expect(body.blobs.map((x) => [x.machineId, x.name]).sort()).toEqual(
      [
        [b, "profile"],
        ["group", "retired"],
      ].sort(),
    );
    await expectError(await getBlob(c, a, "profile"), 404, "blob_not_found");
  });

  it("is idempotent for an unknown Machine", async () => {
    const c = newCredentials();
    await createGroup(c);
    expect((await del(c, `/machines/${newMachineId()}`)).status).toBe(204);
  });

  it("rejects the reserved group ID and malformed Machine IDs", async () => {
    const c = newCredentials();
    await createGroup(c);
    await expectError(await del(c, "/machines/group"), 422, "invalid_machine_id");
    await expectError(await del(c, "/machines/nope"), 422, "invalid_machine_id");
  });

  it("removes the group and everything in it", async () => {
    const c = newCredentials();
    await createGroup(c);
    await putBlob(c, newMachineId(), "profile");
    expect((await del(c)).status).toBe(204);
    await expectError(await getChanges(c), 404, "group_not_found");
    // The ID is free again: the old group is gone, not hidden.
    expect((await createGroup(c)).status).toBe(201);
    expect((await changes(c)).blobs).toEqual([]);
  });

  it("needs the group's credentials", async () => {
    const c = newCredentials();
    await createGroup(c);
    await expectError(await del({ ...c, authKey: b64url(randomBytes(32)) }), 404, "group_not_found");
    await expectError(
      await del({ ...c, authKey: b64url(randomBytes(32)) }, `/machines/${newMachineId()}`),
      404,
      "group_not_found",
    );
    expect((await getChanges(c)).status).toBe(200);
  });
});

describe("retention", () => {
  it("deletes only day blobs older than retentionDays before today", async () => {
    setUp({ retentionDays: 30 });
    const c = newCredentials();
    await createGroup(c);
    const m = newMachineId();
    // 2026-09-23 minus 30 days is 2026-08-24, the oldest day kept.
    for (const name of ["profile", "day-2026-08-23", "day-2026-08-24", "day-2026-09-23", "day-2025-01-01"]) {
      await putBlob(c, m, name);
    }
    await putBlob(c, "group", "retired");

    expect(store.pruneExpiredDays("2026-09-23")).toBe(2);
    const names = (await changes(c)).blobs.map((b) => b.name).sort();
    expect(names).toEqual(["day-2026-08-24", "day-2026-09-23", "profile", "retired"]);
  });

  it("uses each group's own retentionDays", async () => {
    setUp({ retentionDays: 10 });
    const short = newCredentials();
    await createGroup(short);
    setUpSharedStore({ retentionDays: 400 });
    const long = newCredentials();
    await createGroup(long);

    const m = newMachineId();
    await putBlob(short, m, "day-2026-09-01");
    await putBlob(long, m, "day-2026-09-01");
    expect(store.pruneExpiredDays("2026-09-23")).toBe(1);
    expect((await changes(long)).blobs.map((b) => b.name)).toEqual(["day-2026-09-01"]);
    expect((await changes(short)).blobs).toEqual([]);
  });
});

/** Swaps the config while keeping the same store, like restarting the server with a new RETENTION_DAYS. */
function setUpSharedStore(overrides: Partial<AppConfig>) {
  app = createApp({ store, config: { ...baseConfig, ...overrides }, clock: () => now });
}

describe("rate limiting", () => {
  it("returns 429 with Retry-After once a client's burst is spent, then recovers", async () => {
    setUp({ rateLimit: { perMinute: 60, burst: 2 } }, () => "10.0.0.1");
    expect((await app.request("/v1/info")).status).toBe(200);
    expect((await app.request("/v1/info")).status).toBe(200);

    const limited = await app.request("/v1/info");
    await expectError(limited, 429, "rate_limited");
    expect(limited.headers.get("retry-after")).toBe("1");

    now = new Date(now.getTime() + 1000);
    expect((await app.request("/v1/info")).status).toBe(200);
  });

  it("rounds Retry-After up to whole seconds", async () => {
    setUp({ rateLimit: { perMinute: 6, burst: 1 } }, () => "10.0.0.1");
    await app.request("/v1/info");
    const limited = await app.request("/v1/info");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("10");
  });

  it("limits each client separately", async () => {
    let address = "10.0.0.1";
    setUp({ rateLimit: { perMinute: 60, burst: 1 } }, () => address);
    expect((await app.request("/v1/info")).status).toBe(200);
    expect((await app.request("/v1/info")).status).toBe(429);
    address = "10.0.0.2";
    expect((await app.request("/v1/info")).status).toBe(200);
  });

  it("keys on the last X-Forwarded-For hop only when trustProxy is on", async () => {
    setUp({ rateLimit: { perMinute: 60, burst: 1 }, trustProxy: true }, () => "127.0.0.1");
    const from = (xff: string) => app.request("/v1/info", { headers: { "x-forwarded-for": xff } });
    expect((await from("1.1.1.1, 203.0.113.5")).status).toBe(200);
    expect((await from("2.2.2.2, 203.0.113.5")).status).toBe(429);
    expect((await from("203.0.113.6")).status).toBe(200);

    setUp({ rateLimit: { perMinute: 60, burst: 1 }, trustProxy: false }, () => "127.0.0.1");
    expect((await from("203.0.113.7")).status).toBe(200);
    expect((await from("203.0.113.8")).status).toBe(429);
  });

  it("runs before authentication", async () => {
    setUp({ rateLimit: { perMinute: 60, burst: 1 } }, () => "10.0.0.1");
    await app.request("/v1/info");
    await expectError(await getChanges(newCredentials()), 429, "rate_limited");
  });
});
