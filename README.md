# UsageBar Sync Server

An open-source Sync Server for [UsageBar](https://github.com/felipearosr/UsageBar) / CodexBar **Machine Sync**. It lets each of your machines see the Spend of all the others.

The server stores opaque, end-to-end-encrypted blobs. It never sees keys, Spend amounts, providers, models or machine names. The wire contract is the **Machine Sync protocol v1**, specified in the UsageBar repo:

- Protocol: [`docs/machine-sync-protocol.md`](https://github.com/felipearosr/UsageBar/blob/main/docs/machine-sync-protocol.md)
- Glossary: [`CONTEXT.md`](https://github.com/felipearosr/UsageBar/blob/main/CONTEXT.md)
- Decisions: [`docs/adr/`](https://github.com/felipearosr/UsageBar/tree/main/docs/adr)
- Test vectors: [`docs/machine-sync-test-vectors/`](https://github.com/felipearosr/UsageBar/tree/main/docs/machine-sync-test-vectors) (copied into `test/fixtures/` and checked by `test/vectors.test.ts`)

Anyone can build a compatible server from the spec. This one is written in TypeScript on [Hono](https://hono.dev), with SQLite through Node's built-in `node:sqlite`.

## Status

Tracer bullet. What's implemented:

| Endpoint | Notes |
|---|---|
| `GET /v1/info` | `enrollment: "none"` (open enrollment) |
| `POST /v1/groups` | Idempotent for the same `authKeyHash`, `409 group_exists` otherwise |
| `PUT /v1/groups/{g}/machines/{m}/blobs/{name}` | Name validation, `If-Match`, `413`, `machine_limit`, Last Seen |
| `GET /v1/groups/{g}/machines/{m}/blobs/{name}` | Returns the envelope with an `ETag` |
| `GET /v1/groups/{g}/changes?since=&limit=` | Opaque cursor, `hasMore`, lists every Machine |

Not yet implemented: Enrollment Tokens and expiry, deletion (§6.7), retention pruning (§7), and rate limiting.

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

Limits are copied into a group when it is created, so a later change applies only to new groups.

## Behavior notes

- **Credentials:** a wrong or missing bearer key and an unknown group all return the same `404 group_not_found`. The server stores only `SHA-256(auth-key)` and compares it in constant time.
- **Blob names:** `profile` and `day-YYYY-MM-DD` live under a Machine ID. `retired` lives only under the reserved Machine ID `group`, and it is the only blob allowed there.
- **Last Seen:** set from server receive time on every successful PUT to a Machine. PUTs to `group` never update it.
- **Changes feed:** blobs come back in write order, and a rewritten blob moves to the end. The cursor is opaque, and `machines` always lists every Machine in the group.

## Development

```sh
pnpm typecheck
pnpm test
```

## License

MIT
