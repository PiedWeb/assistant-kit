import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { connectorById, VaultError } from './catalog.js';
import { probeConnector, hasProbe } from './probes.js';
import { vaultPage, closedPage, verificationView } from './view.js';

const DEFAULT_BRAND = Object.freeze({ name: 'assistant', css: '' });

/**
 * Local web form to fill a project's vault: 127.0.0.1 only, unguessable path,
 * Origin and CSRF checks, strict CSP, closes after `sessionMs`.
 */
export async function startVaultServer({
  vault, selectedId, probe = (id, values, options) => probeConnector(vault.catalog, id, values, options),
  probeOptions = {}, autoVerify = true, sessionMs = 30 * 60_000, brand = DEFAULT_BRAND,
  configureHint = 'vault configure',
} = {}) {
  const catalog = vault.catalog;
  selectedId ||= Object.keys(catalog)[0];
  connectorById(catalog, selectedId);
  const nonce = crypto.randomBytes(24).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const scriptNonce = crypto.randomBytes(24).toString('base64');
  let states = vault.status();
  const verifications = new Map();
  const running = new Map();
  let origin;
  let ended = false;
  let expiry;
  let flash;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  function payload() {
    const views = Object.fromEntries(states.map((state) => [state.id, verificationView(catalog, state, verifications.get(state.id))]));
    return { states, verifications: views, pending: Object.values(views).some((view) => view.pending),
      testable: states.some((state) => state.ready && hasProbe(catalog, state.id)) };
  }

  function startVerification(id, restart = false) {
    const state = states.find((item) => item.id === id);
    if (!state.ready || !hasProbe(catalog, id) || ended) return;
    if (running.has(id) && !restart) return;
    running.get(id)?.abort();
    const controller = new AbortController();
    running.set(id, controller);
    verifications.set(id, { status: 'running', detail: 'Vérification en lecture seule. Vous pouvez continuer votre saisie.' });
    // Capture values before starting. An older request must never overwrite the
    // result for newly saved credentials, even if it ignores cancellation.
    let values;
    try { values = vault.assertReady(id); }
    catch {
      running.delete(id);
      verifications.set(id, { status: 'unknown', detail: 'Configuration devenue indisponible. Relancez le contrôle.' });
      return;
    }
    Promise.resolve().then(() => probe(id, values, { ...probeOptions, signal: controller.signal }))
      .then((result) => {
        if (!ended && running.get(id) === controller) verifications.set(id, result);
      }).catch(() => {
        if (!ended && running.get(id) === controller) verifications.set(id, {
          status: 'unknown', detail: 'Vérification interrompue. Réessayez.', checkedAt: new Date().toISOString(),
        });
      }).finally(() => { if (running.get(id) === controller) running.delete(id); });
  }

  function refresh() { vault.refresh(); states = vault.status(); }

  function close() {
    if (ended) return closed;
    ended = true;
    clearTimeout(expiry);
    for (const controller of running.values()) controller.abort();
    running.clear();
    server.close();
    server.closeAllConnections();
    return closed;
  }

  function send(response, body, status = 200, headers = {}) {
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      // same-origin also preserves Origin on native POST forms in Chromium,
      // while withholding the capability URL from external services.
      'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      ...headers,
    });
    response.end(body);
  }

  function render(id, message = '', error = '') {
    return vaultPage({ vault, states, verifications: payload().verifications, selectedId: id, nonce, csrf, scriptNonce, brand, configureHint, message, error });
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!response.headersSent) send(response, error instanceof VaultError ? error.message : 'Opération impossible. Vérifiez le trousseau puis réessayez.', 500,
        { 'Content-Type': 'text/plain; charset=utf-8' });
      else response.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('close', () => resolveClosed());

  async function handle(request, response) {
    if (ended) { send(response, 'Session terminée.', 410); return; }
    if (request.headers.host !== new URL(origin).host || request.headers['sec-fetch-site'] === 'cross-site') {
      send(response, 'Origine refusée.', 403); return;
    }
    const url = new URL(request.url || '/', origin);
    if (url.origin !== origin || url.pathname !== `/${nonce}`) { send(response, 'Introuvable.', 404); return; }
    if (!['GET', 'POST'].includes(request.method)) { send(response, 'Méthode refusée.', 405, { Allow: 'GET, POST' }); return; }
    const id = url.searchParams.get('connector') || selectedId;
    try { connectorById(catalog, id); } catch { send(response, 'Connecteur inconnu.', 404); return; }
    if (request.method === 'GET') {
      if (url.searchParams.get('format') === 'status') {
        send(response, JSON.stringify(payload()), 200, { 'Content-Type': 'application/json; charset=utf-8' });
      } else {
        const message = flash?.id === id ? flash.message : '';
        if (message) flash = null;
        send(response, render(id, message));
      }
      return;
    }
    if (request.headers.origin !== origin) { send(response, 'Origine refusée.', 403); return; }
    if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
      send(response, 'Format de formulaire refusé.', 415); return;
    }
    let form;
    try { form = new URLSearchParams(await readRequestBody(request)); }
    catch { send(response, 'Formulaire trop volumineux ou interrompu.', 413); return; }
    if (form.getAll('csrf').length !== 1 || form.get('csrf') !== csrf) { send(response, 'Session invalide.', 403); return; }
    if (form.getAll('action').length !== 1) { send(response, 'Action invalide.', 400); return; }
    const action = form.get('action');
    if (action === 'finish') {
      response.once('finish', close);
      send(response, closedPage(scriptNonce, brand));
      return;
    }
    if (action === 'verify' || action === 'verify-all') {
      refresh();
      if (action === 'verify') {
        const state = states.find((item) => item.id === id);
        if (!state.ready || !hasProbe(catalog, id)) { send(response, render(id, '', 'Ce connecteur ne peut pas encore être testé.'), 400); return; }
        startVerification(id, true);
      } else {
        verifications.clear();
        for (const state of states) startVerification(state.id, true);
      }
      if (request.headers.accept?.includes('application/json')) {
        send(response, JSON.stringify(payload()), 200, { 'Content-Type': 'application/json; charset=utf-8' });
      } else send(response, '', 303, { Location: `/${nonce}?connector=${id}` });
      return;
    }
    if (action !== 'save') { send(response, 'Action inconnue.', 400); return; }
    try {
      const submitted = {};
      const allowed = new Set(connectorById(catalog, id).fields.map((field) => field.name));
      for (const [name, value] of form) {
        if (name === 'csrf' || name === 'action') continue;
        if (!allowed.has(name) || form.getAll(name).length !== 1) throw new VaultError('Champ inconnu ou répété dans le formulaire.');
        submitted[name] = value;
      }
      refresh();
      const { saved, shadowed } = vault.save(id, submitted);
      states = vault.status();
      verifications.delete(id);
      startVerification(id, true);
      flash = { id, message: `${saved.length} valeur(s) enregistrée(s). Vous pouvez continuer la configuration.`
        + (shadowed.length ? ` ${shadowed.length} valeur(s) restent surchargées par l’environnement ou systemd.` : '') };
      send(response, '', 303, { Location: `/${nonce}?connector=${id}#configuration` });
    } catch (error) {
      states = vault.status();
      send(response, render(id, '', error instanceof VaultError ? error.message : 'Enregistrement impossible. Vérifiez le trousseau puis réessayez.'), 400);
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  expiry = setTimeout(close, sessionMs);
  expiry.unref();
  if (autoVerify) for (const state of states) startVerification(state.id);
  return { url: `${origin}/${nonce}?connector=${selectedId}`, closed, close };
}

/** Open the form in the default browser and wait until the session ends. */
export async function configureVault({ vault, selectedId, open = true, brand, configureHint } = {}) {
  const session = await startVaultServer({ vault, selectedId, brand, configureHint });
  process.stdout.write(`Vault local : ${session.url}\nFermez la session avec « Terminer » ou Ctrl+C.\n`);
  if (open) {
    const [command, args] = browserCommand(session.url);
    const browser = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    browser.on('error', () => process.stderr.write('Ouverture automatique impossible. Copiez l’adresse ci-dessus dans votre navigateur.\n'));
    browser.unref();
  }
  const stop = () => session.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await session.closed; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

export function browserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 512 * 1024) { reject(new Error('too large')); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('aborted', () => reject(new Error('aborted')));
    request.on('error', reject);
  });
}
