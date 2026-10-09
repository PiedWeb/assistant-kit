import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, HttpError } from '../src/http.js';

function client(responses, calls = [], options = {}) {
  return new HttpClient({
    baseUrl: 'https://api.example.test/',
    token: 'secret',
    sleep: async (milliseconds) => { calls.push({ slept: milliseconds }); },
    random: () => 0,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(url, init) : next;
    },
    ...options,
  });
}

const requests = (calls) => calls.filter((call) => call.url);

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
  assert.equal(requests(calls).length, 2);
});

test('POST is sent once even on a 502, so a create is never duplicated', async () => {
  const calls = [];
  const http = client([new Response('bad gateway', { status: 502 })], calls);

  await assert.rejects(http.request('POST', '/api/page/example.com', { body: { h1: 'x' }, attempts: 5 }), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get('Content-Type'), 'application/json');
  assert.equal(calls[0].body, '{"h1":"x"}');
});

test('DELETE and PATCH without If-Match are never replayed after a network failure', async () => {
  for (const method of ['DELETE', 'PATCH']) {
    const calls = [];
    const http = client([new TypeError('socket hang up'), new Response(null, { status: 204 })], calls);
    await assert.rejects(http.send(method, '/api/media/a.jpg'), /échec réseau après 1 tentative/);
    assert.equal(requests(calls).length, 1);
  }
});

test('a request carrying If-Match is retried: a replay can only end in a 409', async () => {
  const calls = [];
  const http = client([new TypeError('socket hang up'), new Response('ok', { status: 200 })], calls);

  const response = await http.send('POST', '/api/x', { headers: { 'If-Match': 'rev' } });

  assert.equal(response.status, 200);
  assert.equal(requests(calls).length, 2);
});

