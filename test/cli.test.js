import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsonFlag, listFlag, parseArguments, runCli } from '../src/cli.js';

function fakeProcess() {
  const fake = new EventEmitter();
  fake.errors = [];
  fake.exits = [];
  fake.exitCode = undefined;
  fake.stderr = { write: (text) => fake.errors.push(text) };
  fake.exit = (code) => fake.exits.push(code);
  return fake;
}

test('parseArguments refuses unknown flags only when the known list is given', () => {
  const argv = ['sync', 'a.md', '--no-publish', '--code=302', '--', '--literal'];
  assert.deepEqual(parseArguments(argv), {
    positionals: ['sync', 'a.md', '--literal'],
    flags: { 'no-publish': true, code: '302' },
  });
  assert.deepEqual(parseArguments(argv, { known: ['no-publish', 'code'] }).flags, { 'no-publish': true, code: '302' });
  assert.throws(() => parseArguments(['--help'], { known: ['all'] }), /^Error: Option inconnue : --help \(options : --all\)\.$/);
  assert.throws(() => parseArguments(['--cod=1'], { known: ['code'] }), /Option inconnue : --cod/);
  assert.throws(() => parseArguments(['--x'], { known: [] }), /options : aucune/);
});

test('jsonFlag reads inline JSON or an @file, and explains the PowerShell trap', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-kit-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'changes.json');
  fs.writeFileSync(file, '﻿{"alt": "Le \\"mont\\" Blanc"}');

  assert.deepEqual(jsonFlag('{"a":1}', 'json'), { a: 1 });
  assert.deepEqual(jsonFlag(`@${file}`, 'json'), { alt: 'Le "mont" Blanc' });
  assert.equal(jsonFlag(undefined, 'json', null), null);
  assert.equal(jsonFlag(true, 'json', 'default'), 'default');
  assert.throws(() => jsonFlag('{a:1}', 'changes'), /--changes n’est pas un JSON valide .*PowerShell.*--changes @fichier\.json/);
  assert.throws(() => jsonFlag(`@${path.join(directory, 'missing.json')}`, 'changes'), /fichier illisible \(ENOENT\)/);
});

test('listFlag accepts a comma list, a JSON array or an @file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-kit-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'tags.json'), '["a b", 2]');

  assert.deepEqual(listFlag(' a, b ,,c '), ['a', 'b', 'c']);
  assert.deepEqual(listFlag('["x","y"]'), ['x', 'y']);
  assert.deepEqual(listFlag(`@${path.join(directory, 'tags.json')}`), ['a b', '2']);
  assert.equal(listFlag(undefined), undefined);
  assert.equal(listFlag(true), undefined);
  assert.throws(() => listFlag('[1', 'tags'), /--tags n’est pas un JSON valide/);
  assert.throws(() => listFlag('@/dev/null/x', 'tags'), /fichier illisible/);
});

test('runCli maps the outcome of main to an exit code and prints errors in one line', async () => {
  const ok = fakeProcess();
  assert.equal(await runCli(async () => 3, { processImpl: ok }), 3);
  assert.equal(ok.exitCode, 3);
  assert.deepEqual(ok.errors, []);

  const failed = fakeProcess();
  assert.equal(await runCli(() => { throw new Error('Jeton absent.'); }, { processImpl: failed }), 2);
  assert.deepEqual(failed.errors, ['✗ Jeton absent.\n']);

  const custom = fakeProcess();
  await runCli(async () => { throw Object.assign(new Error('Conflit.'), { exitCode: 3 }); }, { processImpl: custom });
  assert.equal(custom.exitCode, 3);

  const silent = fakeProcess();
  assert.equal(await runCli(async () => undefined, { processImpl: silent }), 0);
});

test('runCli exits 130 on SIGINT and 143 on SIGTERM while main runs, then lets go', async () => {
  const fake = fakeProcess();
  let finish;
  const running = runCli(() => new Promise((resolve) => { finish = resolve; }), { processImpl: fake });
  assert.equal(fake.listenerCount('SIGINT'), 1);
  fake.emit('SIGINT');
  fake.emit('SIGTERM');
  assert.deepEqual(fake.exits, [130, 143]);
  finish(0);
  await running;
  assert.equal(fake.listenerCount('SIGINT'), 0);
  assert.equal(fake.listenerCount('SIGTERM'), 0);

  const quiet = fakeProcess();
  await runCli(async () => 0, { processImpl: quiet, signals: false });
  assert.equal(quiet.listenerCount('SIGINT'), 0);
});
