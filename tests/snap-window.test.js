'use strict';

const { SnapEventLog } = require('../snap-window');

describe('SnapEventLog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('size returns 0 on empty log', () => {
    const log = new SnapEventLog();
    expect(log.size).toBe(0);
  });

  test('a single record sets size = 1', () => {
    const log = new SnapEventLog();
    log.record(Date.now());
    expect(log.size).toBe(1);
  });

  test('event is evicted after retention window expires', () => {
    const retentionMs = 60 * 60 * 1000;
    const log = new SnapEventLog(retentionMs);
    log.record(Date.now());
    jest.advanceTimersByTime(retentionMs + 1);
    log.evict(Date.now());
    expect(log.size).toBe(0);
  });

  test('event recorded near the boundary survives, older does not', () => {
    const retentionMs = 60 * 60 * 1000;
    const log = new SnapEventLog(retentionMs);
    log.record(Date.now()); // T=0, will be outside the window
    jest.advanceTimersByTime(50 * 60 * 1000); // T=50min
    log.record(Date.now()); // T=50min, will still be inside the window
    jest.advanceTimersByTime(11 * 60 * 1000); // T=61min
    log.evict(Date.now());
    expect(log.size).toBe(1);
  });

  test('countSince counts only events strictly after the given timestamp', () => {
    const log = new SnapEventLog();
    const base = Date.now();
    log.record(base);
    jest.advanceTimersByTime(1000);
    log.record(Date.now());
    jest.advanceTimersByTime(1000);
    log.record(Date.now());
    expect(log.countSince(base)).toBe(2);
    expect(log.countSince(base - 1)).toBe(3);
    expect(log.countSince(Date.now())).toBe(0);
  });

  test('evict is idempotent', () => {
    const retentionMs = 60 * 60 * 1000;
    const log = new SnapEventLog(retentionMs);
    log.record(Date.now());
    jest.advanceTimersByTime(retentionMs + 1);
    const now = Date.now();
    log.evict(now);
    log.evict(now);
    expect(log.size).toBe(0);
  });

  test('latest returns null on empty log, and the most recent timestamp otherwise', () => {
    const log = new SnapEventLog();
    expect(log.latest).toBeNull();
    const t1 = Date.now();
    log.record(t1);
    jest.advanceTimersByTime(1000);
    const t2 = Date.now();
    log.record(t2);
    expect(log.latest).toBe(t2);
  });

  test('recording the same key twice within the window only counts once (dedupes edits)', () => {
    const log = new SnapEventLog();
    log.record(Date.now(), 'alice/my-snap');
    jest.advanceTimersByTime(1000);
    log.record(Date.now(), 'alice/my-snap'); // simulated edit re-broadcast
    expect(log.size).toBe(1);
  });

  test('a key can be recorded again after it has been evicted', () => {
    const retentionMs = 60 * 60 * 1000;
    const log = new SnapEventLog(retentionMs);
    log.record(Date.now(), 'alice/my-snap');
    jest.advanceTimersByTime(retentionMs + 1);
    log.evict(Date.now());
    log.record(Date.now(), 'alice/my-snap');
    expect(log.size).toBe(1);
  });
});
