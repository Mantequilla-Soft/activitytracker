'use strict';

const { Client } = require('@hiveio/dhive');
const { hedgedRpc } = require('./rpc-hedge');

const BEACON_API_URL = process.env.BEACON_API_URL ?? 'https://beacon.peakd.com/api/nodes';
const MIN_NODE_SCORE = parseInt(process.env.MIN_NODE_SCORE ?? '80', 10);
const NODE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
// dhive's `timeout` client option isn't honored once a node's response
// errors without a `.code` (see retryingFetch in dhive/lib/utils.js) — it
// fails over and retries forever instead of ever rejecting. A cold start
// makes hundreds of sequential RPC calls, so a single unlucky node hit
// anywhere in that sequence hangs the whole thing. `client.call()` is the
// one choke point every dhive API method funnels through, so wrapping it
// there bounds every individual call independently and lets this app's
// existing per-call try/catch sites (fetchBlockRange, hydrateItems, etc.)
// skip-and-continue as they were written to, instead of hanging forever.
const RPC_CALL_TIMEOUT_MS = parseInt(process.env.RPC_CALL_TIMEOUT_MS ?? '10000', 10);

const FALLBACK_NODES = [
  'https://api.hive.blog',
  'https://api.openhive.network',
  'https://techcoderx.com',
  'https://rpc.mahdiyari.info',
];

// api.c0ff33a.uk added 2026-08-09: returns HTTP 502 on RPC calls, which
// triggers an infinite retry loop in dhive's retryingFetch (no absolute
// ceiling once an error lacks a `.code`) — see coldStart() hang investigation.
const EXCLUDED_NODE_HOSTS = ['api.deathwing.me', 'api.c0ff33a.uk'];

async function fetchBeaconNodes() {
  const res = await fetch(BEACON_API_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Beacon responded ${res.status}`);
  const nodes = await res.json();
  const filtered = nodes
    .filter(n => n.score >= MIN_NODE_SCORE)
    .filter(n => {
      try {
        const host = new URL(n.endpoint).hostname;
        return !EXCLUDED_NODE_HOSTS.includes(host);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.score - a.score)
    .map(n => n.endpoint);
  return [...new Set(filtered)];
}

async function resolveNodes() {
  try {
    const nodes = await fetchBeaconNodes();
    if (nodes.length >= 2) return nodes;
    console.log('[hive-sidecar] Beacon returned fewer than 2 nodes — using fallback list');
  } catch (err) {
    console.log(`[hive-sidecar] Beacon fetch failed (${err.message}) — using fallback list`);
  }
  return FALLBACK_NODES;
}

// dhive's Client has no updateNodes() method — address/currentAddress are
// plain public properties, so refreshing the node list means reassigning
// them directly (also resets currentAddress to the top pick in case the
// client had failed over to a now-stale node). Exported so every node-refresh
// call site (the periodic refresh below, and feed-index.js's post-failure
// refresh) shares one correct implementation instead of each reinventing it —
// feed-index.js used to call the nonexistent client.updateNodes(fresh) and
// silently fail every time its self-healing kicked in.
function applyNodeRefresh(client, nodes) {
  client.address = nodes;
  client.currentAddress = nodes[0];
}

async function createHiveClient() {
  const nodes = await resolveNodes();
  const client = new Client(nodes, { timeout: 8000 });

  // DatabaseAPI/BroadcastAPI/etc. all resolve `this.client` dynamically on
  // every call, so replacing this own property (shadowing the prototype
  // method) is enough to cover every API call made through this client.
  const originalCall = client.call.bind(client);
  // Reads go through hedgedRpc (see rpc-hedge.js) so one stuck or
  // rate-limited node can't stall a call; broadcasts, and the degenerate
  // single-node case, keep dhive's own path.
  const dispatch = (api, method, params) => {
    const nodes = Array.isArray(client.address) ? client.address.filter(n => typeof n === 'string') : [];
    const isBroadcast = api === 'network_broadcast_api' || String(method).startsWith('broadcast_transaction');
    if (isBroadcast || nodes.length < 2) return originalCall(api, method, params);
    return hedgedRpc(nodes, api, method, params);
  };
  client.call = (api, method, params) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`RPC call ${api}.${method} timed out after ${RPC_CALL_TIMEOUT_MS}ms`)),
        RPC_CALL_TIMEOUT_MS,
      );
    });
    return Promise.race([dispatch(api, method, params), timeout]).finally(() => clearTimeout(timer));
  };

  setInterval(async () => {
    try {
      const fresh = await resolveNodes();
      applyNodeRefresh(client, fresh);
      console.log(`[hive-sidecar] Node list refreshed: ${fresh.length} nodes`);
    } catch (err) {
      console.log(`[hive-sidecar] Node refresh failed: ${err.message}`);
    }
  }, NODE_REFRESH_INTERVAL_MS);

  return client;
}

module.exports = { createHiveClient, resolveNodes, applyNodeRefresh };
