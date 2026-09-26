import { randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type Limits = {
  maxMachines: number;
  retentionDays: number;
  expiresAt: string | null;
};

export type Group = {
  groupId: string;
  authKeyHash: Uint8Array;
  limits: Limits;
};

export type Machine = { machineId: string; lastSeen: string };

export type Blob = {
  machineId: string;
  name: string;
  body: Uint8Array;
  etag: string;
  updatedAt: string;
};

export type PutBlobInput = {
  groupId: string;
  machineId: string;
  name: string;
  body: Uint8Array;
  ifMatch: string | undefined;
  /** Server receive time, RFC 3339. Also becomes the Machine's Last Seen unless `touchesMachine` is false. */
  receivedAt: string;
  /** False for `machine-id = group`: group blobs neither count as a Machine nor update Last Seen. */
  touchesMachine: boolean;
};

export type PutBlobResult =
  | { ok: true; etag: string; updatedAt: string }
  | { ok: false; reason: "precondition_failed" | "machine_limit" | "group_not_found" };

export type ChangesPage = { blobs: Blob[]; lastSeq: number; hasMore: boolean };

export type EnrollmentToken = {
  tokenId: string;
  /** Overrides the server's default `maxMachines` for the group this token creates. */
  maxMachines: number | null;
  /** RFC 3339. The token can't create a group after this, and it becomes the group's `expiresAt`. */
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
  /** The group this token created. It stays set after that group is deleted. */
  groupId: string | null;
  usedAt: string | null;
};

export type CreateGroupInput = {
  groupId: string;
  authKeyHash: Uint8Array;
  /** Limits for a group created without an Enrollment Token. */
  defaultLimits: Limits;
  /** SHA-256 of the presented Enrollment Token, if any. */
  tokenHash?: Uint8Array;
  /** RFC 3339 server time. */
  now: string;
};

export type CreateGroupResult =
  | { ok: true; created: boolean; group: Group }
  | { ok: false; reason: "group_exists" | "enrollment_invalid" | "enrollment_used" | "enrollment_expired" };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  group_id       TEXT PRIMARY KEY,
  auth_key_hash  BLOB NOT NULL,
  max_machines   INTEGER NOT NULL,
  retention_days INTEGER NOT NULL,
  expires_at     TEXT,
  created_at     TEXT NOT NULL,
  last_seq       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS machines (
  group_id   TEXT NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (group_id, machine_id)
);
CREATE TABLE IF NOT EXISTS blobs (
  group_id   TEXT NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  body       BLOB NOT NULL,
  etag       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (group_id, machine_id, name)
);
CREATE INDEX IF NOT EXISTS blobs_by_seq ON blobs (group_id, seq);
-- group_id has no foreign key on purpose: a token stays bound to its group after the group is deleted (protocol §6.7).
CREATE TABLE IF NOT EXISTS enrollment_tokens (
  token_id     TEXT PRIMARY KEY,
  token_hash   BLOB NOT NULL UNIQUE,
  max_machines INTEGER,
  expires_at   TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL,
  group_id     TEXT,
  used_at      TEXT
);
`;

type GroupRow = {
  group_id: string;
  auth_key_hash: Uint8Array;
  max_machines: number;
  retention_days: number;
  expires_at: string | null;
};

type BlobRow = {
  machine_id: string;
  name: string;
  body: Uint8Array;
  etag: string;
  updated_at: string;
  seq: number;
};

type TokenRow = {
  token_id: string;
  max_machines: number | null;
  expires_at: string | null;
  note: string | null;
  created_at: string;
  group_id: string | null;
  used_at: string | null;
};

const TOKEN_COLUMNS = "token_id, max_machines, expires_at, note, created_at, group_id, used_at";

const toToken = (row: TokenRow): EnrollmentToken => ({
  tokenId: row.token_id,
  maxMachines: row.max_machines,
  expiresAt: row.expires_at,
  note: row.note,
  createdAt: row.created_at,
  groupId: row.group_id,
  usedAt: row.used_at,
});

const toBlob = (row: BlobRow): Blob => ({
  machineId: row.machine_id,
  name: row.name,
  body: row.body,
  etag: row.etag,
  updatedAt: row.updated_at,
});

const sameHash = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

/** SQLite-backed storage. Each group keeps its own change sequence, which the `changes` cursor points into. */
export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  getGroup(groupId: string): Group | undefined {
    const row = this.db
      .prepare(
        "SELECT group_id, auth_key_hash, max_machines, retention_days, expires_at FROM groups WHERE group_id = ?",
      )
      .get(groupId) as GroupRow | undefined;
    if (!row) return undefined;
    return {
      groupId: row.group_id,
      authKeyHash: row.auth_key_hash,
      limits: { maxMachines: row.max_machines, retentionDays: row.retention_days, expiresAt: row.expires_at },
    };
  }

  /**
   * Creates a group, spending an Enrollment Token when one is given (protocol §6.3). A token binds to exactly one
   * group ID. Presenting it again for that same ID is idempotent, and it stays bound after the group is deleted.
   */
  createGroup(input: CreateGroupInput): CreateGroupResult {
    return this.transaction(() => {
      let token: TokenRow | undefined;
      if (input.tokenHash) {
        token = this.db
          .prepare(`SELECT ${TOKEN_COLUMNS} FROM enrollment_tokens WHERE token_hash = ?`)
          .get(input.tokenHash) as TokenRow | undefined;
        if (!token) return { ok: false, reason: "enrollment_invalid" };
        if (token.group_id !== null && token.group_id !== input.groupId) {
          return { ok: false, reason: "enrollment_used" };
        }
      }

      const existing = this.getGroup(input.groupId);
      if (existing) {
        if (!sameHash(existing.authKeyHash, input.authKeyHash)) return { ok: false, reason: "group_exists" };
        return { ok: true, created: false, group: existing };
      }

      if (token?.expires_at && token.expires_at <= input.now) return { ok: false, reason: "enrollment_expired" };
      const limits: Limits = token
        ? {
            maxMachines: token.max_machines ?? input.defaultLimits.maxMachines,
            retentionDays: input.defaultLimits.retentionDays,
            expiresAt: token.expires_at,
          }
        : input.defaultLimits;
      this.db
        .prepare(
          `INSERT INTO groups (group_id, auth_key_hash, max_machines, retention_days, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.groupId, input.authKeyHash, limits.maxMachines, limits.retentionDays, limits.expiresAt, input.now);
      if (token) {
        this.db
          .prepare("UPDATE enrollment_tokens SET group_id = ?, used_at = COALESCE(used_at, ?) WHERE token_id = ?")
          .run(input.groupId, input.now, token.token_id);
      }
      return { ok: true, created: true, group: this.getGroup(input.groupId)! };
    });
  }

  /** Removes the group and everything in it. Its Enrollment Token stays bound to the group ID. */
  deleteGroup(groupId: string): boolean {
    return this.db.prepare("DELETE FROM groups WHERE group_id = ?").run(groupId).changes > 0;
  }

  /** Removes a Machine and all of its blobs. The group's `retired` blob is left alone. */
  deleteMachine(groupId: string, machineId: string): boolean {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM blobs WHERE group_id = ? AND machine_id = ?").run(groupId, machineId);
      return this.db.prepare("DELETE FROM machines WHERE group_id = ? AND machine_id = ?").run(groupId, machineId)
        .changes > 0;
    });
  }

  /**
   * Deletes `day-*` blobs dated more than each group's `retentionDays` before `today` (a UTC `YYYY-MM-DD`), per
   * protocol §7. `profile` and `retired` are never touched. Returns how many blobs were deleted.
   */
  pruneExpiredDays(today: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM blobs WHERE name LIKE 'day-%' AND substr(name, 5) < (
           SELECT date(?, '-' || g.retention_days || ' days') FROM groups g WHERE g.group_id = blobs.group_id
         )`,
      )
      .run(today);
    return Number(result.changes);
  }

  insertEnrollmentToken(
    token: Omit<EnrollmentToken, "groupId" | "usedAt">,
    tokenHash: Uint8Array,
  ): EnrollmentToken {
    this.db
      .prepare(
        `INSERT INTO enrollment_tokens (token_id, token_hash, max_machines, expires_at, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(token.tokenId, tokenHash, token.maxMachines, token.expiresAt, token.note, token.createdAt);
    return { ...token, groupId: null, usedAt: null };
  }

  listEnrollmentTokens(): EnrollmentToken[] {
    const rows = this.db
      .prepare(`SELECT ${TOKEN_COLUMNS} FROM enrollment_tokens ORDER BY created_at, token_id`)
      .all() as TokenRow[];
    return rows.map(toToken);
  }

  /** Deletes a token that hasn't created a group yet. A used token stays, because it records the binding. */
  revokeEnrollmentToken(tokenId: string): "revoked" | "not_found" | "used" {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT group_id FROM enrollment_tokens WHERE token_id = ?").get(tokenId) as
        | { group_id: string | null }
        | undefined;
      if (!row) return "not_found";
      if (row.group_id !== null) return "used";
      this.db.prepare("DELETE FROM enrollment_tokens WHERE token_id = ?").run(tokenId);
      return "revoked";
    });
  }

  putBlob(input: PutBlobInput): PutBlobResult {
    return this.transaction(() => {
      const group = this.getGroup(input.groupId);
      if (!group) return { ok: false, reason: "group_not_found" };

      const existing = this.db
        .prepare("SELECT etag FROM blobs WHERE group_id = ? AND machine_id = ? AND name = ?")
        .get(input.groupId, input.machineId, input.name) as { etag: string } | undefined;
      const matches = input.ifMatch === "*" ? existing !== undefined : existing?.etag === input.ifMatch;
      if (input.ifMatch !== undefined && !matches) {
        return { ok: false, reason: "precondition_failed" };
      }

      if (input.touchesMachine) {
        const known = this.db
          .prepare("SELECT 1 FROM machines WHERE group_id = ? AND machine_id = ?")
          .get(input.groupId, input.machineId);
        if (!known) {
          const { count } = this.db
            .prepare("SELECT COUNT(*) AS count FROM machines WHERE group_id = ?")
            .get(input.groupId) as { count: number };
          if (count >= group.limits.maxMachines) return { ok: false, reason: "machine_limit" };
        }
        this.db
          .prepare(
            `INSERT INTO machines (group_id, machine_id, last_seen) VALUES (?, ?, ?)
             ON CONFLICT (group_id, machine_id) DO UPDATE SET last_seen = excluded.last_seen`,
          )
          .run(input.groupId, input.machineId, input.receivedAt);
      }

      const { last_seq: seq } = this.db
        .prepare("UPDATE groups SET last_seq = last_seq + 1 WHERE group_id = ? RETURNING last_seq")
        .get(input.groupId) as { last_seq: number };
      const etag = `"${randomBytes(12).toString("base64url")}"`;
      this.db
        .prepare(
          `INSERT INTO blobs (group_id, machine_id, name, body, etag, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (group_id, machine_id, name) DO UPDATE SET
             body = excluded.body, etag = excluded.etag, updated_at = excluded.updated_at, seq = excluded.seq`,
        )
        .run(input.groupId, input.machineId, input.name, input.body, etag, input.receivedAt, seq);
      return { ok: true, etag, updatedAt: input.receivedAt };
    });
  }

  getBlob(groupId: string, machineId: string, name: string): Blob | undefined {
    const row = this.db
      .prepare(
        `SELECT machine_id, name, body, etag, updated_at, seq FROM blobs
         WHERE group_id = ? AND machine_id = ? AND name = ?`,
      )
      .get(groupId, machineId, name) as BlobRow | undefined;
    return row && toBlob(row);
  }

  listMachines(groupId: string): Machine[] {
    const rows = this.db
      .prepare("SELECT machine_id, last_seen FROM machines WHERE group_id = ? ORDER BY machine_id")
      .all(groupId) as { machine_id: string; last_seen: string }[];
    return rows.map((r) => ({ machineId: r.machine_id, lastSeen: r.last_seen }));
  }

  /** Blobs written after `afterSeq`, oldest write first. */
  changes(groupId: string, afterSeq: number, limit: number): ChangesPage {
    const rows = this.db
      .prepare(
        `SELECT machine_id, name, body, etag, updated_at, seq FROM blobs
         WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(groupId, afterSeq, limit + 1) as BlobRow[];
    const page = rows.slice(0, limit);
    return {
      blobs: page.map(toBlob),
      lastSeq: page.at(-1)?.seq ?? afterSeq,
      hasMore: rows.length > limit,
    };
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
