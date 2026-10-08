import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VaultError,
  connector,
  createKeychain,
  createVault,
  defineCatalog,
  field,
  probeConnector,
  pushwordProbe,
  secureHelperName,
  startVaultServer,
  validateField,
} from '../src/secrets/index.js';

const NAMESPACE = 'secrets-test.invalid';

/** In-memory `git credential` with the libsecret helper configured. */
function fakeGit() {
  const store = new Map();
  const calls = [];
  const run = (command, args, options) => {
    calls.push(args);
    if (args[0] === 'config') return { status: 0, stdout: 'libsecret\n' };
    const action = args.at(-1);
    const fields = Object.fromEntries(String(options.input).trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)));
    const key = `${fields.host}/${fields.username}`;
    if (action === 'approve') store.set(key, fields.password);
    if (action === 'reject') store.delete(key);
    if (action === 'fill') {
      return store.has(key) ? { status: 0, stdout: `password=${store.get(key)}\n` } : { status: 128, stdout: '' };
    }
    return { status: 0, stdout: '' };
  };
  return { run, store, calls };
}

function catalog() {
  return defineCatalog({
    pushword: connector('Pushword', 'Pages', [field('PUSHWORD_TOKEN', 'Jeton')], {
      probe: pushwordProbe({ baseUrl: 'https://edit.example.test' }),
    }),
    mail: connector('Mail', 'Boîte', [
      field('MAIL_HOST', 'Serveur', { kind: 'host', defaultValue: 'mail.example.test' }),
      field('MAIL_ADDRESS', 'Adresse', { kind: 'email', domain: 'example.com' }),
      field('MAIL_PASSWORD', 'Mot de passe'),
    ]),
  });
}

test('the keychain stores under the project namespace through a secure helper only', () => {
  const git = fakeGit();
  const keychain = createKeychain({ namespace: NAMESPACE, run: git.run, environment: {} });

  keychain.write('PUSHWORD_TOKEN', 'abc');

  assert.equal(keychain.read('PUSHWORD_TOKEN', { fresh: true }), 'abc');
  assert.ok(git.store.has(`${NAMESPACE}/PUSHWORD_TOKEN`));
  assert.ok(git.calls.some((args) => args.includes('credential.helper=libsecret')));
  assert.equal(keychain.forget('PUSHWORD_TOKEN'), true);
  assert.equal(keychain.read('PUSHWORD_TOKEN', { fresh: true }), '');
  assert.throws(() => createKeychain({ namespace: 'example.com' }), /\.invalid/);
  assert.throws(() => keychain.write('PUSHWORD_TOKEN', 'two\nlines'), VaultError);
});

test('helper names never reach the shell with arguments', () => {
  assert.equal(secureHelperName('libsecret'), 'libsecret');
  assert.equal(secureHelperName('/usr/libexec/git-core/git-credential-libsecret'), '/usr/libexec/git-core/git-credential-libsecret');
  assert.equal(secureHelperName('store'), null);
  assert.equal(secureHelperName('libsecret; rm -rf /'), null);
  assert.equal(secureHelperName('!echo secret'), null);
});

test('values resolve from environment, systemd, keychain, then default', (t) => {
  const credentials = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-kit-credentials-'));
  t.after(() => fs.rmSync(credentials, { recursive: true, force: true }));
  fs.writeFileSync(path.join(credentials, 'MAIL_PASSWORD'), 'from-systemd\n');
  const git = fakeGit();
  const environment = { MAIL_ADDRESS: 'robin@example.com', CREDENTIALS_DIRECTORY: credentials };
  const vault = createVault({ catalog: catalog(), environment, keychain: createKeychain({ namespace: NAMESPACE, run: git.run, environment }) });

  vault.set('PUSHWORD_TOKEN', ' token ');

  assert.deepEqual(vault.resolve('MAIL_ADDRESS'), { value: 'robin@example.com', source: 'environment' });
  assert.deepEqual(vault.resolve('MAIL_PASSWORD'), { value: 'from-systemd', source: 'systemd' });
  assert.deepEqual(vault.resolve('PUSHWORD_TOKEN'), { value: 'token', source: 'keychain' });
  assert.deepEqual(vault.resolve('MAIL_HOST'), { value: 'mail.example.test', source: 'default' });
  assert.deepEqual(vault.status().map((state) => [state.id, state.ready]), [['pushword', true], ['mail', true]]);
  assert.throws(() => vault.set('UNKNOWN', 'x'), /aucun connecteur/);
  assert.throws(() => vault.credential('NOT_SET'), /manquant/);
});

