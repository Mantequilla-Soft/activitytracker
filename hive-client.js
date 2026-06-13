'use strict';

const { Client } = require('@hiveio/dhive');

const BEACON_API_URL = process.env.BEACON_API_URL ?? 'https://beacon.peakd.com/api/nodes';
const MIN_NODE_SCORE = parseInt(process.env.MIN_NODE_SCORE ?? '80', 10);
const NODE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

const FALLBACK_NODES = [
  'https://api.hive.blog',
  'https://api.openhive.network',
  'https://techcoderx.com',
  'https://rpc.mahdiyari.info',
  'https://api.c0ff33a.uk',
];

const EXCLUDED_NODE_HOSTS = ['api.deathwing.me'];

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

async function createHiveClient() {
  const nodes = await resolveNodes();
  const client = new Client(nodes, { timeout: 8000 });

  setInterval(async () => {
    try {
      const fresh = await resolveNodes();
      client.updateNodes(fresh);
      console.log(`[hive-sidecar] Node list refreshed: ${fresh.length} nodes`);
    } catch (err) {
      console.log(`[hive-sidecar] Node refresh failed: ${err.message}`);
    }
  }, NODE_REFRESH_INTERVAL_MS);

  return client;
}

module.exports = { createHiveClient, resolveNodes };
