'use strict';

const express = require('express');
const { hydrateItems, FEED_PAGE_LIMIT_DEFAULT, FEED_PAGE_LIMIT_MAX } = require('./feed-index');

function combinedTier(subTier, delTier) {
  const RANK = { 'snap-master': 3, snapian: 2, snaperino: 1 };
  const subRank = RANK[subTier] ?? 0;
  const delRank = RANK[delTier] ?? 0;
  if (subRank === 0 && delRank === 0) return null;
  return subRank >= delRank ? subTier : delTier;
}

function createServer(state, snapLog, authorTally, patronSubs, patronDelegations, feedIndex, client) {
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

  app.get('/feed', async (req, res) => {
    if (!feedIndex || !client) return res.json({ items: [], hasMore: false });
    if (state.feedWarming) return res.json({ items: [], hasMore: true });

    const before = req.query.before ? String(req.query.before) : undefined;
    const requested = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(requested, FEED_PAGE_LIMIT_MAX))
      : FEED_PAGE_LIMIT_DEFAULT;

    try {
      const { items: pointers, hasMore } = await feedIndex.getPage(client, { before, limit });
      const items = await hydrateItems(client, pointers);
      res.json({ items, hasMore });
    } catch (err) {
      console.log(`[hive-sidecar] feed: ERROR /feed request failed — ${err.message}`);
      res.status(502).json({ items: [], hasMore: false });
    }
  });

  app.get('/feed/new-since', (req, res) => {
    const sinceRaw = req.query.since;
    const since = sinceRaw && /^\d+$/.test(String(sinceRaw))
      ? parseInt(sinceRaw, 10)
      : Date.parse(String(sinceRaw ?? ''));

    if (!sinceRaw || !Number.isFinite(since)) {
      return res.status(400).json({ error: 'since query param required (epoch ms or ISO-8601 timestamp)' });
    }

    const count = state.feedWarming || !feedIndex ? 0 : feedIndex.countSince(since);
    const latest = state.feedWarming || !feedIndex ? null : feedIndex.newestIndexed;
    res.json({
      count,
      latestTimestamp: latest,
      serverTime: new Date().toISOString(),
      warming: state.feedWarming ?? true,
    });
  });

  app.get('/health', (req, res) => {
    const health = { status: 'ok' };
    if (feedIndex && !state.feedWarming) {
      health.feedIndex = {
        snapContainers: feedIndex.containerCount('snap'),
        waveContainers: feedIndex.containerCount('wave'),
        oldestIndexed: feedIndex.oldestIndexed,
        newestIndexed: feedIndex.newestIndexed,
      };
    }
    res.json(health);
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
