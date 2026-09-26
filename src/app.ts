import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { RateLimiter, type RateLimitConfig } from "./rate-limit.js";
import type { Group, SqliteStore } from "./store.js";

/** `none`: anyone can create a group. `optional`: a token is honored but not needed. `required`: a token is needed. */
export type EnrollmentMode = "none" | "optional" | "required";

export const ENROLLMENT_MODES: readonly EnrollmentMode[] = ["none", "optional", "required"];

export type AppConfig = {
  /** Display text shown by clients as-is. */
  operator: string;
  maxBlobBytes: number;
  retentionDays: number;
  /** Default for groups created without an Enrollment Token, or with one that sets no cap. */
  maxMachines: number;
  enrollment: EnrollmentMode;
  rateLimit: RateLimitConfig;
  /** Use the last `X-Forwarded-For` hop as the client address. Only turn on behind a reverse proxy that sets it. */
  trustProxy: boolean;
};

export type AppDeps = {
  store: SqliteStore;
  config: AppConfig;
  clock?: () => Date;
  /** The socket's remote address. Tests and in-process callers can leave it out. */
  remoteAddress?: (c: Context) => string | undefined;
};

/** How long reads keep working after a group's `expiresAt` (protocol §6.4). */
export const EXPIRED_READ_DAYS = 30;
const DAY_MS = 86_400_000;

/** The reserved Machine ID for blobs that belong to the Sync Group (protocol §4, §5.3). */
const GROUP_MACHINE_ID = "group";

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

/**
 * Unpadded base64url that decodes to exactly `byteLength` bytes and round-trips, so no two strings name the same
 * bytes. Group and Machine IDs are 16 bytes; auth keys and their hashes are 32.
 */
function decodeBase64url(value: string, byteLength: number): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === byteLength && bytes.toString("base64url") === value ? bytes : undefined;
}

const isValidId = (value: string) => decodeBase64url(value, 16) !== undefined;

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

type BlobAddress = { machineId: string; name: string; isGroupBlob: boolean };

/** Validates the Machine ID and blob name in the route (protocol §4, §5.3, §6.4). */
function blobAddress(c: Context): BlobAddress | Response {
  const machineId = c.req.param("machineId") ?? "";
  const name = c.req.param("name") ?? "";
  const isGroupBlob = machineId === GROUP_MACHINE_ID;
  if (!isGroupBlob && !isValidId(machineId)) {
    return error(c, 422, "invalid_machine_id", 'machineId must be 16 bytes of base64url or "group".');
  }
  // `retired` is the only group blob, and it only lives under `group`.
  if (!BLOB_NAME_PATTERN.test(name) || isGroupBlob !== (name === "retired")) {
    return error(c, 422, "invalid_name", `"${name}" is not a valid blob name here.`);
  }
  return { machineId, name, isGroupBlob };
}

/** Reads `Authorization: Enrollment <token>`. `undefined` means none was presented, `null` a malformed one. */
function enrollmentToken(c: Context): Uint8Array | null | undefined {
  const [scheme = "", token = "", ...rest] = (c.req.header("authorization") ?? "").trim().split(/\s+/);
  if (scheme.toLowerCase() !== "enrollment") return undefined;
  return (rest.length === 0 && decodeBase64url(token, 32)) || null;
}

/** Where the group stands against its `expiresAt`: `expired` stops writes, `closed` stops reads too. */
function expiryState(group: Group, now: Date): "active" | "expired" | "closed" {
  if (group.limits.expiresAt === null) return "active";
  const expiresAt = Date.parse(group.limits.expiresAt);
  if (now.getTime() < expiresAt) return "active";
  return now.getTime() < expiresAt + EXPIRED_READ_DAYS * DAY_MS ? "expired" : "closed";
}

const enrollmentExpired = (c: Context) => error(c, 403, "enrollment_expired", "This group's enrollment has expired.");

/** The rate-limit key for a request: the last `X-Forwarded-For` hop behind a trusted proxy, else the socket address. */
export function clientKey(c: Context, trustProxy: boolean, remoteAddress: AppDeps["remoteAddress"]): string {
  if (trustProxy) {
    const hop = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (hop) return hop;
  }
  return remoteAddress?.(c) ?? "unknown";
}

type Env = { Variables: { group: Group } };

