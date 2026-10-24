import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { inspect } from 'node:util';
import { simpleParser } from 'mailparser';
import {
  MAX_ACCOUNTS, MailClient, MailError, htmlToPlainText, imapOptions, normalizeAccount, normalizeAccounts,
  parseAccountConfig, publicAccount, quotableHtml, redactError, smtpOptions, stringifyAccountConfig,
} from '../src/mail.js';
import { connector, defineCatalog, field, mailProbe, probeConnector } from '../src/secrets/index.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'mot-de-passe-ultra-secret';

function account(overrides = {}) {
  return {
    id: 'perso',
    label: 'Perso',
    address: 'agent@example.com',
    username: 'agent@example.com',
    password: PASSWORD,
    signatureHtml: '',
    default: true,
    imap: { host: 'mail.example.test', port: 993, security: 'tls' },
    smtp: { host: 'mail.example.test', port: 465, security: 'tls' },
    ...overrides,
  };
}

const configuration = (overrides) => stringifyAccountConfig([account(overrides)]);

const ORIGINAL = Object.freeze({
  uid: 8,
  size: 1200,
  flags: new Set(['\\Seen']),
  envelope: {
    subject: 'Crédit photo',
    date: new Date('2026-09-17T21:35:56Z'),
    from: [{ name: 'Alice', address: 'Alice@Example.com' }],
    to: [{ address: 'agent@example.com' }],
    messageId: '<original@example.com>',
  },
});
const UNREAD = Object.freeze({
  uid: 9,
  size: 300,
  flags: new Set(),
  envelope: { subject: 'Relance', date: new Date('2026-09-18T08:00:00Z'), from: [{ address: 'bob@example.org' }] },
});

function parsedOriginal(overrides = {}) {
  return {
    messageId: '<original@example.com>',
    references: ['<before@example.com>'],
    date: new Date('2026-09-17T21:35:56Z'),
    text: 'Premier message\nSuite de la conversation',
    html: '<script>hostile()</script><p>Premier message</p>',
    from: { value: [{ name: 'Alice', address: 'alice@example.com' }] },
    to: { value: [{ address: 'agent@example.com' }] },
    attachments: [{ filename: '..\\../facture.pdf', contentType: 'application/pdf', content: Buffer.from('pdf'), size: 3 }],
    ...overrides,
  };
}

/** One fake IMAP server shared by every connection the client opens. */
function imapServer({ folders, inbox = [ORIGINAL, UNREAD], searchUids, overrides } = {}) {
  const state = {
    options: [], connections: 0, logouts: 0, lists: [], locks: [], searches: [], fetches: [], appended: [], flagWrites: 0,
  };
  const mailboxes = folders || [
    { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', flags: new Set(), status: { messages: 2, unseen: 1 } },
    { path: 'INBOX.Sent', name: 'Sent', specialUse: '\\Sent', flags: new Set() },
    { path: 'INBOX.Drafts', name: 'Drafts', specialUse: '\\Drafts', flags: new Set() },
    { path: '[Gmail]', name: '[Gmail]', flags: new Set(['\\Noselect']) },
  ];
  const factory = (options) => {
    state.options.push(options);
    state.connections += 1;
    const client = {
      mailbox: false,
      async connect() {},
      async logout() { state.logouts += 1; },
      close() {},
      async list(query) { state.lists.push(query); return mailboxes; },
      async getMailboxLock(mailbox, options = {}) {
        state.locks.push({ mailbox, readOnly: options.readOnly === true });
        client.mailbox = { path: mailbox, exists: inbox.length };
        return { release() {} };
      },
      async search(query) {
        state.searches.push(query);
        if (query.header) {
          const wanted = query.header['message-id'];
          return state.appended.filter((item) => item.raw.toString().includes(wanted)).map((item) => item.uid);
        }
        return searchUids ?? inbox.map((message) => message.uid);
      },
      async *fetch(range, query, options = {}) {
        state.fetches.push({ range, uid: options.uid === true });
        for (const message of inbox) {
          if (!Array.isArray(range) || range.includes(message.uid)) yield message;
        }
      },
      async fetchOne(uid, query) {
        const message = inbox.find((item) => item.uid === uid);
        if (!message) return false;
        return query.source ? { uid, source: Buffer.from('raw source') } : message;
      },
      async append(mailbox, raw, flags, date) {
        const uid = 100 + state.appended.length;
        state.appended.push({ mailbox, raw, flags, date, uid });
        return { uid };
      },
      async messageFlagsAdd() { state.flagWrites += 1; },
      async messageFlagsRemove() { state.flagWrites += 1; },
      async messageFlagsSet() { state.flagWrites += 1; },
      ...(typeof overrides === 'function' ? overrides(state) : overrides),
    };
    return client;
  };
  return { factory, state };
}

function smtpServer({ failure } = {}) {
  const state = { options: [], created: 0, verified: 0, sent: [], closed: 0 };
  const factory = (options) => {
    state.options.push(options);
    state.created += 1;
    return {
      async verify() {
        if (failure) throw failure;
        state.verified += 1;
        return true;
      },
      async sendMail(message) {
        if (failure) throw failure;
        state.sent.push(message);
        return { messageId: message.messageId, accepted: [...message.to, ...message.cc], rejected: [] };
      },
      close() { state.closed += 1; },
    };
  };
  return { factory, state };
}

function setup({ imap = {}, smtp = {}, parsed = {}, ...options } = {}) {
  const server = imapServer(imap);
  const relay = smtpServer(smtp);
  const client = new MailClient({
    configuration: configuration(),
    imapFactory: server.factory,
    smtpFactory: relay.factory,
    parser: async () => parsedOriginal(parsed),
    ...options,
  });
  return { client, imap: server.state, smtp: relay.state };
}

test('account JSON: the GA v2 value round-trips unchanged, arrays and objects parse', () => {
  const stored = JSON.stringify({
    version: 2,
    accounts: [account({ signatureHtml: '<p>Agent<br>Example</p>' }), account({
      id: 'seconde', label: 'Seconde', address: 'deux@example.org', username: 'deux', password: 'secret-2', default: false,
      imap: { host: 'imap.example.org', port: 143, security: 'starttls' },
      smtp: { host: 'smtp.example.org', port: 587, security: 'starttls' },
    })],
  });
  const accounts = parseAccountConfig(stored);
  assert.equal(stringifyAccountConfig(accounts), stored);
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].default, true);
  assert.equal(accounts[1].smtp.security, 'starttls');
  assert.ok(Object.isFrozen(accounts[0]) && Object.isFrozen(accounts[0].imap));
  assert.deepEqual(parseAccountConfig(JSON.parse(stored).accounts), accounts);
  assert.deepEqual(parseAccountConfig(JSON.parse(stored)), accounts);

  // Without any default, the first account becomes the default one.
  const implicit = normalizeAccounts([account({ default: false, id: 'a' }), account({ default: false, id: 'b' })]);
  assert.deepEqual(implicit.map((item) => item.default), [true, false]);
  assert.equal(normalizeAccount({ ...account(), id: 'Mixte', address: 'Agent@Example.COM', password: '' },
    { requirePassword: false }).address, 'agent@example.com');
});

test('account validation keeps the GA messages', () => {
  assert.throws(() => parseAccountConfig('{cassé'), (error) => error instanceof MailError && /illisible/.test(error.message));
  assert.throws(() => configuration({ password: '' }), /mot de passe de perso est requis/);
  assert.throws(() => stringifyAccountConfig([account(), account({ id: 'b' })]), /Une seule boîte/);
  assert.throws(() => stringifyAccountConfig([account(), account({ default: false })]), /dupliqué : perso/);
  assert.throws(() => configuration({ id: 'Pas bon' }), /lettres minuscules/);
  assert.throws(() => configuration({ address: 'pas-une-adresse' }), /adresse e-mail valide/);
  assert.throws(() => configuration({ imap: { host: 'a..b', port: 993, security: 'tls' } }), /nom de serveur valide/);
  assert.throws(() => configuration({ smtp: { host: 'smtp.example.test', port: 0, security: 'tls' } }), /entre 1 et 65535/);
  assert.throws(() => configuration({ smtp: { host: 'smtp.example.test', port: 25, security: 'none' } }), /TLS direct ou STARTTLS/);
  assert.throws(() => configuration({ username: '' }), /identifiant de connexion/);
  assert.throws(() => parseAccountConfig({ accounts: [] }), /au moins une boîte/);
  const many = Array.from({ length: MAX_ACCOUNTS + 1 }, (_, index) => account({ id: `b${index}`, default: false }));
  assert.throws(() => normalizeAccounts(many), /Au maximum 20 boîtes/);
});

