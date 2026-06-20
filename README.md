# hive-activity-sidecar

A small, standalone Node.js service that counts the number of distinct Hive accounts active in the last 30 minutes and exposes that number via a single local HTTP endpoint.

Designed to run as a sidecar alongside a Next.js app on the same VPS. The Next.js app proxies the count to the browser — no browser ever polls Hive directly.

---

## How it works

Hive produces a block every ~3 seconds. On startup the sidecar bulk-fetches the last 600 blocks (30 minutes worth), then polls for new blocks every 30 seconds. Any account that appears as a signer or actor in an operation within the window is counted. The window self-prunes — accounts that haven't been seen for 30 minutes are evicted automatically.

**One poller. One number. One source of truth.**

---

## Project structure

```
index.js           — entry point, wires everything together
hive-client.js     — beacon node discovery, dhive client, 60-min node refresh
rolling-window.js  — in-memory Map with upsert + evict logic
snap-window.js     — append-only event log for new-snap counting, dedupes edits
poller.js          — block fetching loop, account extraction, snap detection
server.js          — Express HTTP server (localhost only)
ecosystem.config.js— PM2 process config
tests/             — Jest test suite (40 tests)
```

---

## API

The sidecar binds to `127.0.0.1:3099` only — never exposed to the public internet.

### `GET /active-users`

```json
{ "count": 2104, "warming": false, "updatedAt": "2026-06-12T14:32:00.000Z" }
```

- `count` — distinct accounts active in the last 30 minutes. `null` during warm-up.
- `warming` — `true` while the cold-start bulk fetch is in progress.
- `updatedAt` — ISO timestamp of the last successful poll tick.

### `GET /new-snaps?since=<epoch-ms-or-ISO-8601>`

```json
{ "count": 3, "latestTimestamp": "2026-06-19T18:32:10.000Z", "serverTime": "2026-06-19T18:32:40.000Z", "warming": false }
```

- `count` — number of new top-level replies to `peak.snaps` since `since`. An upper bound, not
  an exact preview (the frontend applies its own tag/mute filtering on top). Edits of an
  existing snap are deduped by author+permlink and don't bump the count.
- `latestTimestamp` — ISO timestamp of the most recent matching snap, or `null`.
- `serverTime` — this server's clock at response time. Callers should use this (not their own
  clock) as the `since` for their next poll, to avoid client/server clock drift.
- `warming` — `true` while the cold-start bulk fetch is in progress; `count` is `0` until it
  clears.
- `400` if `since` is missing or unparseable.

### `GET /health`

```json
{ "status": "ok" }
```

---

## Getting started

```bash
npm install
cp .env.example .env
node index.js
```

The service logs progress to stdout:

```
[hive-sidecar] Starting bulk cold-start fetch from block 87654321…
[hive-sidecar] Cold-start complete. 1847 accounts in window. Starting poll loop.
[hive-sidecar] Tick — block 87654931 — 1923 active accounts
```

### Run tests

```bash
npm test
```

---

## Production (PM2)

```bash
pm2 start ecosystem.config.js
pm2 save
```

The process will restart automatically on crash and survive VPS reboots after `pm2 save`.

---

## Configuration

All options are set via environment variables. See `.env.example` for the full list with defaults.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3099` | Port to bind on localhost |
| `POLL_INTERVAL_MS` | `30000` | How often to fetch new blocks (ms) |
| `WINDOW_MS` | `1800000` | Rolling activity window size (ms) |
| `BULK_BATCH_SIZE` | `50` | Blocks per RPC call during cold-start |
| `MIN_NODE_SCORE` | `80` | Minimum beacon score to accept a node |
| `BEACON_API_URL` | `https://beacon.peakd.com/api/nodes` | Node discovery endpoint |
| `SNAP_CONTAINER_AUTHOR` | `peak.snaps` | Account whose top-level replies count as "snaps" |
| `SNAP_RETENTION_MS` | `3600000` | How long to retain snap event timestamps (ms) |

---

## Next.js integration

Create `app/api/active-users/route.ts` in your Next.js app to proxy the sidecar:

```ts
import { NextResponse } from 'next/server';

const SIDECAR_URL = process.env.HIVE_ACTIVITY_SIDECAR_URL ?? 'http://127.0.0.1:3099';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const res = await fetch(`${SIDECAR_URL}/active-users`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return NextResponse.json({ count: null, warming: false }, { status: 200 });
    const data = await res.json();
    return NextResponse.json(data, {
      status: 200,
      headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' },
    });
  } catch {
    return NextResponse.json({ count: null, warming: false }, { status: 200 });
  }
}
```

Add to `.env.local`:

```
HIVE_ACTIVITY_SIDECAR_URL=http://127.0.0.1:3099
```
