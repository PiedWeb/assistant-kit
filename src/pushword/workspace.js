import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as tar from 'tar';
import {
  contentAddress, extractRevision, frontmatter, isSnapshotFile, tryContentAddress, validateHost, walkMarkdown,
} from './content.js';

// The baseline repository never talks to a remote: nothing may prompt.
const GIT_ENV = Object.freeze({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_ASKPASS: '', SSH_ASKPASS: '' });
const LOCK_ATTEMPTS = 5;
const LOCK_PAUSE_MS = 250;
const LAST_PULL_REF = 'refs/tags/last-pull';
// A directory an editor, an indexer or an antivirus holds open cannot be renamed on Windows.
const IN_PLACE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * A local editing mirror of production pages: `{root}/content/{host}/{slug}.md`.
 *
 * Production is the source of truth. `pull()` replaces the mirror with fresh
 * server snapshots (every page carries a `revision:` stamp), `sync()` sends
 * edited files back with optimistic locking and writes the server's canonical
 * text over them, `publish()` regenerates the static pages.
 *
 * A private Git repository inside `content/` records the last pulled or synced
 * state, so a pull refuses to wipe edits that never reached the server. The
 * tag `last-pull` marks the last pull: `git -C content diff last-pull` shows
 * every edit since, synced or not.
 *
 * Only the workspace `hosts` are pushed unasked (hook, `syncAll()`). A page of
 * another host that sits in `content/` (pulled by hand) is pushed only when its
 * file is named explicitly: `sync(files, { anyHost: true })`.
 */
export class ContentWorkspace {
  constructor({
    root,
    client,
    hosts = [],
    contentDir = 'content',
    stateDir = '.assistant',
    marker = path.join('.claude', '.last-pull'),
    syncCommand = null,
    onPulled = null,
    rename = fs.renameSync,
    sleep = defaultSleep,
    gitTimeoutMs = 60_000,
    log = (line) => process.stderr.write(`${line}\n`),
  }) {
    this.root = path.resolve(root);
    this.client = client;
    this.hosts = hosts;
    this.contentRoot = path.join(this.root, contentDir);
    this.stateRoot = path.join(this.root, stateDir);
    this.marker = path.join(this.root, marker);
    this.syncCommand = syncCommand;
    this.onPulled = onPulled;
    this.rename = rename;
    this.sleep = sleep;
    this.gitTimeoutMs = gitTimeoutMs;
    this.log = log;
  }

