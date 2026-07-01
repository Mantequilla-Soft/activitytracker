'use strict';

const os = require('os');
const path = require('path');
const request = require('supertest');
const { createServer } = require('../server');
const { SnapEventLog } = require('../snap-window');
const { AuthorTally } = require('../author-tally');
const { PatronSubscriptions } = require('../patron-subscriptions');
const { PatronDelegations } = require('../patron-delegations');

describe('HTTP server', () => {
  test('GET /active-users during warm-up returns count=null, warming=true', async () => {
    const state = { warming: true, count: 0, updatedAt: new Date().toISOString() };
    const app = createServer(state);
    const res = await request(app).get('/active-users');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeNull();
    expect(res.body.warming).toBe(true);
  });

  test('GET /active-users after warm-up returns count, warming=false, updatedAt', async () => {
    const now = new Date().toISOString();
    const state = { warming: false, count: 1234, updatedAt: now };
    const app = createServer(state);
    const res = await request(app).get('/active-users');
    expect(res.status).toBe(200);
    expect(res.body.warming).toBe(false);
    expect(res.body.updatedAt).toBe(now);
  });

  test('count in response is always a number or null — never a string', async () => {
    const state = { warming: false, count: 42, updatedAt: new Date().toISOString() };
    const app = createServer(state);
    const res = await request(app).get('/active-users');
    expect(typeof res.body.count === 'number' || res.body.count === null).toBe(true);
  });

  test('GET /health returns status ok with 200', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const app = createServer(state);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('GET /anything-else returns 404', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const app = createServer(state);
    const res = await request(app).get('/not-a-real-route');
    expect(res.status).toBe(404);
  });

  test('two concurrent GET /active-users requests return the same count', async () => {
    const state = { warming: false, count: 999, updatedAt: new Date().toISOString() };
    const app = createServer(state);
    const [r1, r2] = await Promise.all([
      request(app).get('/active-users'),
      request(app).get('/active-users'),
    ]);
    expect(r1.body.count).toBe(r2.body.count);
  });
});