test('public views never expose the password, username or signature HTML', async () => {
  const { client } = setup({ configuration: configuration({ signatureHtml: '<p>Coordonnées privées</p>' }) });
  const [listed] = await client.accounts();
  assert.deepEqual(listed, publicAccount(parseAccountConfig(configuration({ signatureHtml: 'x' }))[0]));
  assert.equal(listed.hasSignature, true);
  for (const view of [listed, await client.account(), await client.account('perso')]) {
    assert.equal('password' in view || 'username' in view || 'signatureHtml' in view, false);
  }
  assert.doesNotMatch(`${inspect(client, { depth: 5 })}${JSON.stringify(client)}`, new RegExp(PASSWORD));
  assert.equal(client.allowWrites, false);
  assert.throws(() => { client.allowWrites = true; }, TypeError);
});

test('constructor: accounts or configuration, never both; no account is a clear error', async () => {
  assert.throws(() => new MailClient({ accounts: [account()], configuration: configuration() }), /pas les deux/);
  assert.equal((await new MailClient({ accounts: [account()] }).account()).id, 'perso');
  const empty = new MailClient({ configuration: '', configureHint: 'Ouvre le vault.' });
  assert.deepEqual(await empty.accounts(), []);
  await assert.rejects(empty.verify(), /Aucune boîte SMTP\/IMAP configurée\. Ouvre le vault\./);
  await assert.rejects(setup().client.folders('inconnue'), /Boîte mail inconnue : inconnue/);
  assert.throws(() => new MailClient({ audit: 'journal' }), /audit doit être une fonction/);
});

