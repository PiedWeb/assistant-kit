/**
 * Personal mailboxes reached with standard IMAP and SMTP credentials.
 *
 * Accounts use the `{ version: 2, accounts: [...] }` JSON shared with other
 * consumers through the keychain (a bare array is accepted too). Reads open
 * mailboxes with EXAMINE and never change a flag. Nothing is written to a
 * mailbox (draft, draft update, read state, send, reply) unless the caller
 * passes `allowWrites: true`.
 *
 * Project specifics plug in through options, never through this file:
 * `authorize` (identity check before the first operation), `audit` (one entry
 * per write, without content), `mark` (agent signature and header),
 * `allowedDomains` (account addresses this project may use).
 *
 * imapflow, nodemailer, mailparser and htmlparser2 load lazily, inside the
 * methods that need them: importing this module (or the vault probes) never
 * loads them.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MAX_ACCOUNTS = 20;
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_SIGNATURE_HTML = 100000;
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 10;
const MAX_BODY_CHARACTERS = 100000;
const MAX_COLLAPSED_TEXT = 200000;
const MASK = '«valeur masquée»';
// imapflow infers specialUse from folder names too; the patterns only catch the
// servers it misses. `flags` are set on the copy appended there: a draft is
// left unread, so that what an agent wrote stands out until someone reads it.
const SENT_FOLDER = Object.freeze({
  specialUse: '\\Sent', label: 'Envoyés', flags: Object.freeze(['\\Seen']),
  names: /^(?:sent|sent items|envoy[eé]s|messages envoy[eé]s)$/i,
});
const DRAFTS_FOLDER = Object.freeze({
  specialUse: '\\Drafts', label: 'Brouillons', flags: Object.freeze(['\\Draft']),
  names: /^(?:drafts?|brouillons?)$/i,
});
// Where a quoted history starts in a draft: `quotedMessage` below, Thunderbird,
// Roundcube and Apple Mail (`blockquote type="cite"`), Gmail, Outlook.
const HISTORY_CLASS = 'mail-history';
const HISTORY_HTML = /class=["']?(?:mail-history|moz-cite-prefix|gmail_quote)\b|<blockquote\b[^>]{0,200}\btype=["']?cite|id=["']?(?:divRplyFwdMsg|appendonsend|mail-editor-reference-message-container)\b/i;
// In the text part: « Le …, X a écrit : » or « On …, X wrote: » above a `>` line,
// or an « Original Message » separator. Tested line by line, in linear time.
const QUOTE_HEADING_END = /(?:a écrit|wrote)[ \u00a0\u202f]?:$/;
const ORIGINAL_SEPARATOR = /^-{2,} ?(?:Original Message|Message d[’']origine|Message original) ?-{2,}$/;

/** Offset of the quoted history in a text part, or -1. */
function textHistoryStart(plain) {
  for (let index = 0; index < plain.length;) {
    const end = plain.indexOf('\n', index);
    const stop = end < 0 ? plain.length : end;
    const line = plain.slice(index, Math.min(stop, index + 600)).trimEnd();
    if (/^(?:Le|On) /.test(line) && QUOTE_HEADING_END.test(line.slice(-12)) && plain[stop + 1] === '>') return index;
    if (ORIGINAL_SEPARATOR.test(line)) return index;
    index = stop + 1;
  }
  return -1;
}

/**
 * Only fixed, non-sensitive fields survive from the original error: `code`
 * (EAUTH, ETIMEDOUT...) and `authenticationFailed`, so that probes can tell a
 * refused login from a network failure. The original error is never kept as
 * `cause`: its message may carry a credential.
 */
export class MailError extends Error {
  constructor(message, { code = '', authenticationFailed = false, details = null } = {}) {
    super(message);
    this.name = 'MailError';
    if (code) this.code = code;
    if (authenticationFailed) this.authenticationFailed = true;
    // What a refused draft update gives back: the draft as it now stands.
    if (details) this.details = details;
  }
}

function requiredText(value, label, max = 255) {
  const text = String(value || '').trim();
  if (!text) throw new MailError(`${label} est requis.`);
  if (text.length > max) throw new MailError(`${label} dépasse ${max} caractères.`);
  return text;
}

function host(value, label) {
  const text = requiredText(value, label, 253).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.:-]*[a-z0-9])?$/i.test(text) || text.includes('..')) {
    throw new MailError(`${label} n’est pas un nom de serveur valide.`);
  }
  return text;
}

function port(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new MailError(`${label} doit être compris entre 1 et 65535.`);
  }
  return number;
}

function security(value, label) {
  const mode = String(value || '').trim().toLowerCase();
  if (!['tls', 'starttls'].includes(mode)) {
    throw new MailError(`${label} doit être TLS direct ou STARTTLS.`);
  }
  return mode;
}

function email(value, label) {
  const address = requiredText(value, label, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new MailError(`${label} n’est pas une adresse e-mail valide.`);
  }
  return address;
}

function recipients(values, label) {
  if (!Array.isArray(values)) throw new MailError(`${label} doit être une liste.`);
  if (values.length > MAX_RECIPIENTS) throw new MailError(`${label} dépasse ${MAX_RECIPIENTS} destinataires.`);
  return values.map((value) => email(value, label));
}

function uidNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new MailError('UID IMAP invalide.');
  return number;
}

function optionalHtml(value, label, max = MAX_SIGNATURE_HTML) {
  const html = String(value || '').trim();
  if (html.length > max) throw new MailError(`${label} dépasse ${max} caractères.`);
  return html;
}

/** One account of the shared JSON, validated and frozen. */
export function normalizeAccount(input, { requirePassword = true } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const id = requiredText(source.id, 'L’identifiant de boîte', 50).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new MailError('L’identifiant de boîte doit contenir lettres minuscules, chiffres et tirets.');
  }
  const password = String(source.password || '');
  if (requirePassword && !password) throw new MailError(`Le mot de passe de ${id} est requis.`);
  if (password.length > 4096) throw new MailError(`Le mot de passe de ${id} est trop long.`);
  return Object.freeze({
    id,
    label: requiredText(source.label || id, `Le libellé de ${id}`, 100),
    address: email(source.address, `L’adresse de ${id}`),
    username: requiredText(source.username, `L’identifiant de connexion de ${id}`, 254),
    password,
    signatureHtml: optionalHtml(source.signatureHtml, `La signature HTML de ${id}`),
    default: Boolean(source.default),
    imap: Object.freeze({
      host: host(source.imap?.host, `Le serveur IMAP de ${id}`),
      port: port(source.imap?.port, `Le port IMAP de ${id}`),
      security: security(source.imap?.security, `La sécurité IMAP de ${id}`),
    }),
    smtp: Object.freeze({
      host: host(source.smtp?.host, `Le serveur SMTP de ${id}`),
      port: port(source.smtp?.port, `Le port SMTP de ${id}`),
      security: security(source.smtp?.security, `La sécurité SMTP de ${id}`),
    }),
  });
}

/** Unique ids, exactly one default (the first account when none is marked). */
export function normalizeAccounts(accounts, options = {}) {
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new MailError('Configure au moins une boîte mail.');
  }
  if (accounts.length > MAX_ACCOUNTS) {
    throw new MailError(`Au maximum ${MAX_ACCOUNTS} boîtes mail peuvent être configurées.`);
  }
  const normalized = accounts.map((item) => normalizeAccount(item, options));
  const ids = new Set();
  for (const account of normalized) {
    if (ids.has(account.id)) throw new MailError(`Identifiant de boîte dupliqué : ${account.id}.`);
    ids.add(account.id);
  }
  const defaults = normalized.filter((account) => account.default);
  if (defaults.length > 1) throw new MailError('Une seule boîte mail peut être définie par défaut.');
  if (!defaults.length) {
    return normalized.map((account, index) => Object.freeze({ ...account, default: index === 0 }));
  }
  return normalized;
}

