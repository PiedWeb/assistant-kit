import test from 'node:test';
import assert from 'node:assert/strict';
import { CadrankClient, encodeKeyword, parseCsv } from '../src/cadrank.js';
import { parseArguments, positiveInteger } from '../src/cli.js';

test('Cadrank sends its key, retries transient errors and parses CSV', async () => {
  const calls = [];
  const responses = [new Response('busy', { status: 503 }), new Response('﻿keyword,volume\n"a, b",10\n', { status: 200 })];
  const client = new CadrankClient({
    apiKey: 'key',
    sleep: async () => undefined,
    fetchImpl: async (url, options) => {
      calls.push({ url, key: options.headers['X-AUTH-TOKEN'] });
      return responses.shift();
    },
  });

  assert.deepEqual(await client.related('ski de rando'), [{ keyword: 'a, b', volume: '10' }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { url: 'https://cadrank.piedweb.com/_api/search/related/ski+de+rando', key: 'key' });
  assert.equal(encodeKeyword(' été  2026 '), '%C3%A9t%C3%A9+2026');
  assert.deepEqual(parseCsv(''), []);
});

test('CLI arguments: flags, inline values and --', () => {
  assert.deepEqual(parseArguments(['pull', 'a.com', '--no-publish', '--code', '302', '--alt=Un texte', '--', '--literal']), {
    positionals: ['pull', 'a.com', '--literal'],
    flags: { 'no-publish': true, code: '302', alt: 'Un texte' },
  });
  assert.equal(positiveInteger('25'), 25);
  assert.equal(positiveInteger(undefined, 5), 5);
  assert.throws(() => positiveInteger('2x'), /Entier/);
});
