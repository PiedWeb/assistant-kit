import { connectorById } from './catalog.js';
import { hasProbe, PROBE_LABELS } from './probes.js';

const SOURCES = { environment: 'Variable d’environnement', systemd: 'Credential systemd', keychain: 'Enregistré dans le trousseau', default: 'Valeur par défaut', missing: 'À renseigner' };

// Project sources (`before`, `after`) keep their own name; a shared keychain shows its scope.
function sourceLabel(source) {
  if (SOURCES[source]) return SOURCES[source];
  if (source.startsWith('keychain:')) return `Trousseau partagé (${source.slice('keychain:'.length)})`;
  return `Source du projet (${source})`;
}
const DETAILS = { idle: 'Les valeurs sont présentes. Le service doit encore confirmer l’accès.',
  unconfigured: 'Complétez les champs requis pour pouvoir tester l’accès.', running: 'Vérification en lecture seule. Vous pouvez continuer votre saisie.',
  unsupported: 'Ce connecteur n’a pas de test automatique sans effet de bord.' };

export function verificationView(catalog, state, entry) {
  const status = !state.ready ? 'unconfigured' : entry?.status || (hasProbe(catalog, state.id) ? 'idle' : 'unsupported');
  return { status, label: PROBE_LABELS[status], detail: entry?.detail || DETAILS[status] || '',
    checkedAt: entry?.checkedAt || '', pending: status === 'running' };
}

