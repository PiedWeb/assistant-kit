# assistant-kit

Connecteurs partagés des ateliers « Assistant » de Pied Web : le code que
`altimood/Assistant`, `piedweb.com/Assistant` et le tronc commun de Grand Angle
réécrivaient chacun de leur côté. Chaque projet garde sa configuration (hôtes,
noms de credentials, textes, règles) et importe ici le comportement ; ses
particularités se branchent par options, hooks ou sous-classes, jamais par une
copie du code.

| Module | Contenu |
| --- | --- |
| `@piedweb/assistant-kit/assistant` | `runAssistant()` : tout le `bin/assistant.js` d'un atelier (doctor, vault, pushword, media, redirection, cadrank, cockpit, mail), extensible par commandes |
| `@piedweb/assistant-kit/http` | `HttpClient` : `fetch` injectable, jeton fixe ou fonction, nouvelles tentatives avec gigue et `Retry-After`, jamais sur une écriture non idempotente, aucun secret envoyé à une autre origine sur redirection, `exchange()` sans exception sur le statut |
| `@piedweb/assistant-kit/pushword` | `PushwordClient` (API `pushword/api`), `ContentWorkspace` (miroir local, pull, synchro, création, suppression, statique), hook `PostToolUse` |
| `@piedweb/assistant-kit/secrets` | trousseau système au format du tronc commun Grand Angle, vault (environnement, systemd, sources du projet, trousseau, défaut), formulaire web local, sondes en lecture seule |
| `@piedweb/assistant-kit/cadrank` | client Cadrank (SERP, mots-clés liés, crawls mémorisés), lancement de crawl audité sur autorisation |
| `@piedweb/assistant-kit/cockpit` | `CockpitClient`, `CockpitProjectClient` : découverte Instagram/YouTube, tableaux CRM, compte, clés API, extension, monitoring, collecteurs et accès générique à toutes les routes `/api` |
| `@piedweb/assistant-kit/mail` | `MailClient` IMAP et SMTP : lecture seule par défaut ; brouillons (création, modification), état lu, envois et réponses sous `allowWrites` |
| `@piedweb/assistant-kit/audit` | journal JSONL des écritures, sans contenu ni secret |
| `@piedweb/assistant-kit/cli` | analyse des arguments, `@fichier` JSON, listes, `runCli` |

## Installation

Épingler un tag, jamais une branche :

```json
"dependencies": {
  "@piedweb/assistant-kit": "git+https://github.com/PiedWeb/assistant-kit.git#v0.5.0"
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
snapshot n'installe que les `.md`, `redirection.csv` et les index de Pushword
(`index.csv`, `index.draft.csv`, aussi par langue), jamais `AGENTS.md` ni
`CLAUDE.md` ni un dossier qui n'en contient aucun. Il part avec la clé de snapshot seule quand le
projet en a une (`snapshotKey`), sinon avec le jeton ; `snapshotTimeoutMs` borne
son téléchargement (2 minutes). `onPulled({ host, directory })` ajoute une étape
propre au projet après chaque pull.

Chaque résultat de `sync()` porte `status` (`synced`, `conflict`, `auth`,
`no-revision`, `outside-hosts`, `error`), `message`, et pour un refus HTTP
`httpStatus` et `responseText` : un projet peut écrire ses propres messages.
Les erreurs se reconnaissent à leur `code`, jamais à leur texte :
`UNSYNCED_CHANGES` et `EMPTY_SNAPSHOT` pour un pull, `NETWORK_ERROR` quand
aucune tentative n'a eu de réponse, `CROSS_ORIGIN_REDIRECT`.

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
const draft = await writer.saveDraft('', { to: ['client@example.org'], subject: 'Devis', text });
await writer.updateDraft('', '', draft.uid, { version: draft.version, text: 'Version corrigée', cc: ['copie@example.org'] });
await writer.setSeen('', 'INBOX', 8, false);                    // remettre un message en non lu
```

La configuration est le JSON `SMTP_IMAP_ACCOUNTS` du tronc commun (boîtes,
serveurs, TLS ou STARTTLS, signature HTML par boîte). Les lectures ne modifient
aucun drapeau. Brouillons, modifications de brouillon, état lu, envois et
réponses exigent `allowWrites: true` ; un envoi est archivé dans « Envoyés »
sans doublon. Un brouillon est enregistré non lu (`\Draft` sans `\Seen`) : il
ressort dans la boîte jusqu'à ce que quelqu'un le relise. `authorize` (contrôle
d'identité), `audit` (journal sans contenu) et `mark` (marque et en-tête des
messages écrits par un agent) se branchent par options.

