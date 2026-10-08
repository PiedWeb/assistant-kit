import test from 'node:test';
import assert from 'node:assert/strict';
import { CadrankClient, encodeKeyword, parseCsv } from '../src/cadrank.js';
import { MailClient } from '../src/mail.js';
import { parseArguments, positiveInteger } from '../src/cli.js';

test('Cadrank sends its key, retries transient errors and parses CSV', async () => {
  const calls = [];
  const responses = [new Response('busy', { status: 503 }), new Response('﻿keyword,volume\n"a, b",10\n', { status: 200 })];
  const client = new CadrankClient({
    apiKey: 'key',
    sleep: async () => undefined,
    fetchImpl: async (url, options) => {
      calls.push({ url, key: options.headers['X-AUTH-TOKEN'] });
      return responses.shift();
    },
  });

  assert.deepEqual(await client.related('ski de rando'), [{ keyword: 'a, b', volume: '10' }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { url: 'https://cadrank.piedweb.com/_api/search/related/ski+de+rando', key: 'key' });
  assert.equal(encodeKeyword(' été  2026 '), '%C3%A9t%C3%A9+2026');
  assert.deepEqual(parseCsv(''), []);
});

function fakeImap(messages) {
  const state = { loggedOut: false, flagged: [] };
  const client = {
    mailbox: { exists: messages.length },
    async connect() {},
    async logout() { state.loggedOut = true; },
    async getMailboxLock() { return { release() {} }; },
    async *fetch() { yield* messages; },
    async fetchOne(uid) { return messages.find((message) => message.uid === uid); },
    async messageFlagsAdd(uid, flags) { state.flagged.push([uid, flags]); },
  };
  return { client, state };
}

test('mail lists newest first, reads without marking seen and guards the sender', async () => {
  const message = (uid, seen) => ({
    uid,
    internalDate: new Date('2026-10-09T08:00:00Z'),
    envelope: { subject: `Sujet ${uid}`, from: [{ name: 'A', address: 'a@x.test' }], to: [] },
    flags: new Set(seen ? ['\\Seen'] : []),
    source: Buffer.from('raw'),
  });
  const imap = fakeImap([message(1, true), message(2, false)]);
  const sent = [];
  const mail = new MailClient({
    host: 'mail.example.test',
    accounts: { personal: { address: 'robin@example.com', password: 'p' }, other: { address: 'x@elsewhere.test', password: 'p' } },
    allowedDomains: ['example.com'],
    imapFactory: async () => imap.client,
    smtpFactory: async () => ({ async verify() {}, async sendMail(options) { sent.push(options); return { messageId: 'id' }; } }),
  });

  assert.deepEqual((await mail.list('personal')).map((item) => item.uid), [2, 1]);
  assert.deepEqual((await mail.list('personal', { unseen: true })).map((item) => item.uid), [2]);
  assert.equal((await mail.read('personal', 2)).source, 'raw');
  assert.deepEqual(imap.state.flagged, []);
  assert.ok(imap.state.loggedOut);
  await assert.rejects(mail.list('other'), /domaines autorisés/);
  await assert.rejects(mail.send('personal', { to: 'b@x.test', subject: 's', text: 't', from: 'evil@x.test' }), /expéditeur/);
  await mail.send('personal', { to: 'b@x.test', subject: 's', text: 't' });
  assert.equal(sent[0].from, 'robin@example.com');
});

test('CLI arguments: flags, inline values and --', () => {
  assert.deepEqual(parseArguments(['pull', 'a.com', '--no-publish', '--code', '302', '--alt=Un texte', '--', '--literal']), {
    positionals: ['pull', 'a.com', '--literal'],
    flags: { 'no-publish': true, code: '302', alt: 'Un texte' },
  });
  assert.equal(positiveInteger('25'), 25);
  assert.equal(positiveInteger(undefined, 5), 5);
  assert.throws(() => positiveInteger('2x'), /Entier/);
});
