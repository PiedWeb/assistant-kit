export const RETRYABLE_STATUS = Object.freeze([
  408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 527,
]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT']);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_REDIRECTS = 5;

/**
 * Headers that carry a credential besides Authorization (always guarded).
 * A request holding one of them never follows a redirect to another origin.
 */
export const DEFAULT_SECRET_HEADERS = Object.freeze([
  'X-Pushword-Snapshot-Key', 'X-AUTH-TOKEN', 'X-API-Key', 'api-key', 'Cookie', 'Proxy-Authorization',
]);

export class HttpError extends Error {
  constructor(message, status, payload = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * Small fetch wrapper shared by every connector.
 *
 * Only idempotent requests are retried: GET, HEAD, OPTIONS, PUT, and any request
 * carrying If-Match (a replay lands on a 409, never on a double write). A POST
 * or DELETE that hits a 502 is reported once, so a page or media is never
 * created twice behind a flaky proxy.
 *
 * Credentials stay with their origin: an absolute URL must share the origin of
 * `baseUrl`, and a request carrying a credential or a body follows redirects by
 * hand, within the same origin only.
 *
 * `token` is a string or a function (sync or async) called once per request,
 * so a short-lived token can be refreshed between calls.
 */
export class HttpClient {
  constructor({
    baseUrl,
    token = null,
    headers = {},
    userAgent = 'assistant-kit/1.0',
    fetchImpl = globalThis.fetch,
    attempts = 4,
    retryStatuses = RETRYABLE_STATUS,
    secretHeaders = DEFAULT_SECRET_HEADERS,
    timeoutMs = 20_000,
    sleep = defaultSleep,
    random = Math.random,
  } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token;
    this.headers = headers;
    this.userAgent = userAgent;
    this.fetch = fetchImpl;
    this.attempts = attempts;
    this.retryStatuses = new Set(retryStatuses);
    this.secretHeaders = ['Authorization', ...secretHeaders];
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.random = random;
  }

  /**
   * Send a request and return the raw Response, after retries. The caller
   * decides what an acceptable status is. When no attempt got an answer, the
   * error carries `code: 'NETWORK_ERROR'`.
   *
   * Options: body, headers, accept, idempotent, attempts, retryStatuses,
   * timeoutMs, signal, redirect ('follow', 'manual', 'error'), auth (false
   * leaves the token out).
   */
  async send(method, urlPath, options = {}) {
    const verb = method.toUpperCase();
    const url = this.resolveUrl(urlPath);
    const headers = new Headers({ ...this.headers, ...(options.headers || {}) });
    headers.set('Accept', options.accept || headers.get('Accept') || 'application/json');
    headers.set('User-Agent', this.userAgent);
    if (options.auth !== false && !headers.has('Authorization')) {
      const token = await this.resolveToken();
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
    }
    const body = encodeBody(options.body, headers);

    const retryable = options.idempotent ?? (IDEMPOTENT_METHODS.has(verb) || headers.has('If-Match'));
    const attempts = retryable ? Math.max(1, options.attempts ?? this.attempts) : 1;
    const retryStatuses = options.retryStatuses ? new Set(options.retryStatuses) : this.retryStatuses;
    const init = {
      method: verb, headers, body, label: `${verb} ${urlPath}`,
      redirect: options.redirect, timeoutMs: options.timeoutMs, signal: options.signal,
    };

    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await this.fetchWithRedirects(url, init);
      } catch (error) {
        if (error instanceof HttpError || options.signal?.aborted || attempt >= attempts) {
          throw error instanceof HttpError ? error : Object.assign(new Error(
            `${verb} ${urlPath} : échec réseau après ${attempt} tentative(s) (${error.message})`, { cause: error },
          ), { code: 'NETWORK_ERROR' });
        }
        await this.sleep(this.backoff(attempt));
        continue;
      }

      if (!retryStatuses.has(response.status) || attempt >= attempts) {
        return response;
      }
      const delay = retryAfter(response.headers.get('retry-after')) ?? this.backoff(attempt);
      await response.body?.cancel().catch(() => undefined);
      await this.sleep(delay);
    }
  }

  /**
   * Send a request and parse its body. Throws HttpError unless the status is
   * listed in `expectedStatus` (default 200).
   */
  async request(method, urlPath, options = {}) {
    const response = await this.send(method, urlPath, options);
    const payload = await parseResponse(response);
    const expected = options.expectedStatus || [200];
    if (!expected.includes(response.status)) {
      const detail = describe(payload) || response.statusText || 'requête refusée';
      throw new HttpError(`${method.toUpperCase()} ${urlPath} : HTTP ${response.status} (${detail})`, response.status, payload);
    }
    return { response, payload, status: response.status };
  }

  /**
   * Send a request and read the whole body, whatever the status:
   * `{ status, ok, headers, text, json, body }`. `json` is undefined when the
   * body is not JSON, `headers` is a plain object with lowercase names, `body`
   * the raw bytes. Throws only when every attempt failed at the network level
   * or a redirect would carry a credential to another origin.
   */
  async exchange(method, urlPath, options = {}) {
    const response = await this.send(method, urlPath, options);
    const body = Buffer.from(await response.arrayBuffer());
    const text = body.toString('utf8');
    let json;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), text, json, body };
  }

  /** Absolute URL for a path. An absolute URL must share the origin of `baseUrl`. */
  resolveUrl(urlPath) {
    const value = String(urlPath);
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error(`Adresse refusée : protocole ${url.protocol} non pris en charge.`);
      }
      if (this.baseUrl && url.origin !== new URL(this.baseUrl).origin) {
        throw new Error(`Adresse refusée : ${url.origin} n’est pas l’origine de ce client (${new URL(this.baseUrl).origin}). `
          + 'Les identifiants ne partent jamais vers une autre origine.');
      }
      return url.href;
    }
    if (!this.baseUrl) {
      throw new Error(`Adresse relative ${value} sans baseUrl : passer une URL absolue.`);
    }
    return `${this.baseUrl}${value.startsWith('/') ? '' : '/'}${value}`;
  }

  async resolveToken() {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    return token ? String(token) : null;
  }

  /**
   * One attempt. A request carrying a credential or a body follows redirects
   * by hand: same origin only, at most five hops. Otherwise fetch follows them.
   */
  async fetchWithRedirects(url, { method, headers, body, redirect = 'follow', label, timeoutMs, signal }) {
    const timeout = AbortSignal.timeout(timeoutMs || this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const guarded = redirect === 'follow' && (body !== undefined || this.carriesSecret(headers));
    if (!guarded) {
      return this.fetch(url, { method, headers, body, redirect, signal: combined });
    }

    let current = new URL(url);
    let verb = method;
    let payload = body;
    let sent = headers;
    for (let hop = 0; ; hop += 1) {
      const response = await this.fetch(current.href, { method: verb, headers: sent, body: payload, redirect: 'manual', signal: combined });
      const location = response.headers.get('location');
      if (!REDIRECT_STATUS.has(response.status) || !location) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(location, current);
      if (next.origin !== current.origin) {
        throw Object.assign(new HttpError(`${label} : redirection vers ${next.origin} refusée. `
          + `La requête porte un identifiant ou un corps qui ne quitte jamais ${current.origin} ; `
          + 'vérifier l’adresse du service.', response.status), { code: 'CROSS_ORIGIN_REDIRECT' });
      }
      if (hop >= MAX_REDIRECTS) {
        throw new HttpError(`${label} : plus de ${MAX_REDIRECTS} redirections, abandon.`, response.status);
      }
      if ((response.status === 303 && verb !== 'HEAD') || ([301, 302].includes(response.status) && verb === 'POST')) {
        verb = 'GET';
        payload = undefined;
        sent = new Headers(sent);
        sent.delete('Content-Type');
      }
      current = next;
    }
  }

  carriesSecret(headers) {
    return this.secretHeaders.some((name) => headers.has(name));
  }

  backoff(attempt) {
    return 400 * (2 ** (attempt - 1)) + Math.floor(this.random() * 250);
  }
}

export async function parseResponse(response) {
  if (response.status === 204 || response.status === 304) {
    return null;
  }
  const raw = await response.text();
  if (!raw) {
    return null;
  }
  if (response.headers.get('content-type')?.includes('json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

// Objects go out as JSON, a URLSearchParams as a form; strings, bytes, Blob and
// FormData as they are (FormData sets its own multipart boundary).
function encodeBody(body, headers) {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (body instanceof URLSearchParams) {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }
    return body.toString();
  }
  if (typeof body === 'string' || body instanceof FormData || body instanceof Blob
    || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return body;
  }
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return JSON.stringify(body);
}

function describe(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.slice(0, 200);
  return payload.message || payload.error || payload.detail || payload.title || '';
}

function retryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return Math.min(milliseconds, MAX_RETRY_AFTER_MS);
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
