import { HttpClient, HttpError } from './http.js';

const INSTANCES = Object.freeze({
  fr: { baseUrl: 'https://cadrank.piedweb.com' },
  us: { baseUrl: 'https://cadrank-us.piedweb.com' },
});

/** Default crawl-export filter: URLs that have a main keyword (Cadrank syntax, already encoded). */
export const NETLINK_FILTER = "(where:(ns.keyword:(o:'!!=',v:%22%22)))";

/**
 * The only paths `post()` accepts. The key may allow more; widening this list
 * is a deliberate change that shows in review.
 */
export const WRITABLE = Object.freeze([
  /^crawler\/[A-Za-z0-9_-]+\/extract$/, // launchCrawl(): re-run an existing crawl
]);

export class CadrankError extends Error {
  constructor(message, { status = null, instance = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CadrankError';
    this.status = status;
    this.instance = instance;
  }
}

/** Cadrank is still computing (`search/semantic`): call back in a few seconds. */
export class CadrankProcessing extends CadrankError {
  constructor(message, options) {
    super(message, options);
    this.name = 'CadrankProcessing';
    this.code = 'CADRANK_PROCESSING';
  }
}

/**
 * Cadrank client (SERP, related keywords, crawls, URL mappings). `instance`
 * picks a default base URL; `baseUrl` overrides it. Each instance has its own
 * key: they are not interchangeable.
 *
 * Reads go through `HttpClient` retries. The single write, `launchCrawl()`,
 * needs `allowWrites: true`, is never retried and is passed to the optional
 * `audit` hook (a function or `{ record }`, see `createAuditLog`), which never
 * receives the key.
 */
export class CadrankClient {
  constructor({
    instance = 'fr',
    apiKey,
    baseUrl,
    fetchImpl = globalThis.fetch,
    maxRetries = 3,
    userAgent = 'assistant-kit/1.0',
    sleep = delay,
    timeoutMs = 60_000,
    allowWrites = false,
    audit = null,
    http = null,
  } = {}) {
    if (!INSTANCES[instance] && !baseUrl) {
      throw new CadrankError(`Instance Cadrank inconnue : ${instance}. Instances : ${Object.keys(INSTANCES).join(', ')}.`);
    }
    this.instance = instance;
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || INSTANCES[instance].baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.allowWrites = allowWrites;
    this.audit = audit;
    this.http = http || new HttpClient({ baseUrl: this.baseUrl, userAgent, fetchImpl, attempts: maxRetries + 1, sleep });
    this.memo = { projects: null, crawls: null };
  }

  /** Never the key. */
  toString() {
    return `CadrankClient(instance=${this.instance}, baseUrl=${this.baseUrl})`;
  }

  /** Forget the memoised projects and crawls. */
  refresh() {
    this.memo = { projects: null, crawls: null };
    return this;
  }

  /** The instance's projects with their crawls (memoised; `refresh: true` reloads). */
  async projects({ refresh = false } = {}) {
    if (refresh || this.memo.projects === null) {
      this.memo = { projects: normaliseProjects(await this.getJson('projects')), crawls: null };
    }
    return [...this.memo.projects];
  }

  /** Every crawl of the instance, flattened (memoised; `refresh: true` reloads). */
  async crawls({ refresh = false } = {}) {
    const projects = await this.projects({ refresh });
    this.memo.crawls ??= flattenCrawls(projects);
    return [...this.memo.crawls];
  }

  /** All crawls of a domain (scheme and `www.` ignored). */
  async crawlsFor(host) {
    const wanted = normaliseDomain(host);
    return (await this.crawls()).filter((crawl) => crawl.domain === wanted);
  }

