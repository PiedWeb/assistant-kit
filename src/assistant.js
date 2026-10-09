import fs from 'node:fs';
import path from 'node:path';
import { CadrankClient } from './cadrank.js';
import {
  parseArguments, positiveInteger, print, printPublication, readStdin, requireArguments, requireFlag,
} from './cli.js';
import { pagesFromHookPayload, runSyncHook } from './pushword/hook.js';
import { probeConnector } from './secrets/probes.js';
import { configureVault } from './secrets/server.js';

const MAIL_WRITES = Object.freeze(['draft', 'draft-reply', 'send', 'reply']);

/**
 * The `bin/assistant.js` of a content workspace: doctor, vault, pushword,
 * media, redirection, cadrank and mail commands over the library's
 * connectors. A project passes its configuration and may add scopes
 * (`commands`), add actions to a scope (`actions.pushword[...]`) or doctor
 * lines; a built-in action is replaced by declaring one with the same name.
 *
 * Options:
 *   name, cli ('node bin/assistant.js'), root, hosts
 *   createVault(): the project vault (catalog, keychain, sources)
 *   createWorkspace({ vault, requireToken }): a ContentWorkspace
 *   brand, configureHint: for `vault configure`
 *   cadrank: { instances: { fr: { baseUrl, keyField } }, defaultInstance, userAgent } or null
 *   createMailClient({ vault, allowWrites }) or null; mailWriteRule: the
 *     sentence telling who may allow a mailbox write
 *   help: extra help lines; commands: { scope: handler }; actions: { scope: { action: handler } }
 *   doctor: [async ({ vault }) => [label, value]]
 *   stdout, stderr, stdin, argv
 */
export async function runAssistant(options) {
  const settings = {
    cli: 'node bin/assistant.js',
    cadrank: null,
    createMailClient: null,
    mailWriteRule: 'à n’ajouter qu’à la demande explicite de l’utilisateur',
    help: '',
    commands: {},
    actions: {},
    doctor: [],
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    argv: process.argv.slice(2),
    ...options,
  };
  try {
    await dispatch(settings);
  } catch (error) {
    settings.stderr.write(`✗ ${error.message}\n`);
    process.exitCode = process.exitCode || 1;
  }
}

async function dispatch(settings) {
  const { positionals, flags } = parseArguments(settings.argv);
  const [scope, action, ...args] = positionals;
  const out = (value) => print(value, settings.stdout);
  if (!scope || scope === 'help' || flags.help) {
    settings.stdout.write(helpText(settings));
    return;
  }
  const scopes = {
    doctor,
    vault: vaultCommand,
    pushword: pushwordCommand,
    media: mediaCommand,
    redirection: redirectionCommand,
    ...(settings.cadrank ? { cadrank: cadrankCommand } : {}),
    ...(settings.createMailClient ? { mail: mailCommand } : {}),
    ...settings.commands,
  };
  if (!Object.hasOwn(scopes, scope)) {
    throw new Error(`Commande inconnue : ${scope}. Voir ${settings.cli} help.`);
  }
  const context = {
    settings, action, args, flags, out,
    usage: (count, usage) => requireArguments(args, count, usage, settings.cli),
    get vault() {
      return (this.cachedVault ??= settings.createVault());
    },
  };
  const extra = settings.actions[scope];
  if (extra && Object.hasOwn(extra, action || '')) {
    await extra[action](context);
    return;
  }
  await scopes[scope](context);
}