test('per-call attempts and retryStatuses', async () => {
  const once = [];
  const single = client([new Response('busy', { status: 503 }), Response.json({})], once);
  assert.equal((await single.send('GET', '/a', { attempts: 1 })).status, 503);
  assert.equal(requests(once).length, 1);

  const custom = [];
  const http = client([new Response('locked', { status: 423 }), new Response('ok')], custom);
  assert.equal((await http.send('GET', '/a', { retryStatuses: [423] })).status, 200);
  assert.equal(requests(custom).length, 2);

  const ignored = [];
  const plain = client([new Response('busy', { status: 503 })], ignored, { retryStatuses: [] });
  assert.equal((await plain.send('GET', '/a')).status, 503);
  assert.equal(requests(ignored).length, 1);
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

test('a URLSearchParams body is sent as a form, not as "{}"', async () => {
  const calls = [];
  const http = client([new Response('ok')], calls);

  await http.send('POST', '/form', { body: new URLSearchParams({ reset: '1', name: 'a b' }) });

  assert.equal(calls[0].headers.get('Content-Type'), 'application/x-www-form-urlencoded;charset=UTF-8');
  assert.equal(calls[0].body, 'reset=1&name=a+b');
});

test('a token function is called on every request, sync or async', async () => {
  let issued = 0;
  for (const token of [() => `t${++issued}`, async () => `t${++issued}`]) {
    const calls = [];
    const http = client([new Response('ok'), new Response('ok')], calls, { token });
    await http.send('GET', '/a');
    await http.send('GET', '/b');
    assert.deepEqual(requests(calls).map((call) => call.headers.get('Authorization')), [`Bearer t${issued - 1}`, `Bearer t${issued}`]);
  }
  const anonymous = [];
  await client([new Response('ok')], anonymous, { token: () => 'x' }).send('GET', '/a', { auth: false });
  assert.equal(anonymous[0].headers.has('Authorization'), false);
});

test('a credential follows a same-origin redirect and never leaves its origin', async () => {
  const calls = [];
  const http = client([
    new Response(null, { status: 302, headers: { Location: '/moved' } }),
    new Response('here'),
  ], calls);
  const response = await http.send('GET', '/api/content/snapshot.tar.gz', { headers: { 'X-Pushword-Snapshot-Key': 'k' } });
  assert.equal(await response.text(), 'here');
  assert.deepEqual(requests(calls).map((call) => [call.url, call.redirect]), [
    ['https://api.example.test/api/content/snapshot.tar.gz', 'manual'],
    ['https://api.example.test/moved', 'manual'],
  ]);
  assert.equal(calls[1].headers.get('X-Pushword-Snapshot-Key'), 'k');

  for (const headers of [{}, { 'X-Pushword-Snapshot-Key': 'k' }, { 'X-AUTH-TOKEN': 'k' }]) {
    const leaked = [];
    const guarded = client([
      new Response(null, { status: 301, headers: { Location: 'https://cdn.elsewhere.test/a.tar.gz' } }),
      new Response('stolen'),
    ], leaked, { token: Object.keys(headers).length ? null : 'secret' });
    await assert.rejects(guarded.send('GET', '/a', { headers }), (error) => {
      assert.equal(error.code, 'CROSS_ORIGIN_REDIRECT');
      assert.equal(error.status, 301);
      assert.match(error.message, /redirection vers https:\/\/cdn\.elsewhere\.test refusée/);
      return true;
    });
    assert.equal(requests(leaked).length, 1);
  }
});

test('redirects: https to http is another origin, five hops at most, 303 turns a POST into a GET', async () => {
  const downgrade = client([new Response(null, { status: 307, headers: { Location: 'http://api.example.test/a' } })]);
  await assert.rejects(downgrade.send('GET', '/a'), /redirection vers http:\/\/api\.example\.test refusée/);

  const loop = Array.from({ length: 7 }, () => new Response(null, { status: 302, headers: { Location: '/again' } }));
  await assert.rejects(client(loop).send('GET', '/a'), /plus de 5 redirections/);

  const calls = [];
  const http = client([new Response(null, { status: 303, headers: { Location: '/result' } }), new Response('done')], calls);
  await http.send('POST', '/form', { body: { a: 1 } });
  assert.deepEqual(requests(calls).map((call) => [call.method, call.body, call.headers.get('Content-Type')]), [
    ['POST', '{"a":1}', 'application/json'],
    ['GET', undefined, null],
  ]);

  const open = [];
  await client([new Response('ok')], open, { token: null }).send('GET', '/public');
  assert.equal(open[0].redirect, 'follow');
});

test('exchange returns status, headers, text and json without throwing on HTTP status', async () => {
  const http = client([
    Response.json({ error: 'nope' }, { status: 404, headers: { 'X-Request-Id': 'r1' } }),
    new Response('<html>proxy</html>', { status: 502 }),
  ], [], { attempts: 1 });

  const missing = await http.exchange('GET', '/api/x');
  assert.equal(missing.status, 404);
  assert.equal(missing.ok, false);
  assert.equal(missing.headers['x-request-id'], 'r1');
  assert.deepEqual(missing.json, { error: 'nope' });
  assert.equal(missing.text, '{"error":"nope"}');

  const proxy = await http.exchange('GET', '/api/y');
  assert.equal(proxy.json, undefined);
  assert.equal(proxy.text, '<html>proxy</html>');

  const down = client([new TypeError('reset'), new TypeError('reset')], [], { attempts: 2 });
  await assert.rejects(down.exchange('GET', '/a'), (error) => {
    assert.match(error.message, /échec réseau après 2 tentative/);
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.cause.message, 'reset');
    return true;
  });
});

test('absolute URLs: same origin only with a baseUrl, any without one', async () => {
  const calls = [];
  const http = client([new Response('ok')], calls);
  await http.send('GET', 'https://api.example.test/other');
  assert.equal(calls[0].url, 'https://api.example.test/other');
  await assert.rejects(http.send('GET', 'https://evil.example.test/steal'), /n’est pas l’origine de ce client/);
  await assert.rejects(http.send('GET', 'file:///etc/passwd'), /protocole file:/);

  const free = [];
  const bare = client([new Response('ok')], free, { baseUrl: '' });
  await bare.send('GET', 'https://anywhere.example.test/a');
  assert.equal(free[0].url, 'https://anywhere.example.test/a');
  await assert.rejects(bare.send('GET', '/relative'), /sans baseUrl/);
});