  /**
   * The single crawl named by its id or its host. Refuses to choose when a
   * domain is crawled several times: one of them is often empty, and taking
   * the first would give an empty export without any error.
   */
  async crawl(hostOrId) {
    const wanted = String(hostOrId ?? '').trim();
    if (!wanted) {
      throw new CadrankError('Hôte ou identifiant de crawl attendu.', { instance: this.instance });
    }
    const crawls = await this.crawls();
    const byId = crawls.filter((crawl) => crawl.crawlId === wanted);
    if (byId.length === 1) {
      return byId[0];
    }
    const found = crawls.filter((crawl) => crawl.domain === normaliseDomain(wanted));
    if (found.length === 1) {
      return found[0];
    }
    if (!found.length) {
      const known = [...new Set(crawls.map((crawl) => crawl.domain))].sort().join(', ') || 'aucun';
      throw new CadrankError(`Aucun site suivi ne correspond à « ${wanted} » sur l’instance ${this.instance}. `
        + `Suivis ici : ${known}.`, { instance: this.instance });
    }
    const candidates = found.map((crawl) => `${crawl.crawlId} (${crawl.name || 'sans nom'})`).join(', ');
    throw new CadrankError(`« ${wanted} » est crawlé ${found.length} fois sur l’instance ${this.instance} : `
      + `${candidates}. Donner le crawlId : ces crawls n’ont pas le même contenu.`, { instance: this.instance });
  }

  /** Keyword mapping of a site, one row per URL. `filter` is a Cadrank filter expression. */
  async mapping(host, { filter = '' } = {}) {
    const trackedHost = await this.trackedHost(host);
    return this.getCsv(`urlSearchData/${encodeURIComponent(trackedHost)}${filter ? `/${filter}` : ''}`);
  }

  /**
   * Export of the latest crawl. Default filter: URLs with a main keyword (`all: true` drops it).
   * A forced recrawl clones the crawl under a new id; `last=1` follows that chain from any
   * older id. Cadrank reads the flag as a boolean: a bare `?last` counts as false.
   */
  async crawlExport(crawlId, { all = false, filter } = {}) {
    const expression = filter ?? (all ? '' : NETLINK_FILTER);
    return this.getCsv(`crawler/${encodeURIComponent(crawlId)}/exportCsv${expression ? `/${expression}` : ''}?last=1`);
  }

  async keywordsForUrl(url) {
    return this.getCsv(`searchForUrl/${encodeURIComponent(url)}`);
  }

  /**
   * Declared target keywords of a URL. Cadrank answers 400 without an explicit
   * project; by default, the one that tracks the URL's host.
   */
  async targets(url, { projectId } = {}) {
    const project = projectId ?? await this.projectFor(url);
    return this.getCsv(`urlTargetedKws/${encodeURIComponent(url)}?projectId=${encodeURIComponent(project)}`);
  }

  /** The project tracking the host of `url` (scheme and `www.` ignored); refuses to guess between several. */
  async projectFor(url) {
    const host = normaliseDomain(url);
    const ids = [...new Set((await this.crawlsFor(host)).map((crawl) => crawl.projectId).filter(Boolean))];
    if (ids.length === 1) {
      return ids[0];
    }
    throw new CadrankError(ids.length
      ? `« ${host} » est suivi par ${ids.length} projets sur l’instance ${this.instance} : ${ids.join(', ')}. Donner projectId.`
      : `Aucun projet ne suit « ${host} » sur l’instance ${this.instance} : donner projectId.`, { instance: this.instance });
  }

  async related(keyword) {
    return this.getCsv(`search/related/${encodeKeyword(keyword)}`);
  }

  async serp(keyword) {
    return this.getCsv(`search/serp/csv/${encodeKeyword(keyword)}`);
  }

  async serpContent(keyword) {
    const source = await this.get(`search/serp/content/${encodeKeyword(keyword)}`);
    const parts = source.split(/^---(.*)---$/m).slice(1);
    const pages = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const content = parts[index + 1].trim();
      if (content) {
        pages.push({ url: parts[index].trim(), content });
      }
    }
    return pages;
  }

  async semantic(keyword) {
    const source = await this.get(`search/semantic/${encodeKeyword(keyword)}`);
    let payload;
    try {
      payload = JSON.parse(source);
    } catch {
      return source.split(/[\n,]/).map((term) => term.trim()).filter(Boolean);
    }
    if (payload?.status === 'processing') {
      throw new CadrankProcessing(`Cadrank ${this.instance} calcule encore les termes de « ${keyword} » : `
        + 'relancer dans quelques secondes.', { instance: this.instance });
    }
    return Array.isArray(payload) ? payload : [payload];
  }

