'use strict';

const PATRON_ACCOUNT = process.env.PATRON_ACCOUNT ?? 'snapie';
const PATRON_MEMO_TAG = process.env.PATRON_MEMO_TAG ?? 'snapiepatron';
const PATRON_SUBSCRIPTION_RETENTION_MS = parseInt(process.env.PATRON_SUBSCRIPTION_RETENTION_MS ?? '3024000000', 10); // 35 days

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
  constructor(retentionMs = PATRON_SUBSCRIPTION_RETENTION_MS) {
    this._retentionMs = retentionMs;
    this._byAccount = new Map(); // account -> { amount, lastSeen }
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
