import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startServer, type RunningServer } from "../src/server.js";

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({ ...loadConfig({}), host: "127.0.0.1", port: 0, dbPath: ":memory:" });
});

afterAll(() => server.close());

it("creates a group, pushes a blob, and reads it back over HTTP", async () => {
  const authKey = randomBytes(32);
  const groupId = randomBytes(16).toString("base64url");
  const machineId = randomBytes(16).toString("base64url");
  const auth = { authorization: `Bearer ${authKey.toString("base64url")}` };
  const envelope = new Uint8Array([1, ...randomBytes(100)]);

  const info = await fetch(`${server.url}/v1/info`);
  expect(await info.json()).toMatchObject({ protocols: [1], enrollment: "none" });

  const created = await fetch(`${server.url}/v1/groups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      groupId,
      authKeyHash: createHash("sha256").update(authKey).digest("base64url"),
    }),
  });
  expect(created.status).toBe(201);

  const blobUrl = `${server.url}/v1/groups/${groupId}/machines/${machineId}/blobs/day-2026-09-23`;
  const put = await fetch(blobUrl, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/octet-stream" },
    body: envelope,
  });
  expect(put.status).toBe(200);
  const { etag } = (await put.json()) as { etag: string };

  const get = await fetch(blobUrl, { headers: auth });
  expect(get.status).toBe(200);
  expect(get.headers.get("etag")).toBe(etag);
  expect(new Uint8Array(await get.arrayBuffer())).toEqual(envelope);

  const changes = (await (await fetch(`${server.url}/v1/groups/${groupId}/changes`, { headers: auth })).json()) as {
    machines: { machineId: string }[];
    blobs: { name: string; body: string }[];
  };
  expect(changes.machines.map((m) => m.machineId)).toEqual([machineId]);
  expect(changes.blobs).toHaveLength(1);
  expect(new Uint8Array(Buffer.from(changes.blobs[0]!.body, "base64"))).toEqual(envelope);
});

it("rejects an oversized body over real HTTP", async () => {
  const authKey = randomBytes(32);
  const groupId = randomBytes(16).toString("base64url");
  await fetch(`${server.url}/v1/groups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ groupId, authKeyHash: createHash("sha256").update(authKey).digest("base64url") }),
  });
  const res = await fetch(`${server.url}/v1/groups/${groupId}/machines/${"B".repeat(22)}/blobs/profile`, {
    method: "PUT",
    headers: { authorization: `Bearer ${authKey.toString("base64url")}` },
    body: new Uint8Array(65537),
  });
  expect(res.status).toBe(413);
});
