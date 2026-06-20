'use strict';

const { extractAccounts, extractSnapTimestamps } = require('../poller');

function makeBlock(operations, timestamp = '2024-01-01T00:00:00') {
  return {
    timestamp,
    transactions: [{ operations }],
  };
}

describe('extractAccounts', () => {
  test('vote operation yields voter and author', () => {
    const block = makeBlock([['vote', { voter: 'alice', author: 'bob', permlink: 'test' }]]);
    const accounts = extractAccounts(block);
    expect(accounts.has('alice')).toBe(true);
    expect(accounts.has('bob')).toBe(true);
    expect(accounts.size).toBe(2);
  });

  test('transfer operation yields from and to', () => {
    const block = makeBlock([['transfer', { from: 'alice', to: 'charlie', amount: '1.000 HIVE', memo: '' }]]);
    const accounts = extractAccounts(block);
    expect(accounts.has('alice')).toBe(true);
    expect(accounts.has('charlie')).toBe(true);
  });

  test('comment operation yields author', () => {
    const block = makeBlock([['comment', { author: 'dave', permlink: 'my-post', body: 'hello' }]]);
    const accounts = extractAccounts(block);
    expect(accounts.has('dave')).toBe(true);
  });

  test('unknown operation type does not throw', () => {
    const block = makeBlock([['mystery_op_xyz', { weird_field: 'value' }]]);
    expect(() => extractAccounts(block)).not.toThrow();
  });

  test('block with 0 transactions yields 0 accounts', () => {
    const block = { transactions: [] };
    const accounts = extractAccounts(block);
    expect(accounts.size).toBe(0);
  });

  test('duplicate accounts across multiple operations are deduplicated', () => {
    const block = makeBlock([
      ['vote', { voter: 'alice', author: 'bob' }],
      ['transfer', { from: 'alice', to: 'bob' }],
    ]);
    const accounts = extractAccounts(block);
    expect(accounts.size).toBe(2);
    expect(accounts.has('alice')).toBe(true);
    expect(accounts.has('bob')).toBe(true);
  });

  test('null operation does not throw', () => {
    const block = makeBlock([null]);
    expect(() => extractAccounts(block)).not.toThrow();
  });

  test('malformed operation (not array, no value) does not throw', () => {
    const block = makeBlock([{ some: 'garbage' }]);
    expect(() => extractAccounts(block)).not.toThrow();
  });
});

describe('extractSnapTimestamps', () => {
  test('a comment with parent_author: "peak.snaps" yields one event', () => {
    const block = makeBlock([
      ['comment', { parent_author: 'peak.snaps', permlink: 'my-snap', author: 'alice', body: 'hi' }],
    ]);
    const events = extractSnapTimestamps(block);
    expect(events.length).toBe(1);
    expect(events[0].key).toBe('alice/my-snap');
  });

  test('a comment with a different parent_author yields no events', () => {
    const block = makeBlock([
      ['comment', { parent_author: 'someone-else', permlink: 'my-snap', author: 'alice', body: 'hi' }],
    ]);
    expect(extractSnapTimestamps(block).length).toBe(0);
  });

  test('a non-comment op is ignored even with an author field equal to peak.snaps', () => {
    const block = makeBlock([
      ['vote', { voter: 'alice', author: 'peak.snaps', permlink: 'container-post' }],
    ]);
    expect(extractSnapTimestamps(block).length).toBe(0);
  });

  test('a block timestamp without a trailing Z is parsed as UTC', () => {
    const timestamp = '2024-01-01T00:00:00';
    const block = makeBlock(
      [['comment', { parent_author: 'peak.snaps', permlink: 'my-snap', author: 'alice' }]],
      timestamp
    );
    const events = extractSnapTimestamps(block);
    expect(events[0].timestamp).toBe(Date.parse(`${timestamp}Z`));
  });

  test('a matching comment sets events[0].author to the comment author', () => {
    const block = makeBlock([
      ['comment', { parent_author: 'peak.snaps', permlink: 'my-snap', author: 'alice', body: 'hi' }],
    ]);
    const events = extractSnapTimestamps(block);
    expect(events[0].author).toBe('alice');
  });

  test('a matching comment with no string author field sets events[0].author to null', () => {
    const block = makeBlock([
      ['comment', { parent_author: 'peak.snaps', permlink: 'my-snap', body: 'hi' }],
    ]);
    const events = extractSnapTimestamps(block);
    expect(events[0].author).toBeNull();
  });

  test('an edited snap (same author/permlink re-broadcast) yields two events with identical keys', () => {
    const block = makeBlock([
      ['comment', { parent_author: 'peak.snaps', permlink: 'my-snap', author: 'alice', body: 'original' }],
      ['comment', { parent_author: 'peak.snaps', permlink: 'my-snap', author: 'alice', body: 'edited' }],
    ]);
    const events = extractSnapTimestamps(block);
    expect(events.length).toBe(2);
    expect(events[0].key).toBe('alice/my-snap');
    expect(events[1].key).toBe('alice/my-snap');
  });
});
