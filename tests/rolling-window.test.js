'use strict';

const { RollingWindow } = require('../rolling-window');

describe('RollingWindow', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('size returns 0 on empty window', () => {
    const w = new RollingWindow();
    expect(w.size).toBe(0);
  });

  test('adding a single account sets size = 1', () => {
    const w = new RollingWindow();
    w.upsert('alice');
    expect(w.size).toBe(1);
  });

  test('adding the same account twice does not change size', () => {
    const w = new RollingWindow();
    w.upsert('alice');
    w.upsert('alice');
    expect(w.size).toBe(1);
  });

  test('adding two different accounts sets size = 2', () => {
    const w = new RollingWindow();
    w.upsert('alice');
    w.upsert('bob');
    expect(w.size).toBe(2);
  });

  test('account is evicted after window expires', () => {
    const windowMs = 30 * 60 * 1000;
    const w = new RollingWindow(windowMs);
    w.upsert('alice');
    jest.advanceTimersByTime(windowMs + 1);
    w.evict(Date.now());
    expect(w.size).toBe(0);
  });

  test('account refreshed at T=25min survives eviction at T=31min', () => {
    const windowMs = 30 * 60 * 1000;
    const w = new RollingWindow(windowMs);
    w.upsert('alice'); // T=0
    jest.advanceTimersByTime(25 * 60 * 1000); // T=25min
    w.upsert('alice'); // refresh
    jest.advanceTimersByTime(6 * 60 * 1000); // T=31min
    w.evict(Date.now());
    expect(w.size).toBe(1);
  });

  test('evict is idempotent', () => {
    const windowMs = 30 * 60 * 1000;
    const w = new RollingWindow(windowMs);
    w.upsert('alice');
    jest.advanceTimersByTime(windowMs + 1);
    const now = Date.now();
    w.evict(now);
    w.evict(now);
    expect(w.size).toBe(0);
  });
});