function helpText(settings) {
  const { cli } = settings;
  const lines = [
    `${settings.name || 'Assistant'}`,
    '',
    `Usage : ${cli} <commande>`,
    '',
    '  doctor',
    '  vault status | list',
    '  vault check <connecteur> [--live] | vault check --all [--live]',
    '  vault configure [connecteur] [--no-open]',
    '  vault set <NOM>                      valeur lue sur l’entrée standard',
    '  vault migrate <fichier .env> [--dry-run]',
    '  vault migrate-keychain               valeurs du format 0.1 vers le format partagé',
    '',
    '  pushword whoami | docs',
    '  pushword pull [hôte ...]             remplace content/{hôte}/ par la production',
    '  pushword sync <content/{hôte}/{slug}.md ...> [--no-publish]',
    '  pushword sync-all [--no-publish]     pages modifiées depuis le dernier pull',
    '  pushword sync-hook                   hook PostToolUse (Claude Code, Codex)',
    '  pushword create <content/{hôte}/{slug}.md> [--no-publish]',
    '  pushword delete <hôte> <slug> --redirect-to </cible> [--code 301]',
    '  pushword static-status <hôte> | static-generate <hôte> | static-page <hôte> <slug>',
    '  pushword api <GET|POST|PUT|PATCH|DELETE> </api/chemin> [--body-file fichier]',
    '',
    '  media list [--q texte] [--tag tag] | get <fichier>',
    '  media upload <fichier> [--name nom] [--alt texte]',
    '  media update <fichier> --json <changements.json> | delete <fichier>',
    '',
    '  redirection list [--host hôte] | get <hôte> <slug>',
    '  redirection create <hôte> <slug> --to </cible> [--code 301]',
    '  redirection update <hôte> <slug> --to </cible> [--code 301] | delete <hôte> <slug>',
  ];
  if (settings.cadrank) {
    const instances = Object.keys(settings.cadrank.instances);
    const choice = instances.length > 1 ? ` [--instance ${instances.join('|')}]` : '';
    lines.push('', `  cadrank projects | crawls | mapping <hôte> | export <crawl> [--all]${choice}`,
      `  cadrank for-url <url> | targets <url> | related|serp|serp-content|semantic <mot-clé>${choice}`);
  }
  if (settings.createMailClient) {
    lines.push('',
      '  mail verify | accounts | folders                    [--account id] sur chaque commande mail',
      '  mail list [--folder INBOX] [--limit 25] [--unread] [--query texte]',
      '  mail read <uid> [--folder INBOX]     lecture seule, rien n’est marqué comme lu',
      '  mail attachment <uid> <numéro> --to <fichier|dossier> [--overwrite]',
      '  mail draft --to a,b --subject <texte> --text-file <f> [--html-file f] [--cc] [--bcc] [--attach f1,f2] --allow-writes',
      '  mail draft-reply <uid> --text-file <f> [--folder INBOX] --allow-writes',
      '  mail send ...mêmes options que draft... --allow-writes',
      '  mail reply <uid> --text-file <f> [--folder INBOX] --allow-writes');
  }
  if (settings.help) lines.push('', settings.help.replace(/\n+$/, ''));
  lines.push('', 'Toute mutation de la production et toute écriture dans la boîte exigent une demande explicite.',
    'Un brouillon attend dans « Brouillons » ; send et reply envoient le message.', '');
  return lines.join('\n');
}

async function doctor({ settings, vault }) {
  const states = vault.status();
  const backend = vault.backend();
  const lines = [
    ['Trousseau', backend.available ? `helper ${backend.helper}` : backend.detail],
    ...states.map((state) => [state.label, state.ready ? 'configuré'
      : `${state.optional ? 'facultatif, ' : ''}incomplet (${[...state.missing, ...state.invalid].join(', ')})`]),
  ];
  if (settings.createWorkspace) {
    const workspace = settings.createWorkspace({ vault, requireToken: false });
    const marker = workspace.marker;
    let mirror = 'jamais tiré';
    if (marker && fs.existsSync(marker)) {
      mirror = `tiré le ${fs.statSync(marker).mtime.toLocaleString('fr-FR')}`;
      const pending = workspace.modifiedSincePull().length;
      if (pending) mirror += `, ${pending} page(s) modifiée(s) depuis`;
    }
    lines.unshift(['API Pushword', workspace.client.baseUrl]);
    lines.push(['Miroir content/', mirror]);
  }
  for (const line of settings.doctor) lines.push(await line({ vault }));
  for (const [name, value] of lines) settings.stdout.write(`${String(name).padEnd(22)} ${value}\n`);
}

