'use strict';

const WINDOW_MS = parseInt(process.env.WINDOW_MS ?? '1800000', 10);

class RollingWindow {
  constructor(windowMs = WINDOW_MS) {
    this._windowMs = windowMs;
    this._map = new Map();
  }

  upsert(account) {
    this._map.set(account, Date.now());
  }

  evict(now = Date.now()) {
    for (const [account, lastSeen] of this._map) {
      if (now - lastSeen > this._windowMs) {
        this._map.delete(account);
      }
    }
  }

  get size() {
    return this._map.size;
  }
}

module.exports = { RollingWindow };
