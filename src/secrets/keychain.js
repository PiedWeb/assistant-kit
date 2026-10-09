import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VaultError } from './catalog.js';

const SECURE_HELPERS = new Set(['manager', 'manager-core', 'libsecret', 'osxkeychain']);
const NAME = /^[A-Za-z0-9_]{1,128}$/;
const MAX_VALUE_BYTES = 256 * 1024;

/**
 * Storage format shared with the GrandAngle common trunk: an index entry
 * (`configuration-v2`, base64url JSON `{ version: 2, keys }`) and one entry per
 * value (`valeur-v2-NAME`, base64url UTF-8). Both projects read and write the
 * same entries, so a value saved by one is visible to the other.
 */
export const MANIFEST_USER = 'configuration-v2';
export const VALUE_USER_PREFIX = 'valeur-v2-';

/**
 * The keychain did not answer, which is not the same as answering "empty".
 * Nothing stored means "configure"; no answer means "conclude nothing": the
 * values are most likely all there and must not be asked for again.
 */
export class KeychainUnavailableError extends VaultError {
  constructor(message) {
    super(message);
    this.name = 'KeychainUnavailableError';
  }
}

export function validateCredentialName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new VaultError('Nom de credential invalide.');
  }
}

/** Values typed in a form or piped on stdin: one line, at most 256 KB. */
export function validateCredentialValue(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value) || Buffer.byteLength(value) > MAX_VALUE_BYTES) {
    throw new VaultError('Une valeur doit tenir sur une ligne et ne pas dépasser 256 Ko.');
  }
}

// Git executes helper strings through a shell. Accept only a known bare name or
// a simple absolute path, never shell commands, arguments or metacharacters.
export function secureHelperName(value) {
  const candidate = String(value || '').trim();
  const bare = candidate.replace(/^git-credential-/, '').replace(/\.exe$/i, '');
  if (SECURE_HELPERS.has(bare)) return candidate;
  const unquoted = candidate.startsWith('"') && candidate.endsWith('"') ? candidate.slice(1, -1) : candidate;
  if (!/^(?:\/|[A-Za-z]:[\\/])[A-Za-z0-9_ .:/\\-]+$/.test(unquoted)) return null;
  const basename = unquoted.replaceAll('\\', '/').split('/').pop().replace(/\.exe$/i, '').replace(/^git-credential-/, '');
  if (!SECURE_HELPERS.has(basename)) return null;
  // Git must see the leading slash (or drive) to recognize an absolute helper.
  // Quoting the whole path makes Git prepend "git credential-" to it.
  return unquoted.replaceAll('\\', '/').replaceAll(' ', '\\ ');
}

/**
 * Environment for every Git and helper process: never a prompt, never a
 * window. A Linux MCP launcher may omit the desktop session bus, which leaves
 * libsecret unable to reach a healthy keychain: fall back to the user's own
 * session socket when it exists.
 */
export function nonInteractiveGitEnvironment(environment = process.env, {
  platform = process.platform,
  userId = typeof process.getuid === 'function' ? process.getuid() : null,
  stat = fs.statSync,
} = {}) {
  const result = { ...environment, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  if (platform === 'linux' && !result.DBUS_SESSION_BUS_ADDRESS && Number.isInteger(userId) && userId >= 0) {
    const bus = `/run/user/${userId}/bus`;
    try {
      const metadata = stat(bus);
      if (metadata.uid === userId && metadata.isSocket()) result.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
    } catch {
      // A server without a desktop session keeps its environment.
    }
  }
  return result;
}

export function encodeManifest(keys) {
  return Buffer.from(JSON.stringify({ version: 2, keys: [...keys].sort() }), 'utf8').toString('base64url');
}

export function decodeManifest(payload) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new VaultError('L’index du trousseau est illisible. Relancez la configuration.');
  }
  if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.keys)) {
    throw new VaultError('Le format de l’index du trousseau est inconnu. Relancez la configuration.');
  }
  const keys = parsed.keys.map(String);
  if (keys.some((key) => !NAME.test(key))) throw new VaultError('L’index du trousseau est invalide. Relancez la configuration.');
  return keys;
}

export function encodeValue(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeValue(payload) {
  try {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(payload)) throw new Error('invalid base64url');
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload.replace(/=+$/, '')) throw new Error('non-canonical base64url');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new VaultError('Une valeur du trousseau est illisible.');
  }
}

