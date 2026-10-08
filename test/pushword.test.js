import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import {
  ContentWorkspace,
  PushwordClient,
  extractRevision,
  hookFilePaths,
  pagesFromHookPayload,
  runSyncHook,
} from '../src/pushword/index.js';

const HOST = 'example.com';

function temporaryDirectory(t, prefix = 'assistant-kit-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function snapshotArchive(t, files) {
  const source = temporaryDirectory(t, 'assistant-kit-archive-');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.writeFileSync(path.join(source, name), content);
  }
  const file = path.join(source, '..', `${path.basename(source)}.tar.gz`);
  await tar.c({ gzip: true, file, cwd: source }, Object.keys(files));
  t.after(() => fs.rmSync(file, { force: true }));
  return fs.readFileSync(file);
}

/** Fake server: `routes` maps "METHOD path" to a handler returning a Response. */
function fakeServer(routes) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const { pathname, search } = new URL(url);
    const body = typeof options.body === 'string' ? options.body : options.body;
    requests.push({ method: options.method, path: pathname + search, headers: options.headers, body });
    const handler = routes[`${options.method} ${pathname}`];
    if (!handler) return new Response('not found', { status: 404 });
    return handler({ body, headers: options.headers, search });
  };
  return { requests, fetchImpl };
}

function workspaceFor(t, routes, options = {}) {
  const root = temporaryDirectory(t);
  const server = fakeServer(routes);
  const client = new PushwordClient({ baseUrl: 'https://edit.example.test', token: 'api-token', fetchImpl: server.fetchImpl });
  client.http.sleep = async () => undefined;
  const logs = [];
  const workspace = new ContentWorkspace({ root, client, hosts: [HOST], log: (line) => logs.push(line), ...options });
  return { root, workspace, server, logs };
}

function page(revision, body = 'Body') {
  return `---\nh1: Title\nrevision: ${revision} # read only\n---\n\n${body}\n`;
}

test('pull installs editorial files only, marks the pull and refuses to wipe unsynced edits', async (t) => {
  const archive = await snapshotArchive(t, {
    'page.md': page('r1'),
    'blog/post.md': page('r2'),
    'redirection.csv': 'from,to\n',
    'index.en.csv': 'slug\n',
    'conversation.csv': 'private customer data\n',
  });
  const { root, workspace, server } = workspaceFor(t, {
    'GET /api/content/snapshot.tar.gz': () => new Response(archive, { status: 200 }),
  });

  await workspace.pull();

  const content = path.join(root, 'content', HOST);
  assert.equal(fs.readFileSync(path.join(content, 'page.md'), 'utf8'), page('r1'));
  assert.ok(fs.existsSync(path.join(content, 'blog', 'post.md')));
  assert.ok(fs.existsSync(path.join(content, 'redirection.csv')));
  assert.ok(fs.existsSync(path.join(content, 'index.en.csv')));
  assert.equal(fs.existsSync(path.join(content, 'conversation.csv')), false);
  assert.ok(fs.existsSync(path.join(root, '.claude', '.last-pull')));
  assert.equal(server.requests[0].path, `/api/content/snapshot.tar.gz?host=${HOST}`);
  assert.equal(server.requests[0].headers.get('Authorization'), 'Bearer api-token');

  fs.appendFileSync(path.join(content, 'page.md'), 'local edit\n');
  await assert.rejects(workspace.pull(), /non synchronisées/);
});

test('an empty snapshot keeps the previous mirror', async (t) => {
  const good = await snapshotArchive(t, { 'page.md': page('r1') });
  const empty = await snapshotArchive(t, { 'conversation.csv': 'x\n' });
  const archives = [good, empty];
  const { root, workspace } = workspaceFor(t, {
    'GET /api/content/snapshot.tar.gz': () => new Response(archives.shift(), { status: 200 }),
  });

  await workspace.pull();
  await assert.rejects(workspace.pull(), /vide/);

  assert.equal(fs.readFileSync(path.join(root, 'content', HOST, 'page.md'), 'utf8'), page('r1'));
});

test('sync sends If-Match, writes the canonical text back and publishes the page', async (t) => {
  const { root, workspace, server } = workspaceFor(t, {
    'PUT /api/content/page/example.com/blog/post': ({ body }) => new Response(body.replace('r1', 'r2'), {
      status: 200, headers: { 'Content-Type': 'text/markdown' },
    }),
    'POST /api/static/example.com/blog/post': () => Response.json({ host: HOST, slug: 'blog/post', durationMs: 12 }),
  });
  const file = path.join(root, 'content', HOST, 'blog', 'post.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, page('r1', 'Edited'));

  const { results, ok } = await workspace.sync([file]);

  assert.equal(ok, true);
  assert.equal(results[0].status, 'synced');
  assert.equal(results[0].static.generated, true);
  assert.equal(extractRevision(fs.readFileSync(file, 'utf8')), 'r2');
  const put = server.requests.find((request) => request.method === 'PUT');
  assert.equal(put.headers.get('If-Match'), 'r1');
  assert.equal(put.headers.get('Content-Type'), 'text/markdown; charset=UTF-8');
});

test('a 409 replaces the file with the server version and reports a conflict', async (t) => {
  const { root, workspace } = workspaceFor(t, {
    'PUT /api/content/page/example.com/page': () => new Response(page('r9', 'Server'), { status: 409 }),
  });
  const file = path.join(root, 'content', HOST, 'page.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, page('r1', 'Mine'));

  const { results, ok } = await workspace.sync([file]);

  assert.equal(ok, false);
  assert.equal(results[0].status, 'conflict');
  assert.equal(fs.readFileSync(file, 'utf8'), page('r9', 'Server'));
});

test('a file without revision is never sent, and an auth failure stops the batch', async (t) => {
  const { root, workspace, server } = workspaceFor(t, {
    'PUT /api/content/page/example.com/a': () => new Response('denied', { status: 401 }),
  });
  const directory = path.join(root, 'content', HOST);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'new.md'), '---\nh1: New\n---\n\nBody\n');
  fs.writeFileSync(path.join(directory, 'a.md'), page('r1'));
  fs.writeFileSync(path.join(directory, 'b.md'), page('r1'));

  const { results } = await workspace.sync(['new.md', 'a.md', 'b.md'].map((name) => path.join(directory, name)));

  assert.deepEqual(results.map((result) => result.status), ['no-revision', 'auth']);
  assert.equal(server.requests.length, 1);
});