IMAP ne modifie pas un message stocké : `updateDraft(id, dossier, uid,
changements)` ajoute la nouvelle version, non lue, dans le même dossier
(« Brouillons » si `dossier` est vide), puis supprime l'ancienne par `UID
EXPUNGE` ; sans `UIDPLUS`, elle n'est que marquée `\Deleted`, car un `EXPUNGE`
emporterait d'autres messages. `to`, `cc`, `bcc` et `subject` remplacent leur
valeur, `attachments` s'ajoutent, le reste vient du brouillon. `text` ou `html`
remplacent la partie rédigée ; signature et marque sont recomposées, et
l'historique cité d'une réponse est conservé. S'il est introuvable (brouillon
retouché dans un client mail), rien ne change, sauf `wholeBody: true` qui
remplace tout le corps. Une suppression qui échoue après l'ajout est rapportée
dans `previous`, jamais levée.

Une modification part toujours du brouillon tel qu'il est : `version` vient de
sa création, de `message()` (champ `draft` d'un message `\Draft`) ou de la
modification précédente. C'est l'empreinte de ce qu'un agent voit et réécrit
(objet, destinataires, texte au-dessus de l'historique, sans signature ni
marque) : un état lu ne la change pas, une retouche dans un client mail si.
Sans version (`DRAFT_VERSION_REQUIRED`) ou avec une version dépassée
(`DRAFT_CHANGED`), rien n'est écrit et `error.details.current` donne le
brouillon actuel et sa version : la modification se refait sur ce texte, jamais
par-dessus celle de quelqu'un d'autre. L'historique cité se reconnaît dans le
format de la librairie et dans ceux de Thunderbird, Roundcube, Apple Mail,
Gmail et Outlook ; dans le texte, ligne à ligne, en temps linéaire.

## Cockpit

```js
import { CockpitClient } from '@piedweb/assistant-kit/cockpit';

const cockpit = new CockpitClient({ baseUrl: 'https://cockpit.example.com', token });
await cockpit.docs();
await cockpit.scopes();                              // Server-defined permissions
await cockpit.projects();                            // Accessible board UUIDs
await cockpit.searchInstagram({ tier: 'micro', locale: 'fr', hasUrl: true, page: 1 });
await cockpit.instagramDetail('Creator.Test', { simTier: 'nano', simPage: 2 });
await cockpit.youtubeVideos({ q: 'montagne', page: 1 });
const board = cockpit.project(projectUuid);
await board.influencers();
const csv = await board.exportCsv({ ids: [1, 2] });     // Text with the original columns

const writer = new CockpitClient({ baseUrl, token, allowWrites: true, audit });
const writableBoard = writer.project(projectUuid);
await writableBoard.addManualInfluencer({ website: 'https://example.org', name: 'Test' });
await writableBoard.updateInfluencer(rowId, { stageId, addProduct: productId });
await writableBoard.addNote('influencers', rowId, { message: 'Contact établi' });
await writableBoard.pinNote('influencers', rowId, noteIndex); // Toggle pinning
```

L’adresse et la clé viennent du consommateur. `token` peut être une fonction
synchrone ou asynchrone, résolue à chaque requête. Une clé personnelle utilise
`Authorization: Bearer` ; le serveur contrôle ses permissions, sa restriction
aux projets et les rôles du compte. Une clé sudo n’élève pas les rôles du compte.
Les méthodes renvoient les modèles du serveur sans les réécrire et conservent
tous les paramètres de filtre, tri et pagination. Les tableaux passés en query
deviennent des listes séparées par des virgules ; `false` et `0` sont conservés.

| Périmètre | Méthodes |
| --- | --- |
| Découverte Instagram | `searchInstagram`, `instagramDetail`, `sharedCommenters`, `communities`, `tagCommunity`, `exportInstagram` |
| YouTube et monitoring | `youtubeChannels`, `youtubeChannel`, `youtubeVideos`, `youtubeVideo`, `likerHealth` |
| Compte | `me`, `updateMe`, `preferences`, `updatePreferences`, `extension`, `buildExtension`, `downloadExtension`, `passwordLink`, `passwordTarget`, `setPassword` |
| Clés et projets | `scopes`, `apiKeys`, `createApiKey`, `revokeApiKey`, `sudoKey`, `rotateSudoKey`, `projects`, `createProject`, `project(uuid)` |
| Tableau `project(uuid)` | `info`, `docs`, `update`, `rotateToken`, `members`, `addMember`, `updateMember`, `removeMember` |
| Colonnes du tableau | `stages`, `createStage`, `updateStage`, `deleteStage`, `moveStage` et les mêmes méthodes pour `products` / `Product` |
| CRM du tableau | `influencers`, `addInfluencer`, `addManualInfluencer`, `updateInfluencer`, `updateContact`, `removeInfluencer`, `bulk`, `exportCsv` |
| Notes du tableau | `addNote(resource, id, data)`, `deleteNote(resource, id, index)`, `pinNote(resource, id, index)` ; `resource` = `stages`, `products` ou `influencers` |

Les méthodes de création et de modification prennent le JSON de l’API tel
quel. Les identifiants CRM sont ceux des lignes du tableau ; `updateContact`
modifie les coordonnées globales de l’identité. `moveStage` / `moveProduct`
prennent `{ before: id }` (0 pour la fin) ou `{ dir: 'up' | 'down' }`.
`bulk` prend `{ ids, action, targetId, message }` selon l’action.

Pour les anciennes intégrations, construire un client avec
`headers: { 'X-Project-Token': projectToken }` et utiliser `project()` sans UUID.
Une clé personnelle peut aussi sélectionner ce chemin avec
`headers: { 'X-Project-Id': projectUuid }`. Ces en-têtes ne contournent aucune
permission. Les identifiants restent sur l’origine du client, même lors d’une
redirection. `fetchImpl`, `http`, `httpOptions` et `userAgent` sont injectables.

`allowWrites` vaut `false` par défaut. Toutes les mutations exigent `true` et
ne sont jamais rejouées, même si un appel générique demande une nouvelle
tentative. Cela couvre aussi `GET` / `HEAD /api/instagram/{username}` (peut
créer une ligne inconnue) et `/api/instagram/add/{username}`. Le hook `audit`
accepte une fonction ou `{ record }` ; il reçoit la méthode, le chemin sans
query, le statut et le succès, sans corps ni identifiant secret.

```js
// Every API route uses the same write policy.
await writer.request('PATCH', `/api/projects/${projectUuid}/products/${productId}`, {
  body: { position: 0 },
});
const zip = await cockpit.downloadExtension();        // Buffer, requires sudo
const result = await cockpit.exchange('GET', '/api/me');
// result = { status, ok, headers, text, json, body: Buffer }
```

`request(method, path, { query, body, headers, accept, format, ... })` retourne
le JSON, le texte ou `null`, et lève `CockpitError` sur un statut inattendu
(`status`, `payload`, et `code` pour un refus local ou une erreur réseau).
Les statuts 200, 201, 202 et 204 sont acceptés par défaut ; `expectedStatus`
les remplace. `format: 'text'` ou `'buffer'` impose le format de retour.
`exchange()` expose aussi les statuts refusés. Les URLs absolues doivent
appartenir à la même origine et rester dans `/api`.
`passwordTarget(signedUrl)` et `setPassword(signedUrl, { password, passwordConfirm })`
conservent la preuve du lien reçu par mail et n’envoient pas la clé Bearer.

Les collecteurs utilisent un client distinct, sans clé personnelle, avec leur
en-tête `X-Liker-Token` ou leur authentification locale autorisée. Méthodes :
`instagramToUpdate`, `instagramToScrape`, `instagramToRefresh`, `postsToSnapshot`,
`collectorAccount`, `addCollectorAccount`, `updateCollectorAccount`,
`ingestInstagramPosts`, `classifyInstagram`, `ingestYoutube`,
`ingestYoutubeTranscript`, `youtubeFrontier`, `reportYoutubeProfileHealth`,
`reportLikerRun`, `reportLikerError`. `extensionSelectors` lit la configuration
publique. Le serveur garde les restrictions des routes réservées aux collecteurs
locaux. Importer le connecteur ne lance aucun collecteur.

Pour l’atelier et le coffre-fort :

```js
import { cockpitProbe, connector, field } from '@piedweb/assistant-kit/secrets';

