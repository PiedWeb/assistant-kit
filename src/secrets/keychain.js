import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VaultError } from './catalog.js';

const SECURE_HELPERS = new Set(['manager', 'manager-core', 'libsecret', 'osxkeychain']);

export function validateCredentialName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
    throw new VaultError('Nom de credential invalide.');
  }
}

export function validateCredentialValue(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value) || Buffer.byteLength(value) > 16_384) {
    throw new VaultError('Une valeur doit tenir sur une ligne et ne pas dépasser 16 Ko.');
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
 * Secrets in the operating system keychain, through `git credential` and a
 * forced secure helper (libsecret, Git Credential Manager, osxkeychain), never
 * `store` or `cache`. Each project uses its own `namespace`: entries live under
 * `https://{namespace}` with the credential name as username.
 */
export function createKeychain({
  namespace,
  helperVariable = 'ASSISTANT_SECRET_HELPER',
  environment = process.env,
  run = spawnSync,
  platform = process.platform,
  exists = fs.existsSync,
  cacheMs = 15_000,
} = {}) {
  if (!namespace || !/^[a-z0-9.-]+\.invalid$/.test(namespace)) {
    throw new VaultError('Le trousseau exige un espace de noms en .invalid (ex. secrets-mon-projet.invalid).');
  }
  let detected;
  const cache = new Map();

  function git(args, input) {
    const result = run('git', args, {
      input, encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 128 * 1024,
      env: { ...environment, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    });
    if (result.error) throw new VaultError(result.error.code === 'ETIMEDOUT'
      ? 'Le trousseau n’a pas répondu en 10 secondes.' : 'Impossible d’interroger le trousseau avec Git.');
    return result;
  }

  function helper() {
    if (detected !== undefined) return detected;
    const override = environment[helperVariable];
    if (override) {
      const secure = secureHelperName(override);
      if (!secure) throw new VaultError(`${helperVariable} doit désigner libsecret, manager ou osxkeychain.`);
      return (detected = secure);
    }
    const configured = git(['config', '--get-all', 'credential.helper']);
    for (const line of String(configured.stdout || '').split(/\r?\n/)) {
      const secure = secureHelperName(line);
      if (secure) return (detected = secure);
    }
    const executable = git(['--exec-path']);
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

  function execute(action, name, value) {
    const selected = helper();
    if (!selected) throw new VaultError('Aucun trousseau sécurisé disponible. Configurez libsecret, Git Credential Manager ou osxkeychain.');
    const lines = ['protocol=https', `host=${namespace}`, `username=${name}`];
    if (value !== undefined) lines.push(`password=${value}`);
    return git(['-c', 'credential.helper=', '-c', `credential.helper=${selected}`,
      '-c', 'credential.interactive=never', 'credential', action], `${lines.join('\n')}\n\n`);
  }

  function read(name, { fresh = false } = {}) {
    validateCredentialName(name);
    const cached = cache.get(name);
    if (!fresh && cached && cached.expires > Date.now()) return cached.value;
    if (!helper()) return '';
    const result = execute('fill', name);
    const value = result.status === 0
      ? String(result.stdout || '').split(/\r?\n/).find((line) => line.startsWith('password='))?.slice(9) || ''
      : '';
    cache.set(name, { value, expires: Date.now() + cacheMs });
    return value;
  }

  function write(name, value) {
    validateCredentialName(name);
    validateCredentialValue(value);
    if (!value) throw new VaultError('Une valeur vide ne peut pas être enregistrée.');
    if (read(name, { fresh: true }) === value) return;
    cache.delete(name);
    if (execute('approve', name, value).status !== 0) {
      throw new VaultError(`Impossible d’enregistrer ${name} dans le trousseau sécurisé.`);
    }
    if (read(name, { fresh: true }) !== value) {
      throw new VaultError(`Le trousseau n’a pas confirmé l’enregistrement de ${name}.`);
    }
  }

  function forget(name) {
    validateCredentialName(name);
    const current = read(name, { fresh: true });
    cache.delete(name);
    if (!current) return false;
    execute('reject', name, current);
    if (read(name, { fresh: true })) {
      throw new VaultError(`Le trousseau n’a pas confirmé la suppression de ${name}.`);
    }
    return true;
  }

  return {
    namespace,
    read,
    write,
    forget,
    refresh() { cache.clear(); detected = undefined; },
    status() {
      try {
        const selected = helper();
        return { available: Boolean(selected), helper: selected,
          detail: selected ? 'Helper sécurisé détecté. Chaque écriture est relue pour confirmation.'
            : 'Installez et configurez libsecret, Git Credential Manager ou osxkeychain.' };
      } catch (error) {
        return { available: false, helper: null, detail: error instanceof VaultError ? error.message : 'Trousseau indisponible.' };
      }
    },
  };
}
