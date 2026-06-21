'use strict';

const express = require('express');

function combinedTier(subTier, delTier) {
  const RANK = { 'snap-master': 3, snapian: 2, snaperino: 1 };
  const subRank = RANK[subTier] ?? 0;
  const delRank = RANK[delTier] ?? 0;
  if (subRank === 0 && delRank === 0) return null;
  return subRank >= delRank ? subTier : delTier;
}

function createServer(state, snapLog, authorTally, patronSubs, patronDelegations) {
  const app = express();

  app.get('/active-users', (req, res) => {
    res.json({
      count: state.warming ? null : state.count,
      warming: state.warming,
      updatedAt: state.updatedAt,
    });
  });

  app.get('/new-snaps', (req, res) => {
    const sinceRaw = req.query.since;
    const since = sinceRaw && /^\d+$/.test(String(sinceRaw))
      ? parseInt(sinceRaw, 10)
      : Date.parse(String(sinceRaw ?? ''));

    if (!sinceRaw || !Number.isFinite(since)) {
      return res.status(400).json({ error: 'since query param required (epoch ms or ISO-8601 timestamp)' });
    }

    const count = state.warming || !snapLog ? 0 : snapLog.countSince(since);
    const latest = snapLog ? snapLog.latest : null;
    res.json({
      count,
      latestTimestamp: latest ? new Date(latest).toISOString() : null,
      serverTime: new Date().toISOString(),
      warming: state.warming,
    });
  });

  app.get('/trending-authors', (req, res) => {
    const requested = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 50)) : 20;

    const authors = state.warming || !authorTally ? [] : authorTally.top(limit);
    res.json({ authors, warming: state.warming });
  });

  app.get('/patrons', (req, res) => {
    if (state.warming || !patronSubs || !patronDelegations) return res.json({ patrons: [] });
    const accounts = new Set([
      ...patronSubs.all.map(p => p.account),
      ...patronDelegations.all.map(p => p.account),
    ]);
    const patrons = [...accounts].map(account => {
      const subTier = patronSubs.tierFor(account);
      const delTier = patronDelegations.tierFor(account);
      const tier = combinedTier(subTier, delTier);
      const via = subTier && delTier ? 'both' : subTier ? 'subscription' : 'delegation';
      return { account, tier, via };
    }).filter(p => p.tier);
    res.json({ patrons });
  });

  app.get('/patrons/:account', (req, res) => {
    if (!patronSubs || !patronDelegations) return res.json({ account: req.params.account, tier: null });
    const subTier = patronSubs.tierFor(req.params.account);
    const delTier = patronDelegations.tierFor(req.params.account);
    res.json({ account: req.params.account, tier: combinedTier(subTier, delTier) });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

function startServer(app, port = parseInt(process.env.PORT ?? '3099', 10)) {
  return app.listen(port, '127.0.0.1', () => {
    console.log(`[hive-sidecar] HTTP server listening on 127.0.0.1:${port}`);
  });
}

module.exports = { createServer, startServer };
