import { DatabaseSync } from "node:sqlite";

/** One Stripe subscription and the Enrollment Token it currently pays for. */
export type SubscriptionRecord = {
  subscriptionId: string;
  customerId: string | null;
  /** The token in the Sync Server's `enrollment_tokens`. It changes when the customer asks for a replacement. */
  tokenId: string;
  status: string;
  /** RFC 3339, mirrored onto the token and its group. */
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id TEXT PRIMARY KEY,
  customer_id     TEXT,
  token_id        TEXT NOT NULL,
  status          TEXT NOT NULL,
  expires_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
`;

type Row = {
  subscription_id: string;
  customer_id: string | null;
  token_id: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

const toRecord = (row: Row): SubscriptionRecord => ({
  subscriptionId: row.subscription_id,
  customerId: row.customer_id,
  tokenId: row.token_id,
  status: row.status,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * The hosted plan's own data, kept in a separate SQLite file from the Sync Server's. It holds Stripe IDs and token
 * IDs only: no email addresses, no token secrets, no keys.
 */
export class HostedStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  get(subscriptionId: string): SubscriptionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE subscription_id = ?").get(subscriptionId) as
      Row | undefined;
    return row && toRecord(row);
  }

  insert(record: SubscriptionRecord) {
    this.db
      .prepare(
        `INSERT INTO subscriptions (subscription_id, customer_id, token_id, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.subscriptionId,
        record.customerId,
        record.tokenId,
        record.status,
        record.expiresAt,
        record.createdAt,
        record.updatedAt,
      );
  }

  update(subscriptionId: string, fields: Pick<SubscriptionRecord, "tokenId" | "status" | "expiresAt" | "updatedAt">) {
    this.db
      .prepare(
        "UPDATE subscriptions SET token_id = ?, status = ?, expires_at = ?, updated_at = ? WHERE subscription_id = ?",
      )
      .run(fields.tokenId, fields.status, fields.expiresAt, fields.updatedAt, subscriptionId);
  }
}