async function vaultCommand({ settings, vault, action, args, flags, out, usage }) {
  const catalog = vault.catalog;
  if (action === 'status') return out({ backend: vault.backend(), connectors: vault.status() });
  if (action === 'list') {
    return out(Object.entries(catalog).map(([id, item]) => ({ id, label: item.label, description: item.description,
      fields: item.fields.map((entry) => ({ name: entry.name, label: entry.label, secret: entry.secret, required: entry.required })) })));
  }
  if (action === 'check') {
    if (!flags.all) usage(1, 'vault check <connecteur> [--live] | vault check --all [--live]');
    const states = vault.status().filter((state) => flags.all || state.id === args[0]);
    if (!states.length) throw new Error('Connecteur inconnu. Voir vault list.');
    const results = await Promise.all(states.map(async (state) => ({
      id: state.id, label: state.label, missing: state.missing, invalid: state.invalid,
      ...(flags.live ? await probeConnector(catalog, state.id, vault.values(state.id))
        : { status: state.ready ? 'ready' : 'unconfigured' }),
    })));
    out(results);
    if (results.some((result) => ['failed', 'unknown', 'unconfigured'].includes(result.status))) process.exitCode = 2;
    return undefined;
  }
  if (action === 'configure') {
    return configureVault({ vault, selectedId: args[0] || Object.keys(catalog)[0], open: !flags['no-open'],
      brand: settings.brand, configureHint: settings.configureHint });
  }
  if (action === 'set') {
    usage(1, 'vault set <NOM> < fichier');
    const value = (await readStdin(settings.stdin)).trim();
    if (!value) throw new Error('Valeur attendue sur l’entrée standard (jamais en argument).');
    const { shadowed } = vault.set(args[0], value);
    settings.stdout.write(`✓ ${args[0]} enregistré dans le trousseau${shadowed.length ? ' (masqué par une source prioritaire : environnement, systemd...)' : ''}\n`);
    return undefined;
  }
  if (action === 'migrate-keychain') return out(vault.migrateKeychain());
  if (action === 'migrate') {
    usage(1, 'vault migrate <fichier .env> [--dry-run]');
    return out(vault.migrate(path.resolve(args[0]), { dryRun: Boolean(flags['dry-run']) }));
  }
  throw new Error(`Commande vault inconnue : ${action || ''}`);
}

