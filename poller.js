'use strict';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10);
const BULK_BATCH_SIZE = parseInt(process.env.BULK_BATCH_SIZE ?? '50', 10);
const SNAP_CONTAINER_AUTHOR = process.env.SNAP_CONTAINER_AUTHOR ?? 'peak.snaps';

const ACCOUNT_FIELDS = [
  'author', 'voter', 'account', 'from', 'to',
  'delegator', 'delegatee', 'creator', 'new_account_name',
];

// Shared walk: extracts the operation payload (array or object dhive shape)
// for every operation in every transaction, skipping malformed entries.
// Also passes the operation name as a second arg — existing callers ignore
// it, but transfer-shaped extraction needs to know it's actually a transfer.
function walkOperations(block, callback) {
  if (!block || !Array.isArray(block.transactions)) return;
  for (const tx of block.transactions) {
    if (!Array.isArray(tx.operations)) continue;
    for (const op of tx.operations) {
      try {
        const opName = Array.isArray(op) ? op[0] : op?.type;
        const payload = Array.isArray(op) ? op[1] : op?.value;
        if (!payload || typeof payload !== 'object') continue;
        callback(payload, opName);
      } catch {
        // silently skip malformed operations
      }
    }
  }
}

function extractAccounts(block) {
  const accounts = new Set();
  walkOperations(block, (payload) => {
    for (const field of ACCOUNT_FIELDS) {
      if (payload[field] && typeof payload[field] === 'string') {
        accounts.add(payload[field]);
      }
    }
  });
  return accounts;
}

// Top-level replies to the snap container account. No op-type check needed —
// only comment operations carry `parent_author`/`permlink` together, so the
// field check alone is an unambiguous signal. `key` is author/permlink so
// SnapEventLog can dedupe edits (same operation shape re-broadcast on edit).
function extractSnapTimestamps(block) {
  const events = [];
  if (!block) return events;
  // Hive block timestamps omit the trailing 'Z' (e.g. "2024-01-01T00:00:00").
  // Without appending it, Date.parse treats the string as LOCAL time and every
  // recorded event lands off by the server's UTC offset. Always append 'Z'
  // unless it's already there.
  const blockTime = block.timestamp
    ? Date.parse(block.timestamp.endsWith('Z') ? block.timestamp : `${block.timestamp}Z`)
    : Date.now();
  walkOperations(block, (payload) => {
    if (payload.parent_author === SNAP_CONTAINER_AUTHOR && typeof payload.permlink === 'string') {
      const key = typeof payload.author === 'string' ? `${payload.author}/${payload.permlink}` : null;
      const author = typeof payload.author === 'string' ? payload.author : null;
      events.push({ timestamp: blockTime, key, author });
    }
  });
  return events;
}

// Transfers/recurrent_transfers to the patron account. Array-form ops (from
// block_api.get_block_range, the primary path) use short names like
// 'transfer'/'recurrent_transfer'. The getBlock() fallback path may return
// object-form ops with HF26-suffixed type names ('transfer_operation') —
// match both conventions defensively.
function extractPatronTransfers(block) {
  const transfers = [];
  if (!block) return transfers;
  const blockTime = block.timestamp
    ? Date.parse(block.timestamp.endsWith('Z') ? block.timestamp : `${block.timestamp}Z`)
    : Date.now();
  walkOperations(block, (payload, opName) => {
    const isTransferOp = opName === 'transfer' || opName === 'transfer_operation'
      || opName === 'recurrent_transfer' || opName === 'recurrent_transfer_operation';
    if (!isTransferOp) return;
    if (typeof payload.from !== 'string' || typeof payload.to !== 'string') return;
    transfers.push({ from: payload.from, to: payload.to, amount: payload.amount, memo: payload.memo, timestamp: blockTime });
  });
  return transfers;
}