export function vaultPage({ vault, states, verifications, selectedId, nonce, csrf, scriptNonce, brand, configureHint, message = '', error = '' }) {
  const catalog = vault.catalog;
  const item = connectorById(catalog, selectedId);
  const selected = states.find(({ id }) => id === selectedId);
  const current = verifications[selectedId];
  const action = `/${nonce}?connector=${encodeURIComponent(selectedId)}`;
  const form = (actionName, label, { disabled = false, className = 'secondary', live = false } = {}) =>
    `<form method="post" action="${action}"${live ? ' data-verify' : ''}><input type="hidden" name="csrf" value="${csrf}">`
    + `<input type="hidden" name="action" value="${actionName}"><button class="${className}" type="submit"${disabled ? ' disabled' : ''}>${label}</button></form>`;
  const navigation = states.map((state) => `<li><a href="/${nonce}?connector=${state.id}#configuration"${state.id === selectedId ? ' aria-current="page"' : ''}>`
    + `<span>${escapeHtml(state.label)}</span><small data-status="${state.id}" class="state ${verifications[state.id].status}">${verifications[state.id].label}</small></a></li>`).join('');
  const fields = item.fields.map((field) => {
    const state = selected.fields.find(({ name }) => name === field.name);
    // Secret values are never inserted into the HTML, including on validation errors.
    const value = field.secret ? '' : vault.resolve(field.name, field).value;
    const shadowed = state.shadowing;
    const type = field.secret ? 'password' : ({ url: 'url', email: 'email', port: 'number' }[field.kind] || 'text');
    return `<div class="field"><label for="${field.name}">${escapeHtml(field.label)}</label>`
      + `<div class="field-meta"><span>${escapeHtml(sourceLabel(state.source))}${state.valid ? '' : ' · À corriger'}</span><code>${field.name}</code></div>`
      + (field.multiline
        ? `<textarea id="${field.name}" name="${field.name}" rows="8" spellcheck="false"`
          + `${field.required && !state.configured ? ' required' : ''}${!state.valid ? ' aria-invalid="true"' : ''}`
          + ` aria-describedby="${field.name}-help" placeholder="${field.secret && state.configured ? 'Laisser vide pour conserver' : 'Saisir la valeur'}">`
          + `${escapeHtml(value)}</textarea>`
        : `<input id="${field.name}" name="${field.name}" type="${type}" value="${escapeHtml(value)}" `
          + `autocomplete="${field.secret ? 'new-password' : 'off'}" spellcheck="false" maxlength="16384"`
          + `${field.kind === 'port' ? ' min="1" max="65535" step="1"' : ''}`
          + `${field.required && !state.configured ? ' required' : ''}${!state.valid ? ' aria-invalid="true"' : ''}`
          + ` aria-describedby="${field.name}-help" placeholder="${field.secret && state.configured ? 'Laisser vide pour conserver' : field.secret ? 'Saisir le secret' : 'Saisir la valeur'}">`)
      + `<small id="${field.name}-help">${escapeHtml(shadowed
        ? 'Cette source reste prioritaire. Une modification ici sera enregistrée dans le trousseau pour un usage ultérieur.'
        : field.help || (field.secret ? 'Le secret enregistré ne sera jamais réaffiché.' : ''))}</small></div>`;
  }).join('');
  const backend = vault.backend();
  const next = states.find((state) => !state.ready && state.id !== selectedId);
  const content = `<a class="skip" href="#configuration">Aller au formulaire</a><div class="shell">`
    + `<aside><header><span class="brand">${escapeHtml(brand.name)}<span aria-hidden="true">.</span></span><p>Coffre des connecteurs</p></header>`
    + `<p class="progress">${states.filter((state) => state.ready).length} sur ${states.length} configurés</p>`
    + `<nav aria-label="Connecteurs"><ul>${navigation}</ul></nav><div class="session-actions">`
    + form('verify-all', 'Tout vérifier', { live: true, disabled: !states.some((state) => state.ready && hasProbe(catalog, state.id)) })
    + form('finish', 'Terminer', { className: 'quiet' }) + '</div><p class="session-note">Session locale · fermeture automatique après 30 minutes.</p></aside>'
    + `<main id="configuration" tabindex="-1"><p class="eyebrow">Configuration des accès</p><h1>${escapeHtml(item.label)}</h1><p class="intro">${escapeHtml(item.description)}</p>`
    + `${message ? `<p class="notice success" role="status">${escapeHtml(message)}</p>` : ''}`
    + `${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ''}`
    + `${!backend.available ? `<p class="notice error" role="alert">${escapeHtml(backend.detail)} L’enregistrement est indisponible.</p>` : ''}`
    + `<section class="verification" aria-labelledby="verification-title" aria-live="polite"><div>`
    + `<h2 id="verification-title" data-verification-label>${escapeHtml(current.label)}</h2><p data-verification-detail>${escapeHtml(current.detail)}</p>`
    + `<small data-verification-time>${formatTime(current.checkedAt)}</small></div>`
    + (hasProbe(catalog, selectedId) ? form('verify', 'Tester l’accès', { live: true, disabled: !selected.ready || current.pending }) : '')
    + '</section><p id="connection-error" class="notice error" role="alert" hidden></p>'
    + `<form method="post" action="${action}" class="configuration"><input type="hidden" name="csrf" value="${csrf}">`
    + `<input type="hidden" name="action" value="save">${fields}<div class="save-actions"><button type="submit"${!backend.available ? ' disabled' : ''}>Enregistrer</button>`
    + `${next ? `<a class="next" href="/${nonce}?connector=${next.id}#configuration">Configurer ${escapeHtml(next.label)} →</a>` : ''}</div>`
    + '<p class="hint">Laisser un secret vide conserve sa valeur. Enregistrer garde cette session ouverte.</p></form>'
    + `<footer><span>Stockage dans le trousseau du système.</span>${item.link ? `<a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">Ouvrir le service ↗</a>` : ''}</footer></main></div>`;
  return document(`Coffre des connecteurs · ${brand.name}`, content, scriptNonce,
    `data-status-url="/${nonce}?format=status" data-connector="${selectedId}"`, liveScript(configureHint), brand.css);
}

