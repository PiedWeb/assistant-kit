import fs from 'node:fs';
import path from 'node:path';

// Keys whose value is a credential or a content: an audit line names the call, never its payload.
const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'passphrase', 'token', 'secret', 'authorization', 'cookie', 'apikey', 'credential',
  'credentials', 'body', 'text', 'html', 'subject', 'content',
]);
const SENSITIVE_SUFFIXES = ['password', 'token', 'secret', 'apikey'];

/**
 * Local JSONL journal of the writes a connector performs. Each line is
 * `{ ts, ...entry }`; the directory is created 0700, the file kept 0600.
 *
 * `record(entry)` throws when an entry holds an obviously sensitive key
 * (password, token, body, text, html, subject...): that is a bug in the
 * caller. A journal that cannot be written is reported through `onError` and
 * never fails the call (`record()` returns false).
 */
export function createAuditLog(file, { now = () => new Date(), onError = warn } = {}) {
  if (!file) {
    throw new Error('Fichier du journal d’audit manquant.');
  }
  const target = path.resolve(String(file));
  return {
    file: target,
    record(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('Une entrée du journal d’audit doit être un objet.');
      }
      assertNoSensitiveKey(entry);
      const ts = now().toISOString();
      const line = `${JSON.stringify(Object.assign({ ts }, entry, { ts }))}\n`;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.appendFileSync(target, line, { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(target, 0o600);
        return true;
      } catch (error) {
        onError(error);
        return false;
      }
    },
    /** Entries recorded at or after `since` (an ISO timestamp); unreadable lines are skipped. */
    read({ since = '' } = {}) {
      let source;
      try {
        source = fs.readFileSync(target, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
        throw error;
      }
      return source.split(/\r?\n/).flatMap((raw) => {
        if (!raw.trim()) return [];
        try {
          const entry = JSON.parse(raw);
          return entry && typeof entry === 'object' && !Array.isArray(entry) && String(entry.ts || '') >= since ? [entry] : [];
        } catch {
          return [];
        }
      });
    },
  };
}

function assertNoSensitiveKey(value, trail = []) {
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const name = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SENSITIVE_KEYS.has(name) || SENSITIVE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      throw new Error(`Clé « ${[...trail, key].join('.')} » refusée dans le journal d’audit : `
        + 'y consigner l’action, ses paramètres non secrets et le statut, jamais un secret ni un contenu.');
    }
    if (trail.length < 8) {
      assertNoSensitiveKey(item, [...trail, key]);
    }
  }
}

function warn(error) {
  // stdout may be the JSON-RPC channel of an MCP server: warn on stderr.
  process.stderr.write(`⚠ journal d’audit non écrit (${error.message})\n`);
}
