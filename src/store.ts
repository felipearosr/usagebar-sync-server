import { randomBytes } from "node:crypto";
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

const toBlob = (row: BlobRow): Blob => ({
  machineId: row.machine_id,
  name: row.name,
  body: row.body,
  etag: row.etag,
  updatedAt: row.updated_at,
});

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
      .prepare("SELECT group_id, auth_key_hash, max_machines, retention_days, expires_at FROM groups WHERE group_id = ?")
      .get(groupId) as GroupRow | undefined;
    if (!row) return undefined;
    return {
      groupId: row.group_id,
      authKeyHash: row.auth_key_hash,
      limits: { maxMachines: row.max_machines, retentionDays: row.retention_days, expiresAt: row.expires_at },
    };
  }

  /** Inserts the group unless its ID is taken. Returns the stored group either way. */
  createGroup(group: Group, createdAt: string): { created: boolean; group: Group } {
    const result = this.db
      .prepare(
        `INSERT INTO groups (group_id, auth_key_hash, max_machines, retention_days, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (group_id) DO NOTHING`,
      )
      .run(
        group.groupId,
        group.authKeyHash,
        group.limits.maxMachines,
        group.limits.retentionDays,
        group.limits.expiresAt,
        createdAt,
      );
    return { created: result.changes === 1, group: this.getGroup(group.groupId)! };
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
