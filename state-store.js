'use strict';

const fs = require('fs');
const path = require('path');

function loadJsonState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.log(`[hive-sidecar] state: failed to load ${filePath} — ${err.message}`);
    return null;
  }
}

function saveJsonState(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, filePath); // atomic on the same filesystem — no half-written file on crash
  } catch (err) {
    console.log(`[hive-sidecar] state: failed to save ${filePath} — ${err.message}`);
  }
}

module.exports = { loadJsonState, saveJsonState };
