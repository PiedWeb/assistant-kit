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

## Reprise des autres projets

- `altimood/Assistant` : remplacer `src/http.js`, `src/pushword.js`,
  `src/keychain.js`, `src/vault*.js`, `src/cadrank.js`, `src/mail.js` par la
  librairie. Garder l'espace de noms `secrets-altimood-assistant.invalid` et
  `ALTIMOOD_SECRET_HELPER` pour retrouver les secrets déjà enregistrés.
- Tronc commun Grand Angle : son trousseau stocke un manifeste et des valeurs
  en base64url, incompatible avec ce format ; prévoir une migration. Ses
  points forts à remonter ici : Cadrank complet (cache des crawls, relance
  auditée), IMAP avec brouillons et réponses, API `/api/editor/*` d'identité
  Microsoft, lecteur tar sans dépendance.