async function fetchBlockRange(client, from, to) {
  try {
    const blocks = await client.database.call('block_api.get_block_range', [{ starting_block_num: from, count: to - from + 1 }]);
    return blocks?.blocks ?? blocks ?? [];
  } catch {
    // Fall back to individual block fetches (older nodes)
    const results = [];
    const limit = Math.min(to - from + 1, 10);
    for (let i = 0; i < limit; i++) {
      try {
        const block = await client.database.getBlock(from + i);
        if (block) results.push(block);
      } catch {
        // skip individual failures
      }
    }
    return results;
  }
}

async function coldStart(client, window, snapLog, authorTally, patronSubs) {
  console.log('[hive-sidecar] Starting bulk cold-start fetch…');
  const props = await client.database.getDynamicGlobalProperties();
  const head = props.head_block_number;
  const startBlock = head - 600;

  for (let batchStart = startBlock; batchStart <= head; batchStart += BULK_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BULK_BATCH_SIZE - 1, head);
    const blocks = await fetchBlockRange(client, batchStart, batchEnd);
    for (const block of blocks) {
      const accounts = extractAccounts(block);
      for (const account of accounts) window.upsert(account);
      if (snapLog || authorTally) {
        for (const evt of extractSnapTimestamps(block)) {
          if (snapLog) snapLog.record(evt.timestamp, evt.key);
          if (authorTally && evt.author) authorTally.record(evt.author, evt.timestamp);
        }
      }
      if (patronSubs) {
        for (const t of extractPatronTransfers(block)) {
          patronSubs.record(t.from, t.to, t.amount, t.memo, t.timestamp);
        }
      }
    }
  }

  console.log(`[hive-sidecar] Cold-start complete. ${window.size} accounts in window. Starting poll loop.`);
  return head;
}

function startPollLoop(client, window, state, snapLog, authorTally, patronSubs) {
  let consecutiveFailures = 0;

  const tick = async () => {
    try {
      const props = await client.database.getDynamicGlobalProperties();
      const head = props.head_block_number;
      if (head <= state.lastProcessedBlock) return;

      const from = state.lastProcessedBlock + 1;
      const to = head;
      const blocks = await fetchBlockRange(client, from, to);

      for (const block of blocks) {
        const accounts = extractAccounts(block);
        for (const account of accounts) window.upsert(account);
        if (snapLog || authorTally) {
          for (const evt of extractSnapTimestamps(block)) {
            if (snapLog) snapLog.record(evt.timestamp, evt.key);
            if (authorTally && evt.author) authorTally.record(evt.author, evt.timestamp);
          }
        }
        if (patronSubs) {
          for (const t of extractPatronTransfers(block)) {
            patronSubs.record(t.from, t.to, t.amount, t.memo, t.timestamp);
          }
        }
      }

      window.evict();
      if (snapLog) snapLog.evict();
      if (authorTally) authorTally.evict();
      if (patronSubs) patronSubs.evict();
      state.lastProcessedBlock = head;
      state.updatedAt = new Date().toISOString();
      consecutiveFailures = 0;

      console.log(`[hive-sidecar] Tick — block ${head} — ${window.size} active accounts`);
    } catch (err) {
      consecutiveFailures++;
      console.log(`[hive-sidecar] ERROR: poll tick failed — ${err.message}`);
      if (consecutiveFailures >= 5) {
        console.log('[hive-sidecar] 5 consecutive failures — triggering node list refresh');
        consecutiveFailures = 0;
        try {
          const { resolveNodes } = require('./hive-client');
          const fresh = await resolveNodes();
          client.updateNodes(fresh);
          console.log(`[hive-sidecar] Node list refreshed: ${fresh.length} nodes`);
        } catch (refreshErr) {
          console.log(`[hive-sidecar] Node refresh also failed: ${refreshErr.message}`);
        }
      }
    }
  };

  return setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { extractAccounts, extractSnapTimestamps, extractPatronTransfers, coldStart, startPollLoop, fetchBlockRange };
