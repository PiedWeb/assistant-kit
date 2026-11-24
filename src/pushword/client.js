import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { simpleDiffString } from 'lib0/diff';
import * as Y from 'yjs';
import { HttpClient, HttpError, parseResponse } from '../http.js';
import { encodeSlug, validateHost } from './content.js';

const MARKDOWN = 'text/markdown; charset=UTF-8';
const SNAPSHOT_PATH = '/api/content/snapshot.tar.gz';
// The server re-exports the host before streaming it: a large site takes a while.
const SNAPSHOT_TIMEOUT_MS = 120_000;

/**
 * Upload formats, by extension: the list pushword/core accepts
 * (SafeMediaMimeType::EXTENSIONS). Refused here before the bytes travel.
 */
export const MEDIA_TYPES = Object.freeze({
  avif: 'image/avif', cr2: 'image/x-canon-cr2', csv: 'text/csv', gif: 'image/gif',
  gpx: 'application/gpx+xml', jpeg: 'image/jpeg', jpg: 'image/jpeg', mov: 'video/quicktime',
  mp4: 'video/mp4', pdf: 'application/pdf', png: 'image/png', svg: 'image/svg+xml',
  txt: 'text/plain', webm: 'video/webm', webp: 'image/webp', zip: 'application/zip',
});

export const DEFAULT_MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/**
 * Client for the pushword/api bundle (and the routes pushword/flat and
 * pushword/static-generator add to it). Addresses pages by (host, slug).
 *
 * Built to be extended: no private fields, every call goes through
 * `this.http`. `token` and `snapshotKey` are strings or functions (sync or
 * async) resolved at each request. With a snapshot key, the snapshot is
 * fetched with that read-only key alone: the editor token is neither needed
 * nor sent. `snapshotTimeoutMs` bounds a snapshot download (2 minutes).
 */
