'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PatronDelegations,
  tierForUsdValue,
  vestsToHp,
  fetchHivePriceUsd,
} = require('../patron-delegations');

function tmpStateFile() {
  return path.join(os.tmpdir(), `patron-delegations-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function mockFetchSequence(responses) {
  let call = 0;
  global.fetch = jest.fn(() => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    if (r.networkError) return Promise.reject(new Error(r.networkError));
    return Promise.resolve({
      ok: r.ok !== false,
      status: r.status ?? 200,
      json: () => Promise.resolve(r.json),
    });
  });
}

function priceResponse(usd) {
  return { json: { hive: { usd } } };
}

function ecencyResponse(list) {
  return { json: { list } };
}

function fakeClient(totalVestingFundHive, totalVestingShares) {
  return {
    database: {
      getDynamicGlobalProperties: () => Promise.resolve({
        total_vesting_fund_hive: `${totalVestingFundHive} HIVE`,
        total_vesting_shares: `${totalVestingShares} VESTS`,
      }),
    },
  };
}

describe('vestsToHp', () => {
  test('converts VESTS to HP using the fund/shares ratio', () => {
    expect(vestsToHp(1000, 500000, 1000000)).toBeCloseTo(500, 5);
  });
});

describe('tierForUsdValue', () => {
  test('$300+ is snap-master', () => {
    expect(tierForUsdValue(300)).toBe('snap-master');
    expect(tierForUsdValue(500)).toBe('snap-master');
  });

  test('$75-$299.99 is snapian', () => {
    expect(tierForUsdValue(75)).toBe('snapian');
    expect(tierForUsdValue(299.99)).toBe('snapian');
  });

  test('any amount > $0 up to $74.99 is snaperino', () => {
    expect(tierForUsdValue(0.01)).toBe('snaperino');
    expect(tierForUsdValue(74.99)).toBe('snaperino');
  });

  test('$0 is snaperino (min: 0 matches)', () => {
    expect(tierForUsdValue(0)).toBe('snaperino');
  });
});

describe('fetchHivePriceUsd', () => {
  afterEach(() => {
    delete global.fetch;
  });

  test('returns the parsed USD price on success', async () => {
    mockFetchSequence([priceResponse(0.25)]);
    const price = await fetchHivePriceUsd();
    expect(price).toBe(0.25);
  });

  test('throws if CoinGecko returns a non-ok response', async () => {
    mockFetchSequence([{ ok: false, status: 500, json: {} }]);
    await expect(fetchHivePriceUsd()).rejects.toThrow();
  });

  test('throws if the response has no usable price', async () => {
    mockFetchSequence([{ json: {} }]);
    await expect(fetchHivePriceUsd()).rejects.toThrow();
  });
});

describe('PatronDelegations.sync', () => {
  let stateFile;

  beforeEach(() => {
    stateFile = tmpStateFile();
  });

  afterEach(() => {
    delete global.fetch;
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  });

  test('success populates the map with correct tiers', async () => {
    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000000.000000 VESTS' },
    ])]);
    const pd = new PatronDelegations(stateFile);
    const client = fakeClient(500000, 1000000); // 1 VESTS = 0.5 HP
    await pd.sync(client);
    // 1,000,000 VESTS -> 500,000 HP -> $500,000 -> snap-master
    expect(pd.tierFor('alice')).toBe('snap-master');
    expect(pd.all).toEqual([{ account: 'alice', hp: 500000, peakUsdValue: 500000, tier: 'snap-master' }]);
  });

  test('Ecency failure leaves the previous snapshot intact', async () => {
    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000000.000000 VESTS' },
    ])]);
    const pd = new PatronDelegations(stateFile);
    const client = fakeClient(500000, 1000000);
    await pd.sync(client);
    expect(pd.tierFor('alice')).toBe('snap-master');

    mockFetchSequence([priceResponse(1), { ok: false, status: 500, json: {} }]);
    await pd.sync(client);
    expect(pd.tierFor('alice')).toBe('snap-master');
  });

  test('CoinGecko failure leaves the previous snapshot intact', async () => {
    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000000.000000 VESTS' },
    ])]);
    const pd = new PatronDelegations(stateFile);
    const client = fakeClient(500000, 1000000);
    await pd.sync(client);
    expect(pd.tierFor('alice')).toBe('snap-master');

    mockFetchSequence([{ ok: false, status: 500, json: {} }]);
    await pd.sync(client);
    expect(pd.tierFor('alice')).toBe('snap-master');
  });

  test('same VESTS, price drops between syncs — tier does not decrease', async () => {
    // 1,000 VESTS, fund/shares ratio 1:1 -> 1,000 HP.
    mockFetchSequence([priceResponse(0.1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000.000000 VESTS' },
    ])]);
    const pd = new PatronDelegations(stateFile);
    const client = fakeClient(1000000, 1000000);
    await pd.sync(client); // $100 -> snapian
    expect(pd.tierFor('alice')).toBe('snapian');

    mockFetchSequence([priceResponse(0.01), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000.000000 VESTS' },
    ])]);
    await pd.sync(client); // current value $10, but peak stays $100
    expect(pd.tierFor('alice')).toBe('snapian');
  });

  test('same VESTS, price rises between syncs — tier increases', async () => {
    mockFetchSequence([priceResponse(0.01), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000.000000 VESTS' },
    ])]);
    const pd = new PatronDelegations(stateFile);
    const client = fakeClient(1000000, 1000000);
    await pd.sync(client); // $10 -> snaperino
    expect(pd.tierFor('alice')).toBe('snaperino');

    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000.000000 VESTS' },
    ])]);
    await pd.sync(client); // $1000 -> snap-master
    expect(pd.tierFor('alice')).toBe('snap-master');
  });

  test('VESTS→HP ratio drift alone (same VESTS, different global props) is not treated as a reduction', async () => {
    // Sync 1: 1000 VESTS at ratio 0.1 -> 100 HP -> $100 (price $1) -> snapian.
    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000.000000 VESTS' },
    ])]);
    const pd = new PatronDelegations(stateFile);
    const client1 = fakeClient(100000, 1000000); // ratio 0.1
    await pd.sync(client1);
    expect(pd.tierFor('alice')).toBe('snapian');
    expect(pd.all[0].peakUsdValue).toBe(100);

    // Sync 2: same 1000 VESTS, but the global ratio ticked down slightly
    // (inflation drift) -> 99.9 HP -> $99.9. Comparing on raw VESTS (equal,
    // not a reduction) must keep the $100 peak — comparing on derived HP
    // would wrongly see a "decrease" and reset the peak down to $99.9.
    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000.000000 VESTS' },
    ])]);
    const client2 = fakeClient(99900, 1000000); // ratio 0.0999
    await pd.sync(client2);
    expect(pd.tierFor('alice')).toBe('snapian');
    expect(pd.all[0].peakUsdValue).toBe(100);
  });

  test('VESTS increases between syncs — peak recomputed off the new (larger) amount', async () => {
    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '100.000000 VESTS' },
    ])]);
    const pd = new PatronDelegations(stateFile);
    const client = fakeClient(1000000, 1000000); // ratio 1:1
    await pd.sync(client); // 100 HP -> $100 -> snapian
    expect(pd.tierFor('alice')).toBe('snapian');

    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000.000000 VESTS' },
    ])]);
    await pd.sync(client); // 1000 HP -> $1000 -> snap-master
    expect(pd.tierFor('alice')).toBe('snap-master');
  });

  test('VESTS decreases between syncs — peak resets to today value, can drop', async () => {
    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000.000000 VESTS' },
    ])]);
    const pd = new PatronDelegations(stateFile);
    const client = fakeClient(1000000, 1000000); // ratio 1:1
    await pd.sync(client); // 1000 HP -> $1000 -> snap-master
    expect(pd.tierFor('alice')).toBe('snap-master');

    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '10.000000 VESTS' },
    ])]);
    await pd.sync(client); // 10 HP -> $10 -> snaperino (real reduction, no ratchet protection)
    expect(pd.tierFor('alice')).toBe('snaperino');
  });

  test('delegator absent from a later sync is fully dropped', async () => {
    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000.000000 VESTS' },
    ])]);
    const pd = new PatronDelegations(stateFile);
    const client = fakeClient(1000000, 1000000);
    await pd.sync(client);
    expect(pd.tierFor('alice')).toBe('snap-master');

    mockFetchSequence([priceResponse(1), ecencyResponse([])]);
    await pd.sync(client);
    expect(pd.tierFor('alice')).toBeNull();
    expect(pd.all).toEqual([]);
  });
});

describe('PatronDelegations persistence', () => {
  afterEach(() => {
    delete global.fetch;
  });

  test('load() with no file present leaves the map empty', () => {
    const pd = new PatronDelegations(tmpStateFile());
    pd.load();
    expect(pd.all).toEqual([]);
  });

  test('sync() success writes a file a fresh instance can load with matching tiers', async () => {
    const stateFile = tmpStateFile();
    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000000.000000 VESTS' },
    ])]);
    const pd = new PatronDelegations(stateFile);
    const client = fakeClient(500000, 1000000);
    await pd.sync(client);
    expect(pd.tierFor('alice')).toBe('snap-master');

    try {
      const reloaded = new PatronDelegations(stateFile);
      reloaded.load();
      expect(reloaded.tierFor('alice')).toBe('snap-master');
    } finally {
      fs.unlinkSync(stateFile);
    }
  });

  test('restart no longer resets the ratchet peak — the reported bug', async () => {
    const stateFile = tmpStateFile();

    // Sync 1 (before "restart"): HIVE at $1, 1000 VESTS, ratio 1:1 -> $1000 -> snap-master.
    mockFetchSequence([priceResponse(1), ecencyResponse([
      { delegator: 'alice', vesting_shares: '1000.000000 VESTS' },
    ])]);
    const before = new PatronDelegations(stateFile);
    const client = fakeClient(1000000, 1000000);
    await before.sync(client);
    expect(before.tierFor('alice')).toBe('snap-master');

    try {
      // Simulate a restart: brand new instance, nothing in memory except what load() restores.
      const after = new PatronDelegations(stateFile);
      after.load();

      // Sync 2 (after "restart"): price crashed to $0.01, same VESTS -> today's
      // value alone would be $10 (snaperino). Without persistence, this used to
      // silently demote alice. With load() run first, the ratchet must keep
      // the $1000 peak found on disk.
      mockFetchSequence([priceResponse(0.01), ecencyResponse([
        { delegator: 'alice', vesting_shares: '1000.000000 VESTS' },
      ])]);
      await after.sync(client);
      expect(after.tierFor('alice')).toBe('snap-master');
    } finally {
      fs.unlinkSync(stateFile);
    }
  });
});
