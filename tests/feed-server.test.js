'use strict';

const request = require('supertest');
const { createServer } = require('../server');
const { FeedIndex } = require('../feed-index');

function pointer(source, permlink, created) {
  return { source, author: `${source}-author`, permlink, created, parentAuthor: `${source}.container`, parentPermlink: `${source}-container` };
}

function container(permlink, created, items) {
  return { permlink, created, items };
}

function mockClient() {
  return {
    database: {
      call: jest.fn((method, params) => {
        if (method === 'get_content') {
          const [author, permlink] = params;
          return Promise.resolve({
            author, permlink,
            body: `body of ${permlink}`,
            json_metadata: '{}',
            active_votes: [],
            children: 0,
          });
        }
        return Promise.resolve([]);
      }),
    },
  };
}

describe('GET /feed', () => {
  test('with no before returns the newest page', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString(), feedWarming: false };
    const feedIndex = new FeedIndex();
    feedIndex.seedContainers('snap', [
      container('s1', '2026-06-30T00:00:00.000Z', [pointer('snap', 'p1', '2026-06-30T00:00:00.000Z')]),
    ]);
    const client = mockClient();
    const app = createServer(state, undefined, undefined, undefined, undefined, feedIndex, client);

    const res = await request(app).get('/feed');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].permlink).toBe('p1');
  });

  test('limit=999 clamps to the server-side cap of 50', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString(), feedWarming: false };
    const feedIndex = new FeedIndex();
    const items = [];
    for (let i = 0; i < 60; i++) {
      items.push(pointer('snap', `p${i}`, `2026-06-30T00:${String(i).padStart(2, '0')}:00.000Z`));
    }
    feedIndex.seedContainers('snap', [container('s1', '2026-06-30T00:59:00.000Z', items)]);
    const client = mockClient();
    const app = createServer(state, undefined, undefined, undefined, undefined, feedIndex, client);

    const res = await request(app).get('/feed?limit=999');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(50);
  });

  test('items are fully hydrated with body, json_metadata, active_votes', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString(), feedWarming: false };
    const feedIndex = new FeedIndex();
    feedIndex.seedContainers('wave', [
      container('w1', '2026-06-30T00:00:00.000Z', [pointer('wave', 'p1', '2026-06-30T00:00:00.000Z')]),
    ]);
    const client = mockClient();
    const app = createServer(state, undefined, undefined, undefined, undefined, feedIndex, client);

    const res = await request(app).get('/feed');
    expect(res.status).toBe(200);
    const [item] = res.body.items;
    expect(item.body).toBe('body of p1');
    expect(item.json_metadata).toBe('{}');
    expect(item.active_votes).toEqual([]);
  });

  test('no feedIndex/client passed returns items: [], hasMore: false, does not throw', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString(), feedWarming: false };
    const app = createServer(state);
    const res = await request(app).get('/feed');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], hasMore: false });
  });
});

describe('GET /feed/new-since', () => {
  test('counts entries across both sources newer than since', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString(), feedWarming: false };
    const feedIndex = new FeedIndex();
    const since = Date.parse('2026-06-29T00:00:00.000Z');
    feedIndex.seedContainers('snap', [
      container('s1', '2026-06-30T00:00:00.000Z', [pointer('snap', 'p1', '2026-06-30T00:00:00.000Z')]),
    ]);
    feedIndex.seedContainers('wave', [
      container('w1', '2026-06-28T00:00:00.000Z', [pointer('wave', 'p2', '2026-06-28T00:00:00.000Z')]),
      container('w2', '2026-06-30T06:00:00.000Z', [pointer('wave', 'p3', '2026-06-30T06:00:00.000Z')]),
    ]);
    const app = createServer(state, undefined, undefined, undefined, undefined, feedIndex);

    const res = await request(app).get(`/feed/new-since?since=${since}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  test('returns warming: true before the feed index\'s first tick completes', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString(), feedWarming: true };
    const feedIndex = new FeedIndex();
    const app = createServer(state, undefined, undefined, undefined, undefined, feedIndex);

    const res = await request(app).get(`/feed/new-since?since=${Date.now() - 60000}`);
    expect(res.status).toBe(200);
    expect(res.body.warming).toBe(true);
    expect(res.body.count).toBe(0);
  });

  test('missing since returns 400, same convention as /new-snaps', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString(), feedWarming: false };
    const app = createServer(state);
    const res = await request(app).get('/feed/new-since');
    expect(res.status).toBe(400);
  });

  test('two concurrent requests with the same since return the same count', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString(), feedWarming: false };
    const feedIndex = new FeedIndex();
    feedIndex.seedContainers('snap', [
      container('s1', '2026-06-30T00:00:00.000Z', [pointer('snap', 'p1', '2026-06-30T00:00:00.000Z')]),
    ]);
    const app = createServer(state, undefined, undefined, undefined, undefined, feedIndex);
    const since = Date.now() - 60000;

    const [r1, r2] = await Promise.all([
      request(app).get(`/feed/new-since?since=${since}`),
      request(app).get(`/feed/new-since?since=${since}`),
    ]);
    expect(r1.body.count).toBe(r2.body.count);
  });
});

describe('GET /health with feedIndex', () => {
  test('omits feedIndex block while feedWarming is true', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString(), feedWarming: true };
    const feedIndex = new FeedIndex();
    const app = createServer(state, undefined, undefined, undefined, undefined, feedIndex);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.feedIndex).toBeUndefined();
  });

  test('includes a populated feedIndex block once warmup completes', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString(), feedWarming: false };
    const feedIndex = new FeedIndex();
    feedIndex.seedContainers('snap', [
      container('s1', '2026-06-30T00:00:00.000Z', [pointer('snap', 'p1', '2026-06-30T00:00:00.000Z')]),
    ]);
    feedIndex.seedContainers('wave', [
      container('w1', '2026-06-29T00:00:00.000Z', [pointer('wave', 'p2', '2026-06-29T00:00:00.000Z')]),
    ]);
    const app = createServer(state, undefined, undefined, undefined, undefined, feedIndex);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.feedIndex).toEqual({
      snapContainers: 1,
      waveContainers: 1,
      oldestIndexed: '2026-06-29T00:00:00.000Z',
      newestIndexed: '2026-06-30T00:00:00.000Z',
    });
  });

  test('no feedIndex passed still returns status ok with no feedIndex key', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const app = createServer(state);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
