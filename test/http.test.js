import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, HttpError } from '../src/http.js';

function client(responses, calls = []) {
  return new HttpClient({
    baseUrl: 'https://api.example.test/',
    token: 'secret',
    sleep: async (milliseconds) => { calls.push({ slept: milliseconds }); },
    random: () => 0,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, headers: options.headers, body: options.body });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
}

test('GET is retried on a transient status and honours Retry-After', async () => {
  const calls = [];
  const http = client([
    new Response('busy', { status: 503, headers: { 'Retry-After': '2' } }),
    Response.json({ ok: true }),
  ], calls);

  const { payload } = await http.request('GET', '/api/whoami');

  assert.deepEqual(payload, { ok: true });
  assert.equal(calls[0].url, 'https://api.example.test/api/whoami');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer secret');
  assert.deepEqual(calls[1], { slept: 2000 });
  assert.equal(calls.filter((call) => call.url).length, 2);
});

test('POST is sent once even on a 502, so a create is never duplicated', async () => {
  const calls = [];
  const http = client([new Response('bad gateway', { status: 502 })], calls);

  await assert.rejects(http.request('POST', '/api/page/example.com', { body: { h1: 'x' } }), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get('Content-Type'), 'application/json');
  assert.equal(calls[0].body, '{"h1":"x"}');
});

test('a request carrying If-Match is retried: a replay can only end in a 409', async () => {
  const calls = [];
  const http = client([new TypeError('socket hang up'), new Response('ok', { status: 200 })], calls);

  const response = await http.send('POST', '/api/x', { headers: { 'If-Match': 'rev' } });

  assert.equal(response.status, 200);
  assert.equal(calls.filter((call) => call.url).length, 2);
});

test('unexpected status raises HttpError with the parsed payload', async () => {
  const http = client([Response.json({ error: 'Page not found' }, { status: 404 })]);

  await assert.rejects(http.request('GET', '/api/page/example.com/missing'), (error) => {
    assert.equal(error.status, 404);
    assert.deepEqual(error.payload, { error: 'Page not found' });
    assert.match(error.message, /HTTP 404 \(Page not found\)/);
    return true;
  });
});
