'use strict';

// Hedged JSON-RPC over plain fetch. dhive's own failover only rotates nodes
// after a full per-node timeout (and retries 429/5xx with backoff on the same
// node first), so one stuck or rate-limited node turns every call into a
// multi-second stall. Here a call starts on one node and, if it has not
// answered after HEDGE_DELAY_MS, the same call starts on the next node (up to
// HEDGE_MAX_NODES in flight); the first valid answer wins and the rest are
// aborted. Nodes that fail are put on a short cooldown so later calls start
// on healthy ones. Reads only — never use this for broadcasts.

const HEDGE_DELAY_MS = parseInt(process.env.RPC_HEDGE_DELAY_MS ?? '900', 10);
const HEDGE_MAX_NODES = parseInt(process.env.RPC_HEDGE_MAX_NODES ?? '3', 10);
const NODE_COOLDOWN_MS = parseInt(process.env.RPC_NODE_COOLDOWN_MS ?? '30000', 10);
const DEFAULT_NODE_TIMEOUT_MS = parseInt(process.env.RPC_NODE_TIMEOUT_MS ?? '5000', 10);
// Heavy range/list calls legitimately take longer than a single get_content.
const SLOW_METHOD_PATTERN = /get_block_range|get_discussions|get_ops_in_block|get_account_history|list_/;
const SLOW_NODE_TIMEOUT_MS = 10000;

const cooldownUntil = new Map(); // node -> epoch ms
let rotation = 0;

function orderNodes(nodes) {
  const now = Date.now();
  const healthy = nodes.filter(n => (cooldownUntil.get(n) ?? 0) <= now);
  const pool = healthy.length > 0 ? healthy : nodes;
  const start = rotation++ % pool.length;
  const ordered = [];
  for (let i = 0; i < pool.length; i++) ordered.push(pool[(start + i) % pool.length]);
  // Cooled-down nodes stay available as last-resort hedges.
  for (const n of nodes) if (!ordered.includes(n)) ordered.push(n);
  return ordered;
}

function hedgedRpc(nodes, api, method, params = [], { hedgeDelayMs = HEDGE_DELAY_MS, maxNodes = HEDGE_MAX_NODES } = {}) {
  const fullMethod = `${api}.${method}`;
  const nodeTimeout = SLOW_METHOD_PATTERN.test(method) ? SLOW_NODE_TIMEOUT_MS : DEFAULT_NODE_TIMEOUT_MS;
  const body = JSON.stringify({ id: 0, jsonrpc: '2.0', method: fullMethod, params });
  const order = orderNodes(nodes);
  const limit = Math.min(maxNodes, order.length);

  return new Promise((resolve, reject) => {
    const controllers = [];
    let launched = 0;
    let failed = 0;
    let settled = false;
    let hedgeTimer = null;
    let lastErr = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      controllers.forEach(c => c.abort());
      fn(value);
    };

    const launch = () => {
      if (settled || launched >= limit) return;
      const node = order[launched++];
      const ctrl = new AbortController();
      controllers.push(ctrl);
      const killTimer = setTimeout(() => ctrl.abort(), nodeTimeout);
      fetch(node, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctrl.signal })
        .then(async r => {
          if (!r.ok) throw new Error(`${node} responded ${r.status}`);
          const j = await r.json();
          if (j && j.error) {
            const e = new Error(`${node} RPC error: ${j.error.message ?? JSON.stringify(j.error).slice(0, 120)}`);
            e.rpcError = true;
            throw e;
          }
          if (!j || j.result === undefined) throw new Error(`${node} returned no result`);
          return j.result;
        })
        .then(result => finish(resolve, result))
        .catch(err => {
          if (settled) return;
          if (!err.rpcError) cooldownUntil.set(node, Date.now() + NODE_COOLDOWN_MS);
          lastErr = err.name === 'AbortError' ? new Error(`${node} timed out after ${nodeTimeout}ms`) : err;
          failed++;
          if (failed >= launched) {
            if (launched < limit) launch();
            else finish(reject, lastErr);
          }
        })
        .finally(() => clearTimeout(killTimer));
      if (launched < limit) {
        clearTimeout(hedgeTimer);
        hedgeTimer = setTimeout(launch, hedgeDelayMs);
      }
    };
    launch();
  });
}

function resetNodeHealth() {
  cooldownUntil.clear();
  rotation = 0;
}

module.exports = { hedgedRpc, resetNodeHealth };
