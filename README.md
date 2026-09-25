# UsageBar Sync Server

An open-source Sync Server for [UsageBar](https://github.com/felipearosr/UsageBar) / CodexBar **Machine Sync**. It lets each of your machines see the Spend of all the others.

The server stores opaque, end-to-end-encrypted blobs. It never sees keys, Spend amounts, providers, models or machine names. The wire contract is the **Machine Sync protocol v1**, specified in the UsageBar repo:

- Protocol: [`docs/machine-sync-protocol.md`](https://github.com/felipearosr/UsageBar/blob/main/docs/machine-sync-protocol.md)
- Glossary: [`CONTEXT.md`](https://github.com/felipearosr/UsageBar/blob/main/CONTEXT.md)
- Decisions: [`docs/adr/`](https://github.com/felipearosr/UsageBar/tree/main/docs/adr)
- Test vectors: [`docs/machine-sync-test-vectors/`](https://github.com/felipearosr/UsageBar/tree/main/docs/machine-sync-test-vectors) (copied into `test/fixtures/` and checked by `test/vectors.test.ts`)

Anyone can build a compatible server from the spec. This one is written in TypeScript on [Hono](https://hono.dev), with SQLite through Node's built-in `node:sqlite`.

## Status

Protocol v1 is implemented in full:

| Endpoint | Notes |
|---|---|
| `GET /v1/info` | Reports the `enrollment` mode, limits and operator |
| `POST /v1/groups` | Enrollment Tokens, idempotent for the same `authKeyHash`, `409 group_exists` otherwise |
| `PUT /v1/groups/{g}/machines/{m}/blobs/{name}` | Name validation, `If-Match`, `413`, `machine_limit`, `enrollment_expired`, Last Seen |
| `GET /v1/groups/{g}/machines/{m}/blobs/{name}` | Returns the envelope with an `ETag` |
| `GET /v1/groups/{g}/changes?since=&limit=` | Opaque cursor, `hasMore`, lists every Machine |
| `DELETE /v1/groups/{g}/machines/{m}` | Forgets a Machine and its blobs (`204`) |
| `DELETE /v1/groups/{g}` | Deletes the group and everything in it (`204`) |

## Self-hosting with Docker

```sh
docker build -t usagebar-sync-server .
docker run -d --name usagebar-sync -p 8787:8787 -v usagebar-sync:/data \
  -e OPERATOR="My Sync Server" usagebar-sync-server
```

Or `docker compose up -d` with the included [`compose.yaml`](compose.yaml).

The database is one SQLite file at `/data/sync.db`. Back up the volume to back up the server.

Clients pair with a link such as `codexbar-sync://sync.example.com#<key>`, which uses HTTPS. **Put the server behind a TLS reverse proxy** (Caddy, nginx, Traefik, Tailscale Serve…). The bearer credential travels in the `Authorization` header. Plain `codexbar-sync+http://` is only meant for loopback or a tailnet.

## Running locally

Requires Node.js ≥ 22.13 and pnpm.

```sh
pnpm install
pnpm build && pnpm start   # listens on 0.0.0.0:8787, data in ./data/sync.db
scripts/smoke.sh           # create a group, push a blob, read it back with curl
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_DIR` | `data` (`/data` in Docker) | Directory for `sync.db` |
| `DB_PATH` | `$DATA_DIR/sync.db` | Explicit database path (overrides `DATA_DIR`) |
| `OPERATOR` | `Self-hosted Sync Server` | Display text returned by `/v1/info` |
| `MAX_MACHINES` | `10` | `maxMachines` for new groups |
| `RETENTION_DAYS` | `400` | Advertised `retentionDays` |
| `MAX_BLOB_BYTES` | `65536` | Largest accepted envelope |
| `ENROLLMENT` | `none` | `none`, `optional` or `required` (see below) |
| `RATE_LIMIT_PER_MINUTE` | `120` | Sustained requests per minute per client IP. `0` turns rate limiting off |
| `RATE_LIMIT_BURST` | `600` | Requests a client can make at once, enough for a 400-day backfill |
| `TRUST_PROXY` | `false` | Take the client IP from the last `X-Forwarded-For` hop. Turn on only behind a proxy that sets it |

Limits are copied into a group when it is created, so a later change applies only to new groups.

## Enrollment Tokens

With `ENROLLMENT=none` anyone who can reach the server can create a group. `required` makes `POST /v1/groups` need an Enrollment Token (`402 enrollment_required` without one). `optional` accepts groups without a token and applies a token's limits when one is sent. Clients send the token as `Authorization: Enrollment <token>`.

Mint tokens with the operator CLI, on the machine that holds the database:

```sh
node dist/admin.js token create --max-machines 5 --days 30 --note "alice trial"
docker exec usagebar-sync node dist/admin.js token create --days 30   # in Docker
node dist/admin.js token list
node dist/admin.js token revoke <token-id>                            # only tokens not used yet
```

`token create` prints the token once. The server stores only its SHA-256.

- A token creates exactly one group. Presenting it for a different group ID returns `403 enrollment_used`. Presenting it again for the same group is idempotent. The token stays bound after that group is deleted.
- `--max-machines` sets the group's `maxMachines` (default `MAX_MACHINES`). Retired Machines count until they are deleted.
- `--days` or `--expires-at` sets an expiry. An expired token can't create a group, and it becomes the group's `expiresAt`. After that, writes return `403 enrollment_expired`, reads keep working for 30 days, and deletion keeps working.

## Retention

Once at startup and then every hour, the server deletes `day-*` blobs dated more than the group's `retentionDays` before the current UTC date. `profile` and `retired` blobs are kept while the group exists.

## Behavior notes

- **Credentials:** a wrong or missing bearer key and an unknown group all return the same `404 group_not_found`. The server stores only `SHA-256(auth-key)` and compares it in constant time.
- **Blob names:** `profile` and `day-YYYY-MM-DD` live under a Machine ID. `retired` lives only under the reserved Machine ID `group`, and it is the only blob allowed there.
- **Last Seen:** set from server receive time on every successful PUT to a Machine. PUTs to `group` never update it.
- **Changes feed:** blobs come back in write order, and a rewritten blob moves to the end. The cursor is opaque, and `machines` always lists every Machine in the group.
- **Deletion:** deleting an unknown Machine still returns `204`. `DELETE .../machines/group` is `422 invalid_machine_id`, since the `retired` blob belongs to the group.
- **Rate limiting:** one in-memory token bucket per client IP, checked before anything else. Over the limit the server answers `429 rate_limited` with `Retry-After` in seconds. The buckets reset when the server restarts.
- **Versions:** a request under another protocol version (`/v2/...`) gets `400 unsupported_version`. Any other unknown path gets `404 not_found`.

## Development

```sh
pnpm typecheck
pnpm test
```

## License

MIT
