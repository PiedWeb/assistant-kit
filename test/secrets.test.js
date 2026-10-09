import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KeychainUnavailableError,
  VaultError,
  connector,
  createKeychain,
  createVault,
  defineCatalog,
  field,
  nonInteractiveGitEnvironment,
  probeConnector,
  pushwordProbe,
  secureHelperName,
  sharedKeychainSource,
  startVaultServer,
  validateField,
} from '../src/secrets/index.js';

const NAMESPACE = 'secrets-test.invalid';

/**
 * In-memory system keychain behind `git credential approve|reject` and the
 * libsecret helper's own `get`, as the keychain module calls them.
 */
function fakeGit({ failGets = 0 } = {}) {
  const store = new Map();
  const calls = [];
  let failures = failGets;
  const run = (command, args, options) => {
    calls.push(args);
    if (args[0] === 'config') return { status: 0, stdout: 'libsecret\n' };
    const fields = Object.fromEntries(String(options.input || '').trim().split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)));
    const key = `${fields.host}/${fields.username}`;
    if (args[0] === 'credential-libsecret' && args[1] === 'get') {
      if (failures > 0) { failures -= 1; return { status: 1, stdout: '', stderr: 'dbus error' }; }
      return { status: 0, stdout: store.has(key) ? `username=${fields.username}\npassword=${store.get(key)}\n` : '' };
    }
    const action = args.at(-1);
    if (action === 'approve') store.set(key, fields.password);
    if (action === 'reject') store.delete(key);
    return { status: 0, stdout: '' };
  };
  return { run, store, calls };
}

const encoded = (value) => Buffer.from(value, 'utf8').toString('base64url');
const manifest = (keys) => encoded(JSON.stringify({ version: 2, keys }));
const noSleep = () => {};

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

test('the keychain stores the GrandAngle v2 format through a secure helper only', () => {
  const git = fakeGit();
  const keychain = createKeychain({ namespace: NAMESPACE, run: git.run, environment: {}, sleep: noSleep });

  keychain.write('PUSHWORD_TOKEN', 'abc');

  assert.equal(git.store.get(`${NAMESPACE}/valeur-v2-PUSHWORD_TOKEN`), encoded('abc'));
  assert.equal(git.store.get(`${NAMESPACE}/configuration-v2`), manifest(['PUSHWORD_TOKEN']));
  assert.equal(keychain.read('PUSHWORD_TOKEN', { fresh: true }), 'abc');
  assert.deepEqual(keychain.names(), ['PUSHWORD_TOKEN']);
  assert.ok(git.calls.some((args) => args.includes('credential.helper=libsecret')));
  assert.equal(keychain.forget('PUSHWORD_TOKEN'), true);
  assert.equal(keychain.read('PUSHWORD_TOKEN', { fresh: true }), '');
  assert.deepEqual(keychain.names({ fresh: true }), []);
  assert.throws(() => createKeychain({ namespace: 'example.com' }), /\.invalid/);
});

test('values written by GrandAngle are read, the index answers absent names without a helper call', () => {
  const git = fakeGit();
  git.store.set(`${NAMESPACE}/configuration-v2`, manifest(['SMTP_IMAP_ACCOUNTS']));
  git.store.set(`${NAMESPACE}/valeur-v2-SMTP_IMAP_ACCOUNTS`, encoded('{"version":2,"accounts":[]}\nmulti'));
  const keychain = createKeychain({ namespace: NAMESPACE, run: git.run, environment: {}, sleep: noSleep });

  assert.equal(keychain.read('SMTP_IMAP_ACCOUNTS'), '{"version":2,"accounts":[]}\nmulti');
  const before = git.calls.length;
  assert.equal(keychain.read('CADRANK_API_KEY'), '');
  assert.equal(git.calls.length, before, 'a name missing from the index costs no helper call');
  assert.deepEqual(keychain.values(), { SMTP_IMAP_ACCOUNTS: '{"version":2,"accounts":[]}\nmulti' });
});

