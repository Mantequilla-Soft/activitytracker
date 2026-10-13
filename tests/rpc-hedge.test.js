'use strict';

const http = require('http');
const { hedgedRpc, resetNodeHealth } = require('../rpc-hedge');

function server(handler) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => handler(JSON.parse(body), res, req));
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}
const good = (label) => server((rq, res) => res.end(JSON.stringify({ id: rq.id, jsonrpc: '2.0', result: { label, method: rq.method } })));
const stuck = () => server(() => { /* never answers */ });
const limited = () => server((_rq, res) => { res.statusCode = 429; res.end('slow down'); });
const rpcErr = () => server((rq, res) => res.end(JSON.stringify({ id: rq.id, jsonrpc: '2.0', error: { code: -32000, message: 'boom' } })));

const opened = [];
const track = async (p) => { const x = await p; opened.push(x.s); return x.url; };
afterEach(() => { opened.splice(0).forEach(s => { s.closeAllConnections?.(); s.close(); }); resetNodeHealth(); });

describe('hedgedRpc', () => {
  test('builds api.method request and returns the result', async () => {
    const a = await track(good('a')); const b = await track(good('b'));
    const r = await hedgedRpc([a, b], 'condenser_api', 'get_content', ['x', 'y']);
    expect(r.method).toBe('condenser_api.get_content');
  });

  test('a stuck node is hedged past after the hedge delay', async () => {
    const s = await track(stuck()); const g = await track(good('g'));
    const t = Date.now();
    const r = await hedgedRpc([s, g], 'condenser_api', 'get_content', [], { hedgeDelayMs: 100 });
    expect(r.label).toBe('g');
    expect(Date.now() - t).toBeLessThan(2000);
  });

  test('a 429 node fails over immediately without waiting for the hedge delay', async () => {
    const l = await track(limited()); const g = await track(good('g'));
    const t = Date.now();
    const r = await hedgedRpc([l, g], 'condenser_api', 'get_content', [], { hedgeDelayMs: 5000 });
    expect(r.label).toBe('g');
    expect(Date.now() - t).toBeLessThan(1000);
  });

  test('an RPC-level error falls through to the next node', async () => {
    const e = await track(rpcErr()); const g = await track(good('g'));
    const r = await hedgedRpc([e, g], 'condenser_api', 'get_content', [], { hedgeDelayMs: 5000 });
    expect(r.label).toBe('g');
  });

  test('rejects when every node fails', async () => {
    const l1 = await track(limited()); const l2 = await track(limited());
    await expect(hedgedRpc([l1, l2], 'condenser_api', 'get_content', [])).rejects.toThrow(/429/);
  });
});
