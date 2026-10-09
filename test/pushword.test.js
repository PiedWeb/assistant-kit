import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as tar from 'tar';
import {
  ContentWorkspace,
  PushwordClient,
  extractRevision,
  hookFilePaths,
  pagesFromHookPayload,
  runSyncHook,
} from '../src/pushword/index.js';
import { probeConnector } from '../src/secrets/probes.js';

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
    'AGENTS.md': '# stale agent guide\n',
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
  assert.equal(fs.existsSync(path.join(content, 'AGENTS.md')), false);
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

function writePage(root, host, slug, text) {
  const file = path.join(root, 'content', host, `${slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function gitIn(root, args) {
  return execFileSync('git', ['-C', path.join(root, 'content'), ...args], { encoding: 'utf8' });
}

const echoPut = ({ body }) => new Response(body.replace(/revision: (\w+)/, 'revision: $1-next'), { status: 200 });

test('host rules: the hook and syncAll push the workspace hosts only, a named file any host', async (t) => {
  const { root, workspace, server, logs } = workspaceFor(t, {
    'PUT /api/content/page/example.com/page': echoPut,
    'PUT /api/content/page/doc.example.org/guide': echoPut,
  }, { syncCommand: 'node bin/assistant.js pushword sync' });
  const mine = writePage(root, HOST, 'page', page('r1'));
  const other = writePage(root, 'doc.example.org', 'guide', page('d1'));

  const restricted = await workspace.sync([mine, other], { publish: false });
  assert.deepEqual(restricted.results.map((result) => result.status), ['synced', 'outside-hosts']);
  assert.equal(restricted.ok, false);
  assert.match(restricted.results[1].message, /doc\.example\.org n’est pas dans les hôtes du projet \(example\.com\)/);
  assert.match(restricted.results[1].message, /node bin\/assistant\.js pushword sync content\/doc\.example\.org\/guide\.md/);
  assert.equal(server.requests.filter((request) => request.path.includes('doc.example.org')).length, 0);
  assert.ok(logs.some((line) => line.startsWith('✗ content/doc.example.org/guide.md')));

  const hook = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: other } });
  assert.equal(await runSyncHook(workspace, hook, { publish: false }), 2);
  assert.equal(server.requests.filter((request) => request.path.includes('doc.example.org')).length, 0);

  const named = await workspace.sync([other], { publish: false, anyHost: true });
  assert.equal(named.results[0].status, 'synced');
  assert.equal(extractRevision(fs.readFileSync(other, 'utf8')), 'd1-next');
});

test('syncAll pushes pending pages of the workspace hosts and lists the others as skipped', async (t) => {
  const archive = await snapshotArchive(t, { 'page.md': page('r1'), 'other.md': page('r1') });
  const { root, workspace, server } = workspaceFor(t, {
    'GET /api/content/snapshot.tar.gz': () => new Response(archive),
    'PUT /api/content/page/example.com/page': echoPut,
  });
  await workspace.pull();
  assert.deepEqual(workspace.pendingFiles(), []);
  const edited = path.join(root, 'content', HOST, 'page.md');
  fs.writeFileSync(edited, page('r1', 'Edited'));
  writePage(root, 'doc.example.org', 'guide', page('d1'));

  const { results, ok, skipped } = await workspace.syncAll({ publish: false });

  assert.equal(ok, true);
  assert.deepEqual(results.map((result) => [result.slug, result.status]), [['page', 'synced']]);
  assert.deepEqual(skipped.map((result) => [result.host, result.status]), [['doc.example.org', 'outside-hosts']]);
  assert.equal(server.requests.filter((request) => request.method === 'PUT').length, 1);
  assert.deepEqual(workspace.pendingFiles().map((file) => path.relative(root, file)),
    [path.join('content', 'doc.example.org', 'guide.md')]);
});

test('last-pull tag: every edit since the pull stays visible after a sync commits it', async (t) => {
  const archive = await snapshotArchive(t, { 'page.md': page('r1'), 'blog/café.md': page('r2') });
  const { root, workspace } = workspaceFor(t, {
    'GET /api/content/snapshot.tar.gz': () => new Response(archive),
    'PUT /api/content/page/example.com/page': echoPut,
  });
  await workspace.pull();
  assert.deepEqual(workspace.changesSincePull(), []);

  const edited = path.join(root, 'content', HOST, 'page.md');
  fs.writeFileSync(edited, page('r1', 'Edited'));
  await workspace.sync([edited], { publish: false });
  fs.writeFileSync(path.join(root, 'content', HOST, 'blog', 'café.md'), page('r2', 'Pending'));
  writePage(root, HOST, 'draft', '---\nh1: Draft\n---\n');

  assert.equal(gitIn(root, ['status', '--porcelain', '--', `${HOST}/page.md`]), '');
  assert.equal(gitIn(root, ['diff', '--name-only', 'last-pull', '--', `${HOST}/page.md`]).trim(), `${HOST}/page.md`);
  assert.deepEqual(workspace.changesSincePull().map((change) => [change.status, change.path]), [
    ['modified', `${HOST}/blog/café.md`],
    ['untracked', `${HOST}/draft.md`],
    ['modified', `${HOST}/page.md`],
  ]);
  assert.equal(workspace.changesSincePull()[2].file, edited);
});

test('a held index.lock delays the baseline commit instead of skipping it', async (t) => {
  const archive = await snapshotArchive(t, { 'page.md': page('r1') });
  const pauses = [];
  let workspaceRoot;
  const { root, workspace, logs } = workspaceFor(t, {
    'GET /api/content/snapshot.tar.gz': () => new Response(archive),
    'PUT /api/content/page/example.com/page': echoPut,
  }, {
    sleep: async (milliseconds) => {
      pauses.push(milliseconds);
      if (pauses.length === 2) fs.rmSync(path.join(workspaceRoot, 'content', '.git', 'index.lock'));
    },
  });
  workspaceRoot = root;
  await workspace.pull();
  const lock = path.join(root, 'content', '.git', 'index.lock');
  const file = path.join(root, 'content', HOST, 'page.md');
  fs.writeFileSync(file, page('r1', 'Edited'));
  fs.writeFileSync(lock, '');

  await workspace.sync([file], { publish: false });

  assert.deepEqual(pauses, [250, 500]);
  assert.equal(gitIn(root, ['status', '--porcelain']), '');
  assert.ok(!logs.some((line) => line.startsWith('⚠')));

  pauses.length = 0;
  fs.writeFileSync(lock, '');
  workspace.sleep = async (milliseconds) => { pauses.push(milliseconds); };
  fs.writeFileSync(file, page('r1-next', 'Again'));
  await workspace.sync([file], { publish: false });
  assert.deepEqual(pauses, [250, 500, 1000, 2000]);
  assert.match(logs.at(-1), /⚠ état de référence non mis à jour : content\/\.git\/index\.lock reste tenu/);
});

test('git in the baseline repository never prompts and never opens a window', (t) => {
  const workspace = new ContentWorkspace({ root: temporaryDirectory(t), client: null, gitTimeoutMs: 5000 });
  fs.mkdirSync(workspace.contentRoot, { recursive: true });
  const environment = JSON.parse(workspace.git(['-c', 'alias.env=!node -e "process.stdout.write(JSON.stringify(process.env))"', 'env']));
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  assert.equal(environment.GCM_INTERACTIVE, 'Never');
  assert.equal(environment.GIT_ASKPASS, '');
});

test('a locked directory (Windows EPERM) is replaced in place', async (t) => {
  const first = await snapshotArchive(t, { 'page.md': page('r1'), 'old/gone.md': page('r1') });
  const second = await snapshotArchive(t, { 'page.md': page('r2'), 'new.md': page('r3') });
  const archives = [first, second];
  let locked = false;
  const { root, workspace } = workspaceFor(t, {
    'GET /api/content/snapshot.tar.gz': () => new Response(archives.shift()),
  }, {
    rename: (from, to) => {
      if (locked && from.endsWith(path.join('content', HOST))) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' });
      }
      fs.renameSync(from, to);
    },
  });
  await workspace.pull();
  locked = true;

  await workspace.pull();

  const content = path.join(root, 'content', HOST);
  assert.equal(fs.readFileSync(path.join(content, 'page.md'), 'utf8'), page('r2'));
  assert.ok(fs.existsSync(path.join(content, 'new.md')));
  assert.equal(fs.existsSync(path.join(content, 'old')), false);
  assert.equal(gitIn(root, ['status', '--porcelain']), '');
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('.content-backup-')), []);
});

test('a failed install puts every host back, in place included', async (t) => {
  const before = {
    'example.com': await snapshotArchive(t, { 'page.md': page('a1') }),
    'example.org': await snapshotArchive(t, { 'page.md': page('b1') }),
  };
  const after = {
    'example.com': await snapshotArchive(t, { 'page.md': page('a2'), 'added.md': page('a3') }),
    'example.org': await snapshotArchive(t, { 'page.md': page('b2') }),
  };
  let served = before;
  let failing = false;
  let restoreFails = false;
  const { root, workspace, logs } = workspaceFor(t, {
    'GET /api/content/snapshot.tar.gz': ({ search }) => new Response(served[new URLSearchParams(search).get('host')]),
  }, {
    hosts: ['example.com', 'example.org'],
    rename: (from, to) => {
      if (failing && from.endsWith(path.join('content', 'example.com'))) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      if (failing && to.endsWith(path.join('content', 'example.org'))
        && (restoreFails || from.includes(`${path.sep}staged${path.sep}`))) {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      }
      fs.renameSync(from, to);
    },
  });
  await workspace.pull();
  served = after;
  failing = true;

  await assert.rejects(workspace.pull(), /EIO/);

  assert.equal(fs.readFileSync(path.join(root, 'content', 'example.com', 'page.md'), 'utf8'), page('a1'));
  assert.equal(fs.existsSync(path.join(root, 'content', 'example.com', 'added.md')), false);
  assert.equal(fs.readFileSync(path.join(root, 'content', 'example.org', 'page.md'), 'utf8'), page('b1'));
  assert.equal(gitIn(root, ['status', '--porcelain']), '');
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('.content-backup-')), []);

  restoreFails = true;
  await assert.rejects(workspace.pull(), /EIO/);
  const kept = fs.readdirSync(root).filter((name) => name.startsWith('.content-backup-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(root, kept[0], 'example.org', 'page.md'), 'utf8'), page('b1'));
  assert.match(logs.at(-1), /example\.org non restauré \(EIO: i\/o error\) : copie précédente gardée dans /);
});

test('onPulled runs per host before the baseline commit; its failure never undoes the pull', async (t) => {
  const archive = await snapshotArchive(t, { 'page.md': page('r1') });
  const seen = [];
  const { root, workspace, logs } = workspaceFor(t, {
    'GET /api/content/snapshot.tar.gz': () => new Response(archive),
  }, {
    onPulled: async ({ host, directory, hosts, workspace: owner }) => {
      seen.push({ host, directory, hosts, same: owner === workspace });
      const data = path.join(owner.contentRoot, 'data');
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, 'shared.csv'), 'a\n');
    },
  });

  await workspace.pull();

  assert.deepEqual(seen, [{ host: HOST, directory: path.join(root, 'content', HOST), hosts: [HOST], same: true }]);
  assert.equal(gitIn(root, ['status', '--porcelain']), '');
  assert.equal(gitIn(root, ['ls-files', 'data']).trim(), 'data/shared.csv');

  workspace.onPulled = () => { throw new Error('archive de données absente'); };
  await workspace.pull();
  assert.match(logs.join('\n'), /⚠ example\.com tiré, mais l’étape après pull a échoué : archive de données absente/);
  assert.ok(fs.existsSync(path.join(root, 'content', HOST, 'page.md')));
});

test('snapshot key and token never follow a redirect to another origin', async (t) => {
  const requests = [];
  const client = new PushwordClient({
    baseUrl: 'https://edit.example.test',
    token: async () => 'api-token',
    snapshotKey: () => 'snapshot-key',
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: init.headers, redirect: init.redirect });
      return new Response(null, { status: 302, headers: { Location: 'https://storage.elsewhere.test/a.tar.gz' } });
    },
  });
  const destination = path.join(temporaryDirectory(t), 'a.tar.gz');

  await assert.rejects(client.downloadSnapshot(HOST, destination), /redirection vers https:\/\/storage\.elsewhere\.test refusée/);

  assert.deepEqual(requests.map((request) => new URL(request.url).origin), ['https://edit.example.test']);
  assert.equal(requests[0].redirect, 'manual');
  assert.equal(requests[0].headers.get('X-Pushword-Snapshot-Key'), 'snapshot-key');
  assert.equal(requests[0].headers.get('Authorization'), 'Bearer api-token');
  assert.equal(fs.existsSync(destination), false);
});

test('checkSnapshotKey sends a HEAD with the key alone; pushwordProbe uses it', async () => {
  const requests = [];
  const statuses = [200, 403, 200];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, headers: new Headers(init.headers) });
    if (url.endsWith('/api/whoami')) return Response.json({ id: 1, email: 'editor@example.test' });
    return new Response(null, { status: statuses.shift() });
  };
  const client = new PushwordClient({ baseUrl: 'https://edit.example.test', token: 't', snapshotKey: 'k', fetchImpl });

  assert.deepEqual(await client.checkSnapshotKey(HOST), { ok: true, status: 200 });
  assert.equal(requests[0].method, 'HEAD');
  assert.equal(requests[0].url, `https://edit.example.test/api/content/snapshot.tar.gz?host=${HOST}`);
  assert.equal(requests[0].headers.get('X-Pushword-Snapshot-Key'), 'k');
  assert.equal(requests[0].headers.has('Authorization'), false);
  await assert.rejects(client.checkSnapshotKey(), (error) => error.status === 403);
  await assert.rejects(new PushwordClient({ baseUrl: 'https://edit.example.test', fetchImpl }).checkSnapshotKey(), /absente/);

  const { pushwordProbe } = await import('../src/secrets/probes.js');
  const catalog = { pushword: { label: 'Pushword', fields: [
    { name: 'PUSHWORD_TOKEN', required: true }, { name: 'SNAPSHOT_KEY', required: true },
  ], probe: pushwordProbe({ baseUrl: 'https://edit.example.test', snapshotKeyField: 'SNAPSHOT_KEY' }) } };
  const result = await probeConnector(catalog, 'pushword', { PUSHWORD_TOKEN: 'token-value', SNAPSHOT_KEY: 'key-value' }, { fetchImpl });
  assert.equal(result.status, 'ok');
  assert.equal(result.detail, 'Pushword a reconnu le compte associé au jeton. Pushword a accepté la clé de snapshot.');
  assert.equal(requests.at(-1).headers.get('X-Pushword-Snapshot-Key'), 'key-value');
});

