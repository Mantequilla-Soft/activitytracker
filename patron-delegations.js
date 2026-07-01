'use strict';

const path = require('path');
const { loadJsonState, saveJsonState } = require('./state-store');

const PATRON_ACCOUNT = process.env.PATRON_ACCOUNT ?? 'snapie';
const DELEGATION_SYNC_INTERVAL_MS = parseInt(process.env.DELEGATION_SYNC_INTERVAL_MS ?? '3600000', 10); // 1h
const ECENCY_VESTING_URL = process.env.ECENCY_VESTING_URL ?? 'https://ecency.com/private-api/received-vesting';
const COINGECKO_PRICE_URL = process.env.COINGECKO_PRICE_URL ?? 'https://api.coingecko.com/api/v3/simple/price?ids=hive&vs_currencies=usd';
const PATRON_DELEGATIONS_STATE_FILE = process.env.PATRON_DELEGATIONS_STATE_FILE
  ?? path.join(__dirname, 'data', 'patron-delegations-state.json');

// Tier thresholds in USD value of delegated HP, highest first.
const DELEGATION_TIERS = [
  { min: 300, tier: 'snap-master' },
  { min: 75,  tier: 'snapian' },
  { min: 0,   tier: 'snaperino' },
];

function tierForUsdValue(usdValue) {
  for (const t of DELEGATION_TIERS) {
    if (usdValue >= t.min) return t.tier;
  }
  return null;
}

function vestsToHp(vests, totalVestingFundHive, totalVestingShares) {
  return vests * (totalVestingFundHive / totalVestingShares);
}

async function fetchHivePriceUsd() {
  const res = await fetch(COINGECKO_PRICE_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`);
  const data = await res.json();
  const price = data?.hive?.usd;
  if (!Number.isFinite(price) || price <= 0) throw new Error('CoinGecko returned no usable HIVE price');
  return price;
}

class PatronDelegations {
  constructor(stateFile = PATRON_DELEGATIONS_STATE_FILE) {
    this._stateFile = stateFile;
    this._byAccount = new Map(); // account -> { vests, hp, peakUsdValue, tier }
  }

  // Restores the ratchet's peak values from disk. Must be called before the
  // first sync() after a restart — otherwise sync() would compute peakUsdValue
  // fresh from today's price alone, permanently forgetting a higher historical
  // peak earned when HIVE was worth more. sync()'s ratchet logic itself needs
  // no changes: it just finds this loaded state via `_byAccount.get(...)`.
  load() {
    const saved = loadJsonState(this._stateFile);
    if (!saved || typeof saved !== 'object') return;
    this._byAccount = new Map(Object.entries(saved));
  }

  async sync(client) {
    try {
      const hivePriceUsd = await fetchHivePriceUsd();

      const props = await client.database.getDynamicGlobalProperties();
      const totalVestingFundHive = parseFloat(String(props.total_vesting_fund_hive).split(' ')[0]);
      const totalVestingShares = parseFloat(String(props.total_vesting_shares).split(' ')[0]);

      const res = await fetch(`${ECENCY_VESTING_URL}/${PATRON_ACCOUNT}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Ecency returned ${res.status}`);
      const data = await res.json();
      const incoming = Array.isArray(data?.list) ? data.list : [];

      const next = new Map();
      for (const entry of incoming) {
        const vests = parseFloat(entry.vesting_shares);
        if (!Number.isFinite(vests)) continue;
        const hp = vestsToHp(vests, totalVestingFundHive, totalVestingShares);
        const currentUsdValue = hp * hivePriceUsd;

        const existing = this._byAccount.get(entry.delegator);
        let peakUsdValue;
        // Compare on raw VESTS, not derived HP — the global VESTS→HP ratio
        // drifts every block (inflation), so HP ticks up slightly between
        // syncs even when a delegator's actual VESTS haven't changed at all.
        // Comparing HP here would spuriously trigger the "genuine reduction"
        // reset on syncs where nothing actually changed. VESTS is the precise
        // ledger figure that only moves when the delegator actually acts.
        if (!existing || vests < existing.vests) {
          // New delegator, or a genuine reduction — start fresh from today's value.
          peakUsdValue = currentUsdValue;
        } else {
          // Same or larger delegation — ratchet: keep whichever is higher.
          peakUsdValue = Math.max(existing.peakUsdValue, currentUsdValue);
        }

        const tier = tierForUsdValue(peakUsdValue);
        if (tier) next.set(entry.delegator, { vests, hp, peakUsdValue, tier });
      }

      // Delegators no longer in Ecency's list (fully undelegated) are simply
      // absent from `next` — atomic swap drops them, no special-casing needed.
      this._byAccount = next;
      saveJsonState(this._stateFile, Object.fromEntries(this._byAccount));
      console.log(`[hive-sidecar] Patron delegation sync — ${next.size} qualifying delegators (HIVE @ $${hivePriceUsd})`);
    } catch (err) {
      // Leave the previous snapshot in place on failure — stale data beats no data
      // for a low-stakes cosmetic signal, and Ecency or CoinGecko being briefly
      // down shouldn't wipe everyone's badge.
      console.log(`[hive-sidecar] Patron delegation sync failed: ${err.message}`);
    }
  }

  tierFor(account) {
    return this._byAccount.get(account)?.tier ?? null;
  }

  get all() {
    return [...this._byAccount.entries()].map(([account, { hp, peakUsdValue, tier }]) => ({ account, hp, peakUsdValue, tier }));
  }
}

module.exports = { PatronDelegations, tierForUsdValue, vestsToHp, fetchHivePriceUsd, DELEGATION_TIERS, DELEGATION_SYNC_INTERVAL_MS };
