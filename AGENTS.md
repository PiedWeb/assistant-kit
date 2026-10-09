# assistant-kit

Librairie Node (ESM, Node ≥ 22.12) des connecteurs partagés entre les ateliers
Assistant : `../piedweb.com/Assistant`, `../altimood/Assistant` et, à terme, le
tronc commun `../GrandAngle/AI-SolarSystem-Core`. Dépôt public
`github.com/PiedWeb/assistant-kit`, consommé par tag (`github:PiedWeb/assistant-kit#vX.Y.Z`).

## Règles

- Rien de propre à un projet ici : pas d'hôte, de nom de credential, de chemin
  ni de marque en dur. Ils entrent par les options des constructeurs et
  fabriques (`namespace`, `catalog`, `hosts`, `brand`, `allowedDomains`).
- Aucun secret, aucune donnée client, aucune adresse privée dans le code, les
  tests ou la documentation : le dépôt est public.
- Points d'entrée sans `await` de premier niveau ni export par défaut : les
  consommateurs CommonJS les chargent par `require()`. `npm run check` le vérifie.
- Tests hermétiques : `fetch`, `git credential`, IMAP et SMTP sont injectés.
  Aucun test ne touche le réseau ni le trousseau réel.
- Une écriture HTTP non idempotente (POST, DELETE, PATCH sans `If-Match`) n'est
  jamais rejouée.
- Messages destinés aux agents et aux utilisateurs en français, commentaires de
  code en anglais. Pas de tiret cadratin ni demi-cadratin.

## Publier une version

1. `npm run check`.
2. Monter `version` dans `package.json`, commit `chore(release): X.Y.Z`.
3. `git tag vX.Y.Z && git push origin main vX.Y.Z`.
4. Dans chaque consommateur, changer le tag de la dépendance puis `npm install`.

## Consommateurs

- `piedweb.com/Assistant` et `altimood/Assistant` : `bin/assistant.js` appelle
  `runAssistant()` ; `src/config.js` porte le catalogue, les hôtes et les règles
  du projet. Altimood ajoute `docs` et `pushword context-pull`.
- Tronc commun Grand Angle (`../GrandAngle/AI-SolarSystem-Core`, CommonJS) :
  pas encore branché. Le format du trousseau, le JSON `SMTP_IMAP_ACCOUNTS` et
  les points d'extension du README sont faits pour qu'il remplace ses
  connecteurs par la librairie sans rien perdre : `conf()` sur
  `createKeychain` (espace `secrets-solarsystem.{grandangle|furthertreks}.invalid`,
  `GA_SECRET_HELPER`, `GA_SECRET_DISABLE`), `requestWithRetry` sur
  `HttpClient.exchange`, `SmtpImapClient` sur `MailClient` (`authorize`,
  `audit`, `mark`), Pushword de Jupiter sur `ContentWorkspace` (`onPulled` pour
  `data.tar.gz`). Restent chez lui : l'identité Microsoft, l'EditorClient, le
  catalogue, l'interface du Coffre-fort, la composition et le style des mails.
  Prérequis : Node 22.12 sur les postes et la VM Windows.
- Une correction se fait ici, puis chaque projet monte de version : jamais de
  copie locale modifiée.