test('media upload: MIME from the extension, size limit, metadata fields, bytes in memory', async (t) => {
  const uploads = [];
  const client = new PushwordClient({
    baseUrl: 'https://edit.example.test',
    token: 't',
    maxMediaBytes: 1024,
    fetchImpl: async (url, init) => {
      uploads.push({ url, form: init.body, method: init.method });
      return Response.json({ filename: 'photo.jpg' }, { status: 201 });
    },
  });
  const directory = temporaryDirectory(t);
  const photo = path.join(directory, 'Photo.JPG');
  fs.writeFileSync(photo, Buffer.alloc(10));

  await client.uploadMedia(photo, {
    filename: 'mont-blanc', alt: 'Le mont Blanc', tags: ['alpes'], alts: { en: 'Mont Blanc' }, customProperties: { creditText: 'A' },
  });
  const sent = uploads[0].form;
  assert.equal(uploads[0].url, 'https://edit.example.test/api/media/mont-blanc');
  assert.equal(sent.get('file').type, 'image/jpeg');
  assert.equal(sent.get('file').name, 'Photo.JPG');
  assert.equal(sent.get('alt'), 'Le mont Blanc');
  assert.equal(sent.get('tags'), '["alpes"]');
  assert.equal(sent.get('alts'), '{"en":"Mont Blanc"}');
  assert.equal(sent.get('customProperties'), '{"creditText":"A"}');
  assert.equal(sent.has('fileNameHistory'), false);

  await client.uploadMedia({ bytes: Buffer.from('%PDF'), filename: 'guide.pdf' });
  assert.equal(uploads[1].form.get('file').type, 'application/pdf');
  assert.equal(uploads[1].url, 'https://edit.example.test/api/media/guide.pdf');

  const heavy = path.join(directory, 'heavy.png');
  fs.writeFileSync(heavy, Buffer.alloc(2048));
  await assert.rejects(client.uploadMedia(heavy), /Média trop lourd : heavy\.png pèse 0 Mo pour 0 Mo au maximum/);
  await assert.rejects(client.uploadMedia({ bytes: Buffer.alloc(10), filename: 'song.mp3' }), /Format de média refusé \(\.mp3\)/);
  await assert.rejects(client.uploadMedia({ bytes: Buffer.alloc(10), filename: 'song.mp3' }, { maxBytes: 5 }), /trop lourd/);
  assert.equal(uploads.length, 2);

  const audio = new PushwordClient({
    baseUrl: 'https://edit.example.test', token: 't', mediaTypes: { mp3: 'audio/mpeg' },
    fetchImpl: async (url, init) => { uploads.push({ form: init.body }); return Response.json({}, { status: 201 }); },
  });
  await audio.uploadMedia({ bytes: Buffer.alloc(1), filename: 'song.mp3' });
  assert.equal(uploads.at(-1).form.get('file').type, 'audio/mpeg');
});

test('PushwordClient is subclass friendly and passes HTTP options through', async () => {
  class EditorClient extends PushwordClient {
    async usage(filename) {
      return (await this.http.request('GET', `/api/editor/media/usage?filename=${encodeURIComponent(filename)}`)).payload;
    }
  }
  const seen = [];
  const client = new EditorClient({
    baseUrl: 'https://edit.example.test',
    token: () => 'fresh',
    httpOptions: { attempts: 1 },
    fetchImpl: async (url, init) => { seen.push(init.headers.get('Authorization')); return Response.json({ pages: [] }); },
  });
  assert.deepEqual(await client.usage('a.jpg'), { pages: [] });
  assert.deepEqual(seen, ['Bearer fresh']);
  assert.equal(client.http.attempts, 1);
});