  /**
   * Launch or resume an existing crawl (`POST crawler/{id}/extract`). Cadrank
   * answers 202 at once: the crawl is started, not finished. `force` clones the
   * crawl under a new hashId (read the one returned), `reset` empties it.
   */
  async launchCrawl(crawlId, { reset = false, force = false, limit = null } = {}) {
    this.assertWritable();
    const id = String(crawlId ?? '').trim();
    if (!id) {
      throw new CadrankError('launchCrawl() attend un crawlId : crawls() les liste.', { instance: this.instance });
    }
    const form = {};
    if (reset) form.reset = '1';
    if (force) form.force = '1';
    if (limit !== null && limit !== undefined && limit !== '') form.limit = String(limit);
    const text = await this.post(`crawler/${encodeURIComponent(id)}/extract`, form);
    try {
      return JSON.parse(text);
    } catch {
      return { hashId: id, started: true, raw: text };
    }
  }

  async getJson(apiPath) {
    const source = await this.get(apiPath);
    try {
      return JSON.parse(source);
    } catch {
      throw new CadrankError(`Réponse Cadrank ${this.instance} non JSON pour ${apiPath}.`, { instance: this.instance });
    }
  }

  async getCsv(apiPath) {
    return parseCsv(await this.get(apiPath));
  }

  /** GET `/_api/{path}` as text, retried on transient failures. */
  async get(apiPath) {
    const clean = String(apiPath).replace(/^\/+/, '');
    const response = await this.call('GET', clean, {
      headers: { 'X-AUTH-TOKEN': await this.key() },
      accept: 'text/csv, application/json, text/plain, */*',
    });
    if (!response.ok) {
      throw this.httpError(clean, response);
    }
    return response.text;
  }

  /** Form POST on an allow-listed path: never retried, always audited. */
  async post(apiPath, form = {}) {
    this.assertWritable();
    const clean = String(apiPath).replace(/^\/+/, '');
    if (!WRITABLE.some((allowed) => allowed.test(clean))) {
      throw new CadrankError(`POST ${clean} refusé : les écritures Cadrank de ce client sont une liste fermée (WRITABLE), `
        + 'pas une capacité générale de la clé. Le faire dans l’interface Cadrank.', { instance: this.instance });
    }
    const params = Object.fromEntries(Object.entries(form).map(([name, value]) => [name, String(value)]));
    let response;
    try {
      response = await this.call('POST', clean, {
        body: new URLSearchParams(params),
        headers: { 'X-AUTH-TOKEN': await this.key() },
        accept: 'application/json, text/plain, */*',
      });
    } catch (error) {
      // The POST may have landed: an ambiguous write is the one to journal first.
      this.recordWrite(clean, params, null);
      throw error;
    }
    this.recordWrite(clean, params, response.status);
    if (!response.ok) {
      throw this.httpError(`POST ${clean}`, response, { write: true });
    }
    return response.text;
  }

  async call(method, apiPath, options) {
    try {
      return await this.http.exchange(method, `/_api/${apiPath}`, { ...options, auth: false, timeoutMs: this.timeoutMs });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new CadrankError(`Cadrank ${this.instance} injoignable (${error.message}).`,
        { instance: this.instance, cause: error });
    }
  }

  async key() {
    const key = typeof this.apiKey === 'function' ? await this.apiKey() : this.apiKey;
    if (!key) {
      throw new CadrankError(`Clé absente pour Cadrank ${this.instance}.`, { instance: this.instance });
    }
    return String(key);
  }

  assertWritable() {
    if (!this.allowWrites) {
      throw new CadrankError(`Écriture Cadrank refusée sur l’instance ${this.instance} : ce client est en lecture seule. `
        + 'Le créer avec allowWrites: true pour une demande explicite.', { instance: this.instance });
    }
  }

