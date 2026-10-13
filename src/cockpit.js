import { DEFAULT_SECRET_HEADERS, HttpClient, HttpError } from './http.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const METHODS = new Set([...READ_METHODS, 'POST', 'PUT', 'PATCH', 'DELETE']);
const SECRET_HEADERS = [...DEFAULT_SECRET_HEADERS, 'X-Project-Token', 'X-Discovery-Token', 'X-Api-Token', 'X-Liker-Token'];
const SUCCESS_STATUS = [200, 201, 202, 204];

export class CockpitError extends HttpError {
  constructor(message, { status = null, payload = null, code, cause } = {}) {
    super(message, status, payload);
    this.name = 'CockpitError';
    if (code) this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * Cockpit's personal, project and collector APIs. No host or credential is
 * assumed. token may be a string or a sync/async function; legacy credentials
 * enter through headers. Writes require allowWrites and are never retried,
 * including the collector's two write-on-GET routes.
 *
 * request() returns JSON, text or null; format: 'buffer' preserves downloads.
 * exchange() returns the complete HTTP result, including unsuccessful statuses.
 * Both enforce the API boundary and write policy. audit receives only the
 * method, pathname (without query), status and success flag, never content.
 */
export class CockpitClient {
  constructor({ baseUrl, token = null, headers = {}, allowWrites = false, audit = null,
    fetchImpl, userAgent = 'assistant-kit/1.0', http, httpOptions = {} } = {}) {
    if (!baseUrl && !http?.baseUrl) throw new CockpitError('Adresse de l’API Cockpit manquante.');
    const base = new URL(baseUrl || http.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new CockpitError('Adresse de l’API Cockpit invalide : HTTP(S) sans identifiant, requête ni fragment attendu.');
    }
    this.baseUrl = base.href.replace(/\/+$/, '');
    this.apiRoot = `${base.pathname.replace(/\/+$/, '')}/api`;
    this.allowWrites = allowWrites;
    this.audit = audit;
    this.http = http || new HttpClient({ ...httpOptions, baseUrl: this.baseUrl, token, headers, fetchImpl, userAgent,
      secretHeaders: [...SECRET_HEADERS, ...(httpOptions.secretHeaders || [])] });
    if (http instanceof HttpClient) this.http.secretHeaders = [...new Set([...http.secretHeaders, ...SECRET_HEADERS])];
  }

  toString() { return `CockpitClient(baseUrl=${this.baseUrl})`; }

  /** Same-origin API URLs only, including signed password URLs. */
  endpoint(urlPath, query = {}) {
    const url = new URL(this.http.resolveUrl(urlPath));
    if (url.origin !== new URL(this.baseUrl).origin || url.username || url.password || url.hash
      || /%2f|%5c|\/\//i.test(url.pathname)
      || (url.pathname !== this.apiRoot && !url.pathname.startsWith(`${this.apiRoot}/`))) {
      throw new CockpitError('Adresse refusée : utiliser un chemin /api de cette instance Cockpit.');
    }
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      throw new CockpitError('Les paramètres de requête doivent être un objet ou des URLSearchParams.');
    }
    if (query instanceof URLSearchParams) {
      for (const name of new Set(query.keys())) url.searchParams.delete(name);
      for (const [name, value] of query) url.searchParams.append(name, value);
    } else {
      for (const [name, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(name, Array.isArray(value) ? value.join(',') : String(value));
      }
    }
    return url;
  }

  /** Raw bytes, text, JSON, headers and status; HTTP refusals do not throw. */
  async exchange(method, urlPath, { query = {}, ...options } = {}) {
    const verb = String(method).toUpperCase();
    if (!METHODS.has(verb)) throw new CockpitError(`Méthode Cockpit inconnue : ${verb}.`);
    const url = this.endpoint(urlPath, query);
    const writes = !READ_METHODS.has(verb) || this.isMutatingRead(verb, url);
    if (writes && this.allowWrites !== true) {
      throw new CockpitError('Écriture Cockpit refusée sans allowWrites: true.', { code: 'WRITES_DISABLED' });
    }
    let result;
    try {
      result = await this.http.exchange(verb, url.href, { ...options, ...(writes ? { idempotent: false } : {}) });
    } catch (error) {
      if (writes) await this.record(verb, url, error.status ?? null, false);
      throw new CockpitError(`Cockpit : échec de ${verb} ${url.pathname}.`,
        { status: error.status, payload: error.payload, code: error.code, cause: error });
    }
    if (writes) await this.record(verb, url, result.status, result.ok);
    return result;
  }

  /** Any API route, with all query and body fields forwarded unchanged. */
  async request(method, urlPath, { expectedStatus = SUCCESS_STATUS, format = 'auto', ...options } = {}) {
    if (!['auto', 'text', 'buffer'].includes(format)) throw new CockpitError('Format attendu : auto, text ou buffer.');
    const result = await this.exchange(method, urlPath, options);
    if (!expectedStatus.includes(result.status)) {
      throw new CockpitError(`Cockpit : HTTP ${result.status} sur ${String(method).toUpperCase()} ${this.endpoint(urlPath).pathname}.`,
        { status: result.status, payload: result.json ?? result.text });
    }
    if (format === 'buffer') return result.body;
    if (format === 'text') return result.text;
    return result.json !== undefined ? result.json : result.text || null;
  }

  isMutatingRead(method, url) {
    if (!['GET', 'HEAD'].includes(method)) return false;
    const path = decodeURIComponent(url.pathname.slice(this.apiRoot.length));
    return /^\/instagram\/add\/[^/]+\/?$/.test(path)
      || (/^\/instagram\/[^/]+\/?$/.test(path)
        && !/^\/instagram\/(search|communities|export|toUpdate|toScrape|toRefresh|classify)\/?$/.test(path));
  }

  async record(method, url, status, ok) {
    const entry = { connector: 'cockpit', method, path: url.pathname, status, ok };
    if (typeof this.audit === 'function') await this.audit(entry);
    else if (this.audit) await this.audit.record(entry);
  }

  get(path, query = {}, options = {}) { return this.request('GET', path, { ...options, query }); }
  post(path, body, options = {}) { return this.request('POST', path, { ...options, body }); }
  patch(path, body, options = {}) { return this.request('PATCH', path, { ...options, body }); }
  delete(path, options = {}) { return this.request('DELETE', path, options); }

  docs() { return this.get('/api', {}, { accept: 'text/markdown', format: 'text' }); }
  scopes() { return this.get('/api/api-key-scopes'); }
  projects(query = {}) { return this.get('/api/projects', query); }
  createProject(data) { return this.post('/api/projects', data); }

  /** Omit projectId for legacy X-Project-Token / X-Project-Id integrations. */
  project(projectId = null) { return new CockpitProjectClient(this, projectId); }

  // Discovery: all filters, sorts and pagination remain server-defined.
  searchInstagram(query = {}) { return this.get('/api/instagram/search', query); }
  instagramDetail(username, query = {}) { return this.get(`/api/instagram/${segment(username)}/detail`, query); }
  sharedCommenters(username, other, query = {}) {
    return this.get(`/api/instagram/${segment(username)}/shared/${segment(other)}`, query);
  }
  communities(query = {}) { return this.get('/api/instagram/communities', query); }
  tagCommunity(id, data) { return this.post(`/api/instagram/communities/${segment(id)}/tag`, data); }
  exportInstagram(query = {}) { return this.get('/api/instagram/export', query, { accept: 'text/csv', format: 'text' }); }
  youtubeChannels(query = {}) { return this.get('/api/youtube/channels', query); }
  youtubeChannel(id, query = {}) { return this.get(`/api/youtube/channels/${segment(id)}`, query); }
  youtubeVideos(query = {}) { return this.get('/api/youtube/videos', query); }
  youtubeVideo(id, query = {}) { return this.get(`/api/youtube/videos/${segment(id)}`, query); }
  likerHealth(query = {}) { return this.get('/api/liker/health', query); }

  // Account and credentials; the server enforces feature scopes and sudo.
  me() { return this.get('/api/me'); }
  updateMe(data) { return this.patch('/api/me', data); }
  preferences() { return this.get('/api/me/preferences'); }
  updatePreferences(data) { return this.patch('/api/me/preferences', data); }
  extension() { return this.get('/api/me/extension'); }
  buildExtension() { return this.post('/api/me/extension'); }
  downloadExtension() { return this.get('/api/me/extension/download', {}, { accept: 'application/zip', format: 'buffer' }); }
  passwordLink() { return this.post('/api/me/password-link'); }
  passwordEndpoint(signedUrl) {
    const url = this.endpoint(signedUrl);
    if (url.pathname !== `${this.apiRoot}/set-password`) throw new CockpitError('Lien signé /api/set-password attendu.');
    return url.href;
  }
  passwordTarget(signedUrl) { return this.get(this.passwordEndpoint(signedUrl), {}, { auth: false }); }
  setPassword(signedUrl, data) { return this.post(this.passwordEndpoint(signedUrl), data, { auth: false }); }
  apiKeys() { return this.get('/api/me/api-keys'); }
  createApiKey(data) { return this.post('/api/me/api-keys', data); }
  revokeApiKey(id) { return this.delete(`/api/me/api-keys/${segment(id)}`); }
  sudoKey() { return this.get('/api/me/sudo-key'); }
  rotateSudoKey() { return this.post('/api/me/sudo-key'); }
  extensionSelectors() { return this.get('/api/extension/selectors.json', {}, { auth: false }); }

  // Collector routes need their own credential, never a personal API key.
  instagramToUpdate() { return this.get('/api/instagram/toUpdate'); }
  instagramToScrape(query = {}) { return this.get('/api/instagram/toScrape', query); }
  instagramToRefresh(query = {}) { return this.get('/api/instagram/toRefresh', query); }
  postsToSnapshot() { return this.get('/api/instagram/posts/toSnapshot'); }
  collectorAccount(username) { return this.get(`/api/instagram/${segment(username)}`); }
  addCollectorAccount(username) { return this.get(`/api/instagram/add/${segment(username)}`); }
  updateCollectorAccount(username, data) { return this.post(`/api/instagram/${segment(username)}`, data); }
  ingestInstagramPosts(username, data) { return this.post(`/api/instagram/${segment(username)}/posts`, data); }
  classifyInstagram(data) { return this.post('/api/instagram/classify', data); }
  ingestYoutube(data) { return this.post('/api/youtube/ingest', data); }
  ingestYoutubeTranscript(data) { return this.post('/api/youtube/transcript', data); }
  youtubeFrontier(data) { return this.post('/api/youtube/frontier', data); }
  reportYoutubeProfileHealth(data) { return this.post('/api/youtube/profile-health', data); }
  reportLikerRun(data) { return this.post('/api/liker/run', data); }
  reportLikerError(data) { return this.post('/api/liker/error', data); }
}

/** A board bound to an explicit UUID, or to the legacy project headers. */
export class CockpitProjectClient {
  constructor(client, projectId = null) {
    this.client = client;
    this.path = projectId === null ? '/api/project' : `/api/projects/${segment(projectId)}`;
  }

  request(method, suffix = '', options = {}) {
    if (suffix && !suffix.startsWith('/')) throw new CockpitError('Le suffixe du projet doit commencer par /.');
    const path = `${this.path}${suffix}`;
    const url = this.client.endpoint(path);
    const root = this.client.endpoint(this.path).pathname;
    if (url.pathname !== root && !url.pathname.startsWith(`${root}/`)) {
      throw new CockpitError('Le chemin doit rester dans ce projet.');
    }
    return this.client.request(method, path, options);
  }

  info() { return this.request('GET'); }
  docs() { return this.request('GET', '/doc', { accept: 'text/markdown', format: 'text' }); }
  update(data) { return this.request('PATCH', '', { body: data }); }
  rotateToken() { return this.request('POST', '/rotate-token'); }
  members() { return this.request('GET', '/members'); }
  addMember(data) { return this.request('POST', '/members', { body: data }); }
  updateMember(id, data) { return this.request('PATCH', `/members/${segment(id)}`, { body: data }); }
  removeMember(id) { return this.request('DELETE', `/members/${segment(id)}`); }

  stages() { return this.request('GET', '/stages'); }
  createStage(data) { return this.request('POST', '/stages', { body: data }); }
  updateStage(id, data) { return this.request('PATCH', `/stages/${segment(id)}`, { body: data }); }
  deleteStage(id) { return this.request('DELETE', `/stages/${segment(id)}`); }
  moveStage(id, data) { return this.request('POST', `/stages/${segment(id)}/move`, { body: data }); }
  products() { return this.request('GET', '/products'); }
  createProduct(data) { return this.request('POST', '/products', { body: data }); }
  updateProduct(id, data) { return this.request('PATCH', `/products/${segment(id)}`, { body: data }); }
  deleteProduct(id) { return this.request('DELETE', `/products/${segment(id)}`); }
  moveProduct(id, data) { return this.request('POST', `/products/${segment(id)}/move`, { body: data }); }

  influencers(query = {}) { return this.request('GET', '/influencers', { query }); }
  addInfluencer(data) { return this.request('POST', '/influencers', { body: data }); }
  addManualInfluencer(data) { return this.request('POST', '/influencers/manual', { body: data }); }
  updateInfluencer(id, data) { return this.request('PATCH', `/influencers/${segment(id)}`, { body: data }); }
  updateContact(id, data) { return this.request('PATCH', `/influencers/${segment(id)}/contact`, { body: data }); }
  removeInfluencer(id) { return this.request('DELETE', `/influencers/${segment(id)}`); }
  bulk(data) { return this.request('POST', '/bulk', { body: data }); }
  exportCsv(query = {}) { return this.request('GET', '/export.csv', { query, accept: 'text/csv', format: 'text' }); }

  /** resource: stages, products or influencers. index is the returned note index. */
  notePath(resource, id, index = null) {
    if (!['stages', 'products', 'influencers'].includes(resource)) throw new CockpitError('Ressource de notes inconnue.');
    return `/${resource}/${segment(id)}/notes${index === null ? '' : `/${segment(index)}`}`;
  }
  addNote(resource, id, data) { return this.request('POST', this.notePath(resource, id), { body: data }); }
  deleteNote(resource, id, index) { return this.request('DELETE', this.notePath(resource, id, index)); }
  /** Toggles pinning; the API does not accept a desired pinned state. */
  pinNote(resource, id, index) { return this.request('POST', `${this.notePath(resource, id, index)}/pin`); }
}

function segment(value) {
  const text = String(value ?? '');
  if (!text.trim() || text === '.' || text === '..') throw new CockpitError('Identifiant Cockpit manquant ou invalide.');
  return encodeURIComponent(text);
}
