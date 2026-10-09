import fs from 'node:fs';
import path from 'node:path';

const PAGE_FILE = /^([^/]+)\/(.+)\.md$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

// Agent instruction files are not pages: a stale copy left in a server's
// content directory must never land in the mirror, where agents would obey it.
const AGENT_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);
// Pushword's page indexes, named as its flat importer reads them: `index.csv` and
// `index.draft.csv`, each also per locale (`index.en.csv`, `index.draft.de-DE.csv`).
const INDEX_FILE = /^index(?:\.draft)?(?:\.[a-z]{2}(?:[-_][a-zA-Z]{2,})?)?\.csv$/;

/** Files a snapshot may install. Anything else (conversations, quiz results) stays on the server. */
export function isSnapshotFile(relativePath) {
  const name = path.posix.basename(relativePath);
  if (AGENT_FILES.has(name)) return false;
  return relativePath.endsWith('.md') || name === 'redirection.csv' || INDEX_FILE.test(name);
}

export function validateHost(host) {
  if (typeof host !== 'string' || !HOST.test(host)) {
    throw new Error(`Hôte Pushword invalide : ${host}`);
  }
  return host;
}

/**
 * Locate a page file under `{contentRoot}/{host}/{slug}.md`. Symlinks are
 * resolved first, so a link cannot smuggle a file from outside the mirror.
 */
export function contentAddress(contentRoot, filePath) {
  const root = realpathOrResolve(contentRoot);
  const absolutePath = fs.realpathSync(filePath);
  const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
  const match = relativePath.match(PAGE_FILE);
  if (!match || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    throw new Error(`La page doit se trouver sous ${path.basename(root)}/{host}/{slug}.md.`);
  }
  validateHost(match[1]);
  return { absolutePath, relativePath, host: match[1], slug: match[2] };
}

export function tryContentAddress(contentRoot, filePath) {
  try {
    return contentAddress(contentRoot, filePath);
  } catch {
    return null;
  }
}

/** Front matter block between the opening `---` pair, or '' when absent. */
export function frontmatter(text) {
  return String(text).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1] ?? '';
}

/**
 * The server-managed `revision:` stamp. Anchored to the front matter so a
 * `revision:` line inside a code fence of the body never poisons If-Match.
 */
export function extractRevision(text) {
  return frontmatter(text).match(/^revision:[ \t]*([^\s#]+)/m)?.[1] ?? null;
}

export function walkMarkdown(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git') {
      return [];
    }
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return walkMarkdown(file);
    }
    return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
  });
}

export function encodeSlug(slug) {
  return String(slug).split('/').map(encodeURIComponent).join('/');
}

function realpathOrResolve(directory) {
  try {
    return fs.realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
}
