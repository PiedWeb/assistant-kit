import test from 'node:test';
import assert from 'node:assert/strict';
import { MailClient } from '../src/mail.js';

function harness({ move = true } = {}) {
  const rows = [];
  const folders = [{ path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Sent', specialUse: '\\Sent' }];
  const calls = { moves: [], creates: [], locks: [], failAfterMove: false, loseMove: false };
  const options = {
    configuration: [{ id: 'test', default: true, address: 'agent@example.com', username: 'agent@example.com', password: 'test',
      imap: { host: 'mail.example.com', port: 993, security: 'tls' }, smtp: { host: 'mail.example.com', port: 465, security: 'tls' } }],
    smtpFactory: () => { throw new Error('SMTP must not be used'); },
    imapFactory: () => {
      let selected;
      return {
        capabilities: new Map(move ? [['MOVE', true]] : []),
        connect: async () => {}, logout: async () => {}, list: async () => folders,
        getMailboxLock: async (folder, options) => { selected = folder; calls.locks.push(options); return { release() {} }; },
        search: async query => rows.filter(row => row.mailbox === selected && row.raw.toString().includes(query.header['message-id'])).map(row => row.uid),
        fetchOne: async (uid, query) => {
          const row = rows.find(row => row.mailbox === selected && row.uid === uid);
          return !row ? false : query.source ? { source: row.raw } : { uid, flags: new Set(row.flags), size: row.raw.length };
        },
        append: async (mailbox, raw, flags) => { const uid = rows.length + 1; rows.push({ uid, mailbox, raw, flags }); return { uid }; },
        mailboxCreate: async folder => { calls.creates.push(folder); folders.push({ path: folder }); },
        messageMove: async (uid, target, options) => {
          assert.deepEqual(options, { uid: true });
          calls.moves.push(uid);
          const row = rows.find(row => row.mailbox === selected && row.uid === uid);
          row.mailbox = calls.loseMove ? 'Lost' : target;
          if (calls.failAfterMove) throw new Error('Connection closed');
          return { uidMap: new Map([[uid, uid]]) };
        },
      };
    },
  };
  const client = new MailClient({ ...options, allowWrites: true });
  const save = () => client.saveDraft('', { to: ['customer@example.org'], subject: 'Booking', text: 'Hello customer.', messageId: '<draft-1@example.com>' });
  const archive = draft => client.archiveDraft('', { ...draft, destination: 'Assistant-obsolete' });
  return { client, reader: new MailClient(options), save, archive, rows, calls, folders };
}

test('unchanged draft moves by UID and an interrupted journal can recover the archive', async () => {
  const h = harness();
  const saved = await h.save();
  assert.match(saved.fingerprint, /^[a-f0-9]{64}$/);
  const result = await h.archive(saved);
  assert.equal(result.status, 'archived');
  assert.equal(result.recovered, false);
  assert.deepEqual(h.calls.moves, [saved.uid]);
  assert.equal(h.rows[0].mailbox, 'Assistant-obsolete');
  assert.deepEqual(h.rows[0].flags, ['\\Draft']);
  assert.equal((await h.archive(saved)).recovered, true);
  assert.equal(h.calls.moves.length, 1);
});

test('preview is read only, and apply requires explicit writes and a full fingerprint', async () => {
  const h = harness();
  const saved = await h.save();
  h.calls.locks.length = 0;
  const options = { ...saved, destination: 'Assistant-obsolete' };
  assert.equal((await h.reader.archiveDraft('', { ...options, dryRun: true })).status, 'eligible');
  assert.ok(h.calls.locks.every(lock => lock.readOnly));
  assert.deepEqual([h.calls.moves.length, h.calls.creates.length], [0, 0]);
  await assert.rejects(h.reader.archiveDraft('', options), /Écriture IMAP refusée/);
  await assert.rejects(h.archive({ ...saved, fingerprint: null }), /empreinte complète/);
  await assert.rejects(h.client.archiveDraft('', { ...options, destination: 'Sent' }), /dossiers spéciaux/);
});

test('any raw header, signature, HTML or attachment edit preserves the draft', async () => {
  for (const edit of [
    raw => Buffer.from(raw.toString().replace('Hello customer.', 'Hello changed.')),
    raw => Buffer.concat([Buffer.from('X-Edited: yes\r\n'), raw]),
    raw => Buffer.concat([raw, Buffer.from('\r\nChanged HTML, signature or attachment bytes')]),
  ]) {
    const h = harness();
    const saved = await h.save();
    h.rows[0].raw = edit(h.rows[0].raw);
    await assert.rejects(h.archive(saved), error => error.code === 'DRAFT_CHANGED');
    assert.equal(h.calls.moves.length, 0);
  }
});

test('line ending normalization is harmless, but changed draft flags are preserved', async () => {
  const h = harness();
  const saved = await h.save();
  h.rows[0].raw = Buffer.from(h.rows[0].raw.toString().replace(/\r\n/g, '\n'));
  h.rows[0].flags = [];
  await assert.rejects(h.archive(saved), /modifié/);
  h.rows[0].flags = ['\\Draft', '\\Deleted'];
  await assert.rejects(h.archive(saved), /modifié/);
  h.rows[0].flags = ['\\Draft', '\\Seen'];
  assert.equal((await h.archive(saved)).status, 'archived');
});

test('ambiguous identities, substring header matches and unsafe move fallbacks are refused', async () => {
  const h = harness({ move: false });
  const saved = await h.save();
  await assert.rejects(h.archive(saved), /UID MOVE/);
  assert.equal(h.calls.creates.length, 0);
  h.rows.push({ ...h.rows[0], uid: 99 });
  await assert.rejects(h.archive(saved), /ambigu/);
  h.rows.pop();
  h.rows[0].raw = Buffer.from(h.rows[0].raw.toString().replace('Message-ID:', 'X-Old-Message-ID:'));
  await assert.rejects(h.archive(saved), /modifié/);
  assert.equal(h.calls.moves.length, 0);
});

test('absent draft is idempotent and a duplicate APPEND never adopts the current content', async () => {
  const h = harness();
  const saved = await h.save();
  assert.equal((await h.save()).fingerprint, null);
  h.rows.length = 0;
  assert.equal((await h.archive(saved)).status, 'absent');
  assert.equal(h.calls.creates.length, 0);
});

test('connection loss after MOVE is recovered on retry; missing archive is not success', async () => {
  const h = harness();
  const saved = await h.save();
  h.calls.failAfterMove = true;
  await assert.rejects(h.archive(saved));
  assert.equal((await h.archive(saved)).recovered, true);
  assert.equal(h.calls.moves.length, 1);
  const lost = harness();
  const draft = await lost.save();
  lost.calls.loseMove = true;
  await assert.rejects(lost.archive(draft), /introuvable après déplacement/);
});

test('matching copies in both folders are not moved and modified archives cannot be adopted', async () => {
  const h = harness();
  const saved = await h.save();
  h.folders.push({ path: 'Assistant-obsolete' });
  h.rows.push({ ...h.rows[0], mailbox: 'Assistant-obsolete', uid: 99 });
  await assert.rejects(h.archive(saved), /deux dossiers/);
  h.rows.shift();
  h.rows[0].raw = Buffer.concat([h.rows[0].raw, Buffer.from('edited')]);
  await assert.rejects(h.archive(saved), /modifié/);
  assert.equal(h.calls.moves.length, 0);
});
