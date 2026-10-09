# assistant-kit

Connecteurs partagés des ateliers « Assistant » de Pied Web : le code que
`altimood/Assistant`, `piedweb.com/Assistant` et le tronc commun de Grand Angle
réécrivaient chacun de leur côté. Chaque projet garde sa configuration (hôtes,
noms de credentials, textes, CLI) et importe ici le comportement.

| Module | Contenu |
| --- | --- |
| `@piedweb/assistant-kit/http` | `HttpClient` : `fetch` injectable, nouvelles tentatives avec gigue et `Retry-After`, jamais sur une écriture non idempotente |
| `@piedweb/assistant-kit/pushword` | `PushwordClient` (API `pushword/api`), `ContentWorkspace` (miroir local, pull, synchro, création, suppression, statique), hook `PostToolUse` |
| `@piedweb/assistant-kit/secrets` | trousseau système via `git credential`, vault (environnement, systemd, trousseau, défaut), formulaire web local, sondes en lecture seule |
| `@piedweb/assistant-kit/cadrank` | client Cadrank en lecture (SERP, mots-clés liés, crawls) |
| `@piedweb/assistant-kit/mail` | IMAP et SMTP de boîtes nommées, limitées à des domaines |
| `@piedweb/assistant-kit/cli` | analyse des arguments et affichage pour un `bin/assistant.js` |

## Installation

Épingler un tag, jamais une branche :

```json
"dependencies": {
  "@piedweb/assistant-kit": "github:PiedWeb/assistant-kit#v0.1.1"
}
```

`package-lock.json` retient le commit, `npm ci` le rejoue. Node 22.12 ou plus :
le paquet est en ESM et se charge aussi par `require()` depuis du CommonJS
(`npm run check` le vérifie pour chaque point d'entrée).

## Éditer des pages Pushword

```js
import { ContentWorkspace, PushwordClient, runSyncHook } from '@piedweb/assistant-kit/pushword';

const client = new PushwordClient({ baseUrl: 'https://edit.example.com', token });
const workspace = new ContentWorkspace({ root: projectDir, client, hosts: ['example.com'] });

await workspace.pull();                 // content/{host}/*.md, chaque page porte sa revision:
await workspace.sync([file]);           // PUT + If-Match, réécrit le texte canonique, régénère la page
await workspace.create(newFile);        // POST d'une page sans revision
await workspace.delete('example.com', 'old', { redirectTo: '/new' });
process.exitCode = await runSyncHook(workspace, stdinPayload); // hook Claude Code ou Codex
```

La production fait foi. Un 409 remplace le fichier local par la version du
serveur : réappliquer la modification sur ce texte, jamais forcer. Un dépôt Git
privé dans `content/` garde l'état du dernier pull ou de la dernière synchro,
et un nouveau pull refuse d'écraser une modification qui n'a pas atteint le
serveur. Le snapshot n'installe que les `.md`, `redirection.csv` et les
`index*.csv` : les conversations et autres exports privés restent sur le
serveur.

## Secrets

```js
import { connector, createKeychain, createVault, defineCatalog, field, pushwordProbe } from '@piedweb/assistant-kit/secrets';

const catalog = defineCatalog({
  pushword: connector('Pushword', 'Pages et médias.', [field('PUSHWORD_TOKEN', 'Jeton')], {
    probe: pushwordProbe({ baseUrl: 'https://edit.example.com' }),
  }),
});
const keychain = createKeychain({ namespace: 'secrets-mon-projet.invalid', helperVariable: 'MON_PROJET_SECRET_HELPER' });
const vault = createVault({ catalog, keychain, configureHint: 'node bin/assistant.js vault configure' });
```

Le trousseau impose un helper sûr (libsecret, Git Credential Manager,
osxkeychain), jamais `store` ni `cache`. Les sorties de statut et de sonde ne
contiennent jamais une valeur, une réponse brute de service ou une identité.

## Développement

```bash
npm ci
npm run check   # tests hermétiques (aucun réseau, aucun trousseau réel) et chargement CommonJS
```

Une version publiée est un tag `vX.Y.Z` poussé sur GitHub ; les projets
montent de version en changeant ce tag.