export function closedPage(scriptNonce, brand) {
  return document(`Session terminée · ${brand.name}`, `<main class="closed"><span class="brand">${escapeHtml(brand.name)}.</span><h1>Session terminée</h1><p>Vous pouvez fermer cette fenêtre. Les valeurs enregistrées restent dans le trousseau du système.</p></main>`, scriptNonce, '', '', brand.css);
}

// `css` lets a project override the custom properties of :root (--green, --accent...).
function document(title, content, nonce, attributes = '', script = '', css = '') {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style nonce="${nonce}">${CSS}${css || ''}</style></head><body ${attributes}>${content}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
}

function formatTime(iso) { return iso ? `Dernier test : ${new Date(iso).toLocaleTimeString('fr-FR')}` : ''; }

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

const liveScript = (configureHint) => `(() => {
  let timer;
  let busy = false;
  const error = document.getElementById('connection-error');
  function paint(data) {
    Object.entries(data.verifications).forEach(([id, view]) => {
      const node = document.querySelector('[data-status="' + id + '"]');
      node.textContent = view.label;
      node.className = 'state ' + view.status;
    });
    const view = data.verifications[document.body.dataset.connector];
    document.querySelector('[data-verification-label]').textContent = view.label;
    document.querySelector('[data-verification-detail]').textContent = view.detail;
    document.querySelector('[data-verification-time]').textContent = view.checkedAt
      ? 'Dernier test : ' + new Date(view.checkedAt).toLocaleTimeString('fr-FR') : '';
    document.querySelectorAll('[data-verify]').forEach(form => {
      const single = form.elements.action.value === 'verify';
      form.querySelector('button').disabled = single
        ? view.pending || view.status === 'unconfigured'
        : !data.testable || data.pending;
    });
    error.hidden = true;
    clearTimeout(timer);
    if (data.pending) timer = setTimeout(poll, 1000);
  }
  function failed() {
    error.textContent = ${JSON.stringify(`Le contrôle est interrompu ou la session a expiré. Pour reprendre, relancez ${configureHint}.`)};
    error.hidden = false;
  }
  async function poll() {
    try {
      const response = await fetch(document.body.dataset.statusUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error();
      paint(await response.json());
    } catch { failed(); }
  }
  document.querySelectorAll('[data-verify]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    form.querySelector('button').disabled = true;
    try {
      const response = await fetch(form.getAttribute('action'), { method: 'POST', headers: { Accept: 'application/json' },
        body: new URLSearchParams(new FormData(form)) });
      if (!response.ok) throw new Error();
      paint(await response.json());
    } catch { failed(); } finally { busy = false; }
  }));
  // Poll only while probes are active; never replace a form or reload its page.
  poll();
})();`;