test('a silent helper is unavailable, never empty; a GCM refusal is absent', () => {
  const failing = fakeGit({ failGets: 2 });
  const keychain = createKeychain({ namespace: NAMESPACE, run: failing.run, environment: {}, sleep: noSleep });
  assert.throws(() => keychain.read('PUSHWORD_TOKEN'), KeychainUnavailableError);
  assert.equal(keychain.status().unavailable, false, 'the helper answers again after two failures');

  const flaky = fakeGit({ failGets: 1 });
  flaky.store.set(`${NAMESPACE}/configuration-v2`, manifest(['PUSHWORD_TOKEN']));
  flaky.store.set(`${NAMESPACE}/valeur-v2-PUSHWORD_TOKEN`, encoded('abc'));
  assert.equal(createKeychain({ namespace: NAMESPACE, run: flaky.run, environment: {}, sleep: noSleep }).read('PUSHWORD_TOKEN'), 'abc');

  const gcm = (command, args) => (args[0] === 'config'
    ? { status: 0, stdout: 'manager\n' }
    : { status: 1, stdout: '', stderr: 'fatal: Cannot prompt because user interactivity has been disabled.' });
  assert.equal(createKeychain({ namespace: NAMESPACE, run: gcm, environment: {}, sleep: noSleep }).read('PUSHWORD_TOKEN'), '');

  const timeout = () => ({ status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) });
  assert.equal(createKeychain({ namespace: NAMESPACE, run: timeout, environment: {}, sleep: noSleep }).status().unavailable, true);
});

test('save merges by default and replaces on request; forgetAll leaves foreign entries alone', () => {
  const git = fakeGit();
  git.store.set(`${NAMESPACE}/git-forge-token`, 'foreign');
  git.store.set('other.invalid/configuration-v2', manifest(['A']));
  const keychain = createKeychain({ namespace: NAMESPACE, run: git.run, environment: {}, sleep: noSleep });

  keychain.save({ A: 'one', B: 'two' });
  assert.deepEqual(keychain.save({ B: 'two', C: 'three' }).saved, ['C']);
  assert.deepEqual(keychain.names({ fresh: true }), ['A', 'B', 'C']);
  keychain.save({ C: 'three' }, { replace: true });
  assert.deepEqual(keychain.names({ fresh: true }), ['C']);
  assert.equal(keychain.read('A', { fresh: true }), '', 'a name left out of the index reads as absent');

  assert.deepEqual(keychain.forgetAll(['A', 'B']), ['A', 'B', 'C']);
  assert.equal(git.store.has(`${NAMESPACE}/configuration-v2`), false);
  assert.equal(git.store.get(`${NAMESPACE}/git-forge-token`), 'foreign');
  assert.ok(git.store.has('other.invalid/configuration-v2'));
});

test('values of the 0.1 format move to the shared format, conflicts stay for a manual check', () => {
  const git = fakeGit();
  git.store.set(`${NAMESPACE}/PUSHWORD_TOKEN`, 'legacy-token');
  git.store.set(`${NAMESPACE}/CADRANK_API_KEY`, 'old-key');
  const keychain = createKeychain({ namespace: NAMESPACE, run: git.run, environment: {}, sleep: noSleep });
  keychain.write('CADRANK_API_KEY', 'new-key');

  assert.deepEqual(keychain.migrateLegacy(['PUSHWORD_TOKEN', 'CADRANK_API_KEY', 'MAIL_PASSWORD']),
    { migrated: ['PUSHWORD_TOKEN'], conflicts: ['CADRANK_API_KEY'] });
  assert.equal(keychain.read('PUSHWORD_TOKEN', { fresh: true }), 'legacy-token');
  assert.equal(git.store.has(`${NAMESPACE}/PUSHWORD_TOKEN`), false);
  assert.equal(git.store.get(`${NAMESPACE}/CADRANK_API_KEY`), 'old-key');
});