const cockpitEntry = connector('Cockpit', 'Découverte et tableaux CRM.', [field('COCKPIT_API_KEY', 'Clé API')], {
  probe: cockpitProbe({ baseUrl, tokenField: 'COCKPIT_API_KEY' }),
});
// Add cockpitEntry to the project catalog and pass this factory to runAssistant().
const createCockpitClient = ({ vault, allowWrites }) => new CockpitClient({
  baseUrl, token: () => vault.credential('COCKPIT_API_KEY'), allowWrites, audit,
});
```

La sonde lit `/api/api-key-scopes`, accessible à toute clé personnelle valide,
même sans permission de lecture du compte ou des projets. Son résultat ne
contient ni identité ni secret. `baseUrl` accepte aussi une fonction des valeurs
du coffre-fort et `tokenField` se configure.

Avec `createCockpitClient`, la CLI propose `cockpit docs|scopes|me|projects`, les
recherches Instagram/YouTube, `cockpit project <uuid>` et l’accès complet :

```bash
node bin/assistant.js cockpit api GET /api/instagram/search --query-file filters.json
node bin/assistant.js cockpit api PATCH /api/me --body-file changes.json --allow-writes
node bin/assistant.js cockpit api GET /api/me/extension/download --output extension.zip
```

`--allow-writes` autorise les écritures de cet appel. `--output` conserve les
octets et crée un fichier privé ; il refuse un fichier existant sans
`--overwrite`.

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
| API Cockpit et commandes d’atelier | `CockpitClient({ baseUrl, token, headers, allowWrites, audit })`, `runAssistant({ createCockpitClient })`, `cockpitProbe` |
| Réponses HTTP `{ status, text, json }` | `HttpClient.exchange()` |
| Messages propres au projet | résultats de `sync()`, `code` des erreurs, `ContentWorkspace#report` |
| Commandes d'atelier | `runAssistant({ commands, actions, doctor })` |

## Développement

```bash
npm ci
npm run check   # tests hermétiques (aucun réseau, aucun trousseau réel) et chargement CommonJS
```

Une version publiée est un tag `vX.Y.Z` poussé sur GitHub ; les projets
montent de version en changeant ce tag.
