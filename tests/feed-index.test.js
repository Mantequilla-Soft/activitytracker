'use strict';

const { FeedIndex } = require('../feed-index');

function pointer(source, permlink, created) {
  return { source, author: `${source}-author`, permlink, created, parentAuthor: `${source}.container`, parentPermlink: `${source}-container` };
}

function container(permlink, created, items) {
  return { permlink, created, items };
}

describe('FeedIndex', () => {
  test('merges two per-source pointer lists into one created-descending array', async () => {
    const feedIndex = new FeedIndex();
    feedIndex.seedContainers('snap', [
      container('snaps-2', '2026-06-30T12:00:00.000Z', [pointer('snap', 'a', '2026-06-30T12:00:00.000Z')]),
      container('snaps-1', '2026-06-29T12:00:00.000Z', [pointer('snap', 'b', '2026-06-29T12:00:00.000Z')]),
    ]);
    feedIndex.seedContainers('wave', [
      container('waves-1', '2026-06-30T18:00:00.000Z', [pointer('wave', 'c', '2026-06-30T18:00:00.000Z')]),
    ]);

    const { items } = await feedIndex.getPage(null, { limit: 50 });
    expect(items.map(i => i.permlink)).toEqual(['c', 'a', 'b']);
  });

  test('adding a container beyond the per-source cap evicts only that source\'s oldest container', () => {
    const feedIndex = new FeedIndex({ maxContainersPerSource: 3 });
    feedIndex.upsertContainer('snap', container('s1', '2026-06-27T00:00:00.000Z', [pointer('snap', 'p1', '2026-06-27T00:00:00.000Z')]));
    feedIndex.upsertContainer('snap', container('s2', '2026-06-28T00:00:00.000Z', [pointer('snap', 'p2', '2026-06-28T00:00:00.000Z')]));
    feedIndex.upsertContainer('snap', container('s3', '2026-06-29T00:00:00.000Z', [pointer('snap', 'p3', '2026-06-29T00:00:00.000Z')]));
    feedIndex.upsertContainer('snap', container('s4', '2026-06-30T00:00:00.000Z', [pointer('snap', 'p4', '2026-06-30T00:00:00.000Z')]));

    expect(feedIndex.containerCount('snap')).toBe(3);
    expect(feedIndex.containerCount('wave')).toBe(0);
  });

  test('a before cursor within the cached window returns a slice with no fallback walk triggered', async () => {
    const fallbackWalkFn = jest.fn();
    const feedIndex = new FeedIndex({ fallbackWalkFn });
    feedIndex.seedContainers('snap', [
      container('s2', '2026-06-30T00:00:00.000Z', [pointer('snap', 'p2', '2026-06-30T00:00:00.000Z')]),
      container('s1', '2026-06-28T00:00:00.000Z', [pointer('snap', 'p1', '2026-06-28T00:00:00.000Z')]),
    ]);

    const { items } = await feedIndex.getPage(null, { before: '2026-06-30T00:00:00.000Z', limit: 10 });
    expect(items.map(i => i.permlink)).toEqual(['p1']);
    expect(fallbackWalkFn).not.toHaveBeenCalled();
  });

  test('a before cursor older than the cached window triggers the fallback walk with the capped limit', async () => {
    const fallbackWalkFn = jest.fn().mockResolvedValue({ containers: [], exhausted: false });
    const feedIndex = new FeedIndex({ fallbackWalkFn, maxFallbackContainers: 30 });
    feedIndex.seedContainers('snap', [
      container('s1', '2026-06-28T00:00:00.000Z', [pointer('snap', 'p1', '2026-06-28T00:00:00.000Z')]),
    ]);

    const client = {};
    await feedIndex.getPage(client, { before: '2026-06-01T00:00:00.000Z', limit: 10 });

    expect(fallbackWalkFn).toHaveBeenCalledWith(client, { key: 'snap', author: expect.any(String) }, '2026-06-01T00:00:00.000Z', 30);
    expect(fallbackWalkFn).toHaveBeenCalledWith(client, { key: 'wave', author: expect.any(String) }, '2026-06-01T00:00:00.000Z', 30);
  });

  test('hasMore is true when the oldest indexed container has not been confirmed as the true end of history', async () => {
    const feedIndex = new FeedIndex();
    feedIndex.seedContainers('snap', [
      container('s1', '2026-06-30T00:00:00.000Z', [pointer('snap', 'p1', '2026-06-30T00:00:00.000Z')]),
    ]);

    const { hasMore } = await feedIndex.getPage(null, { limit: 50 });
    expect(hasMore).toBe(true);
  });

  test('hasMore is false once every source is confirmed exhausted and the slice covers everything', async () => {
    const feedIndex = new FeedIndex();
    feedIndex.seedContainers('snap', [
      container('s1', '2026-06-30T00:00:00.000Z', [pointer('snap', 'p1', '2026-06-30T00:00:00.000Z')]),
    ]);
    feedIndex.markExhausted('snap');
    feedIndex.markExhausted('wave');

    const { hasMore } = await feedIndex.getPage(null, { limit: 50 });
    expect(hasMore).toBe(false);
  });

  test('countSince counts pointers across both sources newer than the cutoff', async () => {
    const feedIndex = new FeedIndex();
    const since = Date.parse('2026-06-29T00:00:00.000Z');
    feedIndex.seedContainers('snap', [
      container('s1', '2026-06-30T00:00:00.000Z', [pointer('snap', 'p1', '2026-06-30T00:00:00.000Z')]),
      container('s0', '2026-06-28T00:00:00.000Z', [pointer('snap', 'p0', '2026-06-28T00:00:00.000Z')]),
    ]);
    feedIndex.seedContainers('wave', [
      container('w1', '2026-06-29T12:00:00.000Z', [pointer('wave', 'p2', '2026-06-29T12:00:00.000Z')]),
    ]);

    expect(feedIndex.countSince(since)).toBe(2);
  });
});
