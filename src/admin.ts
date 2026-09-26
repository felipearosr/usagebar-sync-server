import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { SqliteStore, type EnrollmentToken } from "./store.js";

const USAGE = `Usage: node dist/admin.js <command>

Commands:
  token create [--max-machines N] [--days N | --expires-at <RFC 3339>] [--note <text>]
      Mint an Enrollment Token. It is printed once; the server keeps only its hash.
      --max-machines   Machine cap for the group (default: MAX_MACHINES)
      --days           Expire N days from now
      --expires-at     Expire at this time. After expiry the token can't create a group, the
                       group stops accepting writes, and reads keep working for 30 days.
      --note           Free text shown by "token list", for example who the token is for
  token list [--json]
      List tokens with their limits and the group each one created.
  token revoke <token-id>
      Delete a token that hasn't created a group yet.

The database is the server's (DB_PATH or DATA_DIR), so run this where the server runs,
for example: docker exec usagebar-sync node dist/admin.js token create --days 30`;

export type AdminIO = { out: (line: string) => void; err: (line: string) => void };

class UsageError extends Error {}

/** RFC 3339 UTC with second precision, the same form the API uses. */
const timestamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

function positiveInteger(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`--${name} must be a positive integer, got "${raw}"`);
  return value;
}

function createToken(args: string[], store: SqliteStore, now: Date, io: AdminIO) {
  const { values } = parseArgs({
    args,
    options: {
      "max-machines": { type: "string" },
      days: { type: "string" },
      "expires-at": { type: "string" },
      note: { type: "string" },
    },
  });
  const maxMachines = positiveInteger("max-machines", values["max-machines"]) ?? null;
  const days = positiveInteger("days", values.days);
  if (days !== undefined && values["expires-at"] !== undefined) {
    throw new UsageError("Use --days or --expires-at, not both.");
  }
  let expiresAt: string | null = null;
  if (days !== undefined) expiresAt = timestamp(new Date(now.getTime() + days * 86_400_000));
  if (values["expires-at"] !== undefined) {
    const parsed = Date.parse(values["expires-at"]);
    if (Number.isNaN(parsed)) throw new UsageError(`--expires-at is not a date: "${values["expires-at"]}"`);
    expiresAt = timestamp(new Date(parsed));
  }

  const secret = randomBytes(32);
  const token = store.insertEnrollmentToken(
    {
      tokenId: randomBytes(6).toString("base64url"),
      maxMachines,
      expiresAt,
      note: values.note ?? null,
      createdAt: timestamp(now),
    },
    createHash("sha256").update(secret).digest(),
  );
  io.out(secret.toString("base64url"));
  io.err(
    `Created token ${token.tokenId} (max machines: ${maxMachines ?? "server default"}, ` +
      `expires: ${expiresAt ?? "never"}). Clients send it as "Authorization: Enrollment <token>".`,
  );
}

function listTokens(args: string[], store: SqliteStore, io: AdminIO) {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
  const tokens = store.listEnrollmentTokens();
  if (values.json) {
    io.out(JSON.stringify(tokens, null, 2));
    return;
  }
  if (tokens.length === 0) {
    io.out("No Enrollment Tokens.");
    return;
  }
  const cell = (value: string | number | null) => (value === null ? "-" : String(value));
  const rows = tokens.map((t: EnrollmentToken) => [
    t.tokenId,
    cell(t.maxMachines),
    cell(t.expiresAt),
    cell(t.groupId),
    cell(t.createdAt),
    cell(t.note),
  ]);
  const header = ["ID", "MAX MACHINES", "EXPIRES", "GROUP", "CREATED", "NOTE"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  for (const row of [header, ...rows]) io.out(row.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd());
}

function revokeToken(args: string[], store: SqliteStore, io: AdminIO) {
  const [tokenId, ...rest] = args;
  if (!tokenId || rest.length > 0) throw new UsageError("token revoke takes exactly one token ID.");
  switch (store.revokeEnrollmentToken(tokenId)) {
    case "revoked":
      io.out(`Revoked token ${tokenId}.`);
      return;
    case "not_found":
      throw new UsageError(`No token with ID ${tokenId}.`);
    case "used":
      throw new UsageError(`Token ${tokenId} already created a group. Delete the group instead.`);
  }
}

/** Runs one admin command against `store`. Returns the process exit code. */
export function runAdmin(argv: string[], store: SqliteStore, io: AdminIO, now = new Date()): number {
  const [noun, verb, ...args] = argv;
  try {
    if (noun === "token" && verb === "create") createToken(args, store, now, io);
    else if (noun === "token" && verb === "list") listTokens(args, store, io);
    else if (noun === "token" && verb === "revoke") revokeToken(args, store, io);
    else if (noun === undefined || noun === "help" || noun === "--help" || noun === "-h") io.out(USAGE);
    else throw new UsageError(`Unknown command: ${argv.join(" ")}`);
    return 0;
  } catch (error) {
    const code = String((error as { code?: unknown }).code);
    const isArgError = error instanceof TypeError && code.startsWith("ERR_PARSE_ARGS");
    if (!(error instanceof UsageError) && !isArgError) throw error;
    io.err((error as Error).message);
    io.err("Run with --help for usage.");
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { dbPath } = loadConfig();
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const store = new SqliteStore(dbPath);
  try {
    process.exitCode = runAdmin(process.argv.slice(2), store, {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  } finally {
    store.close();
  }
}