async function pushwordCommand(context) {
  const { settings, vault, action, args, flags, out, usage } = context;
  if (action === 'sync-hook') return syncHook(context);
  const workspace = settings.createWorkspace({ vault });
  const client = workspace.client;
  const publish = !flags['no-publish'];
  const stdout = settings.stdout;

  if (action === 'whoami') return out(await client.whoami());
  if (action === 'docs') return out(await client.docs());
  if (action === 'pull') {
    for (const destination of await workspace.pull(args.length ? args : settings.hosts)) {
      stdout.write(`✓ ${path.basename(destination)} → ${path.relative(settings.root || process.cwd(), destination)}\n`);
    }
    return undefined;
  }
  if (action === 'sync' || action === 'sync-all') {
    if (action === 'sync') usage(1, 'pushword sync <fichier ...>');
    const files = action === 'sync' ? args.map((file) => path.resolve(file)) : workspace.modifiedSincePull();
    if (!files.length) {
      stdout.write('Aucune page modifiée depuis le dernier pull.\n');
      return undefined;
    }
    // A file named on the command line is pushed on purpose, whatever its host.
    const { results, ok } = await workspace.sync(files, { publish, anyHost: action === 'sync' });
    printPublication(results.map((result) => result.static), stdout);
    for (const result of results.filter((entry) => entry.status !== 'synced')) {
      settings.stderr.write(`✗ ${result.file ? path.relative(process.cwd(), result.file) : ''} : ${result.message || result.status}\n`);
    }
    if (!ok) process.exitCode = 2;
    return undefined;
  }
  if (action === 'create') {
    usage(1, 'pushword create <fichier>');
    const page = await workspace.create(path.resolve(args[0]), { publish });
    stdout.write(`✓ ${page.host}/${page.slug} créé${publish ? ', génération de l’hôte lancée' : ''}\n`);
    return undefined;
  }
  if (action === 'delete') {
    usage(2, 'pushword delete <hôte> <slug> --redirect-to </cible>');
    return out(await workspace.delete(args[0], args[1], {
      redirectTo: requireFlag(flags, 'redirect-to'), code: positiveInteger(flags.code, 301), publish,
    }));
  }
  if (action === 'static-status') {
    usage(1, 'pushword static-status <hôte>');
    return out(await client.staticStatus(args[0]));
  }
  if (action === 'static-generate') {
    usage(1, 'pushword static-generate <hôte>');
    return out(await client.triggerStatic(args[0]));
  }
  if (action === 'static-page') {
    usage(2, 'pushword static-page <hôte> <slug>');
    return printPublication([await client.generatePage(args[0], args[1])], stdout);
  }
  if (action === 'api') {
    usage(2, 'pushword api <MÉTHODE> </api/chemin>');
    const body = flags['body-file'] ? readBody(flags['body-file']) : undefined;
    return out(await client.request(args[0], args[1], { body }));
  }
  throw new Error(`Commande pushword inconnue : ${action || ''}`);
}

// Runs after every Write/Edit: stay silent for files outside content/, and
// answer 2 on any failure so Claude Code shows it to the model.
async function syncHook({ settings, vault }) {
  const payload = await readStdin(settings.stdin);
  if (!pagesFromHookPayload(settings.createWorkspace({ vault, requireToken: false }), payload).length) return;
  try {
    process.exitCode = await runSyncHook(settings.createWorkspace({ vault }), payload);
  } catch (error) {
    settings.stderr.write(`✗ synchro Pushword impossible : ${error.message}\n`);
    process.exitCode = 2;
  }
}

async function mediaCommand({ settings, vault, action, args, flags, out, usage }) {
  const client = settings.createWorkspace({ vault }).client;
  if (action === 'list') return out(await client.listMedia({ q: flags.q, tag: flags.tag, mimeType: flags['mime-type'] }));
  usage(1, `media ${action || '<action>'} <fichier>`);
  if (action === 'get') return out(await client.getMedia(args[0]));
  if (action === 'upload') {
    out(await client.uploadMedia(args[0], { filename: flags.name, alt: flags.alt }));
  } else if (action === 'update') {
    out(await client.updateMedia(args[0], JSON.parse(fs.readFileSync(requireFlag(flags, 'json'), 'utf8'))));
  } else if (action === 'delete') {
    await client.deleteMedia(args[0]);
    settings.stdout.write(`✓ média ${args[0]} supprimé\n`);
  } else {
    throw new Error(`Commande media inconnue : ${action}`);
  }
  // A media change can touch any page: regenerate every host.
  return out(await client.triggerStaticAll());
}

async function redirectionCommand({ settings, vault, action, args, flags, out, usage }) {
  const client = settings.createWorkspace({ vault }).client;
  if (action === 'list') return out(await client.listRedirections({ host: flags.host }));
  usage(2, `redirection ${action || '<action>'} <hôte> <slug>`);
  const [host, slug] = args;
  if (action === 'get') return out(await client.getRedirection(host, slug));
  const target = () => ({ redirectTo: requireFlag(flags, 'to'), code: positiveInteger(flags.code, 301) });
  if (action === 'create') {
    out(await client.createRedirection(host, { slug, ...target() }));
  } else if (action === 'update') {
    out(await client.updateRedirection(host, slug, target()));
  } else if (action === 'delete') {
    await client.deleteRedirection(host, slug);
    settings.stdout.write(`✓ redirection ${host}/${slug} supprimée\n`);
  } else {
    throw new Error(`Commande redirection inconnue : ${action}`);
  }
  // Redirections live in the generated .htaccess: regenerate the host.
  return out(await client.triggerStatic(host));
}

