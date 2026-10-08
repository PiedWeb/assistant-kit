import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { HttpClient, HttpError, parseResponse } from '../http.js';
import { encodeSlug, validateHost } from './content.js';

const MARKDOWN = 'text/markdown; charset=UTF-8';

/**
 * Client for the pushword/api bundle (and the routes pushword/flat and
 * pushword/static-generator add to it). Addresses pages by (host, slug).
 */
export class PushwordClient {
  constructor({ baseUrl, token = null, snapshotKey = null, userAgent = 'assistant-kit/1.0', fetchImpl, http } = {}) {
    if (!baseUrl && !http) {
      throw new Error('Adresse de l’API Pushword manquante.');
    }
    this.baseUrl = String(baseUrl || http.baseUrl).replace(/\/+$/, '');
    this.snapshotKey = snapshotKey;
    this.http = http || new HttpClient({ baseUrl: this.baseUrl, token, userAgent, fetchImpl });
  }

  // Identity and discovery

  async whoami() {
    return (await this.http.request('GET', '/api/whoami')).payload;
  }

  async docs() {
    return (await this.http.request('GET', '/api/docs')).payload;
  }

  /** Any /api/* call, for routes this client does not wrap yet. */
  async request(method, urlPath, { body, headers, accept, expectedStatus = [200, 201, 202, 204] } = {}) {
    const apiPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
    if (!apiPath.startsWith('/api/')) {
      throw new Error('Le chemin doit commencer par /api/.');
    }
    return (await this.http.request(method, apiPath, { body, headers, accept, expectedStatus })).payload;
  }

  // Pages (JSON)

  async searchPages(query = {}) {
    return (await this.http.request('GET', `/api/page/search${queryString(query)}`)).payload;
  }

  async getPage(host, slug) {
    return (await this.http.request('GET', pagePath('/api/page', host, slug))).payload;
  }

  /** Delete a page; the server requires a target and keeps the slug as a redirection. */
  async deletePage(host, slug, { redirectTo, code = 301 }) {
    if (!redirectTo) {
      throw new Error('Une suppression de page exige une cible de redirection.');
    }
    await this.http.request('DELETE', pagePath('/api/page', host, slug), {
      body: { redirectTo, code },
      expectedStatus: [204],
    });
  }

  // Pages (raw flat files)

  /**
   * Replace a page from its .md text. Returns `{ status, text }` without
   * throwing for 200 and 409: both carry the canonical file text to write back.
   */
  async putPageFile(host, slug, text, revision) {
    if (!revision) {
      throw new Error('Une mise à jour exige la revision du fichier.');
    }
    const response = await this.http.send('PUT', pagePath('/api/content/page', host, slug), {
      body: text,
      accept: 'text/markdown',
      headers: { 'Content-Type': MARKDOWN, 'If-Match': revision },
    });
    return { status: response.status, text: await response.text() };
  }

  /** Create a page from its .md text. 201 returns the canonical text, 409 the existing page. */
  async createPageFile(host, slug, text) {
    const response = await this.http.send('POST', pagePath('/api/content/page', host, slug), {
      body: text,
      accept: 'text/markdown',
      headers: { 'Content-Type': MARKDOWN },
    });
    return { status: response.status, text: await response.text() };
  }

  /** Stream the host's flat export (tar.gz) to `destination`. */
  async downloadSnapshot(host, destination) {
    validateHost(host);
    const headers = this.snapshotKey ? { 'X-Pushword-Snapshot-Key': this.snapshotKey } : {};
    const response = await this.http.send('GET', `/api/content/snapshot.tar.gz?host=${encodeURIComponent(host)}`, {
      accept: 'application/gzip',
      headers,
      timeoutMs: 120_000,
    });
    if (!response.ok || !response.body) {
      const payload = await parseResponse(response).catch(() => null);
      throw new HttpError(`Snapshot ${host} : HTTP ${response.status}`, response.status, payload);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
    return destination;
  }

  // Static generation

  /** Regenerate one page in-process. 409 means the page is not publishable (draft, redirection...). */
  async generatePage(host, slug) {
    const response = await this.http.send('POST', pagePath('/api/static', host, slug), { idempotent: true });
    const payload = await parseResponse(response);
    if (response.status === 409) {
      return { host, slug, generated: false, skipped: payload?.error || 'not_publishable' };
    }
    if (response.status !== 200) {
      throw new HttpError(`Génération statique ${host}/${slug} : HTTP ${response.status}`, response.status, payload);
    }
    return { host, slug, generated: true, ...(payload && typeof payload === 'object' ? payload : {}) };
  }

  /** Queue a whole-host generation (sitemap, listings, redirections). */
  async triggerStatic(host, { incremental = true } = {}) {
    validateHost(host);
    return (await this.http.request('POST', `/api/static/${encodeURIComponent(host)}${incremental ? '?incremental=1' : ''}`, {
      expectedStatus: [202],
      idempotent: true,
    })).payload;
  }

  async triggerStaticAll({ incremental = true } = {}) {
    return (await this.http.request('POST', `/api/static${incremental ? '?incremental=1' : ''}`, {
      expectedStatus: [202],
      idempotent: true,
    })).payload;
  }

  async staticStatus(host) {
    validateHost(host);
    return (await this.http.request('GET', `/api/static/${encodeURIComponent(host)}`)).payload;
  }

  // Media

  async listMedia(query = {}) {
    return (await this.http.request('GET', `/api/media${queryString(query)}`)).payload;
  }

  async getMedia(filename) {
    return (await this.http.request('GET', mediaPath(filename))).payload;
  }

  async uploadMedia(filePath, { filename = path.basename(filePath), alt = '' } = {}) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(filePath)]), filename);
    if (alt) {
      form.append('alt', alt);
    }
    return (await this.http.request('POST', mediaPath(filename), {
      body: form,
      expectedStatus: [200, 201],
    })).payload;
  }

  async updateMedia(filename, changes) {
    return (await this.http.request('PATCH', mediaPath(filename), { body: changes })).payload;
  }

  async deleteMedia(filename) {
    await this.http.request('DELETE', mediaPath(filename), { expectedStatus: [204] });
  }

  // Redirections

  async listRedirections(query = {}) {
    return (await this.http.request('GET', `/api/redirection${queryString(query)}`)).payload;
  }

  async getRedirection(host, slug) {
    return (await this.http.request('GET', pagePath('/api/redirection', host, slug))).payload;
  }

  async createRedirection(host, { slug, redirectTo, code = 301 }) {
    validateHost(host);
    return (await this.http.request('POST', `/api/redirection/${encodeURIComponent(host)}`, {
      body: { slug, redirectTo, code },
      expectedStatus: [200, 201],
    })).payload;
  }

  async updateRedirection(host, slug, { redirectTo, code = 301 }) {
    return (await this.http.request('PUT', pagePath('/api/redirection', host, slug), {
      body: { redirectTo, code },
    })).payload;
  }

  async deleteRedirection(host, slug) {
    await this.http.request('DELETE', pagePath('/api/redirection', host, slug), { expectedStatus: [204] });
  }
}

function pagePath(prefix, host, slug) {
  validateHost(host);
  return `${prefix}/${encodeURIComponent(host)}/${encodeSlug(slug)}`;
}

function mediaPath(filename) {
  return `/api/media/${encodeSlug(filename)}`;
}

function queryString(query) {
  if (typeof query === 'string') {
    return query ? `?${query.replace(/^\?/, '')}` : '';
  }
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query || {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null && item !== '') {
        params.append(Array.isArray(value) ? `${name}[]` : name, String(item));
      }
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}
