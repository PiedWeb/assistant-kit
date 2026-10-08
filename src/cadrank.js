const INSTANCES = Object.freeze({
  fr: { baseUrl: 'https://cadrank.piedweb.com' },
  us: { baseUrl: 'https://cadrank-us.piedweb.com' },
});

/**
 * Read-only Cadrank client (SERP, related keywords, crawls, URL mappings).
 * `instance` picks a default base URL; `baseUrl` overrides it.
 */
export class CadrankClient {
  constructor({ instance = 'fr', apiKey, baseUrl, fetchImpl = globalThis.fetch, maxRetries = 3, userAgent = 'assistant-kit/1.0', sleep = delay }) {
    if (!INSTANCES[instance]) {
      throw new Error(`Instance Cadrank inconnue : ${instance}.`);
    }
    this.instance = instance;
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || INSTANCES[instance].baseUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.maxRetries = maxRetries;
    this.userAgent = userAgent;
    this.sleep = sleep;
  }

  async projects() {
    const payload = await this.getJson('projects');
    if (Array.isArray(payload)) {
      return payload;
    }
    return payload?.projects || payload?.items || [];
  }

  async crawls() {
    return flattenCrawls(await this.projects());
  }

  async mapping(host) {
    const trackedHost = await this.trackedHost(host);
    return this.getCsv(`urlSearchData/${encodeURIComponent(trackedHost)}`);
  }

  async crawlExport(crawlId, { all = false } = {}) {
    const filter = all ? '' : "/(where:(ns.keyword:(o:'!!=',v:%22%22)))";
    return this.getCsv(`crawler/${encodeURIComponent(crawlId)}/exportCsv${filter}?last`);
  }

  async keywordsForUrl(url) {
    return this.getCsv(`searchForUrl/${encodeURIComponent(url)}`);
  }

  async targets(url) {
    return this.getCsv(`urlTargetedKws/${encodeURIComponent(url)}`);
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
    try {
      const payload = JSON.parse(source);
      if (payload?.status === 'processing') {
        const error = new Error('Cadrank calcule encore les termes ; relancer dans quelques secondes.');
        error.code = 'CADRANK_PROCESSING';
        throw error;
      }
      return Array.isArray(payload) ? payload : [payload];
    } catch (error) {
      if (error.code === 'CADRANK_PROCESSING') {
        throw error;
      }
      return source.split(/[\n,]/).map((term) => term.trim()).filter(Boolean);
    }
  }

  async getJson(apiPath) {
    const source = await this.get(apiPath);
    try {
      return JSON.parse(source);
    } catch {
      throw new Error(`Réponse Cadrank non JSON pour ${apiPath}.`);
    }
  }

  async getCsv(apiPath) {
    return parseCsv(await this.get(apiPath));
  }

  async get(apiPath) {
    if (!this.apiKey) {
      throw new Error(`Clé absente pour Cadrank ${this.instance}.`);
    }
    const url = `${this.baseUrl}/_api/${String(apiPath).replace(/^\/+/, '')}`;
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetch(url, {
          method: 'GET',
          headers: {
            'X-AUTH-TOKEN': this.apiKey,
            Accept: 'text/csv, application/json, text/plain, */*',
            'User-Agent': this.userAgent,
          },
          signal: AbortSignal.timeout(60_000),
        });
        if (response.ok) {
          return response.text();
        }
        if (![408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(response.status)
          || attempt === this.maxRetries) {
          throw new Error(`Cadrank ${this.instance} : HTTP ${response.status} sur ${apiPath}.`);
        }
        await this.sleep(300 * (2 ** attempt));
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries || /^Cadrank .*HTTP/.test(error.message)) {
          throw error;
        }
        await this.sleep(300 * (2 ** attempt));
      }
    }
    throw lastError || new Error(`Cadrank ${this.instance} est indisponible.`);
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

export function flattenCrawls(projects) {
  return projects.flatMap((project) => (Array.isArray(project?.crawls) ? project.crawls : [])
    .map((crawl) => {
      const host = String(crawl?.host || '').trim()
        || new URL(String(crawl?.startUrl || 'https://invalid.local')).hostname;
      return {
        host,
        domain: normaliseDomain(host),
        crawlId: String(crawl?.hashId || ''),
        name: String(crawl?.name || ''),
        projectId: String(project?.id || ''),
        projectName: String(project?.name || ''),
      };
    }).filter((crawl) => crawl.host && crawl.host !== 'invalid.local'));
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

function normaliseDomain(value) {
  const raw = String(value || '').trim().toLowerCase();
  const host = raw.includes('://') ? new URL(raw).hostname : raw.split('/')[0];
  return host.startsWith('www.') ? host.slice(4) : host;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { INSTANCES };