async function cadrankCommand({ settings, vault, action, args, flags, out, usage }) {
  const { instances, defaultInstance = Object.keys(instances)[0], userAgent } = settings.cadrank;
  const name = flags.instance || defaultInstance;
  if (!Object.hasOwn(instances, name)) {
    throw new Error(`Instance Cadrank inconnue : ${name}. Choix : ${Object.keys(instances).join(', ')}.`);
  }
  const instance = instances[name];
  const client = new CadrankClient({
    instance: name, baseUrl: instance.baseUrl, apiKey: vault.credential(instance.keyField || 'CADRANK_API_KEY'), userAgent,
  });
  const keyword = args.join(' ');
  const calls = {
    projects: () => client.projects(),
    crawls: () => client.crawls(),
    mapping: () => client.mapping(args[0]),
    export: () => client.crawlExport(args[0], { all: Boolean(flags.all) }),
    'for-url': () => client.keywordsForUrl(args[0]),
    targets: () => client.targets(args[0]),
    related: () => client.related(keyword),
    serp: () => client.serp(keyword),
    'serp-content': () => client.serpContent(keyword),
    semantic: () => client.semantic(keyword),
  };
  if (!Object.hasOwn(calls, action || '')) throw new Error(`Commande cadrank inconnue : ${action || ''}`);
  if (!['projects', 'crawls'].includes(action)) usage(1, `cadrank ${action} <argument>`);
  return out(await calls[action]());
}

async function mailCommand({ settings, vault, action, args, flags, out, usage }) {
  const writes = MAIL_WRITES.includes(action);
  if (writes && flags['allow-writes'] !== true) {
    throw new Error(`Écriture dans la boîte refusée sans --allow-writes, ${settings.mailWriteRule}.`);
  }
  const client = settings.createMailClient({ vault, allowWrites: writes });
  const account = flags.account && flags.account !== true ? flags.account : '';
  const mailbox = flags.folder || 'INBOX';
  const uid = () => {
    usage(1, `mail ${action} <uid>`);
    return positiveInteger(args[0]);
  };
  const body = () => ({
    text: flags['text-file'] ? fs.readFileSync(flags['text-file'], 'utf8') : '',
    html: flags['html-file'] ? fs.readFileSync(flags['html-file'], 'utf8') : '',
    attachments: list(flags.attach).map((file) => ({ filename: path.basename(file), content: fs.readFileSync(file) })),
  });
  const message = () => ({
    to: list(flags.to), cc: list(flags.cc), bcc: list(flags.bcc), subject: requireFlag(flags, 'subject'), ...body(),
  });
  const calls = {
    verify: () => client.verify(account),
    accounts: () => client.accounts(),
    folders: () => client.folders(account),
    list: () => client.messages(account, {
      mailbox, limit: positiveInteger(flags.limit, 25), unreadOnly: Boolean(flags.unread), query: flags.query || '',
    }),
    read: () => client.message(account, mailbox, uid()),
    attachment: () => {
      usage(2, 'mail attachment <uid> <numéro> --to <fichier|dossier>');
      return client.saveAttachment(account, mailbox, positiveInteger(args[0]), args[1], path.resolve(requireFlag(flags, 'to')),
        { overwrite: Boolean(flags.overwrite) });
    },
    draft: () => client.saveDraft(account, message()),
    send: () => client.send(account, message()),
    'draft-reply': () => client.replyDraft(account, mailbox, uid(), body()),
    reply: () => client.reply(account, mailbox, uid(), body()),
  };
  if (!Object.hasOwn(calls, action || '')) throw new Error(`Commande mail inconnue : ${action || ''}`);
  return out(await calls[action]());
}

function list(value) {
  return value && value !== true ? String(value).split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function readBody(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
