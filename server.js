'use strict';

const express = require('express');

function createServer(state) {
  const app = express();

  app.get('/active-users', (req, res) => {
    res.json({
      count: state.warming ? null : state.count,
      warming: state.warming,
      updatedAt: state.updatedAt,
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
