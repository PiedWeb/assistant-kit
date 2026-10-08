import fs from 'node:fs';
import path from 'node:path';
import { catalogFields, connectorById, validateField, VaultError } from './catalog.js';
import { validateCredentialName, validateCredentialValue } from './keychain.js';

/**
 * One logical vault per project. A value resolves, in order, from the
 * environment, a systemd credential (`CREDENTIALS_DIRECTORY`), the keychain,
 * then the catalog default. Statuses report where each value comes from,
 * never the value itself.
 */
export function createVault({ catalog, keychain, environment = process.env, aliases = {}, configureHint = 'vault configure' }) {
  const fields = () => catalogFields(catalog);
  const fieldByName = (name) => fields().find((item) => item.name === name);

  function resolve(name, { defaultValue = '' } = {}) {
    validateCredentialName(name);
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
    const stored = keychain.read(name);
    if (stored) return { value: stored, source: 'keychain' };
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

  function validate(id, candidate) {
    const item = connectorById(catalog, id);
    const missing = item.fields.filter((entry) => entry.required && !candidate[entry.name]);
    if (missing.length) throw new VaultError(`Champs manquants : ${missing.map((entry) => entry.label).join(', ')}.`);
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
      const missing = states.filter((entry) => entry.required && !entry.configured).map((entry) => entry.name);
      const invalid = states.filter((entry) => !entry.valid).map((entry) => entry.name);
      return { id, label: item.label, ready: !missing.length && !invalid.length, missing, invalid, fields: states };
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
    const saved = [];
    try {
      for (const [name, value] of Object.entries(updates)) {
        keychain.write(name, value);
        saved.push(name);
      }
    } catch {
      keychain.refresh();
      throw new VaultError(`Enregistrement interrompu après ${saved.length} valeur(s) confirmée(s). Vérifiez le trousseau puis réessayez ; certaines valeurs peuvent déjà avoir été enregistrées.`);
    }
    const shadowed = saved.filter((name) => ['environment', 'systemd'].includes(resolve(name).source));
    return { saved, shadowed };
  }

  /** Store one catalog value, for scripted setup (read the value from stdin, never argv). */
  function set(name, raw) {
    const entry = fieldByName(name);
    if (!entry) throw new VaultError(`${name} n’appartient à aucun connecteur du catalogue.`);
    const value = String(raw ?? '').trim();
    validateCredentialValue(value);
    validateField(entry, value);
    keychain.write(name, value);
    return { saved: [name], shadowed: ['environment', 'systemd'].includes(resolve(name).source) ? [name] : [] };
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
      if (['environment', 'systemd', 'keychain'].includes(resolve(name).source)) { skipped.push(name); continue; }
      validateCredentialValue(value);
      validateField(fieldByName(name), value);
      pending.push([name, value]);
    }
    const migrated = [];
    if (!dryRun) {
      try {
        for (const [name, value] of pending) { keychain.write(name, value); migrated.push(name); }
      } catch {
        keychain.refresh();
        throw new VaultError(`Migration interrompue après ${migrated.length} valeur(s) confirmée(s). Le fichier source est conservé ; relancez la migration après vérification du trousseau.`);
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
    assertReady: (id) => validate(id, values(id)),
    backend: () => keychain.status(),
    refresh: () => keychain.refresh(),
  };
}
