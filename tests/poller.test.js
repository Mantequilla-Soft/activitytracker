'use strict';

const { extractAccounts } = require('../poller');

function makeBlock(operations) {
  return {
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