test('create posts the raw file, keeps the canonical text and queues a host generation', async (t) => {
  const { root, workspace, server } = workspaceFor(t, {
    'POST /api/content/page/example.com/new-page': ({ body }) => new Response(body.replace('---\n\n', 'revision: r1 # read only\n---\n\n'), { status: 201 }),
    'POST /api/static/example.com': () => Response.json({ status: 'queued' }, { status: 202 }),
  });
  const file = path.join(root, 'content', HOST, 'new-page.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nh1: New\n---\n\nBody\n');

  const created = await workspace.create(file);

  assert.equal(created.revision, 'r1');
  assert.equal(extractRevision(fs.readFileSync(file, 'utf8')), 'r1');
  assert.equal(server.requests.at(-1).path, '/api/static/example.com?incremental=1');
  fs.writeFileSync(file, page('r1'));
  await assert.rejects(workspace.create(file), /revision/);
});

test('delete requires a redirection target and removes the local copy', async (t) => {
  const { root, workspace, server } = workspaceFor(t, {
    'DELETE /api/page/example.com/old': () => new Response(null, { status: 204 }),
    'POST /api/static/example.com': () => Response.json({ status: 'queued' }, { status: 202 }),
  });
  const file = path.join(root, 'content', HOST, 'old.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, page('r1'));

  await assert.rejects(workspace.delete(HOST, 'old', {}), /redirection/);
  await workspace.delete(HOST, 'old', { redirectTo: '/new' });

  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(JSON.parse(server.requests[0].body), { redirectTo: '/new', code: 301 });
});

test('hook payloads: Claude file tools and Codex apply_patch', () => {
  assert.deepEqual(hookFilePaths({ tool_name: 'Edit', tool_input: { file_path: '/a/b.md' } }), ['/a/b.md']);
  assert.deepEqual(hookFilePaths({ tool_name: 'Bash', tool_input: { command: 'ls' } }), []);
  assert.deepEqual(hookFilePaths({
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: content/a.md\n*** Move to: content/b.md\n*** Add File: content/c.md\n*** Delete File: content/d.md\n*** End Patch' },
  }), ['content/a.md', 'content/c.md', 'content/b.md']);
});

test('the sync hook ignores files outside the mirror and exits 2 on a conflict', async (t) => {
  const { root, workspace } = workspaceFor(t, {
    'PUT /api/content/page/example.com/page': () => new Response(page('r9'), { status: 409 }),
  });
  const file = path.join(root, 'content', HOST, 'page.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, page('r1'));
  fs.writeFileSync(path.join(root, 'notes.md'), 'x');

  const outside = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'notes.md' }, cwd: root });
  assert.deepEqual(pagesFromHookPayload(workspace, outside), []);
  assert.equal(await runSyncHook(workspace, outside), 0);
  assert.equal(await runSyncHook(workspace, 'not json'), 0);

  const inside = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file } });
  assert.equal(await runSyncHook(workspace, inside), 2);
});

test('client encodes slugs, media names and redirection bodies', async () => {
  const server = fakeServer({
    'GET /api/page/example.com/blog/caf%C3%A9': () => Response.json({ slug: 'blog/café' }),
    'POST /api/redirection/example.com': ({ body }) => Response.json(JSON.parse(body), { status: 201 }),
    'GET /api/media': ({ search }) => Response.json({ search }),
  });
  const client = new PushwordClient({ baseUrl: 'https://edit.example.test', token: 't', fetchImpl: server.fetchImpl });

  assert.deepEqual(await client.getPage(HOST, 'blog/café'), { slug: 'blog/café' });
  assert.deepEqual(await client.createRedirection(HOST, { slug: 'old', redirectTo: '/new' }), { slug: 'old', redirectTo: '/new', code: 301 });
  assert.deepEqual(await client.listMedia({ q: 'col', tag: ['a', 'b'] }), { search: '?q=col&tag%5B%5D=a&tag%5B%5D=b' });
  await assert.rejects(client.request('GET', '/admin'), /\/api\//);
  await assert.rejects(client.getPage('Bad Host', 'x'), /invalide/);
});
