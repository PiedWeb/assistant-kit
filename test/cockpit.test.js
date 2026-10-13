import test from 'node:test';
import assert from 'node:assert/strict';
import { CockpitClient, CockpitError, CockpitProjectClient } from '../src/cockpit.js';
import { HttpClient } from '../src/http.js';
import { cockpitProbe, connector, defineCatalog, field, probeConnector } from '../src/secrets/index.js';

const BASE = 'https://cockpit.example';
const PROJECT = '11111111-1111-4111-8111-111111111111';

function fixture(handler = () => Response.json({ ok: true }), options = {}) {
  const calls = [];
  const client = new CockpitClient({ baseUrl: BASE, token: 'test-key',
    httpOptions: { sleep: async () => {}, random: () => 0 },
    fetchImpl: async (url, init) => {
      const call = { url: new URL(url), method: init.method, headers: init.headers,
        body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      return handler(call, calls.length);
    }, ...options });
  return { client, calls };
}

test('Cockpit discovery keeps every filter, false, zero, comma lists and case-sensitive handles', async () => {
  const { client, calls } = fixture(() => Response.json({ results: [], total: 0, page: 2, pages: 1 }));
  assert.deepEqual(await client.searchInstagram({ locale: 'fr', tier: 'micro', hasUrl: false, minGrowth: 0,
    page: 2, ids: [1, 2], niche: 'été & montagne', omitted: undefined, absent: null }),
  { results: [], total: 0, page: 2, pages: 1 });
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer test-key');
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
    locale: 'fr', tier: 'micro', hasUrl: 'false', minGrowth: '0', page: '2', ids: '1,2', niche: 'été & montagne',
  });
  await client.instagramDetail('Creator.Test', { simHasUrl: 0, simPage: 3, simTier: 'nano' });
  assert.equal(calls[1].url.pathname, '/api/instagram/Creator.Test/detail');
  await client.sharedCommenters('Creator.Test', 'other', { minFollowers: 100 });
  assert.equal(calls[2].url.pathname, '/api/instagram/Creator.Test/shared/other');
  await client.request('GET', '/api/instagram/search?page=1', { query: new URLSearchParams('page=4&hasUrl=0') });
  assert.equal(calls[3].url.search, '?page=4&hasUrl=0');
  await client.request('GET', '/api/instagram/search?tag=old', { query: new URLSearchParams('tag=a&tag=b') });
  assert.deepEqual(calls.at(-1).url.searchParams.getAll('tag'), ['a', 'b']);
  await client.instagramDetail('Creator.Test ');
  assert.equal(calls.at(-1).url.pathname, '/api/instagram/Creator.Test%20/detail');
});