test('verify logs in to IMAP and SMTP over TLS 1.2 or later without sending anything', async () => {
  const { client, imap, smtp } = setup({
    configuration: configuration({
      imap: { host: 'imap.example.test', port: 143, security: 'starttls' },
      smtp: { host: 'smtp.example.test', port: 587, security: 'starttls' },
    }),
    timeout: 5000,
  });
  assert.deepEqual(await client.verify(), { account: 'perso', address: 'agent@example.com', imap: true, smtp: true });
  const [imapConfig] = imap.options;
  const [smtpConfig] = smtp.options;
  assert.deepEqual([imapConfig.host, imapConfig.port, imapConfig.secure, imapConfig.doSTARTTLS], ['imap.example.test', 143, false, true]);
  assert.deepEqual([smtpConfig.host, smtpConfig.port, smtpConfig.secure, smtpConfig.requireTLS], ['smtp.example.test', 587, false, true]);
  for (const options of [imapConfig, smtpConfig]) {
    assert.deepEqual(options.tls, { rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    assert.deepEqual(options.auth, { user: 'agent@example.com', pass: PASSWORD });
    assert.equal(options.connectionTimeout, 5000);
    assert.equal(options.socketTimeout, 30000);
  }
  assert.equal(imapOptions(parseAccountConfig(configuration())[0], 1000).secure, true);
  assert.equal(smtpOptions(parseAccountConfig(configuration())[0], 1000).secure, true);
  assert.deepEqual(imap.lists, [{ listOnly: true }]);
  assert.deepEqual([smtp.verified, smtp.sent.length, smtp.closed, imap.logouts], [1, 0, 1, 1]);
});

test('reads open mailboxes read-only, search on the server and never touch flags', async () => {
  const { client, imap, smtp } = setup();

  const searched = await client.messages('', { query: '  facture ', unreadOnly: true, limit: 500 });
  assert.deepEqual(imap.searches[0], { seen: false, or: [{ subject: 'facture' }, { from: 'facture' }, { text: 'facture' }] });
  assert.deepEqual(imap.fetches[0], { range: [8, 9], uid: true });
  assert.deepEqual(searched.messages.map((item) => item.uid), [9, 8]);
  assert.equal(searched.messages[1].from[0].address, 'alice@example.com');
  assert.equal(searched.messages[1].seen, true);

  const latest = await client.messages('perso', { limit: 1 });
  assert.deepEqual(imap.fetches[1], { range: '2:*', uid: false });
  assert.equal(latest.mailbox, 'INBOX');
  assert.equal(imap.searches.length, 1, 'a plain listing does not search');

  const folders = await client.folders();
  assert.deepEqual(folders.folders.map((item) => item.path), ['INBOX', 'INBOX.Sent', 'INBOX.Drafts']);
  assert.deepEqual(folders.folders[0], {
    path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', subscribed: false, messages: 2, unseen: 1,
  });

  const message = await client.message('', 'INBOX', 8);
  assert.equal(message.untrustedContent, true);
  assert.equal(message.text, 'Premier message\nSuite de la conversation');
  assert.equal(message.messageId, '<original@example.com>');
  assert.deepEqual(message.attachments[0], {
    id: '0', filename: 'facture.pdf', contentType: 'application/pdf', size: 3, contentId: '', inline: false,
  });

  assert.ok(imap.locks.length >= 3);
  assert.ok(imap.locks.every((lock) => lock.readOnly), 'every read lock is EXAMINE');
  assert.deepEqual([imap.flagWrites, imap.appended.length, smtp.created], [0, 0, 0]);
  assert.equal(imap.logouts, imap.connections);

  await assert.rejects(client.message('', 'INBOX', 0), /UID IMAP invalide/);
  await assert.rejects(client.message('', 'INBOX', 42), /introuvable : UID 42/);
  const small = setup({ maxMessageBytes: 1024 }).client;
  await assert.rejects(small.message('', 'INBOX', 8), /Message trop volumineux \(1200 octets, limite 1024\)/);
});

test('the default parser reads a real MIME source', async () => {
  const source = [
    'From: Alice <alice@example.com>', 'To: agent@example.com', 'Subject: Bonjour',
    'Message-ID: <real@example.com>', 'Content-Type: text/plain; charset=utf-8', '', 'Corps réel', '',
  ].join('\r\n');
  const client = new MailClient({
    configuration: configuration(),
    imapFactory: imapServer({ overrides: { async fetchOne(uid, query) {
      return query.source ? { uid, source: Buffer.from(source) } : ORIGINAL;
    } } }).factory,
  });
  const message = await client.message('', 'INBOX', 8);
  assert.equal(message.text.trim(), 'Corps réel');
  assert.deepEqual(message.from, [{ name: 'Alice', address: 'alice@example.com' }]);
});

test('attachments: download returns the bytes, save never overwrites unless asked', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-kit-mail-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { client } = setup();

  const attachment = await client.downloadAttachment('', 'INBOX', 8, '0');
  assert.deepEqual({ ...attachment, data: attachment.data.toString() }, {
    data: 'pdf', filename: 'facture.pdf', contentType: 'application/pdf', size: 3, account: 'perso',
  });
  await assert.rejects(client.downloadAttachment('', 'INBOX', 8, '0', { maxBytes: 2 }), /trop volumineuse/);
  await assert.rejects(client.downloadAttachment('', 'INBOX', 8, '../1'), /pièce jointe invalide/);
  await assert.rejects(client.downloadAttachment('', 'INBOX', 8, '3'), /introuvable/);

  const saved = await client.saveAttachment('', 'INBOX', 8, '0', directory);
  assert.equal(saved.path, path.join(directory, 'facture.pdf'));
  assert.equal('data' in saved, false);
  assert.equal(fs.readFileSync(saved.path, 'utf8'), 'pdf');
  assert.equal(fs.statSync(saved.path).mode & 0o777, 0o600);

  fs.writeFileSync(saved.path, 'local');
  await assert.rejects(client.saveAttachment('', 'INBOX', 8, '0', saved.path), /existe déjà/);
  assert.equal(fs.readFileSync(saved.path, 'utf8'), 'local');
  await client.saveAttachment('', 'INBOX', 8, '0', saved.path, { overwrite: true });
  assert.equal(fs.readFileSync(saved.path, 'utf8'), 'pdf');
  assert.deepEqual(fs.readdirSync(directory), ['facture.pdf']);

  const nested = await client.saveAttachment('', 'INBOX', 8, '0', path.join(directory, 'sous', 'copie.pdf'));
  assert.equal(fs.readFileSync(nested.path, 'utf8'), 'pdf');
});

test('every write is refused without allowWrites, before any connection', async () => {
  const { client, imap, smtp } = setup();
  const input = { to: ['dest@example.org'], subject: 'Objet', text: 'Corps' };
  await assert.rejects(client.saveDraft('', input), /Écriture IMAP refusée : utilise allowWrites=true/);
  await assert.rejects(client.replyDraft('', 'INBOX', 8, input), /Écriture IMAP refusée/);
  await assert.rejects(client.send('', input), /Envoi SMTP refusé : utilise allowWrites=true/);
  await assert.rejects(client.reply('', 'INBOX', 8, input), /Envoi SMTP refusé/);
  assert.deepEqual([imap.connections, smtp.created], [0, 0]);
  const truthy = setup({ allowWrites: 'yes' });
  await assert.rejects(truthy.client.send('', input), /allowWrites=true/);
});

test('a draft is appended once to Drafts with \\Draft, never through SMTP', async () => {
  const { client, imap, smtp } = setup({
    allowWrites: true,
    configuration: configuration({ signatureHtml: '<p>Agent</p>' }),
  });
  const draft = await client.saveDraft('', { bcc: ['Cache@Example.org'], subject: 'Objet', text: 'Corps' });
  assert.equal(smtp.created, 0);
  assert.deepEqual(draft, {
    account: 'perso', messageId: draft.messageId, mailbox: 'INBOX.Drafts', uid: 100, version: draft.version, to: [], sent: false,
  });
  assert.match(draft.version, /^[0-9a-f]{16}$/);
  assert.match(draft.messageId, /^<[0-9a-f-]+@example\.com>$/);
  const [stored] = imap.appended;
  assert.equal(stored.mailbox, 'INBOX.Drafts');
  assert.deepEqual(stored.flags, ['\\Draft'], 'left unread, so that it stands out');
  assert.deepEqual(imap.searches.at(-1), { header: { 'message-id': draft.messageId } });
  const saved = await simpleParser(stored.raw);
  assert.equal(saved.messageId, draft.messageId);
  assert.deepEqual(saved.from.value, [{ name: 'Perso', address: 'agent@example.com' }]);
  // The mail client sends this draft later: the blind copy must survive.
  assert.equal(saved.bcc.text, 'cache@example.org');
  assert.match(saved.html, /mail-signature/);

  // Already there (same Message-ID): nothing is appended a second time.
  const present = setup({ allowWrites: true, imap: { overrides: { async search() { return [7]; } } } });
  const again = await present.client.saveDraft('', { subject: 'Objet', text: 'Corps' });
  assert.deepEqual([again.uid, present.imap.appended.length], [7, 0]);

  // The connection drops after the server stored it: found again, not duplicated.
  const dropped = setup({
    allowWrites: true,
    imap: { overrides: (state) => ({
      async append(mailbox, raw, flags) {
        state.appended.push({ mailbox, raw, flags, uid: 55 });
        throw new Error('connexion perdue');
      },
    }) },
  });
  assert.equal((await dropped.client.saveDraft('', { subject: 'Objet', text: 'Corps' })).uid, 55);
  assert.equal(dropped.imap.appended.length, 1);

  // No uid from APPEND and nothing found: the append is not proven.
  const lost = setup({ allowWrites: true, imap: { overrides: { async search() { return []; }, async append() { return {}; } } } });
  await assert.rejects(lost.client.saveDraft('', { subject: 'Objet', text: 'Corps' }), /introuvable dans « Brouillons » après ajout IMAP/);

  // Drafts found by its French name when the server has no special-use flag.
  const french = setup({ allowWrites: true, imap: { folders: [{ path: 'Brouillons', name: 'Brouillons' }] } });
  assert.equal((await french.client.saveDraft('', { subject: 'Objet', text: 'Corps' })).mailbox, 'Brouillons');
  const none = setup({ allowWrites: true, imap: { folders: [{ path: 'INBOX', name: 'INBOX' }] } });
  await assert.rejects(none.client.saveDraft('', { subject: 'Objet', text: 'Corps' }), /Aucun dossier IMAP « Brouillons »/);
});

test('send goes through SMTP once, then archives the same message in Sent', async () => {
  const { client, imap, smtp } = setup({ allowWrites: true });
  const result = await client.send('', {
    from: 'usurpation@example.org', to: ['Dest@Example.org'], cc: ['copie@example.org'], subject: 'Objet', text: 'Corps',
  });
  assert.equal(smtp.sent.length, 1);
  const [sent] = smtp.sent;
  assert.deepEqual(sent.from, { name: 'Perso', address: 'agent@example.com' });
  assert.deepEqual(sent.to, ['dest@example.org']);
  assert.equal(sent.text, 'Corps');
  assert.equal('html' in sent, false);
  assert.deepEqual(result, {
    account: 'perso', messageId: sent.messageId, accepted: 2, rejected: 0,
    archived: true, archiveMailbox: 'INBOX.Sent', archiveUid: 100,
  });
  assert.equal(imap.appended.length, 1);
  assert.deepEqual(imap.appended[0].flags, ['\\Seen']);
  assert.equal((await simpleParser(imap.appended[0].raw)).messageId, sent.messageId);
  assert.equal(smtp.closed, 1);
});

test('an archive failure after SMTP acceptance is reported, never thrown', async () => {
  const audit = [];
  const { client, smtp } = setup({
    allowWrites: true,
    audit: (entry) => audit.push(entry),
    imap: { overrides: { async list() { throw new Error(`IMAP indisponible pour ${PASSWORD}`); } } },
  });
  const result = await client.send('', { to: ['dest@example.org'], subject: 'Objet', text: 'Corps' });
  assert.equal(result.archived, false);
  assert.equal(result.archiveError, 'IMAP indisponible pour «valeur masquée»');
  assert.equal(smtp.sent.length, 1);
  assert.deepEqual(audit.map((entry) => entry.outcome), ['accepted-unarchived']);
});

test('an SMTP failure is redacted, audited and never archived', async () => {
  const audit = [];
  const refused = Object.assign(new Error(`535 refus pour ${PASSWORD}`), { code: 'EAUTH', response: PASSWORD });
  const { client, imap } = setup({ allowWrites: true, smtp: { failure: refused }, audit: (entry) => audit.push(entry) });
  await assert.rejects(client.send('', { to: ['dest@example.org'], subject: 'Objet', text: 'Corps' }), (error) => {
    assert.ok(error instanceof MailError);
    assert.equal(error.code, 'EAUTH');
    assert.equal(error.message, '535 refus pour «valeur masquée»');
    assert.doesNotMatch(inspect(error, { depth: 5 }), new RegExp(PASSWORD));
    return true;
  });
  assert.equal(imap.appended.length, 0);
  assert.deepEqual(audit.map((entry) => entry.outcome), ['failed']);
});

test('a reply keeps the thread and quotes the original in French, below signature and mark', async () => {
  const mark = { text: '✦', html: '<p class="mark">✦</p>' };
  const { client, smtp, imap } = setup({
    allowWrites: true, mark, configuration: configuration({ signatureHtml: '<p>Agent</p>' }),
  });
  const result = await client.reply('', 'INBOX', 8, { to: ['alice@example.com'], subject: 'ignoré', text: 'Voici la réponse.' });
  const [sent] = smtp.sent;
  assert.equal(result.archived, true);
  assert.equal(sent.subject, 'Re: Crédit photo');
  assert.equal(sent.inReplyTo, '<original@example.com>');
  assert.deepEqual(sent.references, ['<before@example.com>', '<original@example.com>']);
  assert.ok(sent.html.indexOf('mail-signature') < sent.html.indexOf(mark.html));
  assert.ok(sent.html.indexOf(mark.html) < sent.html.indexOf('<blockquote'));
  assert.match(sent.html, /<blockquote[^>]*><p>Premier message<\/p><\/blockquote>/);
  assert.doesNotMatch(sent.html, /hostile/);
  assert.match(sent.text, /^Voici la réponse\.\n\nAgent\n\n✦\n\nLe 2026-09-17 23:35, Alice a écrit\u00a0:\n> Premier message\n> Suite/);
  // Laid out as Roundcube does: its heading, a cited blockquote with its blue bar.
  assert.match(sent.html, /<div class="mail-history"><p>Le 2026-09-17 23:35, Alice a écrit\u00a0:<\/p><blockquote type="cite" style="padding:0 0\.4em;border-left:#1010ff 2px solid;margin:0">/);
  assert.ok(imap.locks.filter((lock) => lock.mailbox === 'INBOX').every((lock) => lock.readOnly));

  const drafting = setup({ allowWrites: true, parsed: { references: undefined } });
  const draft = await drafting.client.replyDraft('', 'INBOX', 8, { to: ['alice@example.com'], text: 'Brouillon de réponse.' });
  assert.equal(drafting.smtp.created, 0);
  const saved = await simpleParser(drafting.imap.appended[0].raw);
  assert.equal(saved.messageId, draft.messageId);
  assert.equal(saved.subject, 'Re: Crédit photo');
  assert.equal(saved.inReplyTo, '<original@example.com>');
  assert.equal(saved.references, '<original@example.com>');

  // A message without HTML, or whose HTML keeps no text, is quoted from its text part.
  for (const html of [false, '<img src="https://example.com/a.png"><style>p{}</style>']) {
    const textOnly = setup({ allowWrites: true, parsed: { html } });
    await textOnly.client.reply('', 'INBOX', 8, { to: ['alice@example.com'], text: 'Oui' });
    assert.match(textOnly.smtp.sent[0].html, /<blockquote[^>]*>Premier message<br>Suite de la conversation<\/blockquote>/);
  }

  const prefixed = setup({ allowWrites: true, imap: { inbox: [{ ...ORIGINAL, envelope: { ...ORIGINAL.envelope, subject: 'RE: Déjà' } }] } });
  await prefixed.client.reply('', 'INBOX', 8, { to: ['alice@example.com'], text: 'Oui' });
  assert.equal(prefixed.smtp.sent[0].subject, 'RE: Déjà');

  const orphan = setup({
    allowWrites: true, parsed: { messageId: '' },
    imap: { inbox: [{ ...ORIGINAL, envelope: { ...ORIGINAL.envelope, messageId: '' } }] },
  });
  await assert.rejects(orphan.client.replyDraft('', 'INBOX', 8, { text: 'Oui' }), /pas de Message-ID utilisable/);
  assert.equal(orphan.imap.appended.length, 0);
});

test('a reply draft without recipients answers like a mail client; a sent reply names its own', async () => {
  const addressed = async (parsed, input = {}) => {
    const { client, imap, smtp } = setup({ allowWrites: true, parsed });
    const draft = await client.replyDraft('', 'INBOX', 8, { text: 'Réponse.', ...input });
    const saved = await simpleParser(imap.appended[0].raw);
    assert.deepEqual(saved.to?.value.map((entry) => entry.address) || [], draft.to, 'the result says who it is for');
    assert.equal(smtp.created, 0);
    return draft.to;
  };
  assert.deepEqual(await addressed({}), ['alice@example.com'], 'the sender');
  assert.deepEqual(await addressed({}, { to: [] }), ['alice@example.com'], 'an empty list, as the MCP default sends it');
  assert.deepEqual(await addressed({ replyTo: { value: [{ address: 'Contact@Example.org' }] } }), ['contact@example.org'],
    'Reply-To first, as a website form sets it');
  assert.deepEqual(await addressed({
    replyTo: { value: [{ address: 'agent@example.com' }] },
    from: { value: [{ address: 'AGENT@example.com' }] },
    to: { value: [{ address: 'alice@example.com' }, { address: 'agent@example.com' }, { address: 'bob@example.org' }] },
  }), ['alice@example.com', 'bob@example.org'], 'our own message goes back to its recipients, never to ourselves');
  assert.deepEqual(await addressed({ replyTo: { value: [{ address: 'contact@example.org' }] } }, { to: ['dest@example.org'] }),
    ['dest@example.org'], 'a named recipient wins');

  // Sending stays explicit: refused before any connection, even with a sender at hand.
  const { client, imap, smtp } = setup({ allowWrites: true });
  for (const input of [{ text: 'Oui' }, { to: [], text: 'Oui' }]) {
    await assert.rejects(client.reply('', 'INBOX', 8, input), /exige son destinataire \(to\)/);
  }
  assert.deepEqual([imap.connections, smtp.created], [0, 0]);
});

/**
 * A Drafts folder that keeps what is appended: a draft saved by the client can
 * be read back (real MIME, real parser) and updated. UID 8 stays the original.
 */
function draftSetup({ uidplus = true, overrides, ...options } = {}) {
  const server = imapServer({ overrides: (state) => {
    state.deletes ||= [];
    state.flagCalls ||= [];
    const stored = (uid) => state.appended.find((item) => item.uid === uid && !state.deletes.includes(uid));
    return {
      capabilities: new Map(uidplus ? [['UIDPLUS', true]] : []),
      async fetchOne(uid, query) {
        const draft = stored(uid);
        if (draft) return query.source ? { uid, source: draft.raw } : { uid, flags: new Set(draft.flags), size: draft.raw.length, envelope: {} };
        if (uid !== ORIGINAL.uid) return false;
        return query.source ? { uid, source: Buffer.from('raw source') } : ORIGINAL;
      },
      async messageDelete(range, flags) { state.deletes.push(range); state.flagCalls.push(['delete', range, flags]); return true; },
      async messageFlagsAdd(range, flags, query) { state.flagCalls.push(['add', range, flags, query]); return true; },
      async messageFlagsRemove(range, flags, query) { state.flagCalls.push(['remove', range, flags, query]); return true; },
      ...(typeof overrides === 'function' ? overrides(state) : overrides),
    };
  } });
  const audit = [];
  const client = new MailClient({
    configuration: configuration({ signatureHtml: '<p>Agent</p>' }),
    allowWrites: true,
    mark: { text: '✦', html: '<p class="mark">✦</p>' },
    imapFactory: server.factory,
    smtpFactory: smtpServer().factory,
    parser: async (source, parserOptions) => (source.toString() === 'raw source' ? parsedOriginal() : simpleParser(source, parserOptions)),
    audit: (entry) => audit.push(entry),
    ...options,
  });
  const read = async (uid) => simpleParser(server.state.appended.find((item) => item.uid === uid).raw);
  return { client, imap: server.state, audit, read };
}

test('a draft update rewrites the written part, keeps signature, mark and history once, and stays unread', async () => {
  const { client, imap, audit, read } = draftSetup();
  const first = await client.replyDraft('', 'INBOX', 8, { to: ['alice@example.com'], text: 'Premier jet.' });
  const updated = await client.updateDraft('', '', first.uid, {
    version: first.version, text: 'Version **finale**.', cc: ['Copie@Example.org'],
  });

  assert.deepEqual(updated, {
    account: 'perso', messageId: updated.messageId, mailbox: 'INBOX.Drafts', uid: 101, version: updated.version,
    sent: false, seen: false, bodyReplaced: true, historyKept: true, previous: { uid: 100, deleted: true, expunged: true },
  });
  assert.notEqual(updated.version, first.version);
  assert.notEqual(updated.messageId, first.messageId, 'a new version, never mistaken for the old one');
  const stored = imap.appended.at(-1);
  assert.deepEqual([stored.mailbox, stored.flags], ['INBOX.Drafts', ['\\Draft']]);
  assert.deepEqual(imap.flagCalls, [['delete', 100, { uid: true }]]);

  const draft = await read(101);
  assert.equal(draft.subject, 'Re: Crédit photo');
  assert.equal(draft.inReplyTo, '<original@example.com>');
  assert.equal(draft.to.text, 'alice@example.com');
  assert.equal(draft.cc.text, 'copie@example.org');
  assert.match(draft.text, /^Version \*\*finale\*\*\.\n\nAgent\n\n✦\n\nLe 2026-09-17 23:35, Alice a écrit\u00a0:\n> Premier message\n> Suite/);
  assert.doesNotMatch(draft.text, /Premier jet/);
  for (const [part, pattern] of [[draft.html, /mail-signature/g], [draft.html, /class="mark"/g], [draft.html, /mail-history/g], [draft.text, /a écrit\u00a0:/g]]) {
    assert.equal(part.match(pattern).length, 1, `${pattern} once`);
  }
  assert.ok(draft.html.indexOf('Version') < draft.html.indexOf('mail-history'));

  // A second update finds the history the first one kept, and the version it returned.
  const again = await client.updateDraft('', 'INBOX.Drafts', 101, { version: updated.version, html: '<p>Troisième</p>' });
  assert.equal(again.historyKept, true);
  assert.match((await read(again.uid)).text, /^Troisième\n\nAgent\n\n✦\n\nLe 2026-09-17 /);
  assert.deepEqual(audit.map(({ operation, outcome }) => [operation, outcome]), [
    ['reply-draft', 'draft-saved'], ['draft-update', 'draft-updated'], ['draft-update', 'draft-updated'],
  ]);
  assert.deepEqual(audit[1], {
    connector: 'mail', account: 'perso', operation: 'draft-update', toCount: 1, ccCount: 1, bccCount: 0,
    attachmentCount: 0, outcome: 'draft-updated',
  });
});

test('a draft update without a new body keeps it byte for byte, and its attachments', async () => {
  const { client, read } = draftSetup();
  const first = await client.saveDraft('', {
    to: ['dest@example.org'], bcc: ['cache@example.org'], subject: 'Devis', text: 'Corps initial',
    attachments: [{ filename: 'devis.pdf', content: Buffer.from('pdf') }],
  });
  const before = await read(first.uid);
  const updated = await client.updateDraft('', '', first.uid, {
    version: first.version, subject: 'Devis révisé', attachments: [{ filename: 'annexe.txt', content: 'annexe' }],
  });
  assert.equal(updated.bodyReplaced, false);
  assert.equal('historyKept' in updated, false);
  const after = await read(updated.uid);
  assert.equal(after.subject, 'Devis révisé');
  assert.equal(after.text, before.text);
  assert.equal(after.html, before.html);
  assert.equal(after.bcc.text, 'cache@example.org');
  assert.deepEqual(after.attachments.map((item) => [item.filename, item.content.toString()]), [['devis.pdf', 'pdf'], ['annexe.txt', 'annexe']]);
});

test('a reply carries the inline images its quote shows, as Roundcube does, and an update keeps them', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('logo')]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('photo')]);
  const inline = (cid, content, contentType = 'image/png') => ({
    cid, content, contentType, contentDisposition: 'inline', filename: `${cid}.img`, size: content.length,
  });
  const original = parsedOriginal({
    html: '<p>Bonjour</p><img src="cid:logo@x" alt="Logo" width="96" style="width:1in;position:absolute">'
      + '<img src="cid:logo@x"><img src="cid:photo@x"><img src="https://tracker.example/p.gif">'
      + '<img src="cid:svg@x"><img src="cid:absent@x"><img src="data:image/png;base64,AAAA">',
    attachments: [
      inline('logo@x', png),
      inline('photo@x', jpeg, 'application/octet-stream'),
      inline('svg@x', Buffer.from('<svg onload="x()"/>'), 'image/png'),
      { filename: 'devis.pdf', contentType: 'application/pdf', content: Buffer.from('pdf'), size: 3 },
    ],
  });
  const { client, imap } = draftSetup({
    parser: async (source, options) => (source.toString() === 'raw source' ? original : simpleParser(source, options)),
  });
  const read = (uid) => simpleParser(imap.appended.find((item) => item.uid === uid).raw, { keepCidLinks: true });
  const first = await client.replyDraft('', 'INBOX', 8, { to: ['alice@example.com'], text: 'Premier jet.' });
  const draft = await read(first.uid);
  const images = draft.attachments.map((item) => [item.contentType, item.contentDisposition, item.content.toString('latin1')]);
  assert.deepEqual(images, [['image/png', 'inline', png.toString('latin1')], ['image/jpeg', 'inline', jpeg.toString('latin1')]],
    'the logo once, the photo by its bytes; no SVG, no unknown image, no PDF of the original');
  const cids = draft.attachments.map((item) => item.cid);
  assert.ok(cids.every((cid) => /^[0-9a-f-]{36}@example\.com$/.test(cid)), 'new Content-IDs on the mailbox domain');
  const [logo, photo] = cids;
  assert.match(draft.html, new RegExp(`<img src="cid:${logo}" alt="Logo" width="96" style="width:1in"><img src="cid:${logo}"><img src="cid:${photo}">`));
  assert.doesNotMatch(draft.html, /tracker|svg@x|absent@x|data:image|logo@x/);
  assert.equal(imap.appended.length, 1);

  const updated = await client.updateDraft('', '', first.uid, { version: first.version, text: 'Version finale.' });
  assert.equal(updated.historyKept, true);
  const again = await read(updated.uid);
  assert.deepEqual(again.attachments.map((item) => item.cid), cids, 'the quote keeps its images');
  const replaced = await client.updateDraft('', '', updated.uid, { version: updated.version, text: 'Sans historique.', wholeBody: true });
  assert.deepEqual((await read(replaced.uid)).attachments, [], 'they leave with the history');
});

