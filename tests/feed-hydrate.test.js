'use strict';

const { hydrateItems, clearHydrateCache } = require('../feed-index');

const ptr = (n) => ({ source: 'snap', author: `a${n}`, permlink: `p${n}`, created: '2026-10-13T00:00:00.000Z', parentAuthor: 'peak.snaps', parentPermlink: 'c' });
const content = (n) => ({ author: `a${n}`, body: `b${n}`, json_metadata: '{}', active_votes: [], children: 0 });

describe('hydrateItems cache and failure handling', () => {
  beforeEach(() => clearHydrateCache());

  test('serves repeat requests from cache without a second RPC', async () => {
    const call = jest.fn(async (_m, [a]) => content(a.slice(1)));
    const client = { database: { call } };
    await hydrateItems(client, [ptr(1), ptr(2)]);
    const out = await hydrateItems(client, [ptr(1), ptr(2)]);
    expect(out).toHaveLength(2);
    expect(call).toHaveBeenCalledTimes(2);
  });

  test('retries a failed RPC once before giving up on the item', async () => {
    let n = 0;
    const call = jest.fn(async () => { if (n++ === 0) throw new Error('boom'); return content(1); });
    const out = await hydrateItems({ database: { call } }, [ptr(1)]);
    expect(out).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(2);
  });

  test('drops an item whose RPC keeps failing, keeps the rest', async () => {
    const call = jest.fn(async (_m, [a]) => { if (a === 'a1') throw new Error('down'); return content(2); });
    const out = await hydrateItems({ database: { call } }, [ptr(1), ptr(2)]);
    expect(out.map(i => i.permlink)).toEqual(['p2']);
  });
});
