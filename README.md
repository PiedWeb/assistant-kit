# assistant-kit

Connecteurs partagés des ateliers « Assistant » de Pied Web : le code que
`altimood/Assistant`, `piedweb.com/Assistant` et le tronc commun de Grand Angle
réécrivaient chacun de leur côté. Chaque projet garde sa configuration (hôtes,
noms de credentials, textes, règles) et importe ici le comportement ; ses
particularités se branchent par options, hooks ou sous-classes, jamais par une
copie du code.

| Module | Contenu |
| --- | --- |
| `@piedweb/assistant-kit/assistant` | `runAssistant()` : tout le `bin/assistant.js` d'un atelier (doctor, vault, pushword, media, redirection, cadrank, mail), extensible par commandes |
| `@piedweb/assistant-kit/http` | `HttpClient` : `fetch` injectable, jeton fixe ou fonction, nouvelles tentatives avec gigue et `Retry-After`, jamais sur une écriture non idempotente, aucun secret envoyé à une autre origine sur redirection, `exchange()` sans exception sur le statut |
| `@piedweb/assistant-kit/pushword` | `PushwordClient` (API `pushword/api`), `ContentWorkspace` (miroir local, pull, synchro, création, suppression, statique), hook `PostToolUse` |
| `@piedweb/assistant-kit/secrets` | trousseau système au format du tronc commun Grand Angle, vault (environnement, systemd, sources du projet, trousseau, défaut), formulaire web local, sondes en lecture seule |
| `@piedweb/assistant-kit/cadrank` | client Cadrank (SERP, mots-clés liés, crawls mémorisés), lancement de crawl audité sur autorisation |
| `@piedweb/assistant-kit/mail` | `MailClient` IMAP et SMTP : lecture seule par défaut, brouillons, envois et réponses sous `allowWrites` |
| `@piedweb/assistant-kit/audit` | journal JSONL des écritures, sans contenu ni secret |
| `@piedweb/assistant-kit/cli` | analyse des arguments, `@fichier` JSON, listes, `runCli` |

## Installation

Épingler un tag, jamais une branche :

```json
"dependencies": {
  "@piedweb/assistant-kit": "git+https://github.com/PiedWeb/assistant-kit.git#v0.2.0"
}
```