test('Cockpit account, discovery, administration and collector methods match the API contract', async () => {
  const { client, calls } = fixture(undefined, { allowWrites: true, token: null, headers: { 'X-Liker-Token': 'test-ingest' } });
  const routes = [
    ['scopes', [], 'GET', '/api/api-key-scopes'],
    ['projects', [], 'GET', '/api/projects'], ['createProject', [{ name: 'Test', hosts: ['example.com'] }], 'POST', '/api/projects'],
    ['communities', [], 'GET', '/api/instagram/communities'], ['tagCommunity', [7, { niche: 'outdoor' }], 'POST', '/api/instagram/communities/7/tag'],
    ['youtubeChannels', [], 'GET', '/api/youtube/channels'], ['youtubeChannel', ['UC_test'], 'GET', '/api/youtube/channels/UC_test'],
    ['youtubeVideos', [], 'GET', '/api/youtube/videos'], ['youtubeVideo', ['test-id'], 'GET', '/api/youtube/videos/test-id'],
    ['likerHealth', [], 'GET', '/api/liker/health'], ['me', [], 'GET', '/api/me'],
    ['updateMe', [{ firstName: 'Test' }], 'PATCH', '/api/me'], ['preferences', [], 'GET', '/api/me/preferences'],
    ['updatePreferences', [{ key: 'ig-list-cols', visible: { Followers: false } }], 'PATCH', '/api/me/preferences'],
    ['extension', [], 'GET', '/api/me/extension'], ['buildExtension', [], 'POST', '/api/me/extension'],
    ['passwordLink', [], 'POST', '/api/me/password-link'], ['apiKeys', [], 'GET', '/api/me/api-keys'],
    ['createApiKey', [{ name: 'Test', scopes: ['instagram:read'], projectIds: [PROJECT] }], 'POST', '/api/me/api-keys'],
    ['revokeApiKey', ['a'.repeat(64)], 'DELETE', `/api/me/api-keys/${'a'.repeat(64)}`],
    ['sudoKey', [], 'GET', '/api/me/sudo-key'], ['rotateSudoKey', [], 'POST', '/api/me/sudo-key'],
    ['extensionSelectors', [], 'GET', '/api/extension/selectors.json'],
    ['instagramToUpdate', [], 'GET', '/api/instagram/toUpdate'], ['instagramToScrape', [], 'GET', '/api/instagram/toScrape'],
    ['instagramToRefresh', [], 'GET', '/api/instagram/toRefresh'], ['postsToSnapshot', [], 'GET', '/api/instagram/posts/toSnapshot'],
    ['collectorAccount', ['Creator'], 'GET', '/api/instagram/Creator'],
    ['addCollectorAccount', ['Creator'], 'GET', '/api/instagram/add/Creator'],
    ['updateCollectorAccount', ['Creator', { followers: 100 }], 'POST', '/api/instagram/Creator'],
    ['ingestInstagramPosts', ['Creator', { posts: [] }], 'POST', '/api/instagram/Creator/posts'],
    ['classifyInstagram', [{ usernames: ['Creator'] }], 'POST', '/api/instagram/classify'],
    ['ingestYoutube', [{ channels: [], videos: [] }], 'POST', '/api/youtube/ingest'],
    ['ingestYoutubeTranscript', [{ videoId: 'test-id', segments: [] }], 'POST', '/api/youtube/transcript'],
    ['youtubeFrontier', [{ candidateVideoIds: ['test-id'], limit: 2 }], 'POST', '/api/youtube/frontier'],
    ['reportYoutubeProfileHealth', [{ profile: 'test', connected: true }], 'POST', '/api/youtube/profile-health'],
    ['reportLikerRun', [{ likes: 0 }], 'POST', '/api/liker/run'], ['reportLikerError', [{ message: 'Test' }], 'POST', '/api/liker/error'],
  ];
  for (const [method, args, verb, path] of routes) {
    await client[method](...args);
    const call = calls.at(-1);
    assert.equal(call.method, verb, method);
    assert.equal(call.url.pathname, path, method);
    assert.equal(call.headers.get('Authorization'), null);
    assert.equal(call.headers.get('X-Liker-Token'), 'test-ingest');
    if (['POST', 'PATCH'].includes(verb)) assert.deepEqual(call.body, args.at(-1), method);
  }
});

