export class VaultError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VaultError';
  }
}

/**
 * Describe a project's connectors once: the vault, its web form, its probes
 * and its CLI all read the same catalog. Names are credential identifiers,
 * never values.
 */
export function defineCatalog(connectors) {
  const seen = new Map();
  for (const [id, item] of Object.entries(connectors)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new VaultError(`Identifiant de connecteur invalide : ${id}`);
    for (const candidate of item.fields) {
      if (seen.has(candidate.name) && seen.get(candidate.name) !== candidate) {
        throw new VaultError(`Le champ ${candidate.name} est déclaré deux fois.`);
      }
      seen.set(candidate.name, candidate);
    }
  }
  return Object.freeze({ ...connectors });
}

export function connector(label, description, fields, { link = '', probe = null } = {}) {
  return Object.freeze({ label, description, fields: Object.freeze(fields), link, probe });
}

/**
 * kinds: url (HTTPS only), port, host, email (optionally restricted to `domain`),
 * or none (a secret by default).
 */
export function field(name, label, options = {}) {
  return Object.freeze({ name, label, secret: !options.kind, defaultValue: '', required: true, help: '', ...options });
}

export function connectorById(catalog, id) {
  if (!Object.hasOwn(catalog, id)) throw new VaultError('Connecteur inconnu. Consultez « vault list ».');
  return catalog[id];
}

export function catalogFields(catalog) {
  return Object.values(catalog).flatMap((item) => item.fields);
}

export function validateField(candidate, value) {
  if (!value) return;
  let valid = true;
  let hint = '';
  if (candidate.kind === 'url') {
    try {
      const url = new URL(value);
      const exportQuery = candidate.allowExport && [...url.searchParams].length === 1
        && url.searchParams.has('export') && url.searchParams.get('export') === '';
      valid = url.protocol === 'https:' && !url.username && !url.password && (!url.search || exportQuery) && !url.hash;
    } catch { valid = false; }
    hint = `Utilisez HTTPS, sans identifiants intégrés ni fragment${candidate.allowExport ? ' ; seul le paramètre ?export est accepté' : ' ni paramètres'}.`;
  }
  if (candidate.kind === 'port') valid = /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535;
  if (candidate.kind === 'host') valid = /^(?=.{1,253}$)[a-zA-Z0-9]+(?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value);
  if (candidate.kind === 'email') {
    const domains = [candidate.domain].flat().filter(Boolean).map((domain) => domain.toLowerCase());
    const match = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(value);
    valid = Boolean(match) && (!domains.length || domains.includes(match[1].toLowerCase()));
    if (domains.length) hint = `Adresse attendue en @${domains.join(' ou @')}.`;
  }
  if (!valid) throw new VaultError(`Champ invalide : ${candidate.label}. ${hint}`.trim());
}