test('email fields can be restricted to a domain', () => {
  const address = field('MAIL_ADDRESS', 'Adresse', { kind: 'email', domain: ['example.com', 'example.org'] });
  validateField(address, 'a@example.org');
  assert.throws(() => validateField(address, 'a@other.com'), /@example\.com ou @example\.org/);
  assert.throws(() => validateField(field('URL', 'URL', { kind: 'url' }), 'http://insecure.test'), /HTTPS/);
});

test('migration imports catalog values, maps aliases and never overwrites', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-kit-migrate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.env');
  fs.writeFileSync(file, 'OLD_TOKEN="abc" # legacy\nMAIL_PASSWORD=secret\nUNRELATED=1\n');
  const git = fakeGit();
  const vault = createVault({
    catalog: catalog(),
    environment: {},
    aliases: { OLD_TOKEN: 'PUSHWORD_TOKEN' },
    keychain: createKeychain({ namespace: NAMESPACE, run: git.run, environment: {} }),
  });

  assert.deepEqual(vault.migrate(file, { dryRun: true }).pending, ['MAIL_PASSWORD', 'PUSHWORD_TOKEN']);
  assert.deepEqual(vault.migrate(file).migrated, ['MAIL_PASSWORD', 'PUSHWORD_TOKEN']);
  assert.deepEqual(vault.migrate(file).skipped, ['MAIL_PASSWORD', 'PUSHWORD_TOKEN']);
});

test('probes report fixed descriptions, never server bodies', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://edit.example.test/api/whoami');
    assert.equal(options.redirect, 'manual');
    return options.headers.Authorization === 'Bearer good'
      ? Response.json({ id: 1, email: 'robin@example.com' })
      : new Response('secret detail', { status: 401 });
  };
  const ok = await probeConnector(catalog(), 'pushword', { PUSHWORD_TOKEN: 'good' }, { fetchImpl });
  const denied = await probeConnector(catalog(), 'pushword', { PUSHWORD_TOKEN: 'bad' }, { fetchImpl });
  const unsupported = await probeConnector(catalog(), 'mail', {
    MAIL_HOST: 'mail.example.test', MAIL_ADDRESS: 'a@example.com', MAIL_PASSWORD: 'x',
  }, { fetchImpl });

  assert.equal(ok.status, 'ok');
  assert.equal(denied.status, 'failed');
  assert.doesNotMatch(JSON.stringify(denied), /secret detail/);
  assert.equal(unsupported.status, 'unsupported');
});

test('the vault form only answers its secret path with a CSRF token', async (t) => {
  const git = fakeGit();
  const vault = createVault({ catalog: catalog(), environment: {}, keychain: createKeychain({ namespace: NAMESPACE, run: git.run, environment: {} }) });
  const session = await startVaultServer({ vault, autoVerify: false, brand: { name: 'testkit', css: '' } });
  t.after(() => session.close());
  const url = new URL(session.url);

  const page = await fetch(url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /testkit/);
  assert.equal((await fetch(new URL('/other', url))).status, 404);

  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const post = (body) => fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: url.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  assert.equal((await post({ csrf: 'wrong', action: 'save', PUSHWORD_TOKEN: 'x' })).status, 403);
  assert.equal((await post({ csrf, action: 'save', PUSHWORD_TOKEN: 'saved-token' })).status, 303);
  assert.equal(vault.resolve('PUSHWORD_TOKEN').value, 'saved-token');
});