  recordWrite(apiPath, params, status) {
    const record = typeof this.audit === 'function' ? this.audit : this.audit?.record?.bind(this.audit);
    if (!record) return;
    try {
      record({ connector: 'cadrank', instance: this.instance, method: 'POST', path: apiPath, params,
        status, ok: status !== null && status < 400 });
    } catch (error) {
      process.stderr.write(`⚠ journal d’audit Cadrank non écrit (${error.message})\n`);
    }
  }

  httpError(apiPath, response, { write = false } = {}) {
    const { status } = response;
    let hint = '';
    if (status === 401 || status === 403) {
      hint = ` Clé absente ou invalide pour l’instance ${this.instance} : chaque instance a sa propre clé, `
        + 'elles ne sont pas interchangeables.';
      if (write) {
        hint += ' Sur une écriture, un 403 peut aussi dire que la clé est valide mais que son utilisateur '
          + 'ne peut pas modifier ce projet.';
      }
    } else if (status === 404) {
      hint = ` Hôte, URL ou mot-clé inconnu de l’instance ${this.instance} : vérifier avec crawls() `
        + 'que le site est suivi sur cette instance.';
    } else if (status === 409 && write) {
      hint = ' Les fils d’extraction de Cadrank sont tous occupés : rien n’a été lancé, réessayer dans quelques minutes.';
    }
    const detail = String(response.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return new CadrankError(`Cadrank ${this.instance} : HTTP ${status} sur ${apiPath}${detail ? ` (${detail})` : ''}.${hint}`,
      { status, instance: this.instance });
  }

  async trackedHost(host) {
    const wanted = normaliseDomain(host);
    const match = (await this.crawls()).find((crawl) => crawl.domain === wanted);
    return match?.host || host;
  }
}

export function parseCsv(source) {
  const records = readCsv(String(source || '').replace(/^\uFEFF/, ''));
  if (records.length === 0) {
    return [];
  }
  const headers = records[0].map((header) => header.trim());
  return records.slice(1)
    .filter((record) => record.some((value) => value.trim()))
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] || ''])));
}

export function encodeKeyword(keyword) {
  return String(keyword).trim().split(/\s+/).map(encodeURIComponent).join('+');
}

/**
 * Projects into one row per crawl. `host` stays as Cadrank spells it (`www.`
 * included, the endpoints need it); `startUrl` is only a fallback, with or
 * without a scheme. Malformed entries are skipped, never fatal.
 */
export function flattenCrawls(projects) {
  return (Array.isArray(projects) ? projects : []).flatMap((project) => {
    if (!project || typeof project !== 'object' || !Array.isArray(project.crawls)) return [];
    return project.crawls.flatMap((crawl) => {
      if (!crawl || typeof crawl !== 'object') return [];
      const host = String(crawl.host || '').trim() || hostname(crawl.startUrl);
      if (!host) return [];
      return [{
        host,
        domain: normaliseDomain(host),
        crawlId: String(crawl.hashId || ''),
        name: String(crawl.name || ''),
        projectId: String(project.id || ''),
        projectName: String(project.name || ''),
      }];
    });
  });
}

/** A Cadrank figure ("1 200", "3,4", "") as a number; `fallback` when it is not one. */
export function toFloat(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const text = String(value ?? '').replace(/[\s  ]/g, '').replace(',', '.');
  const number = text ? Number(text) : Number.NaN;
  return Number.isFinite(number) ? number : fallback;
}

function normaliseProjects(payload) {
  const list = Array.isArray(payload) ? payload : payload?.projects || payload?.items || [];
  return Array.isArray(list) ? list.filter((project) => project && typeof project === 'object') : [];
}

function readCsv(source) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (character !== '\r') {
      value += character;
    }
  }
  if (value || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

// Host of a URL or bare host, tolerant: `example.com/x`, `https://www.example.com:8080/`, `''`.
function hostname(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const authority = text.split('://').pop().split(/[/?#]/)[0];
  return authority.split('@').pop().replace(/:\d*$/, '');
}

function normaliseDomain(value) {
  const host = hostname(value);
  return host.startsWith('www.') ? host.slice(4) : host;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { INSTANCES };