function installHelp(platform) {
  if (platform === 'win32') return 'Installez Git for Windows avec l’option « Git Credential Manager ».';
  if (platform === 'darwin') return 'Installez les outils Xcode en ligne de commande (helper osxkeychain).';
  if (platform === 'linux') return 'Installez libsecret (Fedora : sudo dnf install git-credential-libsecret) ou Git Credential Manager.';
  return 'Configurez libsecret, Git Credential Manager ou osxkeychain.';
}

function sleepSync(ms) {
  // Everything here is synchronous (spawnSync), so the pause is too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Secrets in the operating system keychain, through `git credential` and a
 * forced secure helper (libsecret, Git Credential Manager, osxkeychain), never
 * `store` or `cache`. Each scope (project, organisation) has its own
 * `namespace`, an `.invalid` host under which the entries live.
 *
 * Reads ask the helper directly (`get`) instead of `git credential fill`:
 * `fill` turns "nothing stored" into a failed prompt, indistinguishable from a
 * helper that crashed. A helper that does not answer twice raises
 * `KeychainUnavailableError`, never an empty value.
 */
export function createKeychain({
  namespace,
  helperVariable = 'ASSISTANT_SECRET_HELPER',
  disableVariable = '',
  environment = process.env,
  run = spawnSync,
  platform = process.platform,
  exists = fs.existsSync,
  stat = fs.statSync,
  userId = typeof process.getuid === 'function' ? process.getuid() : null,
  sleep = sleepSync,
  cacheMs = 15_000,
  timeoutMs = 10_000,
  attempts = 2,
  retryDelayMs = 250,
} = {}) {
  if (!namespace || !/^[a-z0-9.-]+\.invalid$/.test(namespace)) {
    throw new VaultError('Le trousseau exige un espace de noms en .invalid (ex. secrets-mon-projet.invalid).');
  }
  let detected;
  let manifestCache = null;
  const valueCache = new Map();
  const childEnvironment = () => nonInteractiveGitEnvironment(environment, { platform, userId, stat });
  const disabled = () => Boolean(disableVariable) && environment[disableVariable] === '1';

  function spawn(command, args, input, extraEnvironment = {}) {
    const result = run(command, args, {
      input, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      env: { ...childEnvironment(), ...extraEnvironment },
    });
    if (result.error?.code === 'ETIMEDOUT') {
      throw new KeychainUnavailableError(`Le trousseau n’a pas répondu en ${Math.round(timeoutMs / 1000)} secondes. Les valeurs enregistrées sont intactes : réessayez.`);
    }
    return result;
  }

  function helper() {
    if (detected !== undefined) return detected;
    const override = String(environment[helperVariable] || '').trim();
    if (override) {
      const secure = secureHelperName(override);
      if (!secure) throw new VaultError(`${helperVariable} doit désigner libsecret, manager ou osxkeychain.`);
      return (detected = secure);
    }
    const configured = spawn('git', ['config', '--get-all', 'credential.helper']);
    if (configured.status === 0) {
      for (const line of String(configured.stdout || '').split(/\r?\n/)) {
        const secure = secureHelperName(line);
        if (secure) return (detected = secure);
      }
    }
    const executable = spawn('git', ['--exec-path']);
    if (executable.status === 0) {
      const directory = String(executable.stdout || '').trim();
      if (directory) {
        for (const name of SECURE_HELPERS) {
          if (exists(path.join(directory, `git-credential-${name}${platform === 'win32' ? '.exe' : ''}`))) {
            return (detected = name);
          }
        }
      }
    }
    return (detected = null);
  }

  function requireHelper() {
    const selected = helper();
    if (!selected) throw new VaultError(`Aucun trousseau sécurisé disponible. ${installHelp(platform)}`);
    return selected;
  }

  function credentialInput(username, password) {
    const lines = ['protocol=https', `host=${namespace}`, `username=${username}`];
    if (password !== undefined) lines.push(`password=${password}`);
    return `${lines.join('\n')}\n\n`;
  }

  /** `git credential approve|reject` through the forced secure helper only. */
  function gitCredential(action, username, password) {
    const selected = requireHelper();
    const result = spawn('git', ['-c', 'credential.helper=', '-c', `credential.helper=${selected}`,
      '-c', 'credential.interactive=never', 'credential', action], credentialInput(username, password));
    if (result.error) throw new KeychainUnavailableError('Impossible de lancer Git pour joindre le trousseau.');
    return result;
  }

  // Git's own resolution: a bare name runs `git credential-<name>`, a path runs as is.
  function helperCommand(selected) {
    const value = selected.replaceAll('\\ ', ' ');
    return /[\\/]/.test(value) ? { command: value, args: ['get'] } : { command: 'git', args: [`credential-${value}`, 'get'] };
  }

  /** The stored password for `username`, `null` when the keychain holds none. */
  function getEntry(username) {
    const selected = helper();
    if (!selected) return null;
    const { command, args } = helperCommand(selected);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // GCM_* are read by Git Credential Manager alone: a missing entry then ends
      // offline at once instead of probing the `.invalid` host.
      const result = spawn(command, args, credentialInput(username), { GCM_PROVIDER: 'generic', GCM_ALLOW_WINDOWSAUTH: 'false' });
      if (result.status === 0) {
        const line = String(result.stdout || '').split(/\r?\n/).find((item) => item.startsWith('password='));
        return line ? line.slice('password='.length) : null;
      }
      if (/user interactivity has been disabled/i.test(String(result.stderr || ''))) return null;
      if (attempt < attempts) sleep(retryDelayMs);
    }
    throw new KeychainUnavailableError(`Le trousseau du poste n’a pas répondu (${selected}). Les valeurs enregistrées sont intactes : rien à reconfigurer, réessayez.`);
  }

  /** A decoded entry, asked twice when the answer does not decode (garbled in transit). */
  function getDecoded(username, decode) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const payload = getEntry(username);
      if (payload === null) return null;
      try {
        return decode(payload);
      } catch (error) {
        if (attempt >= attempts) throw error;
        sleep(retryDelayMs);
      }
    }
    return null;
  }

  function fresh(entry) {
    return entry && entry.expires > Date.now();
  }

  /** Names the index declares, or `null` without an index (nothing saved yet, or index lost). */
  function names({ fresh: refresh = false } = {}) {
    if (disabled()) return [];
    if (!refresh && fresh(manifestCache)) return manifestCache.keys && [...manifestCache.keys];
    let keys;
    try {
      keys = getDecoded(MANIFEST_USER, decodeManifest);
    } catch (error) {
      if (error instanceof KeychainUnavailableError) throw error;
      keys = null;
    }
    manifestCache = { keys: keys && new Set(keys), expires: Date.now() + cacheMs };
    return keys && [...keys];
  }

  /** The value entry itself, bypassing the index (used to verify a write). */
  function stored(name) {
    return getDecoded(VALUE_USER_PREFIX + name, decodeValue) ?? '';
  }

  function read(name, { fresh: refresh = false } = {}) {
    validateCredentialName(name);
    if (disabled()) return '';
    const cached = valueCache.get(name);
    if (!refresh && fresh(cached)) return cached.value;
    // The index answers "absent" without a helper call per missing name: on
    // Windows each miss costs more than a hit.
    const known = names({ fresh: refresh });
    const value = known && !known.includes(name) ? '' : stored(name);
    valueCache.set(name, { value, expires: Date.now() + cacheMs });
    return value;
  }

  function values() {
    return Object.fromEntries((names() || []).map((name) => [name, read(name)]).filter(([, value]) => value));
  }

  function writeManifest(keys) {
    if (gitCredential('approve', MANIFEST_USER, encodeManifest(keys)).status !== 0) {
      throw new VaultError(`Le trousseau a refusé son index. ${installHelp(platform)}`);
    }
    const written = getDecoded(MANIFEST_USER, decodeManifest) || [];
    if (written.length !== keys.length || keys.some((key) => !written.includes(key))) {
      throw new VaultError('Le trousseau n’a pas confirmé son index.');
    }
    manifestCache = { keys: new Set(keys), expires: Date.now() + cacheMs };
  }

  /**
   * Store several values. `replace: true` makes them the whole content of the
   * namespace (the index then lists them only), as the GrandAngle Vault does.
   * Each written value is read back before the index is updated.
   */
  function save(input, { replace = false } = {}) {
    requireHelper();
    const cleaned = Object.entries(input).map(([name, value]) => [name, String(value ?? '').trim()]).filter(([, value]) => value);
    for (const [name, value] of cleaned) {
      validateCredentialName(name);
      if (value.includes('\0') || Buffer.byteLength(value) > MAX_VALUE_BYTES) {
        throw new VaultError(`Valeur trop longue ou invalide : ${name}.`);
      }
    }
    if (!cleaned.length) throw new VaultError('Renseignez au moins une valeur avant d’enregistrer.');
    const index = names({ fresh: true });
    const previousKeys = index || [];
    const changed = cleaned.filter(([name, value]) => (index && !index.includes(name) ? '' : stored(name)) !== value);
    for (const [name, value] of changed) {
      if (gitCredential('approve', VALUE_USER_PREFIX + name, encodeValue(value)).status !== 0) {
        throw new VaultError(`Le trousseau a refusé l’enregistrement de ${name}. ${installHelp(platform)}`);
      }
      valueCache.delete(name);
    }
    for (const [name, value] of changed) {
      if (stored(name) !== value) throw new VaultError(`Le trousseau n’a pas confirmé l’enregistrement de ${name}.`);
    }
    const keys = [...new Set([...(replace ? [] : previousKeys), ...cleaned.map(([name]) => name)])].sort();
    if (keys.length !== previousKeys.length || keys.some((key) => !previousKeys.includes(key))) writeManifest(keys);
    for (const [name, value] of cleaned) valueCache.set(name, { value, expires: Date.now() + cacheMs });
    return { saved: changed.map(([name]) => name).sort() };
  }

  function write(name, value) {
    validateCredentialName(name);
    if (!String(value ?? '').trim()) throw new VaultError('Une valeur vide ne peut pas être enregistrée.');
    save({ [name]: value });
  }

  /** Remove one value and its index line. */
  function forget(name) {
    validateCredentialName(name);
    requireHelper();
    const keys = names({ fresh: true });
    const present = stored(name) !== '';
    if (present) gitCredential('reject', VALUE_USER_PREFIX + name);
    valueCache.delete(name);
    if (present && stored(name)) throw new VaultError(`Le trousseau n’a pas confirmé la suppression de ${name}.`);
    if (keys?.includes(name)) writeManifest(keys.filter((key) => key !== name));
    return present;
  }

  /**
   * Empty this namespace: the index and every value it or `known` names.
   * Anything else stored in the system keychain is left alone. The index goes
   * last, so a surviving value always stays listed.
   */
  function forgetAll(known = []) {
    requireHelper();
    const targets = new Set(known.map(String));
    for (const name of names({ fresh: true }) || []) targets.add(name);
    const forgotten = [];
    for (const name of targets) {
      validateCredentialName(name);
      if (getEntry(VALUE_USER_PREFIX + name) === null) continue;
      gitCredential('reject', VALUE_USER_PREFIX + name);
      forgotten.push(name);
    }
    gitCredential('reject', MANIFEST_USER);
    refresh();
    return forgotten.sort();
  }

  function validateUsername(username) {
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(username)) {
      throw new VaultError('Nom d’entrée du trousseau invalide.');
    }
  }

  /** Raw entry access for a project's own legacy formats (never decoded, never cached). */
  function readEntry(username) {
    validateUsername(username);
    return getEntry(username) ?? '';
  }

  function removeEntry(username) {
    validateUsername(username);
    refresh();
    return gitCredential('reject', username).status === 0;
  }

  /** A value in the assistant-kit 0.1 format (username = name, raw value). */
  function readLegacy(name) {
    validateCredentialName(name);
    return getEntry(name) ?? '';
  }

  /**
   * Move values from the 0.1 format to the shared format. A legacy entry is
   * removed only after its copy is confirmed; a different value already in the
   * shared format wins and the legacy entry stays for a manual check.
   */
  function migrateLegacy(candidates) {
    const found = {};
    const conflicts = [];
    const current = [];
    for (const name of candidates) {
      const legacy = readLegacy(name);
      if (!legacy) continue;
      const existing = read(name, { fresh: true });
      if (existing && existing !== legacy) conflicts.push(name);
      else if (existing) current.push(name);
      else found[name] = legacy;
    }
    if (Object.keys(found).length) save(found);
    const migrated = [...Object.keys(found), ...current].sort();
    for (const name of migrated) {
      if (read(name, { fresh: true }) === readLegacy(name)) gitCredential('reject', name);
    }
    return { migrated, conflicts: conflicts.sort() };
  }

  function refresh() {
    detected = undefined;
    manifestCache = null;
    valueCache.clear();
  }

  function status() {
    try {
      const selected = helper();
      if (!selected) return { available: false, unavailable: false, helper: null, configured: false, detail: installHelp(platform) };
      const keys = names({ fresh: true });
      return { available: true, unavailable: false, helper: selected, configured: Boolean(keys?.length),
        detail: 'Helper sécurisé détecté. Chaque écriture est relue pour confirmation.' };
    } catch (error) {
      return { available: false, unavailable: error instanceof KeychainUnavailableError, helper: null, configured: false,
        detail: error instanceof VaultError ? error.message : 'Trousseau indisponible.' };
    }
  }

  return {
    namespace, helper, names, read, values, save, write, forget, forgetAll,
    readEntry, removeEntry, readLegacy, migrateLegacy, refresh, status,
  };
}
