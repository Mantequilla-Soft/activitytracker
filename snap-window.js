'use strict';

const SNAP_RETENTION_MS = parseInt(process.env.SNAP_RETENTION_MS ?? '3600000', 10); // 1h

// Assumes record() is always called with non-decreasing timestamps, which holds
// as long as callers feed it blocks in increasing block-height order (true for
// both coldStart and the poll loop, since fetchBlockRange always walks forward).
class SnapEventLog {
  constructor(retentionMs = SNAP_RETENTION_MS) {
    this._retentionMs = retentionMs;
    this._events = []; // ascending { timestamp, key }
    this._seenKeys = new Set(); // keys currently within the retention window
  }

  // `key` (e.g. "author/permlink") dedupes edits of an existing snap — Hive
  // re-broadcasts the same comment_operation shape on edit, so without this an
  // edit would be miscounted as a new snap. Pass no key to record unconditionally.
  record(timestamp = Date.now(), key = null) {
    if (key && this._seenKeys.has(key)) return false;
    this._events.push({ timestamp, key });
    if (key) this._seenKeys.add(key);
    return true;
  }

  evict(now = Date.now()) {
    let i = 0;
    while (i < this._events.length && now - this._events[i].timestamp > this._retentionMs) i++;
    if (i > 0) {
      const removed = this._events.splice(0, i);
      for (const event of removed) {
        if (event.key) this._seenKeys.delete(event.key);
      }
    }
  }

  countSince(sinceMs) {
    let count = 0;
    for (let i = this._events.length - 1; i >= 0; i--) {
      if (this._events[i].timestamp > sinceMs) count++;
      else break;
    }
    return count;
  }

  get latest() {
    return this._events.length ? this._events[this._events.length - 1].timestamp : null;
  }

  get size() {
    return this._events.length;
  }
}

module.exports = { SnapEventLog };
