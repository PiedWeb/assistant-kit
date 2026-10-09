import { connectorById, validateField } from './catalog.js';
import { validateCredentialValue } from './keychain.js';
import { MailClient } from '../mail.js';

export const PROBE_LABELS = Object.freeze({
  unconfigured: 'À compléter', idle: 'Non testé', running: 'Test en cours',
  ok: 'Vérifié', failed: 'Accès refusé', unknown: 'Indéterminé', unsupported: 'Sans test automatique',
});

export function hasProbe(catalog, id) {
  return typeof connectorById(catalog, id).probe === 'function';
}

/**
 * Run a connector's read-only probe. Results contain fixed descriptions only:
 * never a server body, URL, account identity or raw exception, since any of
 * them can carry a credential.
 */
export async function probeConnector(catalog, id, values, { timeoutMs = 12_000, signal, ...context } = {}) {
  const item = connectorById(catalog, id);
  const result = (status, detail) => ({ status, detail, checkedAt: new Date().toISOString() });
  if (item.fields.some((entry) => entry.required && !values[entry.name])) {
    return result('unconfigured', 'Complétez les champs requis avant de tester l’accès.');
  }
  try {
    for (const entry of item.fields) {
      validateCredentialValue(values[entry.name] || '');
      validateField(entry, values[entry.name]);
    }
  } catch { return result('unconfigured', 'Corrigez les champs invalides avant de tester l’accès.'); }
  if (!hasProbe(catalog, id)) return result('unsupported', 'Ce connecteur n’a pas de test automatique sans effet de bord.');

  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  const deadline = new Promise((_, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (combined.aborted) abort();
    else combined.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
  });
  try {
    combined.throwIfAborted();
    const detail = await Promise.race([
      item.probe(values, { fetchImpl: globalThis.fetch, timeoutMs, ...context, signal: combined }),
      deadline,
    ]);
    return result('ok', detail || 'Le service a confirmé l’accès.');
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.code === 'EAUTH' || error.authenticationFailed === true) {
      return result('failed', 'Le service a refusé l’authentification ou les droits de cet accès.');
    }
    if (combined.aborted) return result('unknown', 'Vérification interrompue ou délai de réponse dépassé.');
    if (error.status >= 300 && error.status < 400) return result('unknown', 'Le service redirige la requête. Vérifiez son adresse.');
    if (error.status >= 500) return result('unknown', 'Le service est temporairement indisponible.');
    return result('unknown', 'Impossible de confirmer l’accès : réseau indisponible, adresse ou réponse inattendue.');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * GET a JSON endpoint over HTTPS without following redirects, then check the
 * payload shape. `url` and `headers` receive the connector values.
 */
export function jsonProbe({ url, headers, check, detail }) {
  return async (values, { fetchImpl, signal }) => {
    const target = safeUrl(url(values));
    const response = await fetchImpl(target.href, {
      headers: { Accept: 'application/json', 'User-Agent': 'assistant-kit/1.0', ...headers(values) },
      signal,
      redirect: 'manual',
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw Object.assign(new Error('status'), { status: response.status });
    }
    const data = JSON.parse(await readLimitedBody(response));
    if (!check(data)) throw new Error('unexpected payload');
    return detail;
  };
}

/** Pushword identity behind a bearer token. */
export function pushwordProbe({ baseUrl, tokenField = 'PUSHWORD_TOKEN' }) {
  return jsonProbe({
    url: (values) => `${(typeof baseUrl === 'function' ? baseUrl(values) : baseUrl).replace(/\/+$/, '')}/api/whoami`,
    headers: (values) => ({ Authorization: `Bearer ${values[tokenField]}` }),
    check: (data) => Boolean(data && typeof data === 'object' && data.id && (data.email || data.username)),
    detail: 'Pushword a reconnu le compte associé au jeton.',
  });
}

/** Cadrank project list behind an X-AUTH-TOKEN key. */
export function cadrankProbe({ baseUrl, keyField = 'CADRANK_API_KEY' }) {
  return jsonProbe({
    url: (values) => `${(typeof baseUrl === 'function' ? baseUrl(values) : baseUrl).replace(/\/+$/, '')}/_api/projects`,
    headers: (values) => ({ 'X-AUTH-TOKEN': values[keyField] }),
    check: (data) => Array.isArray(data) || Array.isArray(data?.projects) || Array.isArray(data?.items),
    detail: 'Cadrank a accepté la lecture de la liste des projets.',
  });
}

/** Depth-0 PROPFIND on a DAV resource (CalDAV, CardDAV, Nextcloud files). */
export function davProbe({ url, user, password }) {
  return async (values, { fetchImpl, signal }) => {
    const target = new URL(url(values));
    // Nextcloud ?export feeds: probe the same resource without exporting it.
    if (target.searchParams.has('export')) target.search = '';
    const checked = safeUrl(target.href);
    const response = await fetchImpl(checked.href, {
      method: 'PROPFIND',
      headers: {
        Authorization: `Basic ${Buffer.from(`${user(values)}:${password(values)}`).toString('base64')}`,
        Depth: '0',
        Accept: 'application/xml, text/xml',
        'Content-Type': 'application/xml; charset=utf-8',
        'User-Agent': 'assistant-kit/1.0',
      },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
      signal,
      redirect: 'manual',
    });
    if (response.status !== 207) {
      await response.body?.cancel();
      throw Object.assign(new Error('status'), { status: response.status });
    }
    const source = await readLimitedBody(response);
    if (!/<(?:[\w-]+:)?multistatus[\s>]/i.test(source)
      || !/<(?:[\w-]+:)?status>\s*HTTP\/[^\s]+\s+200\b/i.test(source)) throw new Error('unexpected DAV response');
    return 'Le service DAV a confirmé l’accès à cette ressource.';
  };
}

/**
 * IMAP LIST then SMTP verify through MailClient, for every account of the
 * configuration (or only `account(values)`). Read-only: no write is possible
 * (allowWrites stays false) and nothing is sent. `configuration(values)`
 * returns the accounts JSON shared with MailClient, an `{ accounts }` object
 * or an array. The detail never names an account, a server or an address.
 */
export function mailProbe({ configuration, account = null, allowedDomains = [] } = {}) {
  if (typeof configuration !== 'function') throw new TypeError('mailProbe attend configuration(values).');
  return async (values, { signal, timeoutMs, imapFactory, smtpFactory }) => {
    const opened = new Set();
    const track = (factory) => async (options) => {
      const resource = await factory(options);
      opened.add(resource);
      return resource;
    };
    const close = () => { for (const resource of opened) { try { resource.close?.(); } catch {} } };
    signal.addEventListener('abort', close, { once: true });
    try {
      const client = new MailClient({
        configuration: configuration(values),
        allowedDomains,
        timeout: timeoutMs,
        imapFactory: track(imapFactory || defaultMailFactories.imap),
        smtpFactory: track(smtpFactory || defaultMailFactories.smtp),
      });
      const wanted = account ? [String(account(values) || '')] : (await client.accounts()).map((item) => item.id);
      if (!wanted.length) throw new Error('no mail account');
      for (const id of wanted) {
        signal.throwIfAborted();
        await client.verify(id);
      }
      return wanted.length > 1
        ? `Connexions IMAP et SMTP acceptées pour ${wanted.length} boîtes. Aucun message envoyé.`
        : 'Connexions IMAP et SMTP acceptées. Aucun message envoyé.';
    } finally {
      signal.removeEventListener('abort', close);
      close();
    }
  };
}

const defaultMailFactories = Object.freeze({
  imap: async (options) => new (await import('imapflow')).ImapFlow(options),
  smtp: async (options) => {
    const nodemailer = await import('nodemailer');
    return (nodemailer.createTransport ? nodemailer : nodemailer.default).createTransport(options);
  },
});

// Credentials must never follow a redirect or leave over unencrypted HTTP.
function safeUrl(address) {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid endpoint');
  }
  return url;
}

async function readLimitedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error('response too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}
