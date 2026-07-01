'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadJsonState, saveJsonState } = require('../state-store');

function tmpFile(name) {
  return path.join(os.tmpdir(), `state-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

describe('loadJsonState', () => {
  test('returns null for a missing file, does not throw', () => {
    const filePath = tmpFile('missing.json');
    expect(loadJsonState(filePath)).toBeNull();
  });

  test('returns null for a corrupt (non-JSON) file, does not throw', () => {
    const filePath = tmpFile('corrupt.json');
    fs.writeFileSync(filePath, 'not valid json{{{');
    try {
      expect(loadJsonState(filePath)).toBeNull();
    } finally {
      fs.unlinkSync(filePath);
    }
  });
});

describe('saveJsonState + loadJsonState', () => {
  test('round-trips the same data', () => {
    const filePath = tmpFile('roundtrip.json');
    const data = { alice: { amount: 5, lastSeen: 12345 } };
    try {
      saveJsonState(filePath, data);
      expect(loadJsonState(filePath)).toEqual(data);
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  test('creates missing parent directories', () => {
    const dir = tmpFile('nested-dir');
    const filePath = path.join(dir, 'sub', 'state.json');
    try {
      saveJsonState(filePath, { ok: true });
      expect(loadJsonState(filePath)).toEqual({ ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
