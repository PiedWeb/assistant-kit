import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAssistant } from '../src/assistant.js';
import { CockpitClient } from '../src/cockpit.js';

function sink() {
  const chunks = [];
  return { write: (chunk) => chunks.push(String(chunk)), text: () => chunks.join('') };
}

async function run(argv, overrides = {}) {
  const stdout = sink();
  const stderr = sink();
  const previous = process.exitCode;
  process.exitCode = undefined;
  await runAssistant({
    name: 'Test Assistant',
    hosts: ['example.com'],
    createVault: () => ({ catalog: {}, status: () => [], backend: () => ({ available: true, helper: 'libsecret' }) }),
    createWorkspace: () => { throw new Error('workspace not expected'); },
    stdout, stderr, argv, ...overrides,
  });
  const exitCode = process.exitCode;
  process.exitCode = previous;
  return { stdout: stdout.text(), stderr: stderr.text(), exitCode };
}

test('help lists the built-in scopes and the project lines', async () => {
  const { stdout } = await run(['help'], {
    cadrank: { instances: { fr: { baseUrl: 'https://fr.example' }, us: { baseUrl: 'https://us.example' } } },
    createMailClient: () => ({}),
    createCockpitClient: () => ({}),
    help: '  docs pull | status',
  });
  for (const scope of ['vault', 'pushword', 'media', 'redirection', 'cadrank', 'cockpit', 'mail', 'docs']) {
    assert.match(stdout, new RegExp(`\\n  ${scope} `));
  }
  assert.match(stdout, /--instance fr\|us/);
});

test('unknown scopes and disabled connectors are refused', async () => {
  assert.match((await run(['nope'])).stderr, /Commande inconnue : nope/);
  assert.match((await run(['mail', 'list'])).stderr, /Commande inconnue : mail/, 'no mail client, no mail scope');
});

test('mail writes need --allow-writes before any client exists', async () => {
  let created = 0;
  const createMailClient = () => { created += 1; return {}; };
  for (const argv of [
    ['mail', 'draft'], ['mail', 'send'], ['mail', 'reply', '1'], ['mail', 'draft-reply', '1'],
    ['mail', 'draft-update', '1', '--subject', 'Objet'], ['mail', 'mark-read', '1', '--unread'],
  ]) {
    const result = await run(argv, { createMailClient, mailWriteRule: 'sur demande de Robin' });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--allow-writes, sur demande de Robin/);
  }
  assert.equal(created, 0);
});

test('mail reads stay read-only and writes get allowWrites', async () => {
  const seen = [];
  const createMailClient = ({ allowWrites }) => ({
    messages: async (account, options) => { seen.push(['messages', account, options.unreadOnly, allowWrites]); return []; },
    saveDraft: async (account, message) => { seen.push(['draft', account, message.to, allowWrites]); return { sent: false }; },
  });
  await run(['mail', 'list', '--unread', '--account', 'perso'], { createMailClient });
  await run(['mail', 'draft', '--to', 'a@example.com,b@example.com', '--subject', 'Objet', '--allow-writes'], { createMailClient });
  assert.deepEqual(seen, [['messages', 'perso', true, false], ['draft', '', ['a@example.com', 'b@example.com'], true]]);
});

test('mail draft-update passes only what changes, mark-read defaults to read', async () => {
  const seen = [];
  const createMailClient = ({ allowWrites }) => ({
    updateDraft: async (...args) => { seen.push(['update', allowWrites, ...args]); return {}; },
    setSeen: async (...args) => { seen.push(['seen', allowWrites, ...args]); return {}; },
  });
  await run(['mail', 'draft-update', '12', '--version', 'abc', '--cc', 'c@example.com', '--subject', 'Nouvel objet', '--allow-writes'], { createMailClient });
  await run(['mail', 'draft-update', '13', '--folder', 'Brouillons', '--whole-body', '--to', 'a@example.com', '--allow-writes'], { createMailClient });
  await run(['mail', 'mark-read', '12', '--folder', 'INBOX.Drafts', '--unread', '--allow-writes'], { createMailClient });
  await run(['mail', 'mark-read', '8', '--allow-writes'], { createMailClient });
  const body = { text: '', html: '', attachments: [] };
  assert.deepEqual(seen, [
    ['update', true, '', '', 12, { cc: ['c@example.com'], subject: 'Nouvel objet', ...body, wholeBody: false, version: 'abc' }],
    ['update', true, '', 'Brouillons', 13, { to: ['a@example.com'], ...body, wholeBody: true, version: '' }],
    ['seen', true, '', 'INBOX.Drafts', 12, false],
    ['seen', true, '', 'INBOX', 8, true],
  ]);

  const stale = Object.assign(new Error('Le brouillon a changé.'), { details: { current: { version: 'v2', text: 'Texte actuel' } } });
  const refused = await run(['mail', 'draft-update', '12', '--subject', 'Objet', '--allow-writes'], {
    createMailClient: () => ({ updateDraft: async () => { throw stale; } }),
  });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /✗ Le brouillon a changé\.\n\{[^]*"version": "v2"[^]*"text": "Texte actuel"/);
});