test('Cockpit boards cover settings, team, columns, contact edits, bulk actions and all note resources', async () => {
  const { client, calls } = fixture(undefined, { allowWrites: true });
  const board = client.project(PROJECT);
  assert.ok(board instanceof CockpitProjectClient);
  const routes = [
    ['info', [], 'GET', ''], ['update', [{ hosts: ['example.org'] }], 'PATCH', ''],
    ['rotateToken', [], 'POST', '/rotate-token'], ['members', [], 'GET', '/members'],
    ['addMember', [{ email: 'test@example.org', role: 'member', create: true }], 'POST', '/members'],
    ['updateMember', [4, { role: 'owner' }], 'PATCH', '/members/4'], ['removeMember', [4], 'DELETE', '/members/4'],
    ['stages', [], 'GET', '/stages'], ['createStage', [{ label: 'Test', color: 'blue' }], 'POST', '/stages'],
    ['updateStage', [3, { hidden: false, position: 0 }], 'PATCH', '/stages/3'],
    ['deleteStage', [3], 'DELETE', '/stages/3'], ['moveStage', [3, { before: 0 }], 'POST', '/stages/3/move'],
    ['products', [], 'GET', '/products'], ['createProduct', [{ name: 'Test' }], 'POST', '/products'],
    ['updateProduct', [5, { position: 0 }], 'PATCH', '/products/5'], ['deleteProduct', [5], 'DELETE', '/products/5'],
    ['moveProduct', [5, { dir: 'up' }], 'POST', '/products/5/move'], ['influencers', [], 'GET', '/influencers'],
    ['addInfluencer', [{ username: 'Creator' }], 'POST', '/influencers'],
    ['addManualInfluencer', [{ website: 'https://example.org', name: 'Test', productId: 5 }], 'POST', '/influencers/manual'],
    ['updateInfluencer', [2, { stageId: 3, addProduct: 5, tag: 'Test' }], 'PATCH', '/influencers/2'],
    ['updateContact', [2, { displayName: 'Test', postalCode: '01234' }], 'PATCH', '/influencers/2/contact'],
    ['removeInfluencer', [2], 'DELETE', '/influencers/2'], ['bulk', [{ ids: [2], action: 'stage', targetId: 3 }], 'POST', '/bulk'],
  ];
  for (const resource of ['stages', 'products', 'influencers']) {
    routes.push(['addNote', [resource, 2, { message: 'Note test' }], 'POST', `/${resource}/2/notes`],
      ['deleteNote', [resource, 2, 0], 'DELETE', `/${resource}/2/notes/0`],
      ['pinNote', [resource, 2, 0], 'POST', `/${resource}/2/notes/0/pin`]);
  }
  for (const [method, args, verb, path] of routes) {
    await board[method](...args);
    assert.equal(calls.at(-1).method, verb, method);
    assert.equal(calls.at(-1).url.pathname, `/api/projects/${PROJECT}${path}`, method);
    if (['POST', 'PATCH'].includes(verb)) {
      const data = args.at(-1);
      assert.deepEqual(calls.at(-1).body, data && typeof data === 'object' ? data : undefined, method);
    }
  }
  assert.throws(() => board.addNote('members', 2, { message: 'Test' }), /Ressource de notes/);
});

test('Cockpit supports legacy project headers and dynamic personal tokens without choosing a project implicitly', async () => {
  let key = 'first-test-key';
  const { client, calls } = fixture(undefined, { token: async () => key, headers: { 'X-Project-Id': PROJECT } });
  await client.project().info();
  assert.equal(calls[0].url.pathname, '/api/project');
  assert.equal(calls[0].headers.get('X-Project-Id'), PROJECT);
  key = 'second-test-key';
  await client.project(PROJECT).members();
  assert.equal(calls[1].headers.get('Authorization'), 'Bearer second-test-key');
  const legacy = fixture(undefined, { token: null, headers: { 'X-Project-Token': 'test-project-key' } });
  await legacy.client.project().stages();
  assert.equal(legacy.calls[0].headers.get('X-Project-Token'), 'test-project-key');
  assert.equal(legacy.calls[0].headers.get('Authorization'), null);
});

test('Cockpit refuses all mutations by default, including HEAD and encoded collector GET aliases', async () => {
  const { client, calls } = fixture();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(client.request(method, '/api/me'), { code: 'WRITES_DISABLED' });
  }
  for (const path of ['/api/instagram/Creator', '/api/instagram/add/Creator', '/api/instagram/%61dd/Creator']) {
    for (const method of ['GET', 'HEAD']) await assert.rejects(client.request(method, path), { code: 'WRITES_DISABLED' });
  }
  await assert.rejects(client.project(PROJECT).addInfluencer({ username: 'Creator' }), { code: 'WRITES_DISABLED' });
  await assert.rejects(client.exchange('POST', '/api/me'), { code: 'WRITES_DISABLED' });
  assert.equal(calls.length, 0);
  const configured = fixture(undefined, { allowWrites: 'false' });
  await assert.rejects(configured.client.updateMe({ firstName: 'Test' }), { code: 'WRITES_DISABLED' });
  assert.equal(configured.calls.length, 0);
});

