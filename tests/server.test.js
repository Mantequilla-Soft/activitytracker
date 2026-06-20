'use strict';

const request = require('supertest');
const { createServer } = require('../server');
const { SnapEventLog } = require('../snap-window');

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
