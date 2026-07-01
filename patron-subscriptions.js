'use strict';

const path = require('path');
const { loadJsonState, saveJsonState } = require('./state-store');

const PATRON_ACCOUNT = process.env.PATRON_ACCOUNT ?? 'snapie';
const PATRON_MEMO_TAG = process.env.PATRON_MEMO_TAG ?? 'snapiepatron';
const PATRON_SUBSCRIPTION_RETENTION_MS = parseInt(process.env.PATRON_SUBSCRIPTION_RETENTION_MS ?? '3024000000', 10); // 35 days
const PATRON_SUBSCRIPTIONS_STATE_FILE = process.env.PATRON_SUBSCRIPTIONS_STATE_FILE
  ?? path.join(__dirname, 'data', 'patron-subscriptions-state.json');

// Tier thresholds in HBD/month, highest first.
const SUBSCRIPTION_TIERS = [
  { min: 5, tier: 'snap-master' },
  { min: 1, tier: 'snapian' },
  { min: 0, tier: 'snaperino' },
];

function tierForAmount(hbd) {
  for (const t of SUBSCRIPTION_TIERS) {
    if (hbd >= t.min) return t.tier;
  }
  return null;
}

class PatronSubscriptions {
  constructor(retentionMs = PATRON_SUBSCRIPTION_RETENTION_MS, stateFile = PATRON_SUBSCRIPTIONS_STATE_FILE) {
    this._retentionMs = retentionMs;
    this._stateFile = stateFile;
    this._byAccount = new Map(); // account -> { amount, lastSeen }
  }

  // Restores subscriber state from disk. Without this, a restart wipes the
  // map and it only refills from the live 30-second block poller going
  // forward (coldStart only replays ~30 minutes of blocks) — a subscriber
  // whose last payment isn't in that window would silently lose their badge
  // until they pay again. Evicts immediately in case the sidecar was down
  // long enough for some loaded entries to already be past retention.
  load() {
    const saved = loadJsonState(this._stateFile);
    if (saved && typeof saved === 'object') {
      this._byAccount = new Map(Object.entries(saved));
    }
    this.evict();
  }

  save() {
    saveJsonState(this._stateFile, Object.fromEntries(this._byAccount));
  }

  // Call for every transfer/recurrent_transfer op already extracted by the poller.
  record(from, to, amountStr, memo, timestamp = Date.now()) {
    if (to !== PATRON_ACCOUNT) return;
    if (!memo || !memo.includes(PATRON_MEMO_TAG)) return;
    const amount = parseFloat(String(amountStr));
    if (!Number.isFinite(amount)) return;
    if (!String(amountStr).toUpperCase().includes('HBD')) return;

    const existing = this._byAccount.get(from);
    if (!existing || timestamp >= existing.lastSeen) {
      this._byAccount.set(from, { amount, lastSeen: timestamp });
    }
  }

  evict(now = Date.now()) {
    for (const [account, entry] of this._byAccount) {
      if (now - entry.lastSeen > this._retentionMs) this._byAccount.delete(account);
    }
  }

  tierFor(account) {
    const entry = this._byAccount.get(account);
    return entry ? tierForAmount(entry.amount) : null;
  }

  get all() {
    return [...this._byAccount.entries()].map(([account, { amount }]) => ({ account, amount, tier: tierForAmount(amount) }));
  }
}

module.exports = { PatronSubscriptions, tierForAmount, SUBSCRIPTION_TIERS };
