'use strict';

const { createHiveClient } = require('./hive-client');
const { RollingWindow } = require('./rolling-window');
const { SnapEventLog } = require('./snap-window');
const { AuthorTally } = require('./author-tally');
const { PatronSubscriptions } = require('./patron-subscriptions');
const { PatronDelegations, DELEGATION_SYNC_INTERVAL_MS } = require('./patron-delegations');
const { FeedIndex, coldStartFeedIndex, startFeedPollLoop } = require('./feed-index');
const { coldStart, startPollLoop } = require('./poller');
const { createServer, startServer } = require('./server');

const WATCHDOG_CHECK_INTERVAL_MS = 30 * 1000;
// Both poll loops run every POLL_INTERVAL_MS / FEED_POLL_INTERVAL_MS and mark
// state.last*TickCompletedAt on every pass (success or handled failure — see
// poller.js/feed-index.js). A gap past these thresholds means a tick hung
// mid-await and the loop is dead in place while pm2 still sees the process as
// "online" — that's exactly how this went unnoticed for 6 days on 2026-08-03
// (an ENOSPC write during a state save coincided with the block poller and
// feed poller both going silent, but the process itself never exited).
// Several multiples of the normal interval, so transient RPC node outages
// (which already self-heal via the 5-consecutive-failures node refresh) don't
// trip a restart.
const BLOCK_POLL_STALL_MS = parseInt(process.env.BLOCK_POLL_STALL_MS ?? String(5 * 60 * 1000), 10);
const FEED_POLL_STALL_MS = parseInt(process.env.FEED_POLL_STALL_MS ?? String(10 * 60 * 1000), 10);

// dhive's retryingFetch has no absolute ceiling once a node returns an error
// without a `.code` (e.g. a 502) — it can loop forever instead of honoring
// the client's `timeout` option. That hangs coldStart()/coldStartFeedIndex()
// mid-await, which is *before* startWatchdog() runs for the block side and
// entirely outside the watchdog's reach for the feed side. These hard
// ceilings turn that silent, permanent hang into a rejection so both paths
// fail loud (block: process exits, pm2 restarts; feed: falls through to the
// poll loop's own self-healing) instead of wedging state.warming forever.
const COLD_START_TIMEOUT_MS = parseInt(process.env.COLD_START_TIMEOUT_MS ?? String(3 * 60 * 1000), 10);
const FEED_COLD_START_TIMEOUT_MS = parseInt(process.env.FEED_COLD_START_TIMEOUT_MS ?? String(3 * 60 * 1000), 10);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const state = {
  warming: true,
  count: 0,
  updatedAt: new Date().toISOString(),
  lastProcessedBlock: 0,
  feedWarming: true,
  lastBlockTickCompletedAt: null,
  lastFeedTickCompletedAt: null,
};

// pm2's ecosystem.config.js has autorestart: true — exiting is the recovery
// mechanism, not a last resort. Only checks a loop once it has left its
// warming phase, since cold-start backfills can legitimately run long.
function startWatchdog(state) {
  setInterval(() => {
    const now = Date.now();
    if (!state.warming && state.lastBlockTickCompletedAt !== null) {
      const stalledFor = now - state.lastBlockTickCompletedAt;
      if (stalledFor > BLOCK_POLL_STALL_MS) {
        console.error(`[hive-sidecar] WATCHDOG: block poll loop stalled for ${Math.round(stalledFor / 1000)}s (limit ${BLOCK_POLL_STALL_MS / 1000}s) — exiting for pm2 restart`);
        process.exit(1);
      }
    }
    if (!state.feedWarming && state.lastFeedTickCompletedAt !== null) {
      const stalledFor = now - state.lastFeedTickCompletedAt;
      if (stalledFor > FEED_POLL_STALL_MS) {
        console.error(`[hive-sidecar] WATCHDOG: feed poll loop stalled for ${Math.round(stalledFor / 1000)}s (limit ${FEED_POLL_STALL_MS / 1000}s) — exiting for pm2 restart`);
        process.exit(1);
      }
    }
  }, WATCHDOG_CHECK_INTERVAL_MS);
}

async function main() {
  const window = new RollingWindow();
  const snapLog = new SnapEventLog();
  const authorTally = new AuthorTally();
  const patronSubs = new PatronSubscriptions();
  const patronDelegations = new PatronDelegations();
  const feedIndex = new FeedIndex();

  // Restore persisted patron state before anything else touches these maps —
  // patronDelegations.sync() ratchets against whatever's already in
  // _byAccount, and coldStart()'s 30-min backfill layers new record() calls
  // on top of patronSubs' restored state, so both must be loaded first.
  patronSubs.load();
  patronDelegations.load();
  // Restore the last known-good feed index so /feed can serve real (if
  // briefly stale) data through this restart's cold-start window instead of
  // the blank response server.js falls back to while state.feedWarming is
  // true — see feedIndex.load()'s comment for why this happens so often.
  feedIndex.load();

  // Created before createServer — unlike the other route dependencies, the
  // /feed route needs a live client reference at request time.
  const client = await createHiveClient();

  const app = createServer(state, snapLog, authorTally, patronSubs, patronDelegations, feedIndex, client);
  startServer(app);

  patronDelegations.sync(client);
  setInterval(() => patronDelegations.sync(client), DELEGATION_SYNC_INTERVAL_MS);

  state.lastProcessedBlock = await withTimeout(
    coldStart(client, window, snapLog, authorTally, patronSubs),
    COLD_START_TIMEOUT_MS,
    'coldStart',
  );
  state.count = window.size;
  state.updatedAt = new Date().toISOString();
  state.warming = false;
  state.lastBlockTickCompletedAt = Date.now();

  startPollLoop(client, window, state, snapLog, authorTally, patronSubs);
  startWatchdog(state);

  // Keep state.count in sync with window after each tick
  const origEvict = window.evict.bind(window);
  window.evict = function (...args) {
    origEvict(...args);
    state.count = window.size;
  };

  // Independent RPC domain from the block-scan poller above — deliberately
  // not awaited before main() returns, so a slow/failed feed backfill can't
  // delay (or be delayed by) the block-scan warmup.
  withTimeout(coldStartFeedIndex(client, feedIndex), FEED_COLD_START_TIMEOUT_MS, 'coldStartFeedIndex')
    .catch(err => console.error('[hive-sidecar] feed: cold-start failed — poll loop will self-heal', err))
    .finally(() => {
      state.feedWarming = false;
      state.lastFeedTickCompletedAt = Date.now();
      startFeedPollLoop(client, feedIndex, state);
    });
}

main().catch(err => {
  console.error('[hive-sidecar] Fatal startup error:', err);
  process.exit(1);
});