/** Stored value (JSON string, `{ accounts }` object or bare array) to accounts. */
export function parseAccountConfig(value, options = {}) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch {
      throw new MailError('La configuration SMTP/IMAP enregistrée est illisible.');
    }
  }
  const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts;
  return normalizeAccounts(accounts, options);
}

export function stringifyAccountConfig(accounts, options = {}) {
  return JSON.stringify({ version: 2, accounts: normalizeAccounts(accounts, options) });
}

/** What may be shown to an agent: no username, password or signature HTML. */
export function publicAccount(account) {
  return {
    id: account.id,
    label: account.label,
    address: account.address,
    default: account.default,
    hasSignature: Boolean(account.signatureHtml),
    imap: { ...account.imap },
    smtp: { ...account.smtp },
  };
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function decodeHtmlEntities(value) {
  const codePoint = (match, raw, radix) => {
    const number = parseInt(raw, radix);
    return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
  };
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, code) => codePoint(match, code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => codePoint(match, code, 16));
}

/**
 * Remote HTML to text: line breaks, list items and block ends kept. Tags are
 * walked with indexOf, in linear time: a `<[^>]*>` expression rescans the rest
 * of the input at every unclosed `<`, which a hostile message can repeat.
 */
export function htmlToPlainText(value) {
  const html = String(value || '');
  let text = '';
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) break;
    const close = html.indexOf('>', open);
    // No `>` left: no tag can follow, the rest is text.
    if (close < 0) break;
    text += html.slice(index, open);
    const tag = /^<\s*(\/?)\s*([a-z][a-z0-9]*)/i.exec(html.slice(open, Math.min(close, open + 40)));
    const name = tag ? tag[2].toLowerCase() : '';
    if (tag && !tag[1] && name === 'br') text += '\n';
    else if (tag && !tag[1] && name === 'li') text += '- ';
    else if (tag?.[1] && /^(?:p|div|li|tr|h[1-6])$/.test(name)) text += '\n';
    index = close + 1;
  }
  return decodeHtmlEntities(text + html.slice(index))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textToHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