export class PushwordClient {
  constructor({
    baseUrl,
    token = null,
    snapshotKey = null,
    userAgent = 'assistant-kit/1.0',
    fetchImpl,
    http,
    httpOptions = {},
    mediaTypes = MEDIA_TYPES,
    maxMediaBytes = DEFAULT_MAX_MEDIA_BYTES,
    snapshotTimeoutMs = SNAPSHOT_TIMEOUT_MS,
  } = {}) {
    if (!baseUrl && !http) {
      throw new Error('Adresse de l’API Pushword manquante.');
    }
    this.baseUrl = String(baseUrl || http.baseUrl).replace(/\/+$/, '');
    this.snapshotKey = snapshotKey;
    this.snapshotTimeoutMs = snapshotTimeoutMs;
    this.mediaTypes = mediaTypes;
    this.maxMediaBytes = maxMediaBytes;
    this.http = http || new HttpClient({ baseUrl: this.baseUrl, token, userAgent, fetchImpl, ...httpOptions });
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

  async editingStatus(host, slug) {
    const url = `${pagePath('/api/page', host, slug)}?return=editing`;
    const { payload } = await this.http.request('GET', url);
    if (!Number.isInteger(payload?.id) || typeof payload.collaborative !== 'boolean') {
      throw new Error('Cette instance Pushword ne fournit pas l’état collaboratif.');
    }
    return { id: payload.id, collaborative: payload.collaborative };
  }

  /** Replace a unique passage of Markdown in the session shared with the admin editor. */
  async collaborate(pageId, search, replacement) {
    if (!/^[1-9][0-9]*$/.test(pageId) || typeof search !== 'string' || search === ''
      || typeof replacement !== 'string' || search === replacement) {
      throw new Error('Indiquer l’identifiant de la page et deux textes différents, dont un texte à remplacer non vide.');
    }

    const url = `/api/pages/${pageId}/draft`;
    const sync = (body) => this.http.request('POST', url, { body, redirect: 'manual' });
    const { payload: joined } = await sync({ after: 0 });
    const draft = new Y.Doc();
    const applySnapshot = (snapshot) => Y.applyUpdate(draft, Buffer.from(snapshot, 'base64'));

    try {
      const body = draft.getText('body');
      if (joined.snapshot) {
        applySnapshot(joined.snapshot);
      } else {
        const seed = new Y.Doc();
        // Pushword uses client ID 1 to give every participant the same baseline.
        seed.clientID = 1;
        seed.getText('body').insert(0, joined.baseline);
        Y.applyUpdate(draft, Y.encodeStateAsUpdate(seed));
        seed.destroy();
      }
      for (const update of joined.legacyUpdates ?? []) {
        applySnapshot(update);
      }

      const current = body.toString();
      const offset = current.indexOf(search);
      if (offset < 0 || offset !== current.lastIndexOf(search)) {
        throw new Error('Le texte à remplacer doit apparaître exactement une fois dans le brouillon partagé.');
      }
      const { index, remove, insert } = simpleDiffString(search, replacement);
      draft.transact(() => {
        if (remove) body.delete(offset + index, remove);
        if (insert) body.insert(offset + index, insert);
      });

      let after = joined.after;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { payload } = await sync({
          room: joined.room,
          after,
          snapshot: Buffer.from(Y.encodeStateAsUpdate(draft)).toString('base64'),
          content: body.toString(),
        });
        if (payload.accepted === true) return payload.revision;
        if (payload.accepted !== false || !payload.snapshot || !(payload.after > after)) break;

        applySnapshot(payload.snapshot);
        after = payload.after;
      }
      throw new Error('Le brouillon partagé a changé pendant l’enregistrement. Relire le texte avant de réessayer.');
    } finally {
      draft.destroy();
    }
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
      headers: { 'Content-Type': MARKDOWN, 'If-Match': revision, 'X-Pushword-Respect-Collaboration': '1' },
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

  /**
   * Stream the host's flat export (tar.gz) to `destination`, with the snapshot
   * key alone when there is one, else with the editor token. Neither follows a
   * redirect to another origin.
   */
  async downloadSnapshot(host, destination) {
    validateHost(host);
    const key = await resolveSecret(this.snapshotKey);
    const response = await this.http.send('GET', `${SNAPSHOT_PATH}?host=${encodeURIComponent(host)}`, {
      accept: 'application/gzip',
      headers: key ? { 'X-Pushword-Snapshot-Key': key } : {},
      auth: !key,
      timeoutMs: this.snapshotTimeoutMs,
    });
    if (!response.ok || !response.body) {
      const payload = await parseResponse(response).catch(() => null);
      throw new HttpError(`Snapshot ${host} : HTTP ${response.status}`, response.status, payload);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
    return destination;
  }

  /**
   * Check the snapshot key alone (no token) with a HEAD: the server refuses a
   * wrong key before writing any byte of the archive. Throws an HttpError
   * carrying the status unless the server answers 200.
   */
  async checkSnapshotKey(host = null, { signal, redirect, attempts } = {}) {
    const key = await resolveSecret(this.snapshotKey);
    if (!key) {
      throw new Error('Clé de snapshot Pushword absente.');
    }
    const query = host ? `?host=${encodeURIComponent(validateHost(host))}` : '';
    const response = await this.http.send('HEAD', `${SNAPSHOT_PATH}${query}`, {
      accept: 'application/gzip',
      headers: { 'X-Pushword-Snapshot-Key': key },
      auth: false,
      signal,
      redirect,
      attempts,
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 200) {
      throw new HttpError(`Clé de snapshot Pushword refusée : HTTP ${response.status}`, response.status);
    }
    return { ok: true, status: response.status };
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

  /**
   * Upload a file (a path, or `{ bytes, filename }` already in memory). The
   * server names the media after `filename` and keeps the extension of the
   * bytes. Optional metadata: `alt`, `alts` ({ locale: text }), `tags`,
   * `customProperties`, `fileNameHistory`. A 200 with `duplicate: true` means
   * the same bytes were already there. Never retried: a lost answer must not
   * become a second media.
   */
  async uploadMedia(source, {
    filename, alt = '', alts, tags, customProperties, fileNameHistory, maxBytes = this.maxMediaBytes,
  } = {}) {
    const file = readMediaSource(source, maxBytes);
    const type = mediaType(file.name, this.mediaTypes);
    const form = new FormData();
    form.append('file', new Blob([file.bytes], { type }), file.name);
    if (alt) {
      form.append('alt', alt);
    }
    for (const [name, value] of Object.entries({ alts, tags, customProperties, fileNameHistory })) {
      if (value !== undefined && value !== null) {
        form.append(name, JSON.stringify(value));
      }
    }
    return (await this.http.request('POST', mediaPath(filename || file.name), {
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

async function resolveSecret(value) {
  const resolved = typeof value === 'function' ? await value() : value;
  return resolved ? String(resolved) : null;
}

function readMediaSource(source, maxBytes) {
  if (source && typeof source === 'object' && source.bytes) {
    const name = path.basename(String(source.filename || ''));
    if (!name) {
      throw new Error('Nom de fichier manquant pour un média en mémoire.');
    }
    return { name, bytes: withinLimit(source.bytes, maxBytes, name) };
  }
  const filePath = String(source || '');
  if (!filePath) {
    throw new Error('Aucun fichier à téléverser.');
  }
  const name = path.basename(filePath);
  withinLimit({ length: fs.statSync(filePath).size }, maxBytes, name);
  return { name, bytes: fs.readFileSync(filePath) };
}

function withinLimit(bytes, maxBytes, name) {
  if (bytes.length > maxBytes) {
    const megabytes = (value) => Math.round((value / 1024 / 1024) * 10) / 10;
    throw new Error(`Média trop lourd : ${name} pèse ${megabytes(bytes.length)} Mo pour ${megabytes(maxBytes)} Mo au maximum.`);
  }
  return bytes;
}

function mediaType(name, types) {
  const extension = path.extname(name).slice(1).toLowerCase();
  const type = Object.hasOwn(types, extension) ? types[extension] : null;
  if (!type) {
    throw new Error(`Format de média refusé (${extension ? `.${extension}` : 'sans extension'}) : `
      + `formats acceptés : ${Object.keys(types).join(', ')}.`);
  }
  return type;
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