  /**
   * Replace the mirror of `hosts` with fresh production snapshots, atomically.
   * `onPulled({ host, directory, hosts, workspace })` runs for each installed
   * host before the baseline commit, so what it writes under `content/` is part
   * of the pulled state; its failure is logged and never undoes the pull.
   */
  async pull(hosts = this.hosts) {
    if (!Array.isArray(hosts) || hosts.length === 0) {
      throw new Error('Au moins un hôte Pushword est requis.');
    }
    hosts.forEach(validateHost);
    this.assertNoUnsyncedChanges();

    fs.mkdirSync(this.stateRoot, { recursive: true });
    const temporaryRoot = fs.mkdtempSync(path.join(this.stateRoot, 'pull-'));
    const staged = path.join(temporaryRoot, 'staged');
    try {
      for (const host of hosts) {
        const archive = path.join(temporaryRoot, `${host}.tar.gz`);
        const extracted = path.join(staged, host);
        fs.mkdirSync(extracted, { recursive: true });
        await this.client.downloadSnapshot(host, archive);
        await tar.x({ file: archive, cwd: extracted, strict: true, filter: allowedEntry });
        if (!walkMarkdown(extracted).length) {
          throw new Error(`Snapshot Pushword vide pour ${host} : le miroir local est conservé.`);
        }
      }
      installSnapshot(this.contentRoot, staged, hosts, { rename: this.rename, log: this.log });
      const directories = hosts.map((host) => path.join(this.contentRoot, host));
      await this.notifyPulled(hosts, directories);
      await this.markPulled();
      return directories;
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  async notifyPulled(hosts, directories) {
    if (typeof this.onPulled !== 'function') {
      return;
    }
    for (const [index, host] of hosts.entries()) {
      try {
        await this.onPulled({ host, directory: directories[index], hosts, workspace: this });
      } catch (error) {
        this.log(`⚠ ${host} tiré, mais l’étape après pull a échoué : ${error.message}`);
      }
    }
  }

  /**
   * Send page files to production. Returns one result per file; never throws
   * for HTTP outcomes. Without `anyHost`, a file of a host outside `hosts`
   * stays local (status `outside-hosts`): only a file named on purpose, with
   * `anyHost: true`, publishes another host.
   */
  async sync(files, { publish = true, anyHost = false } = {}) {
    const results = [];
    for (const file of files) {
      const result = await this.syncOne(file, { anyHost });
      results.push(result);
      if (result.status === 'auth') {
        break;
      }
    }
    const synced = results.filter((result) => result.status === 'synced');
    await this.recordSynced(synced.map((result) => result.file));
    if (publish && synced.length) {
      try {
        const published = await this.publish(synced);
        for (const result of synced) {
          result.static = published.find((item) => item.host === result.host && item.slug === result.slug);
        }
      } catch (error) {
        for (const result of synced) {
          result.static = { generated: false, error: error.message };
        }
        this.log(`✗ contenu synchronisé, génération statique en échec : ${error.message}`);
      }
    }
    return { results, ok: results.every((result) => result.status === 'synced') };
  }

  /**
   * Push every page edited since the last pull or sync, for the workspace
   * hosts only. Pages of other hosts are left local and listed in `skipped`
   * (status `outside-hosts`), without failing the run.
   */
  async syncAll({ publish = true } = {}) {
    const inside = [];
    const skipped = [];
    for (const file of this.pendingFiles()) {
      const page = tryContentAddress(this.contentRoot, file);
      if (page && !this.hosts.includes(page.host)) {
        skipped.push(this.report(this.outsideHosts(page), '⚠'));
      } else {
        inside.push(file);
      }
    }
    const { results, ok } = inside.length ? await this.sync(inside, { publish }) : { results: [], ok: true };
    return { results, ok, skipped };
  }

  async syncOne(file, { anyHost = false } = {}) {
    let page;
    try {
      page = contentAddress(this.contentRoot, file);
    } catch (error) {
      return this.report({ file, status: 'error', message: error.message });
    }
    if (!anyHost && !this.hosts.includes(page.host)) {
      return this.report(this.outsideHosts(page));
    }
    const base = { file: page.absolutePath, host: page.host, slug: page.slug };
    const label = `${page.host}/${page.slug}`;
    const text = fs.readFileSync(page.absolutePath, 'utf8');
    const revision = extractRevision(text);
    if (!revision) {
      return this.report({
        ...base,
        status: 'no-revision',
        message: `${label} : pas de \`revision:\` dans le front matter, rien n’est envoyé en production. `
          + 'Ce fichier ne vient pas d’un snapshot : tirer l’hôte puis réappliquer la modification, '
          + 'ou créer la page avec la commande de création si elle est nouvelle.',
      });
    }

    let response;
    try {
      response = await this.client.putPageFile(page.host, page.slug, text, revision);
    } catch (error) {
      return this.report({ ...base, status: 'error', message: `${label} : ${error.message}` });
    }

    if (response.status === 200 && response.text) {
      fs.writeFileSync(page.absolutePath, response.text, 'utf8');
      return this.report({ ...base, status: 'synced', revision: extractRevision(response.text),
        message: `${label} → rev ${short(extractRevision(response.text))}` });
    }
    if (response.status === 409 && extractRevision(response.text)) {
      fs.writeFileSync(page.absolutePath, response.text, 'utf8');
      await this.recordSynced([page.absolutePath]);
      return this.report({ ...base, status: 'conflict', revision: extractRevision(response.text),
        message: `${label} : conflit, le fichier a été remplacé par la version du serveur `
          + `(rev ${short(extractRevision(response.text))}). Réappliquer la modification sur ce nouveau texte.` });
    }
    if (response.status === 401 || response.status === 403) {
      return this.report({ ...base, status: 'auth',
        message: `Authentification refusée par Pushword (HTTP ${response.status}) : vérifier le jeton.` });
    }
    return this.report({ ...base, status: 'error', httpStatus: response.status,
      message: `${label} : HTTP ${response.status} inattendu : ${truncate(response.text, 300)}` });
  }

  outsideHosts(page) {
    const relative = path.relative(this.root, page.absolutePath).split(path.sep).join('/');
    const how = this.syncCommand
      ? `nommer le fichier : ${this.syncCommand} ${relative}`
      : 'nommer ce fichier explicitement dans la commande de synchronisation';
    return {
      file: page.absolutePath,
      host: page.host,
      slug: page.slug,
      status: 'outside-hosts',
      message: `${relative} : l’hôte ${page.host} n’est pas dans les hôtes du projet `
        + `(${this.hosts.join(', ') || 'aucun'}), rien n’est envoyé en production et la modification reste locale. `
        + `Pour publier cet hôte exprès, ${how}.`,
    };
  }

  /** Page files modified since the last pull, by mtime. */
  modifiedSincePull() {
    if (!fs.existsSync(this.marker)) {
      throw new Error('Aucun pull de référence : tirer les snapshots d’abord.');
    }
    const since = fs.statSync(this.marker).mtimeMs;
    return walkMarkdown(this.contentRoot).filter((file) => fs.statSync(file).mtimeMs > since).sort();
  }

  /**
   * Existing page files that differ from the last pulled or synced state, from
   * the baseline repository (by mtime since the pull when it is missing).
   */
  pendingFiles() {
    if (!this.hasRepository()) {
      return this.modifiedSincePull();
    }
    const entries = this.git(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
    const files = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      if (/^[RC]/.test(entry)) index += 1; // a rename is followed by its source path
      const file = path.join(this.contentRoot, entry.slice(3));
      if (file.endsWith('.md') && fs.existsSync(file)) files.push(file);
    }
    return files.sort();
  }

  /**
   * Every file changed since the last pull, synced or not:
   * `[{ status: 'modified'|'added'|'deleted'|'untracked', path, file }]`, with
   * `path` relative to `content/`. The same list as `git -C content diff last-pull`.
   */
  changesSincePull() {
    if (!this.hasRepository()) {
      throw new Error('Aucun pull de référence : tirer les snapshots d’abord.');
    }
    try {
      this.git(['rev-parse', '--verify', '--quiet', LAST_PULL_REF]);
    } catch {
      throw new Error('Aucune référence last-pull dans content/.git : refaire un pull pour la poser.');
    }
    const names = { M: 'modified', A: 'added', D: 'deleted', T: 'modified' };
    const parts = this.git(['diff', '--name-status', '--no-renames', '-z', LAST_PULL_REF, '--']).split('\0');
    const changes = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      changes.push({ status: names[parts[index]] || parts[index], path: parts[index + 1] });
    }
    for (const relative of this.git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
      changes.push({ status: 'untracked', path: relative });
    }
    return changes
      .map((change) => ({ ...change, file: path.join(this.contentRoot, ...change.path.split('/')) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Create a new page from a local file that has never been on the server. */
  async create(file, { publish = true } = {}) {
    const page = contentAddress(this.contentRoot, file);
    const source = fs.readFileSync(page.absolutePath, 'utf8');
    if (!frontmatter(source)) {
      throw new Error('Une nouvelle page doit commencer par un front matter `---`.');
    }
    if (extractRevision(source)) {
      throw new Error('Une nouvelle page ne doit pas porter de revision serveur.');
    }
    const response = await this.client.createPageFile(page.host, page.slug, source);
    if (response.status === 409) {
      throw new Error(`${page.host}/${page.slug} existe déjà en production : tirer l’hôte et modifier la page existante.`);
    }
    if (response.status !== 201) {
      throw new Error(`Création de ${page.host}/${page.slug} : HTTP ${response.status} : ${truncate(response.text, 300)}`);
    }
    fs.writeFileSync(page.absolutePath, response.text, 'utf8');
    await this.recordSynced([page.absolutePath]);
    const generation = publish ? await this.client.triggerStatic(page.host) : null;
    return { ...page, revision: extractRevision(response.text), generation };
  }

  /** Delete a page in production, leaving a redirection, then drop the local copy. */
  async delete(host, slug, { redirectTo, code = 301, publish = true }) {
    await this.client.deletePage(host, slug, { redirectTo, code });
    const local = path.join(this.contentRoot, host, `${slug}.md`);
    if (fs.existsSync(local)) {
      fs.rmSync(local);
      await this.recordSynced([local]);
    }
    return publish ? this.client.triggerStatic(host) : null;
  }

  async publish(pages) {
    const results = [];
    for (const page of pages) {
      results.push(await this.client.generatePage(page.host, page.slug));
    }
    return results;
  }

  assertNoUnsyncedChanges() {
    if (!this.hasRepository()) {
      return;
    }
    const status = this.git(['status', '--porcelain']).trim();
    if (status) {
      throw new Error('Le miroir contient des modifications non synchronisées. '
        + 'Les synchroniser ou les annuler avant un nouveau pull :\n' + status);
    }
  }

  /** Record files as matching production in the private baseline repository. */
  async recordSynced(files) {
    if (!files.length || !this.hasRepository()) {
      return;
    }
    const relative = files.map((file) => path.relative(this.contentRoot, path.resolve(file)));
    try {
      await this.withIndexLock(() => {
        this.git(['add', '--', ...relative]);
        if (this.git(['diff', '--cached', '--name-only']).trim()) {
          this.git(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify',
            '-m', `synced ${new Date().toISOString()}`, '--', ...relative]);
        }
      });
    } catch (error) {
      this.log(`⚠ état de référence non mis à jour : ${describeGitError(error, this.isIndexLocked(error))}`);
    }
  }

  async markPulled() {
    fs.mkdirSync(path.dirname(this.marker), { recursive: true });
    fs.closeSync(fs.openSync(this.marker, 'w', 0o600));
    const now = new Date();
    fs.utimesSync(this.marker, now, now);
    try {
      if (!this.hasRepository()) {
        this.git(['init', '-q']);
        this.git(['config', 'user.email', 'assistant@localhost']);
        this.git(['config', 'user.name', 'Assistant baseline']);
        this.git(['config', 'commit.gpgsign', 'false']);
      }
      await this.withIndexLock(() => {
        this.git(['add', '-A']);
        this.git(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '--allow-empty',
          '-m', `snapshot ${now.toISOString()}`]);
      });
      this.git(['update-ref', LAST_PULL_REF, 'HEAD']);
    } catch (error) {
      this.log(`⚠ état de référence non créé : ${describeGitError(error, this.isIndexLocked(error))} Le pull a réussi, mais le prochain `
        + 'refusera de partir tant que content/ diffère du dernier état enregistré. Une fois le verrou libéré : '
        + 'git -C content add -A && git -C content commit -q --allow-empty -m baseline '
        + '&& git -C content tag -f last-pull');
    }
  }

  /**
   * Run `step` again while another process (an editor's Git integration,
   * usually) holds `content/.git/index.lock`: five attempts, growing pauses.
   */
  async withIndexLock(step) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return step();
      } catch (error) {
        if (!this.isIndexLocked(error) || attempt >= LOCK_ATTEMPTS) {
          throw error;
        }
        await this.sleep(LOCK_PAUSE_MS * (2 ** (attempt - 1)));
      }
    }
  }