// What a quoted message keeps of the original HTML (`quotableHtml`). Any other
// tag is dropped and its content kept, except QUOTE_DROPPED, which goes whole.
// `img` stays only for an inline image the reply carries along.
const QUOTE_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'ins', 'li', 'ol', 'p', 'pre', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);
const QUOTE_DROPPED = new Set([
  'audio', 'canvas', 'embed', 'head', 'iframe', 'input', 'map', 'math', 'noscript', 'object',
  'picture', 'script', 'select', 'style', 'svg', 'template', 'textarea', 'title', 'video',
]);
const QUOTE_VOID = new Set(['br', 'hr']);
const QUOTE_STYLES = /^(?:background-color|border(?:-(?:top|right|bottom|left))?(?:-(?:color|style|width))?|border-collapse|color|font-(?:family|size|style|weight)|height|line-height|margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?|text-(?:align|decoration)|vertical-align|white-space|(?:max-)?width)$/;
const QUOTE_LINK = /^(?:https?:\/\/|mailto:|tel:)[^\0-\x1f\x7f]{0,4000}$/i;
const QUOTE_HIDDEN = /display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all/i;
const MAX_QUOTED_HTML = 1000000;
// htmlparser2 keeps its open elements in an array it unshifts: past this depth,
// which no real message reaches, each tag would cost more than the last.
const MAX_QUOTE_DEPTH = 400;
// The original's inline images travel with the reply, as Roundcube does;
// remote images never do (tracking pixels).
const MAX_QUOTED_IMAGES = 20;
const MAX_QUOTED_IMAGE_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The type an image's own bytes declare: only PNG, JPEG and GIF travel.
function imageType(content) {
  if (content.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
  if (content.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  return '';
}

// Allowed properties whose value holds no url(), expression() or comment;
// only rgb() and hsl() may use parentheses. No negative length either: a
// negative margin would lift the quote over the reply written above it.
function quotedStyle(value) {
  return String(value || '').slice(0, 2000).split(';').map((declaration) => {
    const colon = declaration.indexOf(':');
    if (colon < 0) return '';
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const raw = declaration.slice(colon + 1).trim();
    const plain = raw.replace(/\b(?:rgba?|hsla?)\([\d\s.,%]*\)/gi, '');
    return QUOTE_STYLES.test(property) && raw && raw.length <= 200 && /^[\w\s#%.,'"!+-]*$/.test(plain)
      && !/(?:^|[^\w-])-[\d.]/.test(plain)
      ? `${property}:${raw}` : '';
  }).filter(Boolean).join(';');
}

// The attributes an allowed tag keeps; null for a link to unwrap.
function quotedAttributes(name, attributes) {
  let result = '';
  if (name === 'a') {
    const href = String(attributes.href || '').trim();
    if (!QUOTE_LINK.test(href)) return null;
    result += ` href="${escapeHtml(href)}"`;
  }
  if (name === 'img' && attributes.alt) result += ` alt="${escapeHtml(String(attributes.alt).slice(0, 300))}"`;
  for (const key of ['colspan', 'rowspan', 'start']) {
    if (/^\d{1,3}$/.test(attributes[key] || '')) result += ` ${key}="${attributes[key]}"`;
  }
  for (const key of ['width', 'height']) {
    if (/^\d{1,4}%?$/.test(attributes[key] || '')) result += ` ${key}="${attributes[key]}"`;
  }
  const style = quotedStyle(attributes.style);
  if (style) result += ` style="${escapeHtml(style)}"`;
  return result;
}

/**
 * The original HTML as a quote may carry it: parsed, then rebuilt from an
 * allow-list of tags, link schemes and style properties. Scripts, styles,
 * form fields and hidden elements go with their content; classes, ids and
 * every other attribute disappear. An image stays only when `inlineImage(src)`
 * gives it a new source. A message nested deeper than MAX_QUOTE_DEPTH is
 * quoted up to that point. Empty when neither text nor image survives.
 * `Parser` is htmlparser2's, loaded by the caller.
 */
export function quotableHtml(value, Parser, inlineImage = () => '') {
  let html = '';
  let visible = false;
  let dropped = 0;
  // One entry per open element: what its end writes, or `drop`.
  const open = [];
  const tooDeep = new Error('quote too deep');
  const parser = new Parser({
    onopentag(name, attributes) {
      if (open.length >= MAX_QUOTE_DEPTH) throw tooDeep;
      if (dropped || QUOTE_DROPPED.has(name) || 'hidden' in attributes || QUOTE_HIDDEN.test(attributes.style || '')) {
        dropped += 1;
        open.push('drop');
        return;
      }
      if (name === 'img') {
        const src = html.length < MAX_BODY_CHARACTERS ? inlineImage(String(attributes.src || '').trim()) : '';
        if (src) {
          html += `<img src="${escapeHtml(src)}"${quotedAttributes(name, attributes)}>`;
          visible = true;
        }
        open.push('');
        return;
      }
      const kept = QUOTE_TAGS.has(name) && html.length < MAX_BODY_CHARACTERS ? quotedAttributes(name, attributes) : null;
      if (kept === null) {
        open.push('');
        return;
      }
      html += `<${name}${kept}>`;
      open.push(QUOTE_VOID.has(name) ? '' : `</${name}>`);
    },
    onclosetag() {
      const end = open.pop();
      if (end === 'drop') dropped -= 1;
      else if (end) html += end;
    },
    ontext(text) {
      const room = MAX_BODY_CHARACTERS - html.length;
      if (dropped || room <= 0) return;
      if (/\S/.test(text)) visible = true;
      html += escapeHtml(text.length > room ? text.slice(0, room) : text);
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  try {
    parser.end(String(value || '').slice(0, MAX_QUOTED_HTML));
  } catch (error) {
    if (error !== tooDeep) throw error;
    html += open.reverse().filter((end) => end !== 'drop').join('');
  }
  return visible ? html.trim() : '';
}

function replySubject(value) {
  const subject = String(value || '(sans objet)').trim() || '(sans objet)';
  return /^(?:re|r[eé]|aw)\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

/**
 * Who a reply goes to when the caller names no one: the original's Reply-To,
 * else its sender. A message the mailbox sent itself goes back to its
 * recipients. Never the mailbox's own address.
 */
function replyRecipients(parsed, self) {
  const others = (value) => parsedAddresses(value).map((entry) => entry.address).filter((address) => address !== self);
  const replyTo = others(parsed.replyTo);
  if (replyTo.length) return replyTo;
  const sentByUs = parsedAddresses(parsed.from).some((entry) => entry.address === self);
  return sentByUs ? others(parsed.to) : others(parsed.from);
}

function referenceList(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry || '').split(/\s+/))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The quoted history of a reply, laid out as Roundcube does, with the inline
 * images it shows (`images`, new Content-IDs on `domain`).
 */
async function quotedMessage(metadata, parsed, domain) {
  const envelope = metadata.envelope || {};
  const sender = parsedAddresses(parsed.from)[0] || addressList(envelope.from)[0] || {};
  const rawDate = parsed.date || envelope.date;
  const date = rawDate ? new Date(rawDate) : null;
  const part = date && !Number.isNaN(date.getTime())
    ? Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Paris',
    }).formatToParts(date).map(({ type, value }) => [type, value]))
    : null;
  const dateLabel = part ? `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}` : 'date inconnue';
  const heading = `Le ${dateLabel}, ${sender.name || sender.address || 'Expéditeur inconnu'} a écrit\u00a0:`;
  const original = String(parsed.text || htmlToPlainText(parsed.html || '') || '(message sans contenu textuel)')
    .trim().slice(0, MAX_BODY_CHARACTERS);
  const inline = new Map((parsed.attachments || [])
    .filter((attachment) => attachment.cid && Buffer.isBuffer(attachment.content))
    .map((attachment) => [String(attachment.cid), attachment]));
  const images = new Map();
  let bytes = 0;
  const inlineImage = (src) => {
    if (!/^cid:/i.test(src)) return '';
    const cid = src.slice(4);
    if (!images.has(cid)) {
      const attachment = inline.get(cid);
      const contentType = attachment ? imageType(attachment.content) : '';
      if (!contentType || images.size >= MAX_QUOTED_IMAGES || bytes + attachment.content.length > MAX_QUOTED_IMAGE_BYTES) return '';
      bytes += attachment.content.length;
      images.set(cid, {
        filename: safeAttachmentName(attachment.filename),
        content: attachment.content,
        contentType,
        contentDisposition: 'inline',
        cid: `${randomUUID()}@${domain}`,
      });
    }
    return `cid:${images.get(cid).cid}`;
  };
  // The remote HTML is untrusted: it is rebuilt, never copied. The text part
  // stands in for a message without HTML, or whose HTML keeps nothing.
  const rich = typeof parsed.html === 'string' && parsed.html.trim()
    ? quotableHtml(parsed.html, (await import('htmlparser2')).Parser, inlineImage)
    : '';
  return {
    text: `${heading}\n${original.split(/\r?\n/).map((line) => `> ${line}`).join('\n')}`,
    html: `<div class="${HISTORY_CLASS}"><p>${escapeHtml(heading)}</p>`
      + '<blockquote type="cite" style="padding:0 0.4em;border-left:#1010ff 2px solid;margin:0">'
      + `${rich || textToHtml(original)}</blockquote></div>`,
    images: rich ? [...images.values()] : [],
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `value` without a trailing `suffix`, whatever the whitespace between its words.
// Only the tail is searched: a leading `\s*` would rescan a long blank run.
function withoutSuffix(value, suffix) {
  const words = String(suffix || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return value;
  const cut = Math.max(0, value.length - (suffix.length * 4 + 200));
  const tail = value.slice(cut).replace(new RegExp(`\\s*${words.map(escapeRegExp).join('\\s+')}\\s*$`), '');
  return value.slice(0, cut) + tail;
}

/**
 * The version an agent must quote to change a draft: a hash of what it can see
 * and rewrite. A mail client that edits the draft changes it; a read state, a
 * flag or a new UID for the same content does not.
 */
export function draftVersion({ subject = '', to = [], cc = [], bcc = [], text = '' } = {}) {
  const body = String(text);
  const canonical = JSON.stringify([
    String(subject).trim(),
    ...[to, cc, bcc].map((list) => list.map((address) => String(address).trim().toLowerCase())),
    // Whitespace runs collapse so that a composed draft and its parsed copy agree.
    // Past 200 000 characters that costs seconds: the text is hashed as is, and
    // the worst case is one needless « changed » refusal, which gives the version.
    body.length > MAX_COLLAPSED_TEXT ? body.trim() : body.replace(/\s+/g, ' ').trim(),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * A draft as an agent rewrites it: `text` is the part above the quoted history,
 * without the signature and mark this client composes again; `history` is kept
 * as is by an update. The history is searched in the HTML part when there is
 * one, else in the text: never guessed across both. `quoted` stays internal.
 */
function draftView(parsed, { signatureText = '', markText = '' } = {}) {
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const plain = String(parsed.text || '');
  const textStart = textHistoryStart(plain);
  const textQuote = textStart >= 0 ? plain.slice(textStart).trimEnd() : '';
  const htmlStart = html ? html.search(HISTORY_HTML) : -1;
  let quoted = null;
  if (htmlStart >= 0) {
    // From the opening tag that carries the marker.
    const tail = html.slice(html.lastIndexOf('<', htmlStart));
    quoted = { html: tail, text: textQuote || htmlToPlainText(tail).trimEnd() };
  } else if (!html && textQuote) {
    quoted = { html: '', text: textQuote };
  }
  let written = plain;
  if (textStart >= 0) written = plain.slice(0, textStart);
  else if (htmlStart >= 0) written = htmlToPlainText(html.slice(0, htmlStart));
  else if (!plain && html) written = htmlToPlainText(html);
  const text = withoutSuffix(withoutSuffix(written.trimEnd(), markText), signatureText).trim();
  const addresses = (field) => parsedAddresses(parsed[field]).map((entry) => entry.address);
  const view = { subject: String(parsed.subject || ''), to: addresses('to'), cc: addresses('cc'), bcc: addresses('bcc'), text };
  return {
    version: draftVersion(view),
    ...view,
    reply: Boolean(String(parsed.inReplyTo || '').trim() || referenceList(parsed.references).length),
    quoted,
  };
}

// What an agent is shown of a draft: never the internal history copy.
function publicDraft({ version, subject, to, cc, bcc, text, quoted }) {
  return { version, subject, to, cc, bcc, text, historyFound: Boolean(quoted) };
}

// A message about to be stored, shaped like the parser's result, so that its
// version is computed exactly as it will be when the draft is read back.
function composedAsParsed(message) {
  const list = (values) => ({ value: values.map((address) => ({ address })) });
  return {
    subject: message.subject, to: list(message.to), cc: list(message.cc), bcc: list(message.bcc),
    text: message.text, html: message.html || '', inReplyTo: message.inReplyTo || '', references: message.references || [],
  };
}

// An attachment already in a draft, handed back to nodemailer unchanged.
function keptAttachment(attachment) {
  const inline = Boolean(attachment.cid) && String(attachment.contentDisposition || '').toLowerCase() === 'inline';
  return {
    filename: safeAttachmentName(attachment.filename),
    content: attachment.content,
    contentType: String(attachment.contentType || 'application/octet-stream'),
    contentDisposition: inline ? 'inline' : 'attachment',
    ...(attachment.cid ? { cid: String(attachment.cid) } : {}),
  };
}

/** What a draft update changes, checked before any connection. */
function draftChanges(changes) {
  const source = changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : {};
  const update = {};
  for (const [field, label] of [['to', 'Destinataire'], ['cc', 'Copie'], ['bcc', 'Copie cachée']]) {
    if (source[field] !== undefined) update[field] = recipients(source[field], label);
  }
  if (source.subject !== undefined) update.subject = requiredText(source.subject, 'L’objet du mail', 500);
  const text = String(source.text || '');
  const html = String(source.html || '');
  update.bodyReplaced = Boolean(text || html);
  if (update.bodyReplaced) Object.assign(update, { text, html });
  const attachments = source.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
    throw new MailError(`Au maximum ${MAX_ATTACHMENTS} pièces jointes peuvent être ajoutées.`);
  }
  update.attachments = attachments;
  update.wholeBody = source.wholeBody === true;
  update.version = String(source.version || '').trim();
  if (!['to', 'cc', 'bcc', 'subject'].some((field) => field in update) && !update.bodyReplaced && !attachments.length) {
    throw new MailError('Aucune modification demandée pour ce brouillon.');
  }
  return update;
}

function composeBodies(account, { text = '', html = '', quote = null } = {}, mark = null) {
  let plain = String(text || '').trimEnd();
  let rich = String(html || '').trim();
  if (!plain && rich) plain = htmlToPlainText(rich);

  const signatureHtml = String(account.signatureHtml || '').trim();
  // A signature or a quote needs an HTML part: the text is converted once.
  if (!rich && text && (signatureHtml || quote)) rich = `<div>${textToHtml(String(text).trimEnd())}</div>`;
  const signatureText = htmlToPlainText(signatureHtml);
  if (signatureText) plain += `${plain ? '\n\n' : ''}${signatureText}`;
  if (signatureHtml) rich += `${rich ? '<br>' : ''}<div class="mail-signature">${signatureHtml}</div>`;

  // The mark closes the new content, above the quoted history.
  if (mark?.text) plain += `${plain ? '\n\n' : ''}${mark.text}`;
  if (rich && mark?.html) rich += mark.html;

  if (quote) {
    plain += `\n\n${quote.text}`;
    rich += `${rich ? '<br><br>' : ''}${quote.html}`;
  }
  return { text: plain, html: rich };
}

function normalizeMark(mark) {
  if (!mark) return null;
  if (typeof mark !== 'object' || Array.isArray(mark)) {
    throw new MailError('La marque doit être un objet { text, html, header }.');
  }
  const text = String(mark.text || '').trim();
  const html = String(mark.html || '').trim() || (text ? `<p>${escapeHtml(text)}</p>` : '');
  let header = null;
  if (mark.header) {
    const name = String(mark.header.name || '').trim();
    const value = String(mark.header.value ?? '').trim();
    // An X- header only: the mark must never replace From, To or Bcc.
    if (!/^X-[A-Za-z0-9-]{1,74}$/i.test(name)) {
      throw new MailError('L’en-tête de la marque doit être un en-tête X-… valide.');
    }
    if (!value || value.length > 200 || /[\0-\x1f\x7f]/.test(value)) {
      throw new MailError('La valeur de l’en-tête de la marque doit tenir sur une ligne de 200 caractères au plus.');
    }
    header = Object.freeze({ name, value });
  }
  return Object.freeze({ text, html, header });
}

function generatedMessageId(account) {
  const domain = String(account.address || '').split('@')[1] || 'localhost';
  return `<${randomUUID()}@${domain}>`;
}

async function loadNodemailer() {
  const module = await import('nodemailer');
  return module.createTransport ? module : module.default;
}

// The exact MIME bytes appended to Drafts or Sent. A stream transport keeps
// the Bcc header, so a draft finished later in a mail client still has it.
async function buildRawMessage(message) {
  const transport = (await loadNodemailer()).createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  try {
    const result = await transport.sendMail(message);
    return Buffer.isBuffer(result.message) ? result.message : Buffer.from(result.message || '');
  } finally {
    try { transport.close(); } catch {}
  }
}

function secretForms(account) {
  const password = String(account?.password || '');
  if (password.length < 4) return [];
  const username = String(account.username || '');
  return [
    password,
    Buffer.from(password).toString('base64'),
    Buffer.from(`\0${username}\0${password}`).toString('base64'),
  ];
}

/** Error message without any account password (plain or base64), on one line. */
export function redactError(error, accounts = []) {
  const forms = accounts.flatMap(secretForms);
  const mask = (text) => forms.reduce((result, value) => result.split(value).join(MASK), text);
  const source = error && typeof error === 'object' ? error.message : error;
  return mask(mask(String(source || 'Échec SMTP/IMAP.')).replace(/\s+/g, ' ').trim()).slice(0, 500);
}

function failure(error, accounts) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code) ? error.code : '';
  return new MailError(redactError(error, accounts), {
    code, authenticationFailed: error?.authenticationFailed === true,
    details: error instanceof MailError ? error.details : null,
  });
}

function addressList(entries) {
  return (entries || []).flatMap((entry) => {
    if (!entry) return [];
    const address = String(entry.address || '').trim().toLowerCase();
    return address ? [{ name: String(entry.name || ''), address }] : [];
  });
}

function envelopeView(message) {
  const envelope = message.envelope || {};
  const date = envelope.date ? new Date(envelope.date) : null;
  return {
    uid: Number(message.uid),
    subject: String(envelope.subject || '(sans objet)'),
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : '',
    from: addressList(envelope.from),
    to: addressList(envelope.to),
    cc: addressList(envelope.cc),
    messageId: String(envelope.messageId || ''),
    seen: Boolean(message.flags?.has?.('\\Seen')),
    flagged: Boolean(message.flags?.has?.('\\Flagged')),
    size: Number(message.size || 0),
  };
}

function parsedAddresses(value) {
  return addressList(Array.isArray(value?.value) ? value.value : []);
}

// Remote names are untrusted: no directory part on any platform, no control
// character, never `.` or `..`.
function safeAttachmentName(value) {
  const name = String(value || '').split(/[\\/]/).pop().replace(/[\0-\x1f\x7f]/g, '').trim();
  return name && name !== '.' && name !== '..' ? name.slice(0, 255) : 'piece-jointe';
}

export function imapOptions(account, timeout) {
  return {
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.security === 'tls',
    doSTARTTLS: account.imap.security === 'starttls',
    auth: { user: account.username, pass: account.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: Math.max(timeout, 30000),
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  };
}

export function smtpOptions(account, timeout) {
  return {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.security === 'tls',
    requireTLS: account.smtp.security === 'starttls',
    auth: { user: account.username, pass: account.password },
    logger: false,
    debug: false,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: Math.max(timeout, 30000),
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  };
}

async function defaultImapFactory(options) {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow(options);
}

async function defaultSmtpFactory(options) {
  return (await loadNodemailer()).createTransport(options);
}

async function defaultParser(source, options) {
  const { simpleParser } = await import('mailparser');
  return simpleParser(source, options);
}

function closeQuietly(resource) {
  try { resource?.close?.(); } catch {}
}

/**
 * new MailClient({
 *   configuration,          // shared JSON string, { accounts } object or array
 *   accounts,               // or the account array itself (not both)
 *   allowWrites: false,     // drafts, flag changes, sends and replies refused unless true
 *   allowedDomains: [],     // account addresses outside these domains are refused
 *   authorize: async () => {},   // runs once before the first operation, throws to refuse
 *   audit: (entry) => {},        // one entry per write attempt, never any content
 *   mark: { text, html, header: { name, value } },  // optional agent mark
 *   imapFactory, smtpFactory, parser,   // may be async; tests inject fakes here
 *   timeout: 12000, maxMessageBytes, configureHint: '',  // hint appended when no account exists
 * })
 *
 * An empty `id` selects the default account. Read results flag remote text as
 * `untrustedContent`. Errors are MailError, with passwords masked.
 */
export class MailClient {
  #accounts;
  #allowWrites;
  #allowedDomains;
  #authorize;
  #authorization = null;
  #audit;
  #mark;
  #imapFactory;
  #smtpFactory;
  #parser;
  #configureHint;

  constructor({
    accounts, configuration, allowWrites = false, allowedDomains = [], authorize = null, audit = null, mark = null,
    imapFactory = defaultImapFactory, smtpFactory = defaultSmtpFactory, parser = defaultParser,
    timeout = 12000, maxMessageBytes = MAX_MESSAGE_BYTES, configureHint = '',
  } = {}) {
    if (accounts !== undefined && configuration !== undefined) {
      throw new MailError('Passe accounts ou configuration, pas les deux.');
    }
    for (const [name, hook] of Object.entries({ authorize, audit, imapFactory, smtpFactory, parser })) {
      if (hook !== null && typeof hook !== 'function') throw new MailError(`L’option ${name} doit être une fonction.`);
    }
    const source = accounts ?? configuration;
    this.#accounts = source ? parseAccountConfig(source) : [];
    this.#allowWrites = allowWrites === true;
    this.#allowedDomains = Object.freeze([allowedDomains].flat().filter(Boolean)
      .map((domain) => String(domain).trim().toLowerCase().replace(/^@/, '')));
    this.#authorize = authorize;
    this.#audit = audit;
    this.#mark = normalizeMark(mark);
    this.#imapFactory = imapFactory;
    this.#smtpFactory = smtpFactory;
    this.#parser = parser;
    this.#configureHint = String(configureHint || '').trim();
    this.timeout = Math.max(1000, Number(timeout) || 12000);
    this.maxMessageBytes = Math.max(1024, Number(maxMessageBytes) || MAX_MESSAGE_BYTES);
  }

  get allowWrites() {
    return this.#allowWrites;
  }

  /** Run the `authorize` hook once; a refusal is retried on the next call. */
  async authorize() {
    if (!this.#authorize) return;
    if (!this.#authorization) {
      // Deferred call: even a synchronous throw rejects after the assignment,
      // so the reset below is never overwritten by the failed attempt.
      this.#authorization = Promise.resolve().then(() => this.#authorize()).then(() => undefined, (error) => {
        this.#authorization = null;
        throw error instanceof MailError ? error : failure(error, this.#accounts);
      });
    }
    await this.#authorization;
  }

  async accounts() {
    await this.authorize();
    return this.#accounts.filter((account) => this.#domainAllowed(account)).map(publicAccount);
  }

  async account(id = '') {
    return publicAccount(await this.#resolve(id));
  }

  /** IMAP LIST and SMTP EHLO/AUTH: proves both logins without sending anything. */
  async verify(id = '') {
    const account = await this.#resolve(id);
    await this.#withImap(account, (client) => client.list({ listOnly: true }));
    let transport;
    try {
      transport = await this.#smtpFactory(smtpOptions(account, this.timeout));
      await transport.verify();
    } catch (error) {
      throw failure(error, [account]);
    } finally {
      closeQuietly(transport);
    }
    return { account: account.id, address: account.address, imap: true, smtp: true };
  }

  async folders(id = '') {
    const account = await this.#resolve(id);
    return this.#withImap(account, async (client) => ({
      account: account.id,
      folders: (await client.list({ statusQuery: { messages: true, unseen: true } }))
        .filter((folder) => !folder.flags?.has?.('\\Noselect'))
        .map((folder) => ({
          path: String(folder.path),
          name: String(folder.name),
          specialUse: String(folder.specialUse || ''),
          subscribed: Boolean(folder.subscribed),
          messages: Number(folder.status?.messages || 0),
          unseen: Number(folder.status?.unseen || 0),
        })),
    }));
  }

  /** Newest first. `query` and `unreadOnly` run as a server-side SEARCH. */
  async messages(id = '', { mailbox = 'INBOX', unreadOnly = false, query = '', limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(100, Number(limit) || 50));
    const folder = requiredText(mailbox, 'Le dossier IMAP', 255);
    const needle = String(query || '').trim().slice(0, 200);
    const account = await this.#resolve(id);
    return this.#withImap(account, async (client) => {
      const empty = { account: account.id, mailbox: folder, messages: [] };
      const lock = await client.getMailboxLock(folder, { readOnly: true, acquireTimeout: this.timeout });
      try {
        let range;
        if (needle || unreadOnly) {
          const search = {
            ...(unreadOnly ? { seen: false } : {}),
            ...(needle ? { or: [{ subject: needle }, { from: needle }, { text: needle }] } : {}),
          };
          range = ((await client.search(search, { uid: true })) || []).slice(-bounded);
          if (!range.length) return empty;
        } else {
          const exists = Number(client.mailbox?.exists || 0);
          if (!exists) return empty;
          range = `${Math.max(1, exists - bounded + 1)}:*`;
        }
        const messages = [];
        for await (const message of client.fetch(range, {
          uid: true, envelope: true, flags: true, internalDate: true, size: true,
        }, { uid: Array.isArray(range) })) {
          messages.push(envelopeView(message));
        }
        messages.sort((a, b) => b.uid - a.uid);
        return { ...empty, messages };
      } finally {
        lock.release();
      }
    });
  }

  /** Complete, bounded header index for scheduled triage; EXAMINE never marks mail as read. */
  async messageIndex(id = '', { mailbox = 'INBOX', query = { all: true }, limit = 5000 } = {}) {
    const folder = requiredText(mailbox, 'Le dossier IMAP', 255);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new MailError('Limite IMAP invalide.');
    const account = await this.#resolve(id);
    return this.#withImap(account, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true, acquireTimeout: this.timeout });
      try {
        const uids = (await client.search(query, { uid: true })) || [];
        const result = { account: account.id, mailbox: folder, uidValidity: String(client.mailbox.uidValidity || ''),
          total: uids.length, complete: uids.length <= limit, messages: [] };
        if (!result.complete || !uids.length) return result;
        for await (const entry of client.fetch(uids, {
          uid: true, envelope: true, flags: true, internalDate: true, size: true,
          headers: ['References', 'In-Reply-To', 'Reply-To', 'Auto-Submitted', 'List-Id', 'Precedence'],
        }, { uid: true })) {
          const parsed = entry.headers ? await this.#parser(entry.headers) : {};
          result.messages.push({ ...envelopeView(entry), mailbox: folder,
            internalDate: entry.internalDate ? new Date(entry.internalDate).toISOString() : '',
            replyTo: parsedAddresses(parsed.replyTo),
            inReplyTo: String(parsed.inReplyTo || entry.envelope?.inReplyTo || ''),
            references: referenceList(parsed.references),
            autoSubmitted: String(parsed.headers?.get('auto-submitted') || ''),
            listId: String(parsed.headers?.get('list-id') || ''),
            precedence: String(parsed.headers?.get('precedence') || ''),
            draft: Boolean(entry.flags?.has?.('\\Draft')),
          });
        }
        result.messages.sort((a, b) => a.uid - b.uid);
        return result;
      } finally { lock.release(); }
    });
  }

  /** Raw imapflow metadata and the mailparser result, read with EXAMINE. */
  async parsedMessage(id, mailbox, uid) {
    const folder = requiredText(mailbox, 'Le dossier IMAP', 255);
    const number = uidNumber(uid);
    const account = await this.#resolve(id);
    return this.#withImap(account, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true, acquireTimeout: this.timeout });
      try {
        return { account: account.id, folder, ...await this.#fetchParsed(client, number) };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Parsed message, never marked as seen. Its text is untrusted input. A draft
   * (\Draft) also carries `draft`: the text to rewrite and its version.
   */
  async message(id = '', mailbox = 'INBOX', uid) {
    const { account, folder, metadata, parsed } = await this.parsedMessage(id, mailbox, uid);
    const isDraft = Boolean(metadata.flags?.has?.('\\Draft'));
    return {
      ...envelopeView(metadata),
      account,
      mailbox: folder,
      from: parsedAddresses(parsed.from),
      to: parsedAddresses(parsed.to),
      cc: parsedAddresses(parsed.cc),
      replyTo: parsedAddresses(parsed.replyTo),
      inReplyTo: String(parsed.inReplyTo || ''),
      references: referenceList(parsed.references),
      text: String(parsed.text || '').slice(0, MAX_BODY_CHARACTERS),
      html: typeof parsed.html === 'string' ? parsed.html.slice(0, MAX_BODY_CHARACTERS) : '',
      attachments: (parsed.attachments || []).map((attachment, index) => ({
        id: String(index),
        filename: safeAttachmentName(attachment.filename),
        contentType: String(attachment.contentType || 'application/octet-stream'),
        size: Number(attachment.size || attachment.content?.length || 0),
        contentId: String(attachment.cid || ''),
        inline: String(attachment.contentDisposition || '').toLowerCase() === 'inline',
      })),
      ...(isDraft ? { draft: publicDraft(this.#draftView(await this.#resolve(account), parsed)) } : {}),
      untrustedContent: true,
    };
  }

  /** `attachmentId` is the `id` listed by `message()`. */
  async downloadAttachment(id = '', mailbox = 'INBOX', uid, attachmentId, { maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
    if (!/^\d{1,4}$/.test(String(attachmentId ?? '').trim())) {
      throw new MailError('Identifiant de pièce jointe invalide.');
    }
    const limit = Math.max(1, Number(maxBytes) || MAX_ATTACHMENT_BYTES);
    const { account, parsed } = await this.parsedMessage(id, mailbox, uid);
    const attachment = (parsed.attachments || [])[Number(attachmentId)];
    if (!attachment || !Buffer.isBuffer(attachment.content)) {
      throw new MailError('Pièce jointe introuvable dans ce message.');
    }
    if (attachment.content.length > limit) {
      throw new MailError(`Pièce jointe trop volumineuse (${attachment.content.length} octets, limite ${limit}).`);
    }
    return {
      data: attachment.content,
      filename: safeAttachmentName(attachment.filename),
      contentType: String(attachment.contentType || 'application/octet-stream'),
      size: attachment.content.length,
      account,
    };
  }

  /**
   * Write an attachment to `destinationPath` (a file, or an existing directory
   * that receives the sanitized remote name). An existing file is kept unless
   * `overwrite`, which replaces it atomically. Local only: no mailbox write.
   */
  async saveAttachment(id, mailbox, uid, attachmentId, destinationPath, { overwrite = false, maxBytes } = {}) {
    const destination = String(destinationPath || '').trim();
    if (!destination) throw new MailError('Le chemin de destination est requis.');
    const attachment = await this.downloadAttachment(id, mailbox, uid, attachmentId, { maxBytes });
    let target = path.resolve(destination);
    const existing = await stat(target).catch(() => null);
    if (existing?.isDirectory() || /[\\/]$/.test(destination)) target = path.join(target, attachment.filename);
    await mkdir(path.dirname(target), { recursive: true });
    if (overwrite) {
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.part`);
      await writeFile(temporary, attachment.data, { flag: 'wx', mode: 0o600 });
      try {
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw new MailError(`Impossible de remplacer ${target} : ${error.code || 'erreur'}.`);
      }
    } else {
      try {
        await writeFile(target, attachment.data, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new MailError(`Le fichier ${target} existe déjà. Passe overwrite: true pour le remplacer.`);
        }
        throw new MailError(`Impossible d’écrire ${target} : ${error.code || 'erreur'}.`);
      }
    }
    const { data, ...metadata } = attachment;
    return { ...metadata, path: target };
  }

  /** IMAP APPEND to Drafts, flagged \Draft and left unread: nothing reaches SMTP. */
  async saveDraft(id = '', input = {}) {
    this.#assertWrites('imap');
    return this.#saveDraft(id, input, 'draft');
  }

  /** SMTP send, then a copy appended once to Sent. */
  async send(id = '', input = {}) {
    this.#assertWrites('smtp');
    return this.#send(id, input, 'send');
  }

  /** Send a reply in the thread of `uid`, quoting it below the signature. `to` is required. */
  async reply(id = '', mailbox = 'INBOX', uid, input = {}) {
    this.#assertWrites('smtp');
    return this.#send(id, await this.#replyInput(id, mailbox, uid, input), 'reply');
  }

  /**
   * Same reply, saved as a draft instead of sent. Without `to` (or with an
   * empty list), it is addressed as a mail client's "Reply" would be.
   */
  async replyDraft(id = '', mailbox = 'INBOX', uid, input = {}) {
    this.#assertWrites('imap');
    return this.#saveDraft(id, await this.#replyInput(id, mailbox, uid, input, { draft: true }), 'reply-draft');
  }

  /**
   * Rewrite the draft `uid` of `mailbox` (the Drafts folder when empty). IMAP
   * cannot edit a stored message: the new version is appended to the same
   * folder, unread, then the old one is deleted. `changes` holds what changes:
   * `to`, `cc`, `bcc`, `subject` replace their value; `text` or `html` replace
   * the written part, signature and mark composed again, and keep the quoted
   * history of a reply; `attachments` are added. A reply draft whose history
   * cannot be found keeps its body unless `wholeBody: true` replaces it all.
   *
   * `changes.version` is the draft's version, from its creation, `message()`
   * or the last update: a missing or outdated one changes nothing, and the
   * error's `details.current` holds the draft as it now stands, so that the
   * change is made again on that text and not over someone's edit.
   */
  async updateDraft(id = '', mailbox = '', uid, changes = {}) {
    this.#assertWrites('imap');
    const number = uidNumber(uid);
    const folderName = String(mailbox || '').trim() ? requiredText(mailbox, 'Le dossier IMAP', 255) : '';
    const update = draftChanges(changes);
    const account = await this.#resolve(id);
    let message = null;
    let appending = false;
    const audit = (outcome) => this.#record(account, 'draft-update', message, outcome);
    let result;
    try {
      result = await this.#withImap(account, async (client) => {
        // LIST only when needed: no folder named, or a message without \Draft.
        let drafts = null;
        const draftsFolder = async () => (drafts ??= await this.#findFolder(client, DRAFTS_FOLDER));
        const folder = folderName || await draftsFolder();
        if (!folder) throw new MailError(`Aucun dossier IMAP « ${DRAFTS_FOLDER.label} » n’a été trouvé.`);
        const lock = await client.getMailboxLock(folder, { acquireTimeout: this.timeout });
        try {
          const { metadata, parsed } = await this.#fetchParsed(client, number);
          if (!metadata.flags?.has?.('\\Draft') && folder !== await draftsFolder()) {
            throw new MailError(`Le message UID ${number} n’est pas un brouillon : seul un brouillon se modifie.`);
          }
          const view = this.#draftView(account, parsed);
          const refuse = (code, reason) => {
            throw new MailError(`${reason} Rien n’a été modifié : applique la modification au texte actuel `
              + '(details.current), puis renvoie-la avec sa version.', { code, details: { current: publicDraft(view) } });
          };
          if (!update.version) refuse('DRAFT_VERSION_REQUIRED', 'Version du brouillon manquante.');
          if (update.version !== view.version) {
            refuse('DRAFT_CHANGED', 'Le brouillon a changé depuis cette version (retouché dans un client mail ?).');
          }
          if (update.bodyReplaced && !update.wholeBody && !view.quoted && view.reply) {
            throw new MailError('Historique cité introuvable dans ce brouillon de réponse : rien n’a été modifié. '
              + 'wholeBody: true remplace tout le corps, historique compris.', {
              code: 'DRAFT_HISTORY_NOT_FOUND', details: { current: publicDraft(view) },
            });
          }
          const revision = this.#revisedDraft(account, parsed, view, update);
          message = revision.message;
          const raw = await buildRawMessage(message);
          appending = true;
          // A new Message-ID: no need to look for it before the append.
          const saved = await this.#appendInLock(client, folder, DRAFTS_FOLDER, raw, message, { fresh: true });
          // The new version is stored: from here on, nothing may throw, or a
          // caller could save a third copy.
          const previous = await this.#deleteQuietly(client, account, number);
          return {
            account: account.id,
            messageId: message.messageId,
            mailbox: folder,
            uid: Number(saved.uid || 0),
            version: this.#draftView(account, composedAsParsed(message)).version,
            sent: false,
            seen: false,
            bodyReplaced: update.bodyReplaced,
            ...(update.bodyReplaced ? { historyKept: revision.historyKept } : {}),
            previous,
          };
        } finally {
          lock.release();
        }
      });
    } catch (error) {
      // Nothing was written before the append: the draft is unchanged.
      await audit(appending ? 'failed' : 'failed-before-append');
      throw error;
    }
    await audit(result.previous.deleted ? 'draft-updated' : 'draft-updated-previous-kept');
    return result;
  }

  /** Mark one message as read (`seen: true`) or unread: the only flag a caller sets. */
  async setSeen(id = '', mailbox = 'INBOX', uid, seen = true) {
    this.#assertWrites('imap');
    if (typeof seen !== 'boolean') throw new MailError('L’état lu doit valoir true ou false.');
    const folder = requiredText(mailbox, 'Le dossier IMAP', 255);
    const number = uidNumber(uid);
    const account = await this.#resolve(id);
    const audit = (outcome) => this.#record(account, seen ? 'mark-read' : 'mark-unread', null, outcome);
    try {
      await this.#withImap(account, async (client) => {
        const lock = await client.getMailboxLock(folder, { acquireTimeout: this.timeout });
        try {
          const found = await client.fetchOne(number, { uid: true, flags: true }, { uid: true });
          if (!found) throw new MailError(`Message IMAP introuvable : UID ${number}.`);
          const done = seen
            ? await client.messageFlagsAdd(number, ['\\Seen'], { uid: true })
            : await client.messageFlagsRemove(number, ['\\Seen'], { uid: true });
          if (done === false) throw new MailError(`Le serveur IMAP a refusé de changer l’état lu du message UID ${number}.`);
        } finally {
          lock.release();
        }
      });
    } catch (error) {
      await audit('failed');
      throw error;
    }
    await audit(seen ? 'marked-read' : 'marked-unread');
    return { account: account.id, mailbox: folder, uid: number, seen };
  }

  #assertWrites(kind) {
    if (this.#allowWrites) return;
    throw new MailError(kind === 'smtp'
      ? 'Envoi SMTP refusé : utilise allowWrites=true.'
      : 'Écriture IMAP refusée : utilise allowWrites=true.');
  }

  #domainAllowed(account) {
    return !this.#allowedDomains.length || this.#allowedDomains.includes(account.address.split('@').pop());
  }

  async #resolve(id = '') {
    await this.authorize();
    if (!this.#accounts.length) {
      throw new MailError(`Aucune boîte SMTP/IMAP configurée.${this.#configureHint ? ` ${this.#configureHint}` : ''}`);
    }
    const wanted = String(id || '').trim().toLowerCase();
    const found = wanted
      ? this.#accounts.find((item) => item.id === wanted)
      : this.#accounts.find((item) => item.default);
    if (!found) throw new MailError(`Boîte mail inconnue : ${wanted || '(défaut)'}.`);
    if (!this.#domainAllowed(found)) {
      throw new MailError(`Adresse hors des domaines autorisés : ${found.address}. Domaines : ${this.#allowedDomains.join(', ')}.`);
    }
    return found;
  }

  async #withImap(account, run) {
    let client;
    try {
      client = await this.#imapFactory(imapOptions(account, this.timeout));
      await client.connect();
      return await run(client);
    } catch (error) {
      throw failure(error, [account]);
    } finally {
      if (client) {
        try { await client.logout(); } catch { closeQuietly(client); }
      }
    }
  }

  /** The path of the `target` special folder, or '' when the server has none. */
  async #findFolder(client, target) {
    const folders = await client.list({ listOnly: true });
    const found = folders.find((folder) => String(folder.specialUse || '') === target.specialUse)
      || folders.find((folder) => target.names.test(String(folder.name || folder.path || '').trim()));
    return found ? String(found.path || found.name || '') : '';
  }

  /** Metadata and parsed source of `number`, in the folder the caller has locked. */
  async #fetchParsed(client, number) {
    const metadata = await client.fetchOne(number, { uid: true, envelope: true, flags: true, size: true }, { uid: true });
    if (!metadata) throw new MailError(`Message IMAP introuvable : UID ${number}.`);
    if (Number(metadata.size || 0) > this.maxMessageBytes) {
      throw new MailError(`Message trop volumineux (${metadata.size} octets, limite ${this.maxMessageBytes}).`);
    }
    const raw = await client.fetchOne(number, { source: { maxLength: this.maxMessageBytes + 1 } }, { uid: true });
    if (!raw || !Buffer.isBuffer(raw.source)) {
      throw new MailError(`Source du message IMAP indisponible : UID ${number}.`);
    }
    if (raw.source.length > this.maxMessageBytes) {
      throw new MailError(`Message trop volumineux (limite ${this.maxMessageBytes} octets).`);
    }
    return { metadata, parsed: await this.#parser(raw.source, { keepCidLinks: true }) };
  }

  /** Append `raw` to the `target` folder unless its Message-ID is already there. */
  async #appendOnce(account, target, raw, message) {
    return this.#withImap(account, async (client) => {
      const folder = await this.#findFolder(client, target);
      if (!folder) throw new MailError(`Aucun dossier IMAP « ${target.label} » n’a été trouvé.`);
      const lock = await client.getMailboxLock(folder, { acquireTimeout: this.timeout });
      try {
        return await this.#appendInLock(client, folder, target, raw, message);
      } finally {
        lock.release();
      }
    });
  }

  async #appendInLock(client, folder, target, raw, { messageId, date }, { fresh = false } = {}) {
    const find = async () => (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
    const existing = fresh ? [] : await find();
    if (existing.length) return { mailbox: folder, uid: existing.at(-1), added: false };
    let appended;
    try {
      appended = await client.append(folder, raw, [...target.flags], date);
    } catch (error) {
      // The server may have stored the message before the connection failed.
      const recovered = await find();
      if (recovered.length) return { mailbox: folder, uid: recovered.at(-1), added: true };
      throw error;
    }
    const verified = appended?.uid ? [appended.uid] : await find();
    if (!verified.length) {
      throw new MailError(`Le message reste introuvable dans « ${target.label} » après ajout IMAP.`);
    }
    return { mailbox: folder, uid: verified.at(-1), added: true };
  }

  /**
   * Delete `number` from the locked folder, reporting instead of throwing.
   * UID EXPUNGE removes that message only. Without UIDPLUS, a plain EXPUNGE
   * would also remove every message flagged \Deleted by someone else: the
   * message is then only flagged, and the mail client expunges it later.
   */
  async #deleteQuietly(client, account, number) {
    const expunge = Boolean(client.capabilities?.has?.('UIDPLUS'));
    try {
      const done = expunge
        ? await client.messageDelete(number, { uid: true })
        : await client.messageFlagsAdd(number, ['\\Deleted'], { uid: true });
      if (done === false) throw new MailError(`Le serveur IMAP a refusé de supprimer l’ancienne version (UID ${number}).`);
      return { uid: number, deleted: true, expunged: expunge };
    } catch (error) {
      return { uid: number, deleted: false, expunged: false, error: redactError(error, [account]) };
    }
  }

  // Counts only: never a subject, a body, an address or a file name. A flag
  // change has no message to count.
  async #record(account, operation, message, outcome) {
    if (!this.#audit) return;
    try {
      await this.#audit(Object.freeze({
        connector: 'mail',
        account: account.id,
        operation,
        ...(message ? {
          toCount: message.to.length,
          ccCount: message.cc.length,
          bccCount: message.bcc.length,
          attachmentCount: message.attachments.length,
        } : {}),
        outcome,
      }));
    } catch {
      // The write already happened or was refused: a failing journal must not
      // turn it into an error that invites a second send.
    }
  }

  #draftView(account, parsed) {
    return draftView(parsed, { signatureText: htmlToPlainText(account.signatureHtml), markText: this.#mark?.text || '' });
  }

  /**
   * The new version of a draft: what `update` leaves undefined comes from the
   * stored draft, attachments included. A replaced body is composed again, and
   * an inline image it no longer shows leaves with the old body.
   */
  #revisedDraft(account, parsed, view, update) {
    const inReplyTo = String(parsed.inReplyTo || '').trim();
    const references = referenceList(parsed.references);
    let kept = (parsed.attachments || []).filter((item) => Buffer.isBuffer(item.content)).map(keptAttachment);
    let bodies;
    let historyKept = false;
    if (update.bodyReplaced) {
      const history = update.wholeBody ? null : view.quoted;
      historyKept = Boolean(history);
      bodies = composeBodies(account, { text: update.text, html: update.html, quote: history }, this.#mark);
      kept = kept.filter((item) => item.contentDisposition !== 'inline' || bodies.html.includes(`cid:${item.cid}`));
    } else {
      bodies = { text: String(parsed.text || ''), html: typeof parsed.html === 'string' ? parsed.html : '' };
    }
    const message = this.#compose(account, {
      to: update.to ?? view.to,
      cc: update.cc ?? view.cc,
      bcc: update.bcc ?? view.bcc,
      subject: update.subject ?? view.subject,
      attachments: update.attachments,
      inReplyTo,
      references,
    }, { draft: true, bodies, kept });
    return { message, historyKept };
  }

  /**
   * `bodies` skips the composition (a draft whose body stays as stored);
   * `kept` are attachments already in that draft, outside the limit on new ones.
   */
  #compose(account, {
    to = [], cc = [], bcc = [], subject, text = '', html = '', attachments = [],
    inReplyTo = '', references = [], quote = null, messageId = '',
  } = {}, { draft = false, bodies = null, kept = [] } = {}) {
    const target = recipients(to, 'Destinataire');
    // A draft is finished in the mail client: recipients may come later.
    if (!target.length && !draft) throw new MailError('Au moins un destinataire est requis.');
    const copies = recipients(cc, 'Copie');
    const hidden = recipients(bcc, 'Copie cachée');
    const title = requiredText(subject, 'L’objet du mail', 500);
    if (!bodies && !String(text || '') && !String(html || '')) throw new MailError('Le corps du mail est vide.');
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
      throw new MailError(`Au maximum ${MAX_ATTACHMENTS} pièces jointes peuvent être envoyées.`);
    }
    if (!Array.isArray(references)) throw new MailError('Les références doivent former une liste.');
    const composed = bodies || composeBodies(account, { text, html, quote }, this.#mark);
    if (messageId && !/^<[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+>$/.test(messageId)) {
      throw new MailError('Message-ID invalide.');
    }
    return {
      from: { name: account.label, address: account.address },
      to: target,
      cc: copies,
      bcc: hidden,
      subject: title,
      text: composed.text,
      ...(composed.html ? { html: composed.html } : {}),
      attachments: [...kept, ...(bodies ? [] : quote?.images || []), ...attachments],
      date: new Date(),
      messageId: messageId || generatedMessageId(account),
      ...(this.#mark?.header ? { headers: { [this.#mark.header.name]: this.#mark.header.value } } : {}),
      ...(inReplyTo ? { inReplyTo: String(inReplyTo).slice(0, 1000) } : {}),
      ...(references.length ? { references: references.map(String).slice(0, 100) } : {}),
    };
  }

  async #send(id, input, operation) {
    const account = await this.#resolve(id);
    const message = this.#compose(account, input);
    const audit = (outcome) => this.#record(account, operation, message, outcome);
    let raw;
    try {
      raw = await buildRawMessage(message);
    } catch (error) {
      await audit('failed-before-smtp');
      throw failure(error, [account]);
    }
    let result;
    let transport;
    try {
      transport = await this.#smtpFactory(smtpOptions(account, this.timeout));
      result = await transport.sendMail(message);
    } catch (error) {
      await audit('failed');
      throw failure(error, [account]);
    } finally {
      closeQuietly(transport);
    }
    // Accepted by SMTP: from here on, nothing may throw, or a caller could
    // send the same mail twice.
    let archive = null;
    let archiveError = '';
    try {
      archive = await this.#appendOnce(account, SENT_FOLDER, raw, message);
    } catch (error) {
      archiveError = redactError(error, [account]);
    }
    await audit(archive ? 'accepted-archived' : 'accepted-unarchived');
    return {
      account: account.id,
      messageId: message.messageId,
      accepted: Array.isArray(result?.accepted) ? result.accepted.length : message.to.length,
      rejected: Array.isArray(result?.rejected) ? result.rejected.length : 0,
      archived: Boolean(archive),
      archiveMailbox: archive ? archive.mailbox : '',
      archiveUid: archive ? Number(archive.uid || 0) : 0,
      ...(archiveError ? { archiveError } : {}),
    };
  }

  async #saveDraft(id, input, operation) {
    const account = await this.#resolve(id);
    const message = this.#compose(account, input, { draft: true });
    const audit = (outcome) => this.#record(account, operation, message, outcome);
    let raw;
    try {
      raw = await buildRawMessage(message);
    } catch (error) {
      await audit('failed-before-imap');
      throw failure(error, [account]);
    }
    let saved;
    try {
      saved = await this.#appendOnce(account, DRAFTS_FOLDER, raw, message);
    } catch (error) {
      await audit('failed');
      throw error;
    }
    await audit('draft-saved');
    return {
      account: account.id,
      messageId: message.messageId,
      mailbox: saved.mailbox,
      uid: Number(saved.uid || 0),
      version: this.#draftView(account, composedAsParsed(message)).version,
      to: message.to,
      sent: false,
    };
  }

  async #replyInput(id, mailbox, uid, input, { draft = false } = {}) {
    const named = input.to != null && !(Array.isArray(input.to) && !input.to.length);
    // A send stays explicit: an untrusted Reply-To must not choose the
    // recipient of a message no one reviewed. A draft is reviewed before it leaves.
    if (!named && !draft) {
      throw new MailError('Une réponse envoyée exige son destinataire (to) : seul un brouillon de réponse le reprend du message.');
    }
    const { metadata, parsed } = await this.parsedMessage(id, mailbox, uid);
    const envelope = metadata.envelope || {};
    const messageId = String(parsed.messageId || envelope.messageId || '').trim();
    if (!messageId) throw new MailError('Ce message ne possède pas de Message-ID utilisable pour une réponse.');
    const { address } = await this.#resolve(id);
    return {
      ...input,
      to: named ? input.to : replyRecipients(parsed, address),
      subject: replySubject(envelope.subject),
      inReplyTo: messageId,
      references: [...referenceList(parsed.references), messageId].slice(-100),
      quote: await quotedMessage(metadata, parsed, address.split('@').pop()),
    };
  }
}
