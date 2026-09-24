import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SqliteStore } from "../src/store.js";

// Protocol §12: a Sync Server checks itself against the shared test vectors. It never decrypts, so what it can
// prove is that it accepts the credential the client derives and hands envelopes back byte for byte.
type Vectors = {
  keys: {
    groupIdBase64url: string;
    authKey: string;
    authorizationHeader: string;
    authKeyHashBase64url: string;
  };
  envelopes: { machineId: string; name: string; envelope: string }[];
};

const vectors = JSON.parse(readFileSync(new URL("fixtures/vectors.json", import.meta.url), "utf8")) as Vectors;
const { keys } = vectors;

const app = createApp({ store: new SqliteStore(":memory:"), config: loadConfig({}) });
const auth = { authorization: keys.authorizationHeader };
const groupPath = `/v1/groups/${keys.groupIdBase64url}`;

it("hashes the vector auth key to the vector auth key hash", () => {
  const hash = createHash("sha256").update(Buffer.from(keys.authKey, "hex")).digest("base64url");
  expect(hash).toBe(keys.authKeyHashBase64url);
});

it("accepts the vector group and credential", async () => {
  const created = await app.request("/v1/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ groupId: keys.groupIdBase64url, authKeyHash: keys.authKeyHashBase64url }),
  });
  expect(created.status).toBe(201);
  expect((await app.request(`${groupPath}/changes`, { headers: auth })).status).toBe(200);
});

it("stores every vector envelope at its address and returns it byte for byte", async () => {
  for (const v of vectors.envelopes) {
    const body = new Uint8Array(Buffer.from(v.envelope, "base64"));
    const put = await app.request(`${groupPath}/machines/${v.machineId}/blobs/${v.name}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body,
    });
    expect(put.status, `${v.machineId}/${v.name}`).toBe(200);
    const get = await app.request(`${groupPath}/machines/${v.machineId}/blobs/${v.name}`, { headers: auth });
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(body);
  }

  const changes = (await (await app.request(`${groupPath}/changes`, { headers: auth })).json()) as {
    blobs: { machineId: string; name: string; body: string }[];
  };
  const byAddress = new Map(changes.blobs.map((b) => [`${b.machineId}/${b.name}`, b.body]));
  for (const v of vectors.envelopes) expect(byAddress.get(`${v.machineId}/${v.name}`)).toBe(v.envelope);
});