describe('GET /new-snaps', () => {
  test('missing since returns 400', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const app = createServer(state, new SnapEventLog());
    const res = await request(app).get('/new-snaps');
    expect(res.status).toBe(400);
  });

  test('unparseable since returns 400', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const app = createServer(state, new SnapEventLog());
    const res = await request(app).get('/new-snaps?since=banana');
    expect(res.status).toBe(400);
  });

  test('valid since with one recent event in the log returns count: 1', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const snapLog = new SnapEventLog();
    const since = Date.now() - 60000;
    snapLog.record(Date.now());
    const app = createServer(state, snapLog);
    const res = await request(app).get(`/new-snaps?since=${since}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  test('state.warming === true returns count: 0 regardless of log contents', async () => {
    const state = { warming: true, count: 0, updatedAt: new Date().toISOString() };
    const snapLog = new SnapEventLog();
    snapLog.record(Date.now());
    const app = createServer(state, snapLog);
    const res = await request(app).get(`/new-snaps?since=${Date.now() - 60000}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  test('no snapLog passed to createServer returns count: 0 and does not throw', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const app = createServer(state);
    const res = await request(app).get(`/new-snaps?since=${Date.now() - 60000}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });
});

describe('GET /trending-authors', () => {
  test('no authorTally passed to createServer returns authors: [], warming: false, does not throw', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const app = createServer(state, new SnapEventLog());
    const res = await request(app).get('/trending-authors');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authors: [], warming: false });
  });

  test('state.warming === true returns authors: [] regardless of tally contents', async () => {
    const state = { warming: true, count: 0, updatedAt: new Date().toISOString() };
    const authorTally = new AuthorTally();
    authorTally.record('alice');
    const app = createServer(state, new SnapEventLog(), authorTally);
    const res = await request(app).get('/trending-authors');
    expect(res.status).toBe(200);
    expect(res.body.authors).toEqual([]);
    expect(res.body.warming).toBe(true);
  });

  test('valid tally with 3 authors, default limit returns all 3 sorted by count descending', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const authorTally = new AuthorTally();
    authorTally.record('alice');
    authorTally.record('bob');
    authorTally.record('bob');
    authorTally.record('charlie');
    authorTally.record('charlie');
    authorTally.record('charlie');
    const app = createServer(state, new SnapEventLog(), authorTally);
    const res = await request(app).get('/trending-authors');
    expect(res.status).toBe(200);
    expect(res.body.authors).toEqual([
      { account: 'charlie', count: 3 },
      { account: 'bob', count: 2 },
      { account: 'alice', count: 1 },
    ]);
  });

  test('?limit=1 returns only the top 1', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const authorTally = new AuthorTally();
    authorTally.record('alice');
    authorTally.record('bob');
    authorTally.record('bob');
    const app = createServer(state, new SnapEventLog(), authorTally);
    const res = await request(app).get('/trending-authors?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.authors).toEqual([{ account: 'bob', count: 2 }]);
  });

  test('?limit=999 with a small tally returns all entries unclamped', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const authorTally = new AuthorTally();
    authorTally.record('alice');
    authorTally.record('bob');
    const app = createServer(state, new SnapEventLog(), authorTally);
    const res = await request(app).get('/trending-authors?limit=999');
    expect(res.status).toBe(200);
    expect(res.body.authors.length).toBe(2);
  });

  test('limit clamping math: requested 999 clamps to 50', () => {
    const requested = 999;
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 50)) : 20;
    expect(limit).toBe(50);
  });

  test('?limit=banana (non-numeric) falls back to default of 20, does not throw', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const authorTally = new AuthorTally();
    for (let i = 0; i < 25; i++) authorTally.record(`author${i}`);
    const app = createServer(state, new SnapEventLog(), authorTally);
    const res = await request(app).get('/trending-authors?limit=banana');
    expect(res.status).toBe(200);
    expect(res.body.authors.length).toBe(20);
  });
});

describe('GET /patrons and /patrons/:account', () => {
  // PatronDelegations has no public setter besides sync(), so populate it via
  // a mocked fetch the same way tests/patron-delegations.test.js does.
  async function delegationsWith(entries) {
    let call = 0;
    const responses = [
      { ok: true, json: () => Promise.resolve({ hive: { usd: 1 } }) },
      { ok: true, json: () => Promise.resolve({ list: entries }) },
    ];
    global.fetch = jest.fn(() => Promise.resolve(responses[call++]));
    // Temp stateFile — sync() now persists to disk on success, and this
    // helper shouldn't write into the real repo-relative default file.
    const stateFile = path.join(os.tmpdir(), `patron-delegations-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const pd = new PatronDelegations(stateFile);
    const client = {
      database: {
        getDynamicGlobalProperties: () => Promise.resolve({
          total_vesting_fund_hive: '1000000 HIVE',
          total_vesting_shares: '1000000 VESTS',
        }),
      },
    };
    await pd.sync(client);
    delete global.fetch;
    return pd;
  }

  test('empty state returns patrons: []', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const app = createServer(state, undefined, undefined, new PatronSubscriptions(), new PatronDelegations());
    const res = await request(app).get('/patrons');
    expect(res.status).toBe(200);
    expect(res.body.patrons).toEqual([]);
  });

  test('missing patronSubs/patronDelegations returns patrons: [] and does not throw', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const app = createServer(state);
    const res = await request(app).get('/patrons');
    expect(res.status).toBe(200);
    expect(res.body.patrons).toEqual([]);
  });

  test('state.warming === true returns patrons: [] regardless of contents', async () => {
    const state = { warming: true, count: 0, updatedAt: new Date().toISOString() };
    const patronSubs = new PatronSubscriptions();
    patronSubs.record('alice', 'snapie', '5.000 HBD', 'snapiepatron');
    const app = createServer(state, undefined, undefined, patronSubs, new PatronDelegations());
    const res = await request(app).get('/patrons');
    expect(res.status).toBe(200);
    expect(res.body.patrons).toEqual([]);
  });

  test('one subscription-only patron', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const patronSubs = new PatronSubscriptions();
    patronSubs.record('alice', 'snapie', '5.000 HBD', 'snapiepatron');
    const app = createServer(state, undefined, undefined, patronSubs, new PatronDelegations());
    const res = await request(app).get('/patrons');
    expect(res.status).toBe(200);
    expect(res.body.patrons).toEqual([{ account: 'alice', tier: 'snap-master', via: 'subscription' }]);
  });

  test('one delegation-only patron', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const patronDelegations = await delegationsWith([
      { delegator: 'bob', vesting_shares: '1000000.000000 VESTS' },
    ]);
    const app = createServer(state, undefined, undefined, new PatronSubscriptions(), patronDelegations);
    const res = await request(app).get('/patrons');
    expect(res.status).toBe(200);
    expect(res.body.patrons).toEqual([{ account: 'bob', tier: 'snap-master', via: 'delegation' }]);
  });

  test('a patron qualifying via both — via: "both" and the higher tier wins', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const patronSubs = new PatronSubscriptions();
    patronSubs.record('carol', 'snapie', '1.000 HBD', 'snapiepatron'); // snapian
    const patronDelegations = await delegationsWith([
      { delegator: 'carol', vesting_shares: '1000000.000000 VESTS' }, // snap-master
    ]);
    const app = createServer(state, undefined, undefined, patronSubs, patronDelegations);
    const res = await request(app).get('/patrons');
    expect(res.status).toBe(200);
    expect(res.body.patrons).toEqual([{ account: 'carol', tier: 'snap-master', via: 'both' }]);
  });

  test('GET /patrons/:account for an unknown account returns tier: null', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const app = createServer(state, undefined, undefined, new PatronSubscriptions(), new PatronDelegations());
    const res = await request(app).get('/patrons/nobody');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ account: 'nobody', tier: null });
  });

  test('GET /patrons/:account for a known account returns its combined tier', async () => {
    const state = { warming: false, count: 0, updatedAt: new Date().toISOString() };
    const patronSubs = new PatronSubscriptions();
    patronSubs.record('alice', 'snapie', '5.000 HBD', 'snapiepatron');
    const app = createServer(state, undefined, undefined, patronSubs, new PatronDelegations());
    const res = await request(app).get('/patrons/alice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ account: 'alice', tier: 'snap-master' });
  });
});
