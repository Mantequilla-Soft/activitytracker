'use strict';

const { createHiveClient } = require('./hive-client');
const { RollingWindow } = require('./rolling-window');
const { SnapEventLog } = require('./snap-window');
const { AuthorTally } = require('./author-tally');
const { coldStart, startPollLoop } = require('./poller');
const { createServer, startServer } = require('./server');

const state = {
  warming: true,
  count: 0,
  updatedAt: new Date().toISOString(),
  lastProcessedBlock: 0,
};

async function main() {
  const window = new RollingWindow();
  const snapLog = new SnapEventLog();
  const authorTally = new AuthorTally();
  const app = createServer(state, snapLog, authorTally);
  startServer(app);

  const client = await createHiveClient();

  state.lastProcessedBlock = await coldStart(client, window, snapLog, authorTally);
  state.count = window.size;
  state.updatedAt = new Date().toISOString();
  state.warming = false;

  startPollLoop(client, window, state, snapLog, authorTally);

  // Keep state.count in sync with window after each tick
  const origEvict = window.evict.bind(window);
  window.evict = function (...args) {
    origEvict(...args);
    state.count = window.size;
  };
}

main().catch(err => {
  console.error('[hive-sidecar] Fatal startup error:', err);
  process.exit(1);
});