test('inline images of a quote are bounded in number and bytes', async () => {
  const png = (size) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size)]);
  const many = Array.from({ length: 25 }, (_, index) => ({ cid: `i${index}`, content: png(10), contentType: 'image/png' }));
  const sent = setup({ allowWrites: true, parsed: { html: many.map((item) => `<img src="cid:${item.cid}">`).join(''), attachments: many } });
  await sent.client.reply('', 'INBOX', 8, { to: ['alice@example.com'], text: 'Oui' });
  assert.equal(sent.smtp.sent[0].attachments.length, 20);
  assert.equal((sent.smtp.sent[0].html.match(/<img /g) || []).length, 20);

  const heavy = [{ cid: 'a', content: png(3 * 1024 * 1024), contentType: 'image/png' }, { cid: 'b', content: png(3 * 1024 * 1024), contentType: 'image/png' }];
  const bounded = setup({ allowWrites: true, parsed: { html: '<p>x</p><img src="cid:a"><img src="cid:b">', attachments: heavy } });
  await bounded.client.reply('', 'INBOX', 8, { to: ['alice@example.com'], text: 'Oui' });
  assert.equal(bounded.smtp.sent[0].attachments.length, 1, '5 MiB in all');
});

test('a reply draft whose history was lost keeps its body unless wholeBody replaces it all', async () => {
  const { client, imap, audit, read } = draftSetup();
  const first = await client.replyDraft('', 'INBOX', 8, { text: 'Premier jet.' });
  // Rewritten by a mail client into markup no one recognizes; the text is the same.
  const stored = imap.appended.at(-1);
  stored.raw = Buffer.from(stored.raw.toString().replace(/mail-history|type=(?:3D)?"cite"/g, 'autre-chose'));
  await assert.rejects(client.updateDraft('', '', first.uid, { version: first.version, text: 'Nouveau' }), (error) => {
    assert.equal(error.code, 'DRAFT_HISTORY_NOT_FOUND');
    assert.match(error.message, /Historique cité introuvable[^]*wholeBody: true/);
    assert.equal(error.details.current.text, 'Premier jet.');
    return true;
  });
  assert.equal(imap.appended.length, 1, 'nothing appended');
  assert.deepEqual(imap.flagCalls, [], 'nothing deleted');
  assert.equal(audit.at(-1).outcome, 'failed-before-append');

  const replaced = await client.updateDraft('', '', first.uid, { version: first.version, text: 'Nouveau', wholeBody: true });
  assert.equal(replaced.historyKept, false);
  const draft = await read(replaced.uid);
  assert.equal(draft.text, 'Nouveau\n\nAgent\n\n✦');
  assert.equal(draft.inReplyTo, '<original@example.com>', 'the thread stays');
});

