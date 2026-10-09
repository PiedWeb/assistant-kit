import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuditLog } from '../src/audit.js';
import { CadrankError, NETLINK_FILTER, flattenCrawls, toFloat } from '../src/cadrank.js';
import { CadrankClient, encodeKeyword, parseCsv } from '../src/cadrank.js';
import { parseArguments, positiveInteger } from '../src/cli.js';

test('Cadrank sends its key, retries transient errors and parses CSV', async () => {
  const calls = [];
  const responses = [new Response('busy', { status: 503 }), new Response('﻿keyword,volume\n"a, b",10\n', { status: 200 })];
  const client = new CadrankClient({
    apiKey: 'key',
    sleep: async () => undefined,
    fetchImpl: async (url, options) => {
      calls.push({ url, key: new Headers(options.headers).get('X-AUTH-TOKEN') });
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

function cadrank(routes, options = {}) {
  const calls = [];
  const client = new CadrankClient({
    apiKey: 'key',
    sleep: async () => undefined,
    fetchImpl: async (url, init) => {
      const { pathname } = new URL(url);
      calls.push({ url, method: init.method, headers: new Headers(init.headers), body: init.body });
      const handler = routes[`${init.method} ${decodeURIComponent(pathname)}`];
      if (!handler) return new Response('not found', { status: 404 });
      return typeof handler === 'function' ? handler() : handler.clone();
    },
    ...options,
  });
  return { client, calls };
}

const PROJECTS = [
  { id: 1, name: 'Site', crawls: [
    { host: 'www.example.com', hashId: 'Abc', name: 'principal' },
    { host: 'www.example.com', hashId: 'Def', name: 'vide' },
    { startUrl: 'blog.example.org/fr/', hashId: 'Ghi' },
    null,
  ] },
  { id: 2, name: 'Autre', crawls: [{ startUrl: 'https://Shop.Example.net:8443/x', hashId: 'Jkl' }, { startUrl: 'https://' }] },
  'junk',
];

test('Cadrank memoises projects until refresh() and refuses an ambiguous crawl', async () => {
  const { client, calls } = cadrank({ 'GET /_api/projects': () => Response.json({ projects: PROJECTS }) });

  assert.equal((await client.crawl('blog.example.org')).crawlId, 'Ghi');
  assert.equal((await client.crawl('https://shop.example.net/')).host, 'shop.example.net');
  assert.equal((await client.crawl('Def')).name, 'vide');
  await assert.rejects(client.crawl('example.com'), (error) => {
    assert.ok(error instanceof CadrankError);
    assert.match(error.message, /« example\.com » est crawlé 2 fois sur l’instance fr : Abc \(principal\), Def \(vide\)/);
    return true;
  });
  await assert.rejects(client.crawl('absent.test'), /Aucun site suivi ne correspond à « absent\.test » sur l’instance fr\. Suivis ici : blog\.example\.org, example\.com, shop\.example\.net\./);
  assert.equal(calls.length, 1);

  await client.crawls({ refresh: true });
  client.refresh();
  await client.projects();
  assert.equal(calls.length, 3);
});

test('flattenCrawls tolerates a startUrl without scheme and malformed entries; toFloat reads Cadrank figures', () => {
  assert.deepEqual(flattenCrawls(PROJECTS).map((crawl) => [crawl.host, crawl.domain, crawl.crawlId]), [
    ['www.example.com', 'example.com', 'Abc'],
    ['www.example.com', 'example.com', 'Def'],
    ['blog.example.org', 'blog.example.org', 'Ghi'],
    ['shop.example.net', 'shop.example.net', 'Jkl'],
  ]);
  assert.deepEqual(flattenCrawls(null), []);
  assert.equal(toFloat('1 200'), 1200);
  assert.equal(toFloat('3,4'), 3.4);
  assert.equal(toFloat('1\u202f000\u00a0'), 1000);
  assert.equal(toFloat('n/a', null), null);
  assert.equal(toFloat('', null), null);
  assert.equal(toFloat(Number.NaN), 0);
});

test('Cadrank errors name the instance and the cause; filters reach the path', async () => {
  const { client, calls } = cadrank({
    'GET /_api/projects': () => Response.json([{ id: 1, crawls: [{ host: 'www.example.com', hashId: 'Abc' }] }]),
    'GET /_api/urlSearchData/www.example.com/(where:x)': () => new Response('url\n/a\n'),
    [`GET /_api/crawler/Abc/exportCsv/${decodeURIComponent(NETLINK_FILTER)}`]: () => new Response('url\n'),
    'GET /_api/searchForUrl/https://denied.test/': () => new Response('Invalid key', { status: 403 }),
  }, { instance: 'us', baseUrl: 'https://cadrank.example.test' });

  assert.deepEqual(await client.mapping('example.com', { filter: '(where:x)' }), [{ url: '/a' }]);
  await client.crawlExport('Abc');
  assert.ok(calls.at(-1).url.endsWith(`/exportCsv/${NETLINK_FILTER}?last`));
  await assert.rejects(client.keywordsForUrl('https://denied.test/'), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /^Cadrank us : HTTP 403 sur searchForUrl\/.* \(Invalid key\)\. Clé absente ou invalide pour l’instance us/);
    return true;
  });
  await assert.rejects(client.related('inconnu'), /HTTP 404 .*inconnu de l’instance us/);
  assert.throws(() => new CadrankClient({ instance: 'xx' }), /Instance Cadrank inconnue : xx/);
  assert.equal(new CadrankClient({ instance: 'staging', baseUrl: 'https://cadrank.example.test/' }).baseUrl, 'https://cadrank.example.test');
  assert.equal(String(client), 'CadrankClient(instance=us, baseUrl=https://cadrank.example.test)');
  await assert.rejects(new CadrankClient({ fetchImpl: async () => new Response('[]') }).projects(), /Clé absente pour Cadrank fr/);
});

test('Cadrank key never follows a redirect to another origin', async () => {
  const { client, calls } = cadrank({
    'GET /_api/projects': () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test/projects' } }),
  });
  await assert.rejects(client.projects(), /redirection vers https:\/\/elsewhere\.test refusée/);
  assert.equal(calls.length, 1);
});

test('launchCrawl needs allowWrites, posts a form once and audits without the key', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-kit-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const audit = createAuditLog(path.join(directory, 'logs', 'cadrank.jsonl'));

  const readOnly = cadrank({});
  await assert.rejects(readOnly.client.launchCrawl('Abc'), /lecture seule.*allowWrites: true/);
  assert.equal(readOnly.calls.length, 0);

  const statuses = [Response.json({ hashId: 'New', started: true }, { status: 202 }), new Response('busy', { status: 409 }), new Response('bad gateway', { status: 502 })];
  const { client, calls } = cadrank({ 'POST /_api/crawler/Abc/extract': () => statuses.shift() }, { allowWrites: true, audit, apiKey: 'cadrank-secret-value' });

  assert.deepEqual(await client.launchCrawl('Abc', { force: true, limit: 500 }), { hashId: 'New', started: true });
  assert.equal(calls[0].headers.get('Content-Type'), 'application/x-www-form-urlencoded;charset=UTF-8');
  assert.equal(calls[0].body, 'force=1&limit=500');
  await assert.rejects(client.launchCrawl('Abc'), /HTTP 409 .*fils d’extraction de Cadrank sont tous occupés/);
  await assert.rejects(client.launchCrawl('Abc'), /HTTP 502/);
  assert.equal(calls.length, 3);
  await assert.rejects(client.post('crawler', { url: 'x' }), /liste fermée \(WRITABLE\)/);

  const entries = audit.read();
  assert.deepEqual(entries.map((entry) => [entry.path, entry.status, entry.ok, entry.params]), [
    ['crawler/Abc/extract', 202, true, { force: '1', limit: '500' }],
    ['crawler/Abc/extract', 409, false, {}],
    ['crawler/Abc/extract', 502, false, {}],
  ]);
  assert.equal(calls[0].headers.get('X-AUTH-TOKEN'), 'cadrank-secret-value');
  assert.ok(!fs.readFileSync(audit.file, 'utf8').includes('cadrank-secret-value'));
});
