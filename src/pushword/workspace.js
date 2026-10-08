import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as tar from 'tar';
import { contentAddress, extractRevision, frontmatter, isSnapshotFile, validateHost, walkMarkdown } from './content.js';

/**
 * A local editing mirror of production pages: `{root}/content/{host}/{slug}.md`.
 *
 * Production is the source of truth. `pull()` replaces the mirror with fresh
 * server snapshots (every page carries a `revision:` stamp), `sync()` sends
 * edited files back with optimistic locking and writes the server's canonical
 * text over them, `publish()` regenerates the static pages.
 *
 * A private Git repository inside `content/` records the last pulled or synced
 * state, so a pull refuses to wipe edits that never reached the server.
 */
export class ContentWorkspace {
  constructor({
    root,
    client,
    hosts = [],
    contentDir = 'content',
    stateDir = '.assistant',
    marker = path.join('.claude', '.last-pull'),
    log = (line) => process.stderr.write(`${line}\n`),
  }) {
    this.root = path.resolve(root);
    this.client = client;
    this.hosts = hosts;
    this.contentRoot = path.join(this.root, contentDir);
    this.stateRoot = path.join(this.root, stateDir);
    this.marker = path.join(this.root, marker);
    this.log = log;
  }

  /** Replace the mirror of `hosts` with fresh production snapshots, atomically. */
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
      installAtomically(this.contentRoot, staged, hosts);
      this.markPulled();
      return hosts.map((host) => path.join(this.contentRoot, host));
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  /** Send page files to production. Returns one result per file; never throws for HTTP outcomes. */
  async sync(files, { publish = true } = {}) {
    const results = [];
    for (const file of files) {
      const result = await this.syncOne(file);
      results.push(result);
      if (result.status === 'auth') {
        break;
      }
    }
    const synced = results.filter((result) => result.status === 'synced');
    this.recordSynced(synced.map((result) => result.file));
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

  async syncOne(file) {
    let page;
    try {
      page = contentAddress(this.contentRoot, file);
    } catch (error) {
      return this.report({ file, status: 'error', message: error.message });
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
      this.recordSynced([page.absolutePath]);
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

  /** Page files modified since the last pull, by mtime. */
  modifiedSincePull() {
    if (!fs.existsSync(this.marker)) {
      throw new Error('Aucun pull de référence : tirer les snapshots d’abord.');
    }
    const since = fs.statSync(this.marker).mtimeMs;
    return walkMarkdown(this.contentRoot).filter((file) => fs.statSync(file).mtimeMs > since).sort();
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
    this.recordSynced([page.absolutePath]);
    const generation = publish ? await this.client.triggerStatic(page.host) : null;
    return { ...page, revision: extractRevision(response.text), generation };
  }

  /** Delete a page in production, leaving a redirection, then drop the local copy. */
  async delete(host, slug, { redirectTo, code = 301, publish = true }) {
    await this.client.deletePage(host, slug, { redirectTo, code });
    const local = path.join(this.contentRoot, host, `${slug}.md`);
    if (fs.existsSync(local)) {
      fs.rmSync(local);
      this.recordSynced([local]);
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
    if (!fs.existsSync(path.join(this.contentRoot, '.git'))) {
      return;
    }
    const status = git(this.contentRoot, ['status', '--porcelain']).trim();
    if (status) {
      throw new Error('Le miroir contient des modifications non synchronisées. '
        + 'Les synchroniser ou les annuler avant un nouveau pull :\n' + status);
    }
  }

  /** Record files as matching production in the private baseline repository. */
  recordSynced(files) {
    if (!files.length || !fs.existsSync(path.join(this.contentRoot, '.git'))) {
      return;
    }
    const relative = files.map((file) => path.relative(this.contentRoot, path.resolve(file)));
    try {
      git(this.contentRoot, ['add', '--', ...relative]);
      if (git(this.contentRoot, ['diff', '--cached', '--name-only']).trim()) {
        git(this.contentRoot, ['commit', '-q', '-m', `synced ${new Date().toISOString()}`, '--', ...relative]);
      }
    } catch (error) {
      this.log(`⚠ état de référence non mis à jour : ${error.message}`);
    }
  }

  markPulled() {
    fs.mkdirSync(path.dirname(this.marker), { recursive: true });
    fs.closeSync(fs.openSync(this.marker, 'w', 0o600));
    const now = new Date();
    fs.utimesSync(this.marker, now, now);
    try {
      if (!fs.existsSync(path.join(this.contentRoot, '.git'))) {
        git(this.contentRoot, ['init', '-q']);
        git(this.contentRoot, ['config', 'user.email', 'assistant@localhost']);
        git(this.contentRoot, ['config', 'user.name', 'Assistant baseline']);
        git(this.contentRoot, ['config', 'commit.gpgsign', 'false']);
      }
      git(this.contentRoot, ['add', '-A']);
      git(this.contentRoot, ['commit', '-q', '--allow-empty', '-m', `snapshot ${now.toISOString()}`]);
    } catch (error) {
      this.log(`⚠ état de référence non créé : ${error.message}`);
    }
  }

  report(result) {
    const symbol = { synced: '✓', conflict: '⚠' }[result.status] || '✗';
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

function installAtomically(contentRoot, stagedRoot, hosts) {
  fs.mkdirSync(contentRoot, { recursive: true });
  const backupRoot = fs.mkdtempSync(path.join(path.dirname(contentRoot), '.content-backup-'));
  const installed = [];
  try {
    for (const host of hosts) {
      const destination = path.join(contentRoot, host);
      const backup = path.join(backupRoot, host);
      const hadPrevious = fs.existsSync(destination);
      if (hadPrevious) {
        fs.renameSync(destination, backup);
      }
      try {
        fs.renameSync(path.join(stagedRoot, host), destination);
      } catch (error) {
        if (hadPrevious) {
          fs.renameSync(backup, destination);
        }
        throw error;
      }
      installed.push({ destination, backup, hadPrevious });
    }
  } catch (error) {
    for (const { destination, backup, hadPrevious } of installed.reverse()) {
      fs.rmSync(destination, { recursive: true, force: true });
      if (hadPrevious) {
        fs.renameSync(backup, destination);
      }
    }
    throw error;
  } finally {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function short(revision) {
  return `${String(revision || '').slice(0, 8)}…`;
}

function truncate(value, length) {
  const text = String(value || '');
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}