test('a file named on the command line syncs whatever its host, sync-all keeps to the hosts', async () => {
  const calls = [];
  const workspace = {
    client: {},
    sync: async (files, options) => { calls.push(['sync', options.anyHost]); return { results: [], ok: true }; },
    syncAll: async () => { calls.push(['syncAll']); return { results: [], ok: true, skipped: [] }; },
  };
  await run(['pushword', 'sync', 'content/other.example/page.md'], { createWorkspace: () => workspace });
  const all = await run(['pushword', 'sync-all'], { createWorkspace: () => workspace });
  assert.deepEqual(calls, [['sync', true], ['syncAll']]);
  assert.match(all.stdout, /Aucune page modifiée/);
});

test('projects add actions and scopes, and replace a built-in action', async () => {
  const seen = [];
  const result = await run(['pushword', 'context-pull', 'example.com'], {
    actions: { pushword: { 'context-pull': ({ args }) => seen.push(['context', ...args]) } },
  });
  assert.equal(result.stderr, '');
  await run(['docs', 'status'], { commands: { docs: ({ action }) => seen.push(['docs', action]) } });
  assert.deepEqual(seen, [['context', 'example.com'], ['docs', 'status']]);
});

test('vault set reads the value on stdin, never from the arguments', async () => {
  const saved = [];
  const vault = { catalog: {}, set: (name, value) => { saved.push([name, value]); return { saved: [name], shadowed: [] }; } };
  const result = await run(['vault', 'set', 'API_KEY'], { createVault: () => vault, stdin: Readable.from(['secret\n']) });
  assert.match(result.stdout, /API_KEY enregistré/);
  assert.deepEqual(saved, [['API_KEY', 'secret']]);
  assert.doesNotMatch(result.stdout, /secret/);
});

test('Cockpit is opt-in and reads pass the vault without authorizing writes', async () => {
  assert.match((await run(['cockpit', 'me'])).stderr, /Commande inconnue : cockpit/);
  const seen = [];
  const result = await run(['cockpit', 'me'], { createCockpitClient: ({ vault, allowWrites }) => {
    seen.push({ vaultAvailable: Boolean(vault), allowWrites });
    return { me: async () => ({ id: 1 }) };
  } });
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { id: 1 });
  assert.deepEqual(seen, [{ vaultAvailable: true, allowWrites: false }]);
});

test('Cockpit CLI requires --allow-writes and preserves request bodies and download bytes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-cockpit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bodyFile = path.join(directory, 'body.json');
  const queryFile = path.join(directory, 'query.json');
  const outputFile = path.join(directory, 'extension.zip');
  fs.writeFileSync(bodyFile, JSON.stringify({ firstName: 'Test' }));
  fs.writeFileSync(queryFile, JSON.stringify({ locale: 'fr', hasUrl: false }));
  const zip = Buffer.from([0x50, 0x4b, 0, 0xff, 0x80]);
  const calls = [];
  let created = 0;
  const createCockpitClient = ({ allowWrites }) => {
    created += 1;
    return new CockpitClient({ baseUrl: 'https://cockpit.example', token: 'test-key', allowWrites,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return url.endsWith('/download') ? new Response(zip) : Response.json({ ok: true });
      } });
  };
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const denied = await run(['cockpit', 'api', method, '/api/me'], { createCockpitClient });
    assert.match(denied.stderr, /refusée sans --allow-writes/);
    assert.equal(denied.exitCode, 1);
  }
  assert.equal(created, 0);
  assert.match((await run(['cockpit', 'api', 'GET', '/api/instagram/add/Creator'], { createCockpitClient })).stderr, /--allow-writes/);
  assert.equal(calls.length, 0);
  const write = await run(['cockpit', 'api', 'PATCH', '/api/me', '--body-file', bodyFile, '--allow-writes'], { createCockpitClient });
  assert.equal(write.stderr, '');
  assert.deepEqual(JSON.parse(calls[0].init.body), { firstName: 'Test' });
  await run(['cockpit', 'instagram-search', '--query-file', queryFile], { createCockpitClient });
  assert.equal(new URL(calls[1].url).searchParams.get('hasUrl'), 'false');
  const download = await run(['cockpit', 'api', 'GET', '/api/me/extension/download', '--output', outputFile], { createCockpitClient });
  assert.equal(download.stderr, '');
  assert.deepEqual(fs.readFileSync(outputFile), zip);
  assert.equal(fs.statSync(outputFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(download.stdout), { file: outputFile, bytes: zip.length });
  assert.equal((await run(['cockpit', 'api', 'GET', '/api/me/extension/download', '--output', outputFile], { createCockpitClient })).exitCode, 1);
  assert.deepEqual(fs.readFileSync(outputFile), zip);
  assert.equal((await run(['cockpit', 'api', 'GET', '/api/me/extension/download', '--output', outputFile, '--overwrite'], { createCockpitClient })).stderr, '');
});

test('Cockpit CLI reports missing arguments, missing file flags and unknown actions', async () => {
  const createCockpitClient = () => ({});
  for (const argv of [['cockpit', 'api', 'GET'], ['cockpit', 'project'], ['cockpit', 'instagram-detail'],
    ['cockpit', 'youtube-channel'], ['cockpit', 'youtube-video']]) {
    assert.match((await run(argv, { createCockpitClient })).stderr, /Usage/);
  }
  assert.match((await run(['cockpit', 'api', 'GET', '/api/me', '--query-file'], { createCockpitClient })).stderr, /Option obligatoire : --query-file/);
  assert.match((await run(['cockpit', 'api', 'GET', '/api/me', '--output'], { createCockpitClient })).stderr, /Option obligatoire : --output/);
  assert.match((await run(['cockpit', 'unknown'], { createCockpitClient })).stderr, /Commande cockpit inconnue/);
});