const CSS = `
:root{color-scheme:light;--paper:oklch(97% .012 85);--surface:oklch(99% .005 85);--ink:oklch(26% .025 165);--muted:oklch(45% .023 165);--line:oklch(81% .015 85);--green:oklch(29% .041 166);--accent:oklch(47% .125 43);--good:oklch(39% .068 165);--bad:oklch(43% .15 30)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}a{color:var(--green);text-underline-offset:.2em}button,input,textarea{font:inherit}button,a,input{touch-action:manipulation}button{min-height:44px;padding:.65rem 1.1rem;border:1px solid transparent;border-radius:5px;background:var(--accent);color:var(--surface);font-weight:650;cursor:pointer}button:hover{filter:brightness(.93)}button:disabled{opacity:.5;cursor:not-allowed}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid oklch(62% .12 75);outline-offset:3px}.shell{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh}.skip{position:absolute;top:-100px;left:1rem;z-index:5;padding:1rem;background:var(--surface)}.skip:focus{top:1rem}aside{background:var(--green);color:var(--surface);padding:32px 20px;display:flex;flex-direction:column}aside header{padding:0 12px}.brand{font-size:1.8rem;font-weight:760;letter-spacing:-.055em}.brand span{color:oklch(77% .13 65)}aside header p{font-size:.9rem;margin:.25rem 0 2rem;color:oklch(88% .017 160)}.progress{font-size:.85rem;padding:0 12px;color:oklch(88% .017 160)}nav ul{padding:0;margin:0;list-style:none}nav a{display:grid;gap:3px;padding:11px 12px;margin:3px 0;text-decoration:none;color:var(--surface);border-radius:5px;font-weight:600}nav a:hover{background:oklch(35% .037 166)}nav a[aria-current]{background:oklch(40% .038 166)}.state{font-weight:450;font-size:.78rem;color:oklch(87% .012 160)}.state.ok{color:oklch(91% .085 160)}.state.failed{color:oklch(86% .085 50)}.state.unknown{color:oklch(89% .08 85)}.session-actions{display:flex;gap:8px;flex-wrap:wrap;margin:30px 10px 0}.session-actions .secondary,.quiet{color:var(--surface);border-color:oklch(67% .028 165);background:transparent}.session-note{font-size:.75rem;max-width:27ch;color:oklch(82% .015 165);margin:18px 12px 0}main{padding:48px 56px;max-width:970px;width:100%;min-width:0}.eyebrow{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.1em;margin:0 0 10px}h1{font-size:2rem;line-height:1.2;letter-spacing:-.035em;margin:0 0 12px}p{max-width:70ch}.intro{margin:0 0 30px;color:var(--muted)}.verification{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:20px 0;display:flex;gap:20px;align-items:center;justify-content:space-between;margin:0 0 30px}.verification h2{font-size:1rem;margin:0 0 5px}.verification p{font-size:.9rem;margin:0;color:var(--muted)}.verification small{font-size:.76rem;color:var(--muted)}.verification button{white-space:nowrap}.secondary{background:transparent;color:var(--green);border-color:var(--line)}.configuration{max-width:660px}.field{margin:0 0 22px}.field label{font-weight:650;display:block;margin-bottom:3px}.field-meta{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:.75rem;color:var(--muted);margin-bottom:7px}code{font-size:.75rem;overflow-wrap:anywhere}input,textarea{display:block;width:100%;min-height:46px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:10px 12px}textarea{resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.82rem}input[aria-invalid],textarea[aria-invalid]{border-color:var(--bad)}input::placeholder{color:var(--muted)}.field small{display:block;font-size:.8rem;color:var(--muted);margin-top:6px}.field small:empty{display:none}.save-actions{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-top:30px}.next{font-size:.85rem;padding:10px 0}.hint{font-size:.8rem;color:var(--muted);margin-top:12px}.notice{padding:14px 16px;border:1px solid var(--line);border-radius:5px;font-size:.9rem}.error{color:var(--bad);background:oklch(96% .022 35)}.success{color:var(--good);background:oklch(95% .025 165)}footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.78rem;display:flex;gap:16px;justify-content:space-between;flex-wrap:wrap}.closed{max-width:680px;margin:10vh auto}.closed h1{margin-top:30px}[hidden]{display:none!important}
@media(max-width:900px){.shell{grid-template-columns:235px minmax(0,1fr)}main{padding:36px 28px}.verification{align-items:flex-start;flex-direction:column}}
@media(max-width:640px){.shell{display:block}aside{padding:20px 16px}aside header{display:flex;align-items:baseline;gap:15px;padding:0}aside header p{margin:0}.brand{font-size:1.5rem}.progress{margin:12px 0 6px;padding:0}nav ul{display:grid;grid-template-columns:1fr 1fr;gap:3px}nav a{font-size:.85rem;margin:0;padding:8px;min-height:62px}.state{font-size:.72rem}.session-actions{margin:16px 0 0}.session-note{max-width:none;margin:12px 0 0}main{padding:30px 20px}h1{font-size:1.6rem}.intro{font-size:.95rem}.verification{margin-bottom:25px}.field-meta{display:block}.field-meta code{display:block}.save-actions{gap:8px}.closed{padding:24px}}
`;