test('git and helpers never prompt, and libsecret finds the desktop bus', () => {
  const socket = { uid: 1000, isSocket: () => true };
  const environment = nonInteractiveGitEnvironment({ PATH: '/bin' }, { platform: 'linux', userId: 1000, stat: () => socket });
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  assert.equal(environment.GCM_INTERACTIVE, 'Never');
  assert.equal(environment.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
  assert.equal(nonInteractiveGitEnvironment({}, { platform: 'linux', userId: 1000, stat: () => ({ uid: 0, isSocket: () => true }) }).DBUS_SESSION_BUS_ADDRESS, undefined);
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

test('projects add sources around the keychain and alternative requirements', () => {
  const git = fakeGit();
  git.store.set('secrets-shared.invalid/configuration-v2', manifest(['MAIL_PASSWORD', 'PUSHWORD_TOKEN']));
  git.store.set('secrets-shared.invalid/valeur-v2-MAIL_PASSWORD', encoded('shared-password'));
  git.store.set('secrets-shared.invalid/valeur-v2-PUSHWORD_TOKEN', encoded('other-scope-token'));
  const shared = createKeychain({ namespace: 'secrets-shared.invalid', run: git.run, environment: {}, sleep: noSleep });
  const relay = defineCatalog({
    relay: connector('Relais', 'Deux modes', [field('RELAY_AUTH', 'Relais'), field('RELAY_KEY', 'Clé directe')], {
      requirements: [['RELAY_AUTH'], ['RELAY_KEY']], optional: true, planets: ['mercure'],
    }),
    ...catalog(),
  });
  const vault = createVault({
    catalog: relay,
    environment: { RELAY_KEY: '' },
    keychain: createKeychain({ namespace: NAMESPACE, run: git.run, environment: {}, sleep: noSleep }),
    before: [{ source: 'shared-env', read: (name) => (name === 'MAIL_ADDRESS' ? 'robin@example.com' : '') }],
    after: [sharedKeychainSource(shared, ['MAIL_PASSWORD'])],
  });

  assert.deepEqual(vault.resolve('MAIL_ADDRESS'), { value: 'robin@example.com', source: 'shared-env' });
  assert.deepEqual(vault.resolve('MAIL_PASSWORD'), { value: 'shared-password', source: 'keychain:secrets-shared.invalid' });
  assert.equal(vault.resolve('PUSHWORD_TOKEN').source, 'missing', 'only the listed names cross scopes');
  assert.deepEqual(relay.relay.planets, ['mercure']);
  const state = () => vault.status().find((entry) => entry.id === 'relay');
  assert.deepEqual([state().ready, state().optional, state().missing], [false, true, ['RELAY_AUTH']]);
  vault.set('RELAY_KEY', 'direct');
  assert.equal(state().ready, true, 'one complete group is enough');
  assert.equal(vault.migrateKeychain().migrated.length, 0);
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

test('a multiline field takes an HTML signature, from stdin or the form text area', async (t) => {
  const git = fakeGit();
  git.store.set('secrets-shared.invalid/configuration-v2', manifest(['MAIL_PASSWORD']));
  git.store.set('secrets-shared.invalid/valeur-v2-MAIL_PASSWORD', encoded('shared-password'));
  const signed = defineCatalog({
    mail: connector('Mail', 'Boîte', [
      field('MAIL_PASSWORD', 'Mot de passe'),
      field('MAIL_SIGNATURE_HTML', 'Signature HTML', { secret: false, required: false, multiline: true }),
    ]),
  });
  const vault = createVault({
    catalog: signed, environment: {},
    keychain: createKeychain({ namespace: NAMESPACE, run: git.run, environment: {}, sleep: noSleep }),
    after: [sharedKeychainSource(createKeychain({ namespace: 'secrets-shared.invalid', run: git.run, environment: {}, sleep: noSleep }), ['MAIL_PASSWORD'])],
  });
  const signature = '<p>Robin<br>\n<a href="https://example.com">example.com</a></p>\n<p>06 00 00 00 00</p>';

  vault.set('MAIL_SIGNATURE_HTML', signature);
  assert.equal(vault.resolve('MAIL_SIGNATURE_HTML').value, signature);
  assert.throws(() => vault.set('MAIL_PASSWORD', 'two\nlines'), /une ligne/);

  const session = await startVaultServer({ vault, autoVerify: false, brand: { name: 'testkit', css: '' } });
  t.after(() => session.close());
  const url = new URL(session.url);
  const html = await (await fetch(url)).text();
  assert.match(html, /<textarea id="MAIL_SIGNATURE_HTML"[^>]*>&lt;p&gt;Robin/);
  assert.match(html, /Trousseau partagé \(secrets-shared\.invalid\)/);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const replaced = '<p>Robin</p>\r\n<p>Nouvelle ligne</p>';
  const response = await fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: url.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, action: 'save', MAIL_SIGNATURE_HTML: replaced }),
  });
  assert.equal(response.status, 303);
  assert.equal(vault.resolve('MAIL_SIGNATURE_HTML').value, replaced);
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
