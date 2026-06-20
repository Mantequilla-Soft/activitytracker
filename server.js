'use strict';

const express = require('express');

function createServer(state, snapLog) {
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
