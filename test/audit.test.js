import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuditLog } from '../src/audit.js';

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-kit-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('record appends timestamped JSONL in a private directory and file', (t) => {
  const root = temporaryDirectory(t);
  const times = ['2026-10-09T08:00:00.000Z', '2026-10-09T09:00:00.000Z'];
  const audit = createAuditLog(path.join(root, 'state', 'writes.jsonl'), { now: () => new Date(times.shift()) });

  assert.equal(audit.record({ action: 'launchCrawl', ts: 'forged', params: { limit: '5' }, status: 202 }), true);
  assert.equal(audit.record({ action: 'upload', status: 201 }), true);

  const lines = fs.readFileSync(audit.file, 'utf8').trim().split('\n');
  assert.equal(lines[0], '{"ts":"2026-10-09T08:00:00.000Z","action":"launchCrawl","params":{"limit":"5"},"status":202}');
  assert.deepEqual(audit.read({ since: '2026-10-09T08:30' }).map((entry) => entry.action), ['upload']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(audit.file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(audit.file).mode & 0o777, 0o600);
  }
});

test('an existing journal is tightened to 0600 and unreadable lines are skipped', { skip: process.platform === 'win32' }, (t) => {
  const file = path.join(temporaryDirectory(t), 'audit.jsonl');
  fs.writeFileSync(file, 'not json\n[1]\n', { mode: 0o644 });
  const audit = createAuditLog(file);
  audit.record({ action: 'x' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(audit.read().map((entry) => entry.action), ['x']);
});

test('sensitive keys are refused, nested and whatever their case', (t) => {
  const audit = createAuditLog(path.join(temporaryDirectory(t), 'audit.jsonl'));
  for (const entry of [
    { password: 'x' }, { Token: 'x' }, { params: { apiKey: 'x' } }, { headers: { 'X-AUTH-TOKEN': 'x' } },
    { body: '...' }, { text: '...' }, { html: '...' }, { subject: 'Re' }, { items: [{ refresh_token: 'x' }] },
  ]) {
    assert.throws(() => audit.record(entry), /refusée dans le journal d’audit/);
  }
  assert.throws(() => audit.record('line'), /doit être un objet/);
  assert.equal(fs.existsSync(audit.file), false);
  assert.throws(() => createAuditLog(''), /manquant/);
});

test('a journal that cannot be written is reported, never thrown', (t) => {
  const root = temporaryDirectory(t);
  fs.writeFileSync(path.join(root, 'occupied'), '');
  const errors = [];
  const audit = createAuditLog(path.join(root, 'occupied', 'audit.jsonl'), { onError: (error) => errors.push(error.code) });
  assert.equal(audit.record({ action: 'x' }), false);
  assert.equal(errors.length, 1);
  assert.deepEqual(audit.read(), []);
});
