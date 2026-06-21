'use strict';

const { PatronSubscriptions, tierForAmount } = require('../patron-subscriptions');

describe('tierForAmount', () => {
  test('5+ HBD is snap-master', () => {
    expect(tierForAmount(5)).toBe('snap-master');
    expect(tierForAmount(10)).toBe('snap-master');
  });

  test('1-4.99 HBD is snapian', () => {
    expect(tierForAmount(1)).toBe('snapian');
    expect(tierForAmount(4.99)).toBe('snapian');
  });

  test('above 0 up to 0.99 HBD is snaperino', () => {
    expect(tierForAmount(0.01)).toBe('snaperino');
    expect(tierForAmount(0.99)).toBe('snaperino');
  });
});

describe('PatronSubscriptions.record', () => {
  test('ignores transfers to the wrong account', () => {
    const ps = new PatronSubscriptions();
    ps.record('alice', 'someone-else', '5.000 HBD', 'snapiepatron');
    expect(ps.tierFor('alice')).toBeNull();
  });

  test('ignores transfers without the memo tag', () => {
    const ps = new PatronSubscriptions();
    ps.record('alice', 'snapie', '5.000 HBD', 'just saying hi');
    expect(ps.tierFor('alice')).toBeNull();
  });

  test('ignores transfers with no memo at all', () => {
    const ps = new PatronSubscriptions();
    ps.record('alice', 'snapie', '5.000 HBD', undefined);
    expect(ps.tierFor('alice')).toBeNull();
  });

  test('ignores non-HBD amounts', () => {
    const ps = new PatronSubscriptions();
    ps.record('alice', 'snapie', '5.000 HIVE', 'snapiepatron');
    expect(ps.tierFor('alice')).toBeNull();
  });

  test('picks the right tier per amount', () => {
    const ps = new PatronSubscriptions();
    ps.record('alice', 'snapie', '5.000 HBD', 'snapiepatron');
    expect(ps.tierFor('alice')).toBe('snap-master');

    ps.record('bob', 'snapie', '1.000 HBD', 'snapiepatron');
    expect(ps.tierFor('bob')).toBe('snapian');

    ps.record('carol', 'snapie', '0.500 HBD', 'snapiepatron');
    expect(ps.tierFor('carol')).toBe('snaperino');
  });

  test('memo tag can appear as a substring of a longer memo', () => {
    const ps = new PatronSubscriptions();
    ps.record('alice', 'snapie', '5.000 HBD', 'monthly support #snapiepatron tier');
    expect(ps.tierFor('alice')).toBe('snap-master');
  });

  test('all reflects recorded accounts with their tier', () => {
    const ps = new PatronSubscriptions();
    ps.record('alice', 'snapie', '5.000 HBD', 'snapiepatron');
    expect(ps.all).toEqual([{ account: 'alice', amount: 5, tier: 'snap-master' }]);
  });
});

describe('PatronSubscriptions.evict', () => {
  test('drops entries past the retention window', () => {
    const ps = new PatronSubscriptions(1000); // 1s retention
    const now = Date.now();
    ps.record('alice', 'snapie', '5.000 HBD', 'snapiepatron', now);
    ps.evict(now + 500);
    expect(ps.tierFor('alice')).toBe('snap-master');

    ps.evict(now + 1500);
    expect(ps.tierFor('alice')).toBeNull();
  });

  test('keeps entries within the retention window', () => {
    const ps = new PatronSubscriptions(3024000000);
    const now = Date.now();
    ps.record('alice', 'snapie', '5.000 HBD', 'snapiepatron', now);
    ps.evict(now + 1000 * 60 * 60 * 24 * 10); // 10 days later
    expect(ps.tierFor('alice')).toBe('snap-master');
  });
});