test('Cockpit retries reads but never replays mutations, even with If-Match or idempotent overrides', async () => {
  const reads = fixture((call, n) => n === 1 ? new Response('Busy', { status: 503 }) : Response.json({ id: 1 }));
  assert.deepEqual(await reads.client.me(), { id: 1 });
  assert.equal(reads.calls.length, 2);
  for (const [method, path] of [['POST', '/api/projects'], ['PUT', '/api/me'], ['PATCH', '/api/me'], ['DELETE', '/api/me/api-keys/test'],
    ['GET', '/api/instagram/add/Creator'], ['HEAD', '/api/instagram/Creator']]) {
    const { client, calls } = fixture(() => new Response(null, { status: 503 }), { allowWrites: true });
    await assert.rejects(client.request(method, path, { idempotent: true, attempts: 8, headers: { 'If-Match': 'test-revision' } }), { status: 503 });
    assert.equal(calls.length, 1, `${method} ${path}`);
  }
  const network = fixture(() => { throw new Error('Offline'); }, { allowWrites: true });
  await assert.rejects(network.client.createProject({ name: 'Test' }), { code: 'NETWORK_ERROR' });
  assert.equal(network.calls.length, 1);
});

test('Cockpit preserves Markdown, CSV, ZIP bytes and accepted/no-content responses', async () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x80]);
  const { client, calls } = fixture((call) => {
    if (call.url.pathname.endsWith('/download')) return new Response(zip, { headers: { 'content-type': 'application/zip' } });
    if (call.url.pathname.endsWith('/export') || call.url.pathname.endsWith('/export.csv')) return new Response('name;postalCode\r\nTest;01234\r\n');
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    if (call.method === 'POST') return Response.json({ pending: true }, { status: 202 });
    return new Response('# API\n', { headers: { 'content-type': 'text/markdown' } });
  }, { allowWrites: true });
  assert.equal(await client.docs(), '# API\n');
  assert.equal(await client.project(PROJECT).docs(), '# API\n');
  assert.equal(await client.exportInstagram({ locale: 'fr' }), 'name;postalCode\r\nTest;01234\r\n');
  assert.equal(await client.project(PROJECT).exportCsv({ ids: [1, 2] }), 'name;postalCode\r\nTest;01234\r\n');
  assert.equal(calls.at(-1).url.search, '?ids=1%2C2');
  assert.deepEqual(await client.downloadExtension(), zip);
  assert.equal(calls.at(-1).headers.get('Accept'), 'application/zip');
  assert.deepEqual(await client.buildExtension(), { pending: true });
  assert.equal(await client.revokeApiKey('test'), null);
  const raw = await client.exchange('GET', '/api/me/extension/download');
  assert.deepEqual(raw.body, zip);
  assert.equal(raw.status, 200);
});

test('Cockpit exposes refusal status and payload, while exchange leaves HTTP refusals to the caller', async () => {
  for (const status of [401, 403, 404, 409, 422]) {
    const { client, calls } = fixture(() => Response.json({ error: 'Test refusal' }, { status }));
    await assert.rejects(client.me(), (error) => error instanceof CockpitError && error.status === status && error.payload.error === 'Test refusal');
    const response = await client.exchange('GET', '/api/me');
    assert.equal(response.status, status);
    assert.equal(response.ok, false);
    assert.deepEqual(response.json, { error: 'Test refusal' });
    assert.equal(calls.length, 2);
    assert.deepEqual(await client.request('GET', '/api/me', { expectedStatus: [status] }), { error: 'Test refusal' });
  }
});

