import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Group, SqliteStore } from "./store.js";

export type AppConfig = {
  /** Display text shown by clients as-is. */
  operator: string;
  maxBlobBytes: number;
  retentionDays: number;
  maxMachines: number;
};

export type AppDeps = {
  store: SqliteStore;
  config: AppConfig;
  clock?: () => Date;
};

/** The reserved Machine ID for blobs that belong to the Sync Group (protocol §4, §5.3). */
const GROUP_MACHINE_ID = "group";

const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/; // 16 bytes, base64url, no padding
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding
const BLOB_NAME_PATTERN = /^(profile|retired|day-\d{4}-\d{2}-\d{2})$/;

const DEFAULT_CHANGES_LIMIT = 100;
const MAX_CHANGES_LIMIT = 500;

/** Compared against when the group is unknown, so both paths do the same work. */
const DUMMY_HASH = new Uint8Array(32);

function error(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

const groupNotFound = (c: Context) => error(c, 404, "group_not_found", "Group not found or credentials are wrong.");
const invalidRequest = (c: Context, message: string) => error(c, 400, "invalid_request", message);

/** RFC 3339 UTC with second precision. */
const timestamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

const encodeCursor = (seq: number) => Buffer.from(`c1.${seq}`).toString("base64url");

function decodeCursor(cursor: string): number | undefined {
  const match = /^c1\.(\d{1,15})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return match ? Number(match[1]) : undefined;
}

/** Base64url that decodes to exactly `length` bytes and round-trips, so no two strings name the same bytes. */
function decodeKey(value: string, length: number): Uint8Array | undefined {
  if (!KEY_PATTERN.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === length && bytes.toString("base64url") === value ? bytes : undefined;
}

function isValidId(value: string) {
  return ID_PATTERN.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}

export function createApp({ store, config, clock = () => new Date() }: AppDeps) {
  const app = new Hono();

  /**
   * Resolves the group only when the bearer credential matches. Every failure looks the same to the caller
   * (protocol §6.1), and the hash comparison runs whether or not the group exists.
   */
  function authenticate(c: Context): Group | undefined {
    const groupId = c.req.param("groupId") ?? "";
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const authKey = decodeKey(token, 32);
    const group = isValidId(groupId) ? store.getGroup(groupId) : undefined;

    const presented = createHash("sha256")
      .update(authKey ?? new Uint8Array())
      .digest();
    const expected = group?.authKeyHash ?? DUMMY_HASH;
    const matches = expected.length === presented.length && timingSafeEqual(presented, expected);
    return group && authKey && matches ? group : undefined;
  }

  app.get("/v1/info", (c) =>
    c.json({
      protocols: [1],
      enrollment: "none",
      maxBlobBytes: config.maxBlobBytes,
      retentionDays: config.retentionDays,
      operator: config.operator,
    }),
  );

  app.post("/v1/groups", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalidRequest(c, "Body must be JSON.");
    }
    const { groupId, authKeyHash } = (body ?? {}) as { groupId?: unknown; authKeyHash?: unknown };
    if (typeof groupId !== "string" || !isValidId(groupId)) {
      return invalidRequest(c, "groupId must be 16 bytes of base64url.");
    }
    const hash = typeof authKeyHash === "string" ? decodeKey(authKeyHash, 32) : undefined;
    if (!hash) return invalidRequest(c, "authKeyHash must be a base64url SHA-256 digest.");

    const { created, group } = store.createGroup(
      {
        groupId,
        authKeyHash: hash,
        limits: { maxMachines: config.maxMachines, retentionDays: config.retentionDays, expiresAt: null },
      },
      timestamp(clock()),
    );
    if (created) return c.json({ limits: group.limits }, 201);
    if (timingSafeEqual(group.authKeyHash, hash)) return c.json({ limits: group.limits }, 200);
    return error(c, 409, "group_exists", "A group with this ID already exists.");
  });

  const blobRoute = "/v1/groups/:groupId/machines/:machineId/blobs/:name";

  app.put(
    blobRoute,
    bodyLimit({
      maxSize: config.maxBlobBytes,
      onError: (c) => error(c, 413, "payload_too_large", `Blobs are limited to ${config.maxBlobBytes} bytes.`),
    }),
    async (c) => {
      const group = authenticate(c);
      if (!group) return groupNotFound(c);

      const { machineId, name } = c.req.param();
      const isGroupBlob = machineId === GROUP_MACHINE_ID;
      if (!isGroupBlob && !isValidId(machineId)) {
        return error(c, 422, "invalid_machine_id", "machineId must be 16 bytes of base64url or \"group\".");
      }
      // `retired` is the only group blob, and it only lives under `group` (protocol §5.3, §6.4).
      if (!BLOB_NAME_PATTERN.test(name) || isGroupBlob !== (name === "retired")) {
        return error(c, 422, "invalid_name", `"${name}" is not a valid blob name here.`);
      }

      const body = new Uint8Array(await c.req.arrayBuffer());
      if (body.length === 0) return invalidRequest(c, "Blob body must not be empty.");

      const result = store.putBlob({
        groupId: group.groupId,
        machineId,
        name,
        body,
        ifMatch: c.req.header("if-match"),
        receivedAt: timestamp(clock()),
        touchesMachine: !isGroupBlob,
      });
      if (result.ok) return c.json({ etag: result.etag, updatedAt: result.updatedAt });
      switch (result.reason) {
        case "precondition_failed":
          return error(c, 412, "precondition_failed", "The blob changed since it was read.");
        case "machine_limit":
          return error(c, 403, "machine_limit", `This group allows at most ${group.limits.maxMachines} Machines.`);
        case "group_not_found":
          return groupNotFound(c);
      }
    },
  );

  app.get(blobRoute, (c) => {
    const group = authenticate(c);
    if (!group) return groupNotFound(c);
    const { machineId, name } = c.req.param();
    const blob = store.getBlob(group.groupId, machineId, name);
    if (!blob) return error(c, 404, "blob_not_found", "No blob at this address.");
    return c.body(new Uint8Array(blob.body), 200, { "content-type": "application/octet-stream", etag: blob.etag });
  });

  app.get("/v1/groups/:groupId/changes", (c) => {
    const group = authenticate(c);
    if (!group) return groupNotFound(c);

    const since = c.req.query("since");
    const afterSeq = since === undefined ? 0 : decodeCursor(since);
    if (afterSeq === undefined) return invalidRequest(c, "since is not a cursor from this server.");

    const limitParam = c.req.query("limit");
    const limit = limitParam === undefined ? DEFAULT_CHANGES_LIMIT : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHANGES_LIMIT) {
      return invalidRequest(c, `limit must be an integer from 1 to ${MAX_CHANGES_LIMIT}.`);
    }

    const page = store.changes(group.groupId, afterSeq, limit);
    return c.json({
      limits: group.limits,
      machines: store.listMachines(group.groupId),
      blobs: page.blobs.map((b) => ({
        machineId: b.machineId,
        name: b.name,
        etag: b.etag,
        updatedAt: b.updatedAt,
        body: Buffer.from(b.body).toString("base64"),
      })),
      cursor: encodeCursor(page.lastSeq),
      hasMore: page.hasMore,
    });
  });

  app.notFound((c) => error(c, 404, "not_found", "No such endpoint."));
  app.onError((err, c) => {
    console.error(err);
    return error(c, 500, "internal_error", "Internal server error.");
  });

  return app;
}
