const RETRYABLE_STATUS = new Set([
  408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 527,
]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT']);
const MAX_RETRY_AFTER_MS = 60_000;

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
 */
export class HttpClient {
  constructor({
    baseUrl,
    token = null,
    headers = {},
    userAgent = 'assistant-kit/1.0',
    fetchImpl = globalThis.fetch,
    attempts = 4,
    sleep = defaultSleep,
    random = Math.random,
  }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token;
    this.headers = headers;
    this.userAgent = userAgent;
    this.fetch = fetchImpl;
    this.attempts = attempts;
    this.sleep = sleep;
    this.random = random;
  }

  /**
   * Send a request and return the raw Response, after retries. The caller
   * decides what an acceptable status is.
   */
  async send(method, urlPath, options = {}) {
    const verb = method.toUpperCase();
    const headers = new Headers({ ...this.headers, ...(options.headers || {}) });
    headers.set('Accept', options.accept || headers.get('Accept') || 'application/json');
    headers.set('User-Agent', this.userAgent);
    if (this.token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    let body = options.body;
    if (body !== undefined && body !== null && !(body instanceof FormData)
      && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    }

    const retryable = options.idempotent ?? (IDEMPOTENT_METHODS.has(verb) || headers.has('If-Match'));
    const attempts = retryable ? this.attempts : 1;
    const url = /^https?:\/\//.test(urlPath) ? urlPath : `${this.baseUrl}${urlPath}`;

    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await this.fetch(url, {
          method: verb,
          headers,
          body,
          redirect: options.redirect || 'follow',
          signal: AbortSignal.timeout(options.timeoutMs || 20_000),
        });
      } catch (error) {
        if (attempt >= attempts) {
          throw new Error(`${verb} ${urlPath} : échec réseau après ${attempt} tentative(s) (${error.message})`, {
            cause: error,
          });
        }
        await this.sleep(this.backoff(attempt));
        continue;
      }

      if (!RETRYABLE_STATUS.has(response.status) || attempt >= attempts) {
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
