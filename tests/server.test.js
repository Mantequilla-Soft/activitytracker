'use strict';

const request = require('supertest');
const { createServer } = require('../server');

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
