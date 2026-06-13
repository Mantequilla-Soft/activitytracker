'use strict';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10);
const BULK_BATCH_SIZE = parseInt(process.env.BULK_BATCH_SIZE ?? '50', 10);

const ACCOUNT_FIELDS = [
  'author', 'voter', 'account', 'from', 'to',
  'delegator', 'delegatee', 'creator', 'new_account_name',
];

function extractAccounts(block) {
  const accounts = new Set();
  if (!block || !Array.isArray(block.transactions)) return accounts;
  for (const tx of block.transactions) {
    if (!Array.isArray(tx.operations)) continue;
    for (const op of tx.operations) {
      try {
        const payload = Array.isArray(op) ? op[1] : op?.value;
        if (!payload || typeof payload !== 'object') continue;
        for (const field of ACCOUNT_FIELDS) {
          if (payload[field] && typeof payload[field] === 'string') {
            accounts.add(payload[field]);
          }
        }
      } catch {
        // silently skip malformed operations
      }
    }
  }
  return accounts;
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

async function coldStart(client, window) {
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
    }
  }

  console.log(`[hive-sidecar] Cold-start complete. ${window.size} accounts in window. Starting poll loop.`);
  return head;
}

function startPollLoop(client, window, state) {
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
      }

      window.evict();
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

module.exports = { extractAccounts, coldStart, startPollLoop, fetchBlockRange };
