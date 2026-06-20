'use strict';

const { AuthorTally } = require('../author-tally');

describe('AuthorTally', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('top(n) returns empty array on empty tally', () => {
    const t = new AuthorTally();
    expect(t.top(10)).toEqual([]);
  });

  test('a single record sets count to 1', () => {
    const t = new AuthorTally();
    t.record('alice');
    expect(t.top(10)).toEqual([{ account: 'alice', count: 1 }]);
  });

  test('repeated records from the same author increment count (not dedup)', () => {
    const t = new AuthorTally();
    t.record('alice');
    t.record('alice');
    t.record('alice');
    expect(t.top(10)).toEqual([{ account: 'alice', count: 3 }]);
  });

  test('top(n) returns correct ordering by count descending', () => {
    const t = new AuthorTally();
    t.record('alice');
    t.record('bob');
    t.record('bob');
    t.record('charlie');
    t.record('charlie');
    t.record('charlie');
    expect(t.top(10)).toEqual([
      { account: 'charlie', count: 3 },
      { account: 'bob', count: 2 },
      { account: 'alice', count: 1 },
    ]);
  });

  test('top(n) respects n', () => {
    const t = new AuthorTally();
    t.record('alice');
    t.record('bob');
    t.record('bob');
    t.record('charlie');
    t.record('charlie');
    t.record('charlie');
    expect(t.top(1)).toEqual([{ account: 'charlie', count: 3 }]);
  });

  test('an author silent past the window is dropped on evict', () => {
    const windowMs = 24 * 60 * 60 * 1000;
    const t = new AuthorTally(windowMs);
    t.record('alice');
    jest.advanceTimersByTime(windowMs + 1);
    t.evict(Date.now());
    expect(t.top(10)).toEqual([]);
  });

  test('an author refreshed near the boundary survives while a stale one does not', () => {
    const windowMs = 24 * 60 * 60 * 1000;
    const t = new AuthorTally(windowMs);
    t.record('alice'); // T=0
    t.record('bob'); // T=0, never refreshed again
    jest.advanceTimersByTime(windowMs - 1000); // T=window-1s
    t.record('alice'); // refresh
    jest.advanceTimersByTime(2000); // T=window+1s
    t.evict(Date.now());
    const authors = t.top(10).map(a => a.account);
    expect(authors).toContain('alice');
    expect(authors).not.toContain('bob');
  });

  test('evict is idempotent', () => {
    const windowMs = 24 * 60 * 60 * 1000;
    const t = new AuthorTally(windowMs);
    t.record('alice');
    jest.advanceTimersByTime(windowMs + 1);
    const now = Date.now();
    t.evict(now);
    t.evict(now);
    expect(t.size).toBe(0);
  });
});