test('a draft update refuses what is not a draft, and checks its input before any connection', async () => {
  const { client, imap } = draftSetup();
  await assert.rejects(client.updateDraft('', 'INBOX', 8, { subject: 'Détourné' }), /UID 8 n’est pas un brouillon/);
  assert.equal(imap.appended.length, 0);

  const connections = imap.connections;
  await assert.rejects(client.updateDraft('', '', 100, {}), /Aucune modification demandée/);
  await assert.rejects(client.updateDraft('', '', 100, { text: '' }), /Aucune modification demandée/);
  await assert.rejects(client.updateDraft('', '', 100, { to: ['pas une adresse'] }), /Destinataire n’est pas une adresse/);
  await assert.rejects(client.updateDraft('', '', 100, { subject: ' ' }), /objet du mail est requis/);
  await assert.rejects(client.updateDraft('', '', 0, { subject: 'Objet' }), /UID IMAP invalide/);
  await assert.rejects(client.updateDraft('', '', 100, {
    attachments: Array.from({ length: 11 }, (_, index) => ({ filename: `${index}.txt`, content: 'x' })),
  }), /Au maximum 10 pièces jointes/);
  assert.equal(imap.connections, connections);
  await assert.rejects(setup().client.updateDraft('', '', 100, { subject: 'Objet' }), /Écriture IMAP refusée/);
  await assert.rejects(client.updateDraft('', '', 404, { subject: 'Objet' }), /introuvable : UID 404/);
  const none = draftSetup({ overrides: { async list() { return [{ path: 'INBOX', name: 'INBOX' }]; } } });
  await assert.rejects(none.client.updateDraft('', '', 100, { subject: 'Objet' }), /Aucun dossier IMAP « Brouillons »/);
});