  isIndexLocked(error) {
    return /index\.lock/.test(`${error?.stderr || ''} ${error?.message || ''}`)
      || fs.existsSync(path.join(this.contentRoot, '.git', 'index.lock'));
  }

  hasRepository() {
    return fs.existsSync(path.join(this.contentRoot, '.git'));
  }

  /** Git in the baseline repository: never interactive, no window, bounded in time. */
  git(args) {
    return execFileSync('git', args, {
      cwd: this.contentRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...GIT_ENV },
      windowsHide: true,
      timeout: this.gitTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  report(result, symbol = { synced: '✓', conflict: '⚠' }[result.status] || '✗') {
    this.log(`${symbol} ${result.message}`);
    return result;
  }
}

function allowedEntry(entryPath, entry) {
  if (entry.type === 'Directory') {
    return true;
  }
  if (!['File', 'OldFile', 'ContiguousFile'].includes(entry.type)) {
    return false;
  }
  const clean = path.posix.normalize(String(entryPath).replace(/^\.\//, ''));
  if (!clean || clean === '.' || clean.startsWith('../') || path.posix.isAbsolute(clean) || clean.includes('\\')) {
    return false;
  }
  return isSnapshotFile(clean);
}

/**
 * Swap each staged host directory into `contentRoot`, all or nothing. A rename
 * refused with EPERM, EBUSY or EACCES (Windows, a handle held open) falls back
 * to replacing the files in place, after a copy of the previous tree. On
 * failure every host is put back; a backup that could not be restored is kept
 * and its path logged.
 */
export function installSnapshot(contentRoot, stagedRoot, hosts, { rename = fs.renameSync, log = () => undefined } = {}) {
  fs.mkdirSync(contentRoot, { recursive: true });
  const backupRoot = fs.mkdtempSync(path.join(path.dirname(contentRoot), '.content-backup-'));
  const installed = [];
  let keepBackup = false;
  try {
    for (const host of hosts) {
      installed.push(installHost(path.join(stagedRoot, host), path.join(contentRoot, host), path.join(backupRoot, host), rename));
    }
  } catch (error) {
    const failed = error.unrestored ? [error.unrestored] : [];
    for (const entry of installed.reverse()) {
      try {
        restoreHost(entry, rename);
      } catch (restoreError) {
        failed.push({ ...entry, error: restoreError });
      }
    }
    for (const entry of failed) {
      keepBackup = true;
      log(`✗ ${entry.destination} non restauré (${entry.error.message}) : copie précédente gardée dans ${entry.backup}`);
    }
    throw error;
  } finally {
    if (!keepBackup) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  }
}

function installHost(source, destination, backup, rename) {
  const hadPrevious = fs.existsSync(destination);
  if (hadPrevious) {
    try {
      rename(destination, backup);
    } catch (error) {
      if (!IN_PLACE_CODES.has(error.code)) throw error;
      fs.cpSync(destination, backup, { recursive: true, preserveTimestamps: true });
      const entry = { destination, backup, hadPrevious, inPlace: true };
      try {
        mirrorDirectory(source, destination);
      } catch (mirrorError) {
        throw undoHost(mirrorError, entry, rename);
      }
      return entry;
    }
  }
  const entry = { destination, backup, hadPrevious, inPlace: false };
  try {
    moveDirectory(source, destination, rename);
  } catch (error) {
    throw undoHost(error, entry, rename);
  }
  return entry;
}

// Put one host back after its own install failed; remember it when that fails too.
function undoHost(error, entry, rename) {
  try {
    restoreHost(entry, rename);
  } catch (restoreError) {
    error.unrestored = { ...entry, error: restoreError };
  }
  return error;
}

function restoreHost({ destination, backup, hadPrevious, inPlace }, rename) {
  if (inPlace) {
    mirrorDirectory(backup, destination);
    return;
  }
  fs.rmSync(destination, { recursive: true, force: true });
  if (hadPrevious) {
    moveDirectory(backup, destination, rename);
  }
}

function moveDirectory(source, destination, rename) {
  try {
    rename(source, destination);
  } catch (error) {
    if (!IN_PLACE_CODES.has(error.code)) throw error;
    fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  }
}

/** Make `destination` hold exactly the files of `source`, without replacing the directory itself. */
function mirrorDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const wanted = new Set(listFiles(source));
  for (const relative of listFiles(destination)) {
    if (!wanted.has(relative)) {
      fs.rmSync(path.join(destination, relative), { force: true });
    }
  }
  removeEmptyDirectories(destination);
  fs.cpSync(source, destination, { recursive: true, force: true, preserveTimestamps: true });
}

function listFiles(directory, prefix = '') {
  const here = prefix ? path.join(directory, prefix) : directory;
  return fs.readdirSync(here, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    return entry.isDirectory() ? listFiles(directory, relative) : [relative];
  });
}

function removeEmptyDirectories(directory, isRoot = true) {
  let empty = true;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !removeEmptyDirectories(path.join(directory, entry.name), false)) {
      empty = false;
    }
  }
  if (empty && !isRoot) {
    fs.rmdirSync(directory);
  }
  return empty;
}

function describeGitError(error, locked) {
  if (locked) {
    return 'content/.git/index.lock reste tenu (souvent l’intégration Git d’un éditeur).';
  }
  const detail = String(error?.stderr || '').trim().split('\n').find(Boolean) || error?.message || String(error);
  return `${detail.replace(/\.$/, '')}.`;
}

function short(revision) {
  return `${String(revision || '').slice(0, 8)}…`;
}

function truncate(value, length) {
  const text = String(value || '');
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
