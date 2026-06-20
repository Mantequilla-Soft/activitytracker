'use strict';

const TRENDING_AUTHORS_WINDOW_MS = parseInt(process.env.TRENDING_AUTHORS_WINDOW_MS ?? '86400000', 10); // 24h

// Deliberately a much longer window than SnapEventLog's (1h). A short window
// would leave too few candidates during quiet periods — this pool needs to
// stay populated even when posting activity is low, since it backs a
// "who to follow" suggestion list, not a real-time counter.
class AuthorTally {
  constructor(windowMs = TRENDING_AUTHORS_WINDOW_MS) {
    this._windowMs = windowMs;
    this._tally = new Map(); // author -> { count, lastSeen }
  }

  record(author, timestamp = Date.now()) {
    const entry = this._tally.get(author);
    if (entry) {
      entry.count += 1;
      entry.lastSeen = timestamp;
    } else {
      this._tally.set(author, { count: 1, lastSeen: timestamp });
    }
  }

  evict(now = Date.now()) {
    for (const [author, entry] of this._tally) {
      if (now - entry.lastSeen > this._windowMs) this._tally.delete(author);
    }
  }

  top(n) {
    return [...this._tally.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, n)
      .map(([account, { count }]) => ({ account, count }));
  }

  get size() {
    return this._tally.size;
  }
}

module.exports = { AuthorTally };