test('once the new version is stored, a failed deletion is reported, never thrown', async () => {
  const flagged = draftSetup({ uidplus: false });
  const first = await flagged.client.saveDraft('', { subject: 'Objet', text: 'Corps' });
  const kept = await flagged.client.updateDraft('', '', first.uid, { version: first.version, subject: 'Objet 2' });
  // Without UIDPLUS, EXPUNGE would remove every \Deleted message: only flagged.
  assert.deepEqual(kept.previous, { uid: first.uid, deleted: true, expunged: false });
  assert.deepEqual(flagged.imap.flagCalls, [['add', first.uid, ['\\Deleted'], { uid: true }]]);

  const refused = draftSetup({ overrides: { async messageDelete() { throw new Error(`refus pour ${PASSWORD}`); } } });
  const draft = await refused.client.saveDraft('', { subject: 'Objet', text: 'Corps' });
  const result = await refused.client.updateDraft('', '', draft.uid, { version: draft.version, subject: 'Objet 2' });
  assert.equal(result.uid, draft.uid + 1);
  assert.deepEqual(result.previous, { uid: draft.uid, deleted: false, expunged: false, error: 'refus pour «valeur masquée»' });
  assert.equal(refused.audit.at(-1).outcome, 'draft-updated-previous-kept');
});

test('an update starts from the draft as it stands: no or an outdated version changes nothing and returns it', async () => {
  const { client, imap, audit } = draftSetup();
  const first = await client.replyDraft('', 'INBOX', 8, { to: ['alice@example.com'], text: 'Premier jet.\n\nÀ demain.' });
  const appended = imap.appended.length;
  const current = {
    version: first.version, subject: 'Re: Crédit photo', to: ['alice@example.com'], cc: [], bcc: [],
    text: 'Premier jet.\n\nÀ demain.', historyFound: true,
  };
  await assert.rejects(client.updateDraft('', '', first.uid, { text: 'Nouveau' }), (error) => {
    assert.equal(error.code, 'DRAFT_VERSION_REQUIRED');
    assert.match(error.message, /Version du brouillon manquante[^]*Rien n’a été modifié/);
    // Without signature, mark or history: exactly what the agent rewrites.
    assert.deepEqual(error.details, { current });
    return true;
  });
  await assert.rejects(client.updateDraft('', '', first.uid, { version: '0123456789abcdef', subject: 'Autre' }), (error) => {
    assert.equal(error.code, 'DRAFT_CHANGED');
    assert.deepEqual(error.details.current, current);
    return true;
  });
  assert.equal(imap.appended.length, appended, 'nothing appended');
  assert.deepEqual(imap.flagCalls, [], 'nothing deleted');
  assert.deepEqual(audit.slice(-2).map((entry) => entry.outcome), ['failed-before-append', 'failed-before-append']);

  // Reading the draft gives the same view; a read state is not an edit.
  await client.setSeen('', 'INBOX.Drafts', first.uid, true);
  const read = await client.message('', 'INBOX.Drafts', first.uid);
  assert.deepEqual(read.draft, current);
  assert.equal((await client.message('', 'INBOX', 8)).draft, undefined, 'only a \\Draft message has a draft view');
  assert.equal((await client.updateDraft('', '', first.uid, { version: read.draft.version, text: 'Nouveau' })).historyKept, true);
});

test('a draft written in another mail client keeps its quoted history', async () => {
  const { client, imap, read } = draftSetup();
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const { message: raw } = await transport.sendMail({
    from: 'agent@example.com', to: 'alice@example.com', subject: 'Re: Devis', inReplyTo: '<devis@example.com>',
    text: 'Mon brouillon.\n\nLe 14/10/2026 à 10:00, Alice a écrit :\n> Devis joint.',
    html: '<p>Mon brouillon.</p><div class="moz-cite-prefix">Le 14/10/2026 à 10:00, Alice a écrit :<br></div>'
      + '<blockquote type="cite"><p>Devis joint.</p></blockquote>',
  });
  imap.appended.push({ mailbox: 'INBOX.Drafts', raw, flags: ['\\Draft'], uid: 50 });
  const { draft } = await client.message('', 'INBOX.Drafts', 50);
  assert.equal(draft.text, 'Mon brouillon.');
  assert.equal(draft.historyFound, true);
  const updated = await client.updateDraft('', 'INBOX.Drafts', 50, { version: draft.version, text: 'Brouillon repris.' });
  assert.equal(updated.historyKept, true);
  const saved = await read(updated.uid);
  assert.match(saved.html, /^<div>Brouillon repris\.<\/div><br><div class="mail-signature">[^]*<div class="moz-cite-prefix">[^]*<blockquote type="cite"><p>Devis joint/);
  assert.match(saved.text, /^Brouillon repris\.\n\nAgent\n\n✦\n\nLe 14\/10\/2026 à 10:00, Alice a écrit :\n> Devis joint\.$/);
});

test('an update costs no extra IMAP round trip: no LIST for a named draft, no SEARCH before the append', async () => {
  const { client, imap } = draftSetup();
  const first = await client.saveDraft('', { subject: 'Objet', text: 'Corps' });
  const [lists, searches, connections] = [imap.lists.length, imap.searches.length, imap.connections];
  const updated = await client.updateDraft('', first.mailbox, first.uid, { version: first.version, text: 'Corps 2' });
  assert.equal(imap.connections - connections, 1, 'one connection');
  assert.equal(imap.lists.length - lists, 0, 'the folder is named and the message is a \\Draft');
  assert.equal(imap.searches.length - searches, 0, 'APPEND returned the UID: nothing to search');
  // Without a folder, one LIST finds Drafts.
  await client.updateDraft('', '', updated.uid, { version: updated.version, subject: 'Objet 2' });
  assert.equal(imap.lists.length - lists, 1);
});

test('setSeen marks one message read or unread, and nothing else', async () => {
  const { client, imap, audit } = draftSetup();
  assert.deepEqual(await client.setSeen('', 'INBOX.Drafts', 8, false), { account: 'perso', mailbox: 'INBOX.Drafts', uid: 8, seen: false });
  assert.deepEqual(await client.setSeen('', 'INBOX', 8, true), { account: 'perso', mailbox: 'INBOX', uid: 8, seen: true });
  assert.deepEqual(imap.flagCalls, [['remove', 8, ['\\Seen'], { uid: true }], ['add', 8, ['\\Seen'], { uid: true }]]);
  assert.ok(imap.locks.every((lock) => !lock.readOnly));
  assert.deepEqual(audit, [
    { connector: 'mail', account: 'perso', operation: 'mark-unread', outcome: 'marked-unread' },
    { connector: 'mail', account: 'perso', operation: 'mark-read', outcome: 'marked-read' },
  ]);

  await assert.rejects(client.setSeen('', 'INBOX', 404, true), /introuvable : UID 404/);
  assert.equal(audit.at(-1).outcome, 'failed');
  await assert.rejects(client.setSeen('', 'INBOX', 8, 'non'), /true ou false/);
  const declined = draftSetup({ overrides: { async messageFlagsAdd() { return false; } } });
  await assert.rejects(declined.client.setSeen('', 'INBOX', 8, true), /refusé de changer l’état lu/);
  const readOnly = setup();
  await assert.rejects(readOnly.client.setSeen('', 'INBOX', 8, false), /Écriture IMAP refusée/);
  assert.equal(readOnly.imap.connections, 0);
});

