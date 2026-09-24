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

const newMachineId = () => b64url(randomBytes(16));

const config: AppConfig = {
  operator: "Test Sync",
  maxBlobBytes: 65536,
  retentionDays: 400,
  maxMachines: 3,
};

let now: Date;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  now = new Date("2026-09-23T14:05:12.345Z");
  app = createApp({ store: new SqliteStore(":memory:"), config, clock: () => now });
});

type Creds = ReturnType<typeof newCredentials>;

const createGroup = (c: Creds) =>
  app.request("/v1/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ groupId: c.groupId, authKeyHash: c.authKeyHash }),
  });

const blobPath = (c: Creds, machineId: string, name: string) =>
  `/v1/groups/${c.groupId}/machines/${machineId}/blobs/${name}`;

const putBlob = (c: Creds, machineId: string, name: string, body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
  app.request(blobPath(c, machineId, name), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${c.authKey}`,
      "content-type": "application/octet-stream",
      ...headers,
    },
    body,
  });

const getBlob = (c: Creds, machineId: string, name: string, authKey = c.authKey) =>
  app.request(blobPath(c, machineId, name), { headers: { authorization: `Bearer ${authKey}` } });

const getChanges = (c: Creds, query = "", authKey = c.authKey) =>
  app.request(`/v1/groups/${c.groupId}/changes${query}`, { headers: { authorization: `Bearer ${authKey}` } });

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
}

describe("GET /v1/info", () => {
  it("describes the server without authentication", async () => {
    const res = await app.request("/v1/info");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      protocols: [1],
      enrollment: "none",
      maxBlobBytes: 65536,
      retentionDays: 400,
      operator: "Test Sync",
    });
  });
});

describe("POST /v1/groups", () => {
  it("creates a group with open enrollment and returns its limits", async () => {
    const res = await createGroup(newCredentials());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ limits: { maxMachines: 3, retentionDays: 400, expiresAt: null } });
  });

  it("is idempotent for the same auth key hash", async () => {
    const c = newCredentials();
    await createGroup(c);
    const res = await createGroup(c);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ limits: { maxMachines: 3, retentionDays: 400, expiresAt: null } });
  });

  it("rejects an existing group ID with a different auth key hash", async () => {
    const c = newCredentials();
    await createGroup(c);
    await expectError(await createGroup({ ...newCredentials(), groupId: c.groupId }), 409, "group_exists");
  });

  it.each([
    ["short group ID", { groupId: "abc", authKeyHash: b64url(randomBytes(32)) }],
    ["bad hash", { groupId: b64url(randomBytes(16)), authKeyHash: "not-a-hash" }],
    ["missing fields", {}],
  ])("rejects a malformed body (%s)", async (_label, body) => {
    const res = await app.request("/v1/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await expectError(res, 400, "invalid_request");
  });

  it("rejects a body that is not JSON", async () => {
    const res = await app.request("/v1/groups", { method: "POST", body: "nope" });
    await expectError(res, 400, "invalid_request");
  });
});

describe("authentication", () => {
  it("returns group_not_found for a wrong auth key, never confirming the group exists", async () => {
    const c = newCredentials();
    await createGroup(c);
    const wrong = b64url(randomBytes(32));
    await expectError(await getChanges(c, "", wrong), 404, "group_not_found");
    await expectError(await getBlob(c, newMachineId(), "profile", wrong), 404, "group_not_found");
    await expectError(
      await putBlob({ ...c, authKey: wrong }, newMachineId(), "profile", new Uint8Array([1])),
      404,
      "group_not_found",
    );
  });

  it("returns the same error for an unknown group", async () => {
    const c = newCredentials();
    await expectError(await getChanges(c), 404, "group_not_found");
  });

  it("returns group_not_found when the Authorization header is missing or malformed", async () => {
    const c = newCredentials();
    await createGroup(c);
    await expectError(await app.request(`/v1/groups/${c.groupId}/changes`), 404, "group_not_found");
    const res = await app.request(`/v1/groups/${c.groupId}/changes`, {
      headers: { authorization: `Basic ${c.authKey}` },
    });
    await expectError(res, 404, "group_not_found");
  });
});

describe("PUT and GET a blob", () => {
  it("round-trips an envelope with an ETag", async () => {
    const c = newCredentials();
    await createGroup(c);
    const machine = newMachineId();
    const envelope = new Uint8Array([1, ...randomBytes(40)]);

    const put = await putBlob(c, machine, "day-2026-09-23", envelope);
    expect(put.status).toBe(200);
    const { etag, updatedAt } = (await put.json()) as { etag: string; updatedAt: string };
    expect(etag).toMatch(/\S/);
    expect(updatedAt).toBe("2026-09-23T14:05:12Z");

    const get = await getBlob(c, machine, "day-2026-09-23");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/octet-stream");
    expect(get.headers.get("etag")).toBe(etag);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(envelope);
  });

  it("replaces the blob wholesale and changes the ETag", async () => {
    const c = newCredentials();
    await createGroup(c);
    const machine = newMachineId();
    const first = (await (await putBlob(c, machine, "profile", new Uint8Array([1, 1]))).json()) as { etag: string };
    const second = (await (await putBlob(c, machine, "profile", new Uint8Array([1, 2]))).json()) as { etag: string };
    expect(second.etag).not.toBe(first.etag);
    expect(new Uint8Array(await (await getBlob(c, machine, "profile")).arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  it("returns blob_not_found for a missing blob", async () => {
    const c = newCredentials();
    await createGroup(c);
    await expectError(await getBlob(c, newMachineId(), "profile"), 404, "blob_not_found");
  });

  it("rejects envelopes larger than maxBlobBytes", async () => {
    const c = newCredentials();
    await createGroup(c);
    await expectError(await putBlob(c, newMachineId(), "profile", new Uint8Array(65537)), 413, "payload_too_large");
    const ok = await putBlob(c, newMachineId(), "profile", new Uint8Array(65536));
    expect(ok.status).toBe(200);
  });

  it("rejects an empty body", async () => {
    const c = newCredentials();
    await createGroup(c);
    await expectError(await putBlob(c, newMachineId(), "profile", new Uint8Array()), 400, "invalid_request");
  });
});

describe("blob names", () => {
  it.each(["profile", "day-2026-09-23"])("accepts %s under a Machine", async (name) => {
    const c = newCredentials();
    await createGroup(c);
    expect((await putBlob(c, newMachineId(), name, new Uint8Array([1]))).status).toBe(200);
  });

  it.each(["retired", "day-2026-9-23", "Profile", "profile.json", "day-", "other"])(
    "rejects %s under a Machine",
    async (name) => {
      const c = newCredentials();
      await createGroup(c);
      await expectError(await putBlob(c, newMachineId(), name, new Uint8Array([1])), 422, "invalid_name");
    },
  );

  it("accepts retired under machine-id = group", async () => {
    const c = newCredentials();
    await createGroup(c);
    expect((await putBlob(c, "group", "retired", new Uint8Array([1]))).status).toBe(200);
  });

  it.each(["profile", "day-2026-09-23"])("rejects %s under machine-id = group", async (name) => {
    const c = newCredentials();
    await createGroup(c);
    await expectError(await putBlob(c, "group", name, new Uint8Array([1])), 422, "invalid_name");
  });

  it("rejects a malformed Machine ID", async () => {
    const c = newCredentials();
    await createGroup(c);
    await expectError(await putBlob(c, "not-a-machine", "profile", new Uint8Array([1])), 422, "invalid_machine_id");
  });
});

describe("If-Match", () => {
  it("writes when the ETag matches and fails with 412 otherwise", async () => {
    const c = newCredentials();
    await createGroup(c);
    const { etag } = (await (await putBlob(c, "group", "retired", new Uint8Array([1]))).json()) as { etag: string };

    const ok = await putBlob(c, "group", "retired", new Uint8Array([2]), { "if-match": etag });
    expect(ok.status).toBe(200);

    const stale = await putBlob(c, "group", "retired", new Uint8Array([3]), { "if-match": etag });
    await expectError(stale, 412, "precondition_failed");
    expect(new Uint8Array(await (await getBlob(c, "group", "retired")).arrayBuffer())).toEqual(new Uint8Array([2]));
  });

  it("fails with 412 when the blob does not exist yet", async () => {
    const c = newCredentials();
    await createGroup(c);
    await expectError(
      await putBlob(c, "group", "retired", new Uint8Array([1]), { "if-match": '"nope"' }),
      412,
      "precondition_failed",
    );
  });
});

describe("Last Seen", () => {
  it("is set from server time on Machine-scoped PUTs only", async () => {
    const c = newCredentials();
    await createGroup(c);
    const machine = newMachineId();

    await putBlob(c, machine, "profile", new Uint8Array([1]));
    now = new Date("2026-09-23T15:00:00Z");
    await putBlob(c, "group", "retired", new Uint8Array([1]));

    let body = (await (await getChanges(c)).json()) as { machines: unknown[] };
    expect(body.machines).toEqual([{ machineId: machine, lastSeen: "2026-09-23T14:05:12Z" }]);

    now = new Date("2026-09-23T16:30:00Z");
    await putBlob(c, machine, "day-2026-09-23", new Uint8Array([1]));
    body = (await (await getChanges(c)).json()) as { machines: unknown[] };
    expect(body.machines).toEqual([{ machineId: machine, lastSeen: "2026-09-23T16:30:00Z" }]);
  });
});

describe("machine limit", () => {
  it("rejects a write that would introduce a Machine beyond maxMachines", async () => {
    const c = newCredentials();
    await createGroup(c);
    const machines = [newMachineId(), newMachineId(), newMachineId()];
    for (const m of machines) expect((await putBlob(c, m, "profile", new Uint8Array([1]))).status).toBe(200);

    await expectError(await putBlob(c, newMachineId(), "profile", new Uint8Array([1])), 403, "machine_limit");
    expect((await putBlob(c, machines[0]!, "day-2026-09-23", new Uint8Array([1]))).status).toBe(200);
    expect((await putBlob(c, "group", "retired", new Uint8Array([1]))).status).toBe(200);
  });
});

describe("GET /v1/groups/{groupId}/changes", () => {
  type Changes = {
    limits: unknown;
    machines: { machineId: string; lastSeen: string }[];
    blobs: { machineId: string; name: string; etag: string; updatedAt: string; body: string }[];
    cursor: string;
    hasMore: boolean;
  };
  const changes = async (c: Creds, query = "") => (await (await getChanges(c, query)).json()) as Changes;

  it("returns every blob with its base64 body when no cursor is given", async () => {
    const c = newCredentials();
    await createGroup(c);
    const machine = newMachineId();
    const { etag } = (await (await putBlob(c, machine, "profile", new Uint8Array([1, 2, 3]))).json()) as {
      etag: string;
    };

    const body = await changes(c);
    expect(body.limits).toEqual({ maxMachines: 3, retentionDays: 400, expiresAt: null });
    expect(body.blobs).toEqual([
      { machineId: machine, name: "profile", etag, updatedAt: "2026-09-23T14:05:12Z", body: "AQID" },
    ]);
    expect(body.hasMore).toBe(false);
    expect(body.cursor).toMatch(/\S/);
  });

  it("returns only what changed since the cursor", async () => {
    const c = newCredentials();
    await createGroup(c);
    const machine = newMachineId();
    await putBlob(c, machine, "profile", new Uint8Array([1]));
    await putBlob(c, machine, "day-2026-09-22", new Uint8Array([1]));
    const first = await changes(c);
    expect(first.blobs.map((b) => b.name)).toEqual(["profile", "day-2026-09-22"]);

    const empty = await changes(c, `?since=${first.cursor}`);
    expect(empty.blobs).toEqual([]);
    expect(empty.cursor).toBe(first.cursor);

    await putBlob(c, machine, "profile", new Uint8Array([2]));
    const next = await changes(c, `?since=${first.cursor}`);
    expect(next.blobs.map((b) => [b.name, b.body])).toEqual([["profile", "Ag=="]]);
  });

  it("paginates with limit and hasMore", async () => {
    const c = newCredentials();
    await createGroup(c);
    const machine = newMachineId();
    for (const d of ["20", "21", "22", "23", "24"]) await putBlob(c, machine, `day-2026-09-${d}`, new Uint8Array([1]));

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await changes(c, `?limit=2${cursor ? `&since=${cursor}` : ""}`);
      pages++;
      seen.push(...page.blobs.map((b) => b.name));
      cursor = page.cursor;
      if (!page.hasMore) break;
      expect(page.blobs).toHaveLength(2);
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(["20", "21", "22", "23", "24"].map((d) => `day-2026-09-${d}`));
  });

  it("always lists every Machine, whatever the cursor", async () => {
    const c = newCredentials();
    await createGroup(c);
    const [a, b] = [newMachineId(), newMachineId()];
    await putBlob(c, a, "profile", new Uint8Array([1]));
    await putBlob(c, b, "profile", new Uint8Array([1]));
    const first = await changes(c);

    const later = await changes(c, `?since=${first.cursor}`);
    expect(later.blobs).toEqual([]);
    expect(later.machines.map((m) => m.machineId).sort()).toEqual([a, b].sort());
  });

  it("never returns another group's blobs", async () => {
    const [c1, c2] = [newCredentials(), newCredentials()];
    await createGroup(c1);
    await createGroup(c2);
    await putBlob(c1, newMachineId(), "profile", new Uint8Array([1]));
    const body = await changes(c2);
    expect(body.blobs).toEqual([]);
    expect(body.machines).toEqual([]);
  });

  it.each(["?since=garbage", "?limit=0", "?limit=abc", "?limit=100000"])("rejects %s", async (query) => {
    const c = newCredentials();
    await createGroup(c);
    await expectError(await getChanges(c, query), 400, "invalid_request");
  });
});

describe("unknown routes", () => {
  it("return a protocol error body", async () => {
    await expectError(await app.request("/v2/info"), 404, "not_found");
  });
});