`package-lock.json` retient le commit, `npm ci` le rejoue (sans clé SSH). Node
22.12 ou plus : le paquet est en ESM et se charge aussi par `require()` depuis
du CommonJS (`npm run check` le vérifie pour chaque point d'entrée).

## Un atelier en vingt lignes

```js
import { runAssistant } from '@piedweb/assistant-kit/assistant';

await runAssistant({
  name: 'Mon Assistant',
  root: ROOT,
  hosts: HOSTS,
  createVault: () => createProjectVault(),            // catalogue + trousseau du projet
  createWorkspace,                                     // ({ vault, requireToken }) => ContentWorkspace
  cadrank: { instances: { fr: { baseUrl: 'https://cadrank.example' } } },
  createMailClient,                                    // ({ vault, allowWrites }) => MailClient
  mailWriteRule: 'à n’ajouter qu’à la demande explicite de Robin',
  commands: { docs: async ({ action, out }) => { /* commande propre au projet */ } },
  actions: { pushword: { 'context-pull': async (context) => { /* action ajoutée */ } } },
});
```

## Éditer des pages Pushword

```js
import { ContentWorkspace, PushwordClient, runSyncHook } from '@piedweb/assistant-kit/pushword';

const client = new PushwordClient({ baseUrl: 'https://edit.example.com', token });
const workspace = new ContentWorkspace({ root: projectDir, client, hosts: ['example.com'] });

await workspace.pull();                         // content/{host}/*.md, chaque page porte sa revision:
await workspace.sync([file], { anyHost: true }); // PUT + If-Match, texte canonique réécrit, page régénérée
await workspace.syncAll();                      // pages en attente des hôtes du projet
await workspace.create(newFile);                // POST d'une page sans revision
await workspace.delete('example.com', 'old', { redirectTo: '/new' });
process.exitCode = await runSyncHook(workspace, stdinPayload); // hook Claude Code ou Codex
```

La production fait foi. Un 409 remplace le fichier local par la version du
serveur : réappliquer la modification sur ce texte, jamais forcer. Un dépôt Git
privé dans `content/` garde l'état du dernier pull ou de la dernière synchro ;
un nouveau pull refuse d'écraser une modification qui n'a pas atteint le
serveur, et `git -C content diff last-pull` montre tout ce qui a changé depuis
le pull. Le hook et `syncAll()` ne poussent que les hôtes du projet ; un
fichier nommé exprès (`anyHost: true`) part quel que soit son hôte. Le
snapshot n'installe que les `.md`, `redirection.csv` et les `index*.csv`, jamais
`AGENTS.md` ni `CLAUDE.md`. `onPulled({ host, directory })` ajoute une étape
propre au projet après chaque pull.

## Secrets

```js
import { connector, createKeychain, createVault, defineCatalog, field, pushwordProbe, sharedKeychainSource } from '@piedweb/assistant-kit/secrets';

const catalog = defineCatalog({
  pushword: connector('Pushword', 'Pages et médias.', [field('PUSHWORD_TOKEN', 'Jeton')], {
    probe: pushwordProbe({ baseUrl: 'https://edit.example.com' }),
  }),
});
const keychain = createKeychain({ namespace: 'secrets-mon-projet.invalid', helperVariable: 'MON_PROJET_SECRET_HELPER' });
const vault = createVault({
  catalog, keychain, configureHint: 'node bin/assistant.js vault configure',
  after: [sharedKeychainSource(createKeychain({ namespace: 'secrets-autre.invalid' }), ['SMTP_IMAP_ACCOUNTS'])],
});
```

Le trousseau stocke chaque valeur sous `valeur-v2-NOM` (base64url) et la liste
des noms sous `configuration-v2`, le format du tronc commun Grand Angle : tous
les ateliers lisent les mêmes entrées. Chaque périmètre (projet, organisation)
a son espace de noms en `.invalid` ; `sharedKeychainSource` lit quelques noms
d'un autre périmètre, après les valeurs du projet. Le helper est forcé
(libsecret, Git Credential Manager, osxkeychain, jamais `store` ni `cache`),
interrogé sans invite ni réseau ; un trousseau qui ne répond pas lève
`KeychainUnavailableError` au lieu de passer pour vide. `migrateLegacy()` (CLI :
`vault migrate-keychain`) reprend les valeurs du format 0.1. Un connecteur peut
déclarer des exigences alternatives (`requirements: [['A'], ['B']]`), être
facultatif, et porter toute propriété propre au projet. Un champ `multiline`
(une signature HTML) accepte les retours à la ligne et s'édite dans une zone de
texte. Les sorties de statut
et de sonde ne contiennent jamais une valeur, une réponse brute de service ou
une identité.

## Mail

```js
import { MailClient } from '@piedweb/assistant-kit/mail';

const mail = new MailClient({ configuration: smtpImapAccountsJson, allowedDomains: ['example.com'] });
await mail.messages('', { unreadOnly: true, query: 'devis' }); // lecture seule (EXAMINE)
const writer = new MailClient({ configuration, allowWrites: true, mark, audit });
await writer.saveDraft('', { to: ['client@example.org'], subject: 'Devis', text });
```

La configuration est le JSON `SMTP_IMAP_ACCOUNTS` du tronc commun (boîtes,
serveurs, TLS ou STARTTLS, signature HTML par boîte). Les lectures ne modifient
aucun drapeau. Brouillons, envois et réponses exigent `allowWrites: true` ; un
envoi est archivé dans « Envoyés » sans doublon. `authorize` (contrôle
d'identité), `audit` (journal sans contenu) et `mark` (marque et en-tête des
messages écrits par un agent) se branchent par options.

## Personnaliser par-dessus la librairie

| Besoin du projet | Point d'extension |
| --- | --- |
| Valeurs d'un fichier partagé, d'un autre trousseau | `createVault({ before, after })`, `sharedKeychainSource` |
| Variable vide qui désactive une valeur | `createVault({ emptyEnvironmentOverrides: true })` |
| Anciennes entrées propres au projet | `keychain.readEntry()`, `keychain.removeEntry()` |
| Propriétés de catalogue (équipes, profils) | toute option de `connector()` est conservée |
| Jeton rafraîchi, client d'API dérivé | `token` fonction, sous-classe de `PushwordClient` |
| Étape après un pull | `ContentWorkspace({ onPulled })` |
| Identité, journal, marque des mails | `MailClient({ authorize, audit, mark })` |
| Écritures Cadrank auditées | `CadrankClient({ allowWrites, audit })` |
| Réponses HTTP `{ status, text, json }` | `HttpClient.exchange()` |
| Commandes d'atelier | `runAssistant({ commands, actions, doctor })` |

## Développement

```bash
npm ci
npm run check   # tests hermétiques (aucun réseau, aucun trousseau réel) et chargement CommonJS
```

Une version publiée est un tag `vX.Y.Z` poussé sur GitHub ; les projets
montent de version en changeant ce tag.