test('signature and mark: no mark by default, the configured one otherwise', async () => {
  const plain = setup({ allowWrites: true, configuration: configuration({ signatureHtml: '<p>Agent<br>Example &amp; Cie</p>' }) });
  await plain.client.send('', { to: ['dest@example.org'], subject: 'Objet', text: 'Corps' });
  const [unmarked] = plain.smtp.sent;
  assert.equal(unmarked.text, 'Corps\n\nAgent\nExample & Cie');
  assert.equal(unmarked.html, '<div>Corps</div><br><div class="mail-signature"><p>Agent<br>Example &amp; Cie</p></div>');
  assert.equal(unmarked.headers, undefined);
  assert.doesNotMatch(plain.imap.appended[0].raw.toString(), /^X-/m);

  const mark = { text: '✦', html: '<p class="mark">✦</p>', header: { name: 'X-Test-Agent', value: 'assistant 1.0' } };
  const marked = setup({ allowWrites: true, mark, configuration: configuration({ signatureHtml: '<p>Agent</p>' }) });
  await marked.client.send('', { to: ['dest@example.org'], subject: 'Objet', html: '<p>Corps <b>riche</b></p>' });
  const [signed] = marked.smtp.sent;
  assert.equal(signed.text, 'Corps riche\n\nAgent\n\n✦');
  assert.ok(signed.html.endsWith(`<div class="mail-signature"><p>Agent</p></div>${mark.html}`));
  assert.equal((await simpleParser(marked.imap.appended[0].raw)).headers.get('x-test-agent'), 'assistant 1.0');

  const textOnly = setup({ allowWrites: true, mark: { text: '-- agent' } });
  await textOnly.client.send('', { to: ['dest@example.org'], subject: 'Objet', html: '<p>Corps</p>' });
  assert.ok(textOnly.smtp.sent[0].html.endsWith('<p>-- agent</p>'));

  assert.throws(() => new MailClient({ mark: { text: '✦', header: { name: 'From', value: 'x' } } }), /en-tête X-/);
  assert.throws(() => new MailClient({ mark: { header: { name: 'X-Agent', value: 'a\r\nBcc: b' } } }), /une ligne/);
});

test('recipient, attachment and body limits are enforced before any connection', async () => {
  const { client, imap, smtp } = setup({ allowWrites: true });
  const many = Array.from({ length: 51 }, (_, index) => `dest${index}@example.org`);
  const base = { to: ['dest@example.org'], subject: 'Objet', text: 'Corps' };
  await assert.rejects(client.send('', { ...base, to: many }), /Destinataire dépasse 50 destinataires/);
  await assert.rejects(client.send('', { ...base, bcc: many }), /Copie cachée dépasse 50/);
  await assert.rejects(client.send('', { ...base, to: 'dest@example.org' }), /doit être une liste/);
  await assert.rejects(client.send('', { ...base, cc: ['pas une adresse'] }), /Copie n’est pas une adresse/);
  await assert.rejects(client.send('', { ...base, to: [] }), /Au moins un destinataire/);
  await assert.rejects(client.send('', { ...base, subject: ' ' }), /L’objet du mail est requis/);
  await assert.rejects(client.send('', { ...base, text: '' }), /Le corps du mail est vide/);
  const files = Array.from({ length: 11 }, (_, index) => ({ filename: `${index}.txt`, content: 'x' }));
  await assert.rejects(client.send('', { ...base, attachments: files }), /Au maximum 10 pièces jointes/);
  assert.deepEqual([imap.connections, smtp.created], [0, 0]);
});

test('audit entries count recipients and never carry content', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-kit-mail-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entries = [];
  const { client, imap } = setup({ allowWrites: true, audit: (entry) => entries.push(entry) });
  const secret = { subject: 'Objet secret', text: 'Corps secret', to: ['secret-dest@example.org'] };
  await client.saveDraft('', { ...secret, cc: ['secret-copie@example.org'] });
  await client.send('', { ...secret, bcc: ['secret-cache@example.org'], attachments: [{ filename: 'secret.txt', content: 'x' }] });
  await client.reply('', 'INBOX', 8, { text: 'Réponse secrète', to: ['secret-dest@example.org'] });
  const connections = imap.connections;
  await assert.rejects(client.send('', { ...secret, attachments: [{ filename: 'absent.pdf', path: path.join(directory, 'absent.pdf') }] }),
    (error) => error instanceof MailError && /ENOENT/.test(error.message));
  assert.equal(imap.connections, connections, 'a message that cannot be built opens nothing');

  assert.deepEqual(entries.map(({ operation, outcome }) => [operation, outcome]), [
    ['draft', 'draft-saved'], ['send', 'accepted-archived'], ['reply', 'accepted-archived'], ['send', 'failed-before-smtp'],
  ]);
  assert.deepEqual(entries[1], {
    connector: 'mail', account: 'perso', operation: 'send', toCount: 1, ccCount: 0, bccCount: 1, attachmentCount: 1,
    outcome: 'accepted-archived',
  });
  assert.equal(entries[0].ccCount, 1);
  assert.doesNotMatch(JSON.stringify(entries), /secret|Réponse|example\.org|Crédit/);

  // A failing journal never turns an accepted send into an error.
  const broken = setup({ allowWrites: true, audit: () => { throw new Error('disque plein'); } });
  assert.equal((await broken.client.send('', { to: ['dest@example.org'], subject: 'Objet', text: 'Corps' })).archived, true);
  const rejecting = setup({ allowWrites: true, audit: async () => { throw new Error('disque plein'); } });
  assert.equal((await rejecting.client.saveDraft('', { subject: 'Objet', text: 'Corps' })).sent, false);
});

test('authorize runs once before the first operation and can refuse', async () => {
  let calls = 0;
  const allowed = setup({ authorize: async () => { calls += 1; } });
  await allowed.client.accounts();
  await allowed.client.folders();
  await allowed.client.messages();
  assert.equal(calls, 1);

  let attempts = 0;
  const refused = setup({
    allowWrites: true,
    authorize: () => { attempts += 1; throw new Error('La session active n’autorise pas ce connecteur.'); },
  });
  for (const operation of [
    () => refused.client.accounts(), () => refused.client.verify(), () => refused.client.messages(),
    () => refused.client.send('', { to: ['dest@example.org'], subject: 'Objet', text: 'Corps' }),
  ]) {
    await assert.rejects(operation(), (error) => error instanceof MailError && /n’autorise pas/.test(error.message));
  }
  assert.equal(attempts, 4, 'a refusal is not cached');
  assert.deepEqual([refused.imap.connections, refused.smtp.created], [0, 0]);
});

test('allowedDomains restricts the accounts this project may use', async () => {
  const shared = stringifyAccountConfig([
    account({ id: 'autre', address: 'robin@other.test', username: 'robin@other.test' }),
    account({ default: false }),
  ]);
  const { client, imap } = setup({ configuration: shared, allowedDomains: ['@Example.com'] });
  assert.deepEqual((await client.accounts()).map((item) => item.id), ['perso']);
  await assert.rejects(client.verify('autre'), /hors des domaines autorisés : robin@other\.test/);
  await assert.rejects(client.messages(), /hors des domaines autorisés/, 'the default account is outside too');
  assert.equal(imap.connections, 0);
  assert.equal((await client.verify('perso')).account, 'perso');
  assert.equal((await setup({ configuration: shared }).client.accounts()).length, 2);
});