export function createApp({ store, config, clock = () => new Date(), remoteAddress }: AppDeps) {
  const app = new Hono<Env>();
  const limiter = new RateLimiter(config.rateLimit);

  /** Per-client rate limit on every route, ahead of any other work (protocol §6.8). */
  app.use("*", async (c, next) => {
    const decision = limiter.take(clientKey(c, config.trustProxy, remoteAddress), clock().getTime());
    if (!decision.ok) {
      c.header("retry-after", String(decision.retryAfterSeconds));
      return error(c, 429, "rate_limited", `Too many requests. Retry in ${decision.retryAfterSeconds} s.`);
    }
    await next();
  });

  /** Other protocol versions get their own error rather than a plain 404 (protocol §6.8, §11). */
  app.use("/:version{v\\d+}/*", async (c, next) => {
    if (c.req.param("version") !== "v1") {
      return error(c, 400, "unsupported_version", "This server speaks protocol version 1 only.");
    }
    await next();
  });

  /**
   * Every group-scoped route runs behind this, before any body is read. It resolves the group only when the bearer
   * credential matches. Every failure looks the same to the caller (protocol §6.1), and the hash comparison runs
   * whether or not the group exists.
   */
  app.use("/v1/groups/:groupId/*", async (c, next) => {
    const groupId = c.req.param("groupId");
    const [scheme = "", token = ""] = (c.req.header("authorization") ?? "").trim().split(/\s+/);
    const authKey = scheme.toLowerCase() === "bearer" ? decodeBase64url(token, 32) : undefined;
    const group = isValidId(groupId) ? store.getGroup(groupId) : undefined;

    const presented = createHash("sha256")
      .update(authKey ?? new Uint8Array())
      .digest();
    const matches = sameBytes(presented, group?.authKeyHash ?? DUMMY_HASH);
    if (!group || !authKey || !matches) return groupNotFound(c);

    // After expiry, writes stop and reads keep working for EXPIRED_READ_DAYS. Deletion always works.
    const state = expiryState(group, clock());
    const method = c.req.method;
    if (state === "expired" && method !== "GET" && method !== "HEAD" && method !== "DELETE") {
      return enrollmentExpired(c);
    }
    if (state === "closed" && method !== "DELETE") return enrollmentExpired(c);

    c.set("group", group);
    await next();
  });

  app.get("/v1/info", (c) =>
    c.json({
      protocols: [1],
      enrollment: config.enrollment,
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
    const hash = typeof authKeyHash === "string" ? decodeBase64url(authKeyHash, 32) : undefined;
    if (!hash) return invalidRequest(c, "authKeyHash must be a base64url SHA-256 digest.");

    let tokenHash: Uint8Array | undefined;
    if (config.enrollment !== "none") {
      const token = enrollmentToken(c);
      if (token === null) return error(c, 403, "enrollment_invalid", "The Enrollment Token is not valid.");
      if (token === undefined && config.enrollment === "required") {
        return error(c, 402, "enrollment_required", "This server needs an Enrollment Token to create a group.");
      }
      tokenHash = token && createHash("sha256").update(token).digest();
    }

    const result = store.createGroup({
      groupId,
      authKeyHash: hash,
      defaultLimits: { maxMachines: config.maxMachines, retentionDays: config.retentionDays, expiresAt: null },
      tokenHash,
      now: timestamp(clock()),
    });
    if (result.ok) return c.json({ limits: result.group.limits }, result.created ? 201 : 200);
    switch (result.reason) {
      case "group_exists":
        return error(c, 409, "group_exists", "A group with this ID already exists.");
      case "enrollment_invalid":
        return error(c, 403, "enrollment_invalid", "The Enrollment Token is not valid.");
      case "enrollment_used":
        return error(c, 403, "enrollment_used", "This Enrollment Token already created a different group.");
      case "enrollment_expired":
        return enrollmentExpired(c);
    }
  });

  app.delete("/v1/groups/:groupId", (c) => {
    store.deleteGroup(c.get("group").groupId);
    return c.body(null, 204);
  });

  app.delete("/v1/groups/:groupId/machines/:machineId", (c) => {
    const machineId = c.req.param("machineId");
    if (!isValidId(machineId)) return error(c, 422, "invalid_machine_id", "machineId must be 16 bytes of base64url.");
    store.deleteMachine(c.get("group").groupId, machineId);
    return c.body(null, 204);
  });

  const blobRoute = "/v1/groups/:groupId/machines/:machineId/blobs/:name";

  app.put(
    blobRoute,
    bodyLimit({
      maxSize: config.maxBlobBytes,
      onError: (c) => error(c, 413, "payload_too_large", `Blobs are limited to ${config.maxBlobBytes} bytes.`),
    }),
    async (c) => {
      const group = c.get("group");
      const address = blobAddress(c);
      if (address instanceof Response) return address;
      const { machineId, name, isGroupBlob } = address;

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
      if (result.ok) {
        c.header("etag", result.etag);
        return c.json({ etag: result.etag, updatedAt: result.updatedAt });
      }
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
    const address = blobAddress(c);
    if (address instanceof Response) return address;
    const blob = store.getBlob(c.get("group").groupId, address.machineId, address.name);
    if (!blob) return error(c, 404, "blob_not_found", "No blob at this address.");
    return c.body(new Uint8Array(blob.body), 200, { "content-type": "application/octet-stream", etag: blob.etag });
  });

  app.get("/v1/groups/:groupId/changes", (c) => {
    const group = c.get("group");

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