test('Cockpit signed password links keep their proof, omit bearer auth and exclude proof/content from audit and messages', async () => {
  const audit = [];
  const signed = `${BASE}/api/set-password?user=1&_hash=test-proof&expires=123`;
  const { client, calls } = fixture(() => Response.json({ ok: true }), { allowWrites: true, audit: { record: (entry) => audit.push(entry) } });
  await client.passwordTarget(signed);
  await client.setPassword(signed, { password: 'test-password', passwordConfirm: 'test-password' });
  assert.equal(calls[1].headers.get('Authorization'), null);
  assert.equal(calls[1].url.searchParams.get('_hash'), 'test-proof');
  assert.equal(calls[1].body.password, 'test-password');
  assert.deepEqual(audit, [{ connector: 'cockpit', method: 'POST', path: '/api/set-password', status: 200, ok: true }]);
  assert.throws(() => client.setPassword(`${BASE}/api/me`, {}), /Lien signé/);
  const denied = fixture(() => Response.json({ error: 'Expired' }, { status: 401 }), { allowWrites: true });
  await assert.rejects(denied.client.setPassword(signed, {}), (error) => error.status === 401 && !error.message.includes('test-proof'));
  const offlineAudit = [];
  const offline = fixture(() => { throw new Error('Offline'); }, { allowWrites: true, audit: (entry) => offlineAudit.push(entry) });
  await assert.rejects(offline.client.setPassword(signed, {}), (error) => error.code === 'NETWORK_ERROR' && !error.message.includes('test-proof'));
  assert.deepEqual(offlineAudit, [{ connector: 'cockpit', method: 'POST', path: '/api/set-password', status: null, ok: false }]);
});

test('Cockpit refuses cross-origin URLs, traversal outside the API or project, and invalid path segments', async () => {
  const { client, calls } = fixture(undefined, { allowWrites: true });
  for (const path of ['https://other.example/api/me', '/app/account', '/api/../app', '/apiary', '/api/me#fragment',
    `${BASE}/api/instagram/add%2Ftest`, `${BASE}/api//instagram/test`, `https://user:pass@cockpit.example/api/me`]) {
    await assert.rejects(client.request('GET', path));
  }
  assert.throws(() => client.project(PROJECT).request('GET', '/../other-project/members'), /rester dans ce projet/);
  assert.throws(() => client.project(PROJECT).request('GET', 'members'), /commencer par/);
  assert.throws(() => client.project('..'), /Identifiant Cockpit/);
  assert.throws(() => client.instagramDetail(''), /Identifiant Cockpit/);
  await assert.rejects(client.request('TRACE', '/api'), /Méthode Cockpit/);
  assert.equal(calls.length, 0);
  assert.throws(() => new CockpitClient(), /Adresse.*manquante/);
  assert.throws(() => new CockpitClient({ baseUrl: 'ftp://example.org' }), /Adresse.*invalide/);
});

test('Cockpit protects every legacy secret header on redirects, also with an injected HTTP client', async () => {
  for (const header of ['X-Project-Token', 'X-Discovery-Token', 'X-Api-Token', 'X-Liker-Token']) {
    const seen = [];
    const http = new HttpClient({ baseUrl: BASE, headers: { [header]: 'test-key' },
      fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response(null, { status: 302, headers: { location: 'https://other.example/api/me' } }); } });
    const client = new CockpitClient({ http });
    await assert.rejects(client.scopes(), { code: 'CROSS_ORIGIN_REDIRECT' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.redirect, 'manual');
  }
});

test('Cockpit vault probe works with a write-only key, configurable fields and safe status messages', async () => {
  const catalog = defineCatalog({ cockpit: connector('Cockpit', 'API', [field('TEST_TOKEN', 'Jeton')], {
    probe: cockpitProbe({ baseUrl: () => BASE, tokenField: 'TEST_TOKEN' }),
  }) });
  const calls = [];
  const result = await probeConnector(catalog, 'cockpit', { TEST_TOKEN: 'test-key' }, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return Response.json({ features: { instagram: 'Instagram' }, scopes: ['instagram:read'], writeImpliesRead: false });
  } });
  assert.equal(result.status, 'ok');
  assert.equal(calls[0].url, `${BASE}/api/api-key-scopes`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(result), /test-key|cockpit\.example/);
  const denied = await probeConnector(catalog, 'cockpit', { TEST_TOKEN: 'test-key' },
    { fetchImpl: async () => Response.json({ error: 'test-key' }, { status: 403 }) });
  assert.equal(denied.status, 'failed');
  assert.doesNotMatch(JSON.stringify(denied), /test-key/);
});
