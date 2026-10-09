import fs from 'node:fs';
import path from 'node:path';
import { catalogFields, connectorById, validateField, VaultError } from './catalog.js';
import { validateCredentialName, validateCredentialValue } from './keychain.js';

/**
 * Read only `names` from another scope's keychain, after the project's own
 * values: a mailbox shared by two workspaces is configured once.
 */
export function sharedKeychainSource(keychain, names) {
  const allowed = new Set(names);
  return { source: `keychain:${keychain.namespace}`, read: (name) => (allowed.has(name) ? keychain.read(name) : '') };
}

/**
 * One logical vault per project. A value resolves, in order, from the
 * environment, a systemd credential (`CREDENTIALS_DIRECTORY`), the `before`
 * sources, the keychain, the `after` sources, then the catalog default.
 * A source is `{ source, read(name) }`: projects add their own (a shared
 * configuration file, another scope's keychain). Statuses report where each
 * value comes from, never the value itself.
 */
export function createVault({
  catalog, keychain, environment = process.env, aliases = {}, configureHint = 'vault configure',
  before = [], after = [], emptyEnvironmentOverrides = false,
}) {
  const fields = () => catalogFields(catalog);
  const fieldByName = (name) => fields().find((item) => item.name === name);

  function resolve(name, { defaultValue = '' } = {}) {
    validateCredentialName(name);
    // `emptyEnvironmentOverrides`: a variable set to '' disables the other sources.
    if (emptyEnvironmentOverrides && Object.hasOwn(environment, name)) {
      const value = String(environment[name] || '').trim();
      return { value, source: value ? 'environment' : 'missing' };
    }
    const environmentValue = String(environment[name] || '').trim();
    if (environmentValue) return { value: environmentValue, source: 'environment' };
    const directory = String(environment.CREDENTIALS_DIRECTORY || '').trim();
    if (directory) {
      try {
        const value = fs.readFileSync(path.join(directory, name), 'utf8').trim();
        if (value) return { value, source: 'systemd' };
      } catch (error) {
        if (error.code !== 'ENOENT') throw new VaultError(`Credential systemd illisible : ${name}.`);
      }
    }
    for (const extra of before) {
      const value = String(extra.read(name) || '').trim();
      if (value) return { value, source: extra.source };
    }
    const stored = keychain.read(name);
    if (stored) return { value: stored, source: 'keychain' };
    for (const extra of after) {
      const value = String(extra.read(name) || '').trim();
      if (value) return { value, source: extra.source };
    }
    const fallback = defaultValue || fieldByName(name)?.defaultValue || '';
    return { value: fallback, source: fallback ? 'default' : 'missing' };
  }

  function credential(name, { required = true, defaultValue = '' } = {}) {
    const { value } = resolve(name, { defaultValue });
    if (value) return value;
    if (!required) return null;
    throw new VaultError(`Credential manquant : ${name}. Lancer \`${configureHint}\`.`);
  }

  function values(id) {
    return Object.fromEntries(connectorById(catalog, id).fields.map((item) => [item.name, resolve(item.name, item).value]));
  }

  /**
   * Names still missing. A connector may declare `requirements`, alternative
   * groups of names (any complete group is enough, as in GrandAngle's catalog);
   * otherwise every `required` field is needed.
   */
  function missingNames(item, configured) {
    if (Array.isArray(item.requirements) && item.requirements.length) {
      const gaps = item.requirements.map((group) => group.filter((name) => !configured(name)));
      if (gaps.some((gap) => !gap.length)) return [];
      return gaps.reduce((best, gap) => (gap.length < best.length ? gap : best));
    }
    return item.fields.filter((entry) => entry.required && !configured(entry.name)).map((entry) => entry.name);
  }

  function labelOf(name) {
    return fieldByName(name)?.label || name;
  }

  function validate(id, candidate) {
    const item = connectorById(catalog, id);
    const missing = missingNames(item, (name) => Boolean(Object.hasOwn(candidate, name) ? candidate[name] : resolve(name).value));
    if (missing.length) throw new VaultError(`Champs manquants : ${missing.map(labelOf).join(', ')}.`);
    for (const entry of item.fields) {
      validateCredentialValue(candidate[entry.name] || '');
      validateField(entry, candidate[entry.name]);
    }
    return candidate;
  }

  function status() {
    return Object.entries(catalog).map(([id, item]) => {
      const states = item.fields.map((entry) => {
        const resolved = resolve(entry.name, entry);
        let valid = true;
        try { validateCredentialValue(resolved.value); validateField(entry, resolved.value); } catch { valid = false; }
        return { name: entry.name, label: entry.label, secret: entry.secret, required: entry.required,
          configured: Boolean(resolved.value), valid, source: resolved.source };
      });
      const configured = new Set(states.filter((entry) => entry.configured).map((entry) => entry.name));
      const missing = missingNames(item, (name) => configured.has(name) || (!fieldByName(name) && Boolean(resolve(name).value)));
      const invalid = states.filter((entry) => !entry.valid).map((entry) => entry.name);
      return { id, label: item.label, optional: Boolean(item.optional), ready: !missing.length && !invalid.length, missing, invalid, fields: states };
    });
  }

  function save(id, submitted) {
    const item = connectorById(catalog, id);
    const updates = {};
    for (const [name, raw] of Object.entries(submitted)) {
      if (!item.fields.some((entry) => entry.name === name)) throw new VaultError('Champ inconnu dans le formulaire.');
      validateCredentialValue(raw);
      const value = raw.trim();
      if (value) updates[name] = value;
    }
    validate(id, { ...values(id), ...updates });
    if (!Object.keys(updates).length) return { saved: [], shadowed: [] };
    let saved;
    try {
      ({ saved } = keychain.save(updates));
    } catch (error) {
      keychain.refresh();
      if (error instanceof VaultError) throw error;
      throw new VaultError('Enregistrement interrompu. Vérifiez le trousseau puis réessayez ; certaines valeurs peuvent déjà avoir été enregistrées.');
    }
    return { saved, shadowed: shadowedNames(Object.keys(updates)) };
  }

  /** Store one catalog value, for scripted setup (read the value from stdin, never argv). */
  function set(name, raw) {
    const entry = fieldByName(name);
    if (!entry) throw new VaultError(`${name} n’appartient à aucun connecteur du catalogue.`);
    const value = String(raw ?? '').trim();
    validateCredentialValue(value);
    validateField(entry, value);
    keychain.write(name, value);
    return { saved: [name], shadowed: shadowedNames([name]) };
  }

  // A saved value that still does not resolve from the keychain is hidden by an earlier source.
  function shadowedNames(names) {
    return names.filter((name) => resolve(name).source !== 'keychain');
  }

  /** Move this catalog's values stored in the assistant-kit 0.1 keychain format to the shared format. */
  function migrateKeychain() {
    return keychain.migrateLegacy(fields().map((entry) => entry.name));
  }

  function forget(name) {
    if (!fieldByName(name)) throw new VaultError(`${name} n’appartient à aucun connecteur du catalogue.`);
    return keychain.forget(name);
  }

  function migrate(file, { dryRun = false } = {}) {
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch { throw new VaultError('Fichier de migration illisible.'); }
    const known = new Set(fields().map((entry) => entry.name));
    const parsed = new Map();
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const name = aliases[match[1]] || match[1];
      if (!known.has(name)) continue;
      let value = match[2];
      if (value.startsWith('"') || value.startsWith("'")) {
        const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(value);
        if (!quoted) throw new VaultError(`Valeur de migration invalide : ${name}.`);
        value = quoted[2];
      } else value = value.replace(/\s+#.*$/, '').trim();
      if (value && (!parsed.has(name) || match[1] === name)) parsed.set(name, value);
    }
    const pending = [];
    const skipped = [];
    keychain.refresh();
    for (const [name, value] of parsed) {
      // Never replace a newer local value or an explicit server override.
      if (!['default', 'missing'].includes(resolve(name).source)) { skipped.push(name); continue; }
      validateCredentialValue(value);
      validateField(fieldByName(name), value);
      pending.push([name, value]);
    }
    const migrated = [];
    if (!dryRun) {
      try {
        if (pending.length) migrated.push(...keychain.save(Object.fromEntries(pending)).saved);
      } catch {
        keychain.refresh();
        throw new VaultError('Migration interrompue. Le fichier source est conservé ; relancez la migration après vérification du trousseau.');
      }
    }
    return { dryRun, pending: pending.map(([name]) => name).sort(), migrated: migrated.sort(), skipped: skipped.sort() };
  }

  return {
    catalog,
    credential,
    resolve,
    values,
    validate,
    status,
    save,
    set,
    forget,
    migrate,
    migrateKeychain,
    assertReady: (id) => validate(id, values(id)),
    backend: () => keychain.status(),
    refresh: () => keychain.refresh(),
  };
}