test('errors never carry the password, even base64 encoded', async () => {
  const [stored] = parseAccountConfig(configuration());
  const plainAuth = Buffer.from(`\0agent@example.com\0${PASSWORD}`).toString('base64');
  assert.equal(redactError(new Error(`a ${PASSWORD}\n b ${Buffer.from(PASSWORD).toString('base64')} c ${plainAuth}`), [stored]),
    'a «valeur masquée» b «valeur masquée» c «valeur masquée»');
  assert.equal(redactError('x'.repeat(600), [stored]).length, 500);
  assert.equal(redactError(null), 'Échec SMTP/IMAP.');

  const { client } = setup({
    imap: { overrides: {
      async connect() {
        throw Object.assign(new Error(`AUTHENTICATIONFAILED ${PASSWORD}`), { authenticationFailed: true, code: 'not a code' });
      },
    } },
  });
  await assert.rejects(client.folders(), (error) => {
    assert.equal(error.message, 'AUTHENTICATIONFAILED «valeur masquée»');
    assert.equal(error.authenticationFailed, true);
    assert.equal(error.code, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('htmlToPlainText keeps line breaks, lists and entities', () => {
  assert.equal(htmlToPlainText('<p>Un&nbsp;&amp;&#233;</p><ul><li>a</li><li>b</li></ul>Fin<br>ici'), 'Un &é\n- a\n- b\nFin\nici');
});

test('a quoted message keeps the original layout, rebuilt from an allow-list', async () => {
  const { Parser } = await import('htmlparser2');
  const quoted = quotableHtml(
    '<html><head><style>p{color:red}</style><title>T</title></head>'
    + '<body class="x" style="font-family:Aptos"><div class="WordSection1" id="w" onclick="steal()">'
    + '<p style="margin:0;font-size:11pt;position:fixed;color:rgb(1, 2, 3);background:url(https://t.example/x)">'
    + 'Bonjour&nbsp;<b>Robin</b>,<o:p></o:p></p>'
    + '<ul><li>un</li><li><a href="https://example.com/a?b=1&amp;c=2" target="_blank">lien</a></li></ul>'
    + '<a href="javascript:alert(1)">piège</a> <a href="JaVaScRiPt&#58;alert(1)">bis</a> <a href="cid:logo">cid</a>'
    + '<span style="display:none">pré-en-tête caché</span><div hidden>caché</div>'
    + '<span style="color:red;font-size:expression(alert(1));margin-top:-500px;margin:0 -1em">rouge</span>'
    + '<span style="font-family:-apple-system, Segoe UI;padding:4px 0">police</span>'
    + '<img src="https://tracker.example/pixel.gif" alt="pixel"><script>steal()</script><iframe src="x">cadre</iframe>'
    + '<form action="https://evil.example"><input value="v">Champ</form>'
    + '<table border="1" width="600"><tr><td colspan="2" rowspan="x">case</td></tr></table>'
    + '<blockquote type="cite"><p>Plus ancien</p></blockquote>'
    + '<p>A &lt;b&gt; reste du texte</p></div></body></html>',
    Parser,
  );
  assert.equal(quoted,
    '<div><p style="margin:0;font-size:11pt;color:rgb(1, 2, 3)">Bonjour\u00a0<b>Robin</b>,</p>'
    + '<ul><li>un</li><li><a href="https://example.com/a?b=1&amp;c=2">lien</a></li></ul>'
    + 'piège bis cid'
    + '<span style="color:red">rouge</span>'
    + '<span style="font-family:-apple-system, Segoe UI;padding:4px 0">police</span>'
    + 'Champ'
    + '<table width="600"><tr><td colspan="2">case</td></tr></table>'
    + '<blockquote><p>Plus ancien</p></blockquote>'
    + '<p>A &lt;b&gt; reste du texte</p></div>');

  // An unclosed head ends at the body; unclosed tags end closed; the result is bounded.
  assert.equal(quotableHtml('<html><head><title>T</title><meta charset="utf-8"><body><p>a</p>', Parser), '<p>a</p>');
  assert.equal(quotableHtml('<div><p>a<b>b', Parser), '<div><p>a<b>b</b></p></div>');
  assert.ok(quotableHtml(`<p>${'x'.repeat(300000)}</p>`, Parser).length <= 100010);
  assert.equal(quotableHtml('<style>p{}</style><img src="a">  ', Parser), '');
  // Nested beyond any real message: quoted up to that depth, and closed.
  const deep = quotableHtml(`<p>début</p>${'<div>'.repeat(1000)}fin`, Parser);
  assert.match(deep, /^<p>début<\/p><div>/);
  assert.doesNotMatch(deep, /fin/);
  assert.equal(deep.split('<div>').length, deep.split('</div>').length);
});

test('remote HTML and draft views stay linear on hostile input', async () => {
  // Quadratic, each of these would take tens of seconds.
  for (const input of ['<a '.repeat(200000), `<li ${'x'.repeat(400000)}`, `${'<br '.repeat(100000)}>`]) {
    const start = performance.now();
    htmlToPlainText(input);
    assert.ok(performance.now() - start < 1000, `${input.slice(0, 6)}…`);
  }
  const { Parser } = await import('htmlparser2');
  for (const input of ['<a '.repeat(200000), '<div><span>'.repeat(100000), '<b>'.repeat(300000), `<p style="${'color:red;'.repeat(100000)}">`]) {
    const start = performance.now();
    quotableHtml(input, Parser);
    assert.ok(performance.now() - start < 1000, `quote ${input.slice(0, 6)}…`);
  }
  const { client, imap } = draftSetup();
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const { message: raw } = await transport.sendMail({
    from: 'agent@example.com', to: 'a@example.com', subject: 'S',
    text: `${'Le '.repeat(130)}\n`.repeat(20000) + ' '.repeat(200000), html: '<blockquote '.repeat(50000),
  });
  imap.appended.push({ mailbox: 'INBOX.Drafts', raw, flags: ['\\Draft'], uid: 60 });
  const start = performance.now();
  assert.equal((await client.message('', 'INBOX.Drafts', 60)).draft.historyFound, false);
  assert.ok(performance.now() - start < 2000);
});

test('mailProbe checks every account read-only and reports a fixed detail', async () => {
  const shared = stringifyAccountConfig([account(), account({ id: 'b', default: false })]);
  const catalog = (options = {}) => defineCatalog({
    mail: connector('Mail', 'Boîtes', [field('MAIL_ACCOUNTS', 'Boîtes mail')], {
      probe: mailProbe({ configuration: (values) => values.MAIL_ACCOUNTS, ...options }),
    }),
  });
  const imap = imapServer();
  const smtp = smtpServer();
  const ok = await probeConnector(catalog(), 'mail', { MAIL_ACCOUNTS: shared }, {
    imapFactory: imap.factory, smtpFactory: smtp.factory,
  });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.detail, 'Connexions IMAP et SMTP acceptées pour 2 boîtes. Aucun message envoyé.');
  assert.deepEqual([imap.state.connections, smtp.state.verified, smtp.state.sent.length, imap.state.appended.length], [2, 2, 0, 0]);
  assert.equal(imap.state.locks.length, 0);

  const single = await probeConnector(catalog({ account: () => 'b' }), 'mail', { MAIL_ACCOUNTS: shared }, {
    imapFactory: imapServer().factory, smtpFactory: smtpServer().factory,
  });
  assert.equal(single.detail, 'Connexions IMAP et SMTP acceptées. Aucun message envoyé.');

  const refused = await probeConnector(catalog(), 'mail', { MAIL_ACCOUNTS: shared }, {
    imapFactory: imapServer().factory,
    smtpFactory: smtpServer({ failure: Object.assign(new Error(`535 ${PASSWORD}`), { code: 'EAUTH' }) }).factory,
  });
  assert.equal(refused.status, 'failed');

  const broken = await probeConnector(catalog(), 'mail', { MAIL_ACCOUNTS: '{cassé' }, {
    imapFactory: imapServer().factory, smtpFactory: smtpServer().factory,
  });
  assert.equal(broken.status, 'unknown');
  assert.doesNotMatch(JSON.stringify([ok, single, refused, broken]), /example|perso|mot-de-passe|535/);
  assert.throws(() => mailProbe({ host: () => 'mail.example.test' }), /configuration\(values\)/);
});

test('importing the entry points never loads imapflow, nodemailer, mailparser or htmlparser2', (t) => {
  const script = `
    import { registerHooks } from 'node:module';
    const loaded = [];
    registerHooks({ resolve(specifier, context, next) { loaded.push(specifier); return next(specifier, context); } });
    await import('./src/index.js');
    await import('./src/mail.js');
    await import('./src/secrets/index.js');
    process.stdout.write(JSON.stringify(loaded.filter((name) => /^(imapflow|nodemailer|mailparser|htmlparser2)$/.test(name))));
  `;
  if (!('registerHooks' in (process.getBuiltinModule?.('node:module') || {}))) {
    t.skip('module.registerHooks is not available on this Node version');
    return;
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});
