import { createHash, randomBytes } from "node:crypto";
import type { EnrollmentToken, SqliteStore } from "./store.js";

/** RFC 3339 UTC with second precision, the same form the API uses. */
export const timestamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

export type MintTokenInput = {
  maxMachines: number | null;
  /** RFC 3339, or null for a token that never expires. */
  expiresAt: string | null;
  note: string | null;
  now: Date;
};

/**
 * Creates an Enrollment Token and returns its secret, which exists only in the return value. The store keeps the
 * SHA-256 of the secret, never the secret itself.
 */
export function mintEnrollmentToken(
  store: SqliteStore,
  input: MintTokenInput,
): { secret: string; token: EnrollmentToken } {
  const secret = randomBytes(32);
  const token = store.insertEnrollmentToken(
    {
      tokenId: randomBytes(6).toString("base64url"),
      maxMachines: input.maxMachines,
      expiresAt: input.expiresAt,
      note: input.note,
      createdAt: timestamp(input.now),
    },
    createHash("sha256").update(secret).digest(),
  );
  return { secret: secret.toString("base64url"), token };
}
