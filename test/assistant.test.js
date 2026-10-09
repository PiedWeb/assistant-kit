import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { runAssistant } from '../src/assistant.js';

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
    help: '  docs pull | status',
  });
  for (const scope of ['vault', 'pushword', 'media', 'redirection', 'cadrank', 'mail', 'docs']) {
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
  for (const argv of [['mail', 'draft'], ['mail', 'send'], ['mail', 'reply', '1'], ['mail', 'draft-reply', '1']]) {
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
