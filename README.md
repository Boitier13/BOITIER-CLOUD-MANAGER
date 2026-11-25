# BOITIER CLOUD MANAGER

Application de bureau personnelle pour réunir plusieurs comptes de stockage cloud
(MEGA, Google Drive, Shadow Drive, TeraBox) dans une interface unique : parcourir
les fichiers, lancer des téléchargements, retrouver ses favoris.

> **Version 0.2.0 — Google Drive réel, en lecture seule.**
> Dans sa fenêtre Windows, l’application peut se connecter à un ou plusieurs
> comptes Google : parcourir les dossiers, rechercher et télécharger réellement
> les fichiers. MEGA, Shadow Drive et TeraBox restent des démonstrations.
> Le navigateur reste utilisable : tout y est simulé, comme auparavant.

## Démarrer

```bash
npm install
npm run dev      # http://localhost:5173 — démonstration complète
```

```bash
npm run build    # vérification TypeScript + build de production
npm run preview  # prévisualiser le build
```

### Application Windows (Google Drive réel)

Pour **tester sans rien installer** : téléchargez l'installeur depuis les
[Releases](https://github.com/Boitier13/BOITIER-CLOUD-MANAGER/releases), ou
déclenchez le workflow *Installeur Windows* (onglet Actions → Run workflow).

Depuis les sources :

```bash
npm run desktop:dev   # Vite + fenêtre Electron, avec rechargement à chaud
npm run desktop       # build complet puis fenêtre Electron
npm run verify:desktop # toutes les vérifications (types, build, tests, chemins)
npm run package:win   # installeur Windows (nécessite Windows ou une CI Windows)
```

> **Windows SmartScreen** : l'installeur n'est pas signé numériquement.
> Au premier lancement, Windows affiche un avertissement : *Informations
> complémentaires → Exécuter*. Supprimer cet avertissement demande un
> certificat de signature de code, payant, hors périmètre d'un usage personnel.

## Google Drive réel

Seul Google Drive se connecte réellement. Trois principes :

- **Lecture seule.** Le périmètre demandé est `drive.readonly` : lire, chercher et
  télécharger. Aucune modification, aucun déplacement, aucune suppression n’est
  possible depuis l’application.
- **Aucun mot de passe Google.** L’autorisation se donne dans le navigateur
  système ; l’application reçoit un jeton et un jeton de rafraîchissement.
- **Jetons chiffrés par Windows** (DPAPI via `safeStorage`), dans
  `%APPDATA%/BOITIER CLOUD MANAGER/google-accounts.enc`. Le fichier est inutilisable
  sur une autre machine et reste hors du dépôt. L’interface ne reçoit que des
  métadonnées (nom, adresse, photo, quota).

### Configurer Google Cloud (une seule fois, ~10 minutes, gratuit)

1. <https://console.cloud.google.com> → créer un projet.
2. **API et services → Bibliothèque** → activer **Google Drive API**.
3. **Écran de consentement OAuth** → type **Externe**, nom + e-mail de support,
   puis ajouter votre adresse dans **Utilisateurs tests**.
4. Ajouter le périmètre `.../auth/drive.readonly` (+ `openid`, `email`, `profile`).
5. **Identifiants → Créer des identifiants → ID client OAuth → Application de bureau**.
6. Copier l’**identifiant client** et le **secret client** dans l’application :
   *Clouds → Google Drive → Configurer*. Ils sont chiffrés localement (ou, en
   développement, dans `.env.local`, voir `.env.example`).

Aucune URL de redirection à déclarer : le client « Application de bureau » autorise
une boucle locale `http://127.0.0.1:<port>/callback` avec un port éphémère, et
l’application utilise PKCE (S256) + `state`.

### Limites à connaître

| Limite | Explication |
| --- | --- |
| Mode *Testing* : reconnexion hebdomadaire | Google expire les jetons de rafraîchissement au bout de **7 jours** tant que l’application n’est pas publiée. Publier l’application (« Publier l’application », sans demander la vérification) supprime cette limite pour un usage personnel. |
| Écran « Google n’a pas vérifié cette application » | Normal pour un projet personnel non vérifié : *Paramètres avancés → Continuer*. |
| Documents Google natifs | Docs, Sheets et Slides n’ont pas de fichier binaire : ils doivent être exportés depuis Google Drive. L’application l’indique clairement. |
| Pause et reprise | Une pause annule le flux réseau et supprime le fichier partiel ; la reprise repart du début. |
| Comptes professionnels | Un administrateur Google Workspace peut interdire les applications tierces. |

## Vérification

```bash
npm run verify:desktop    # enchaîne tout ce qui suit
npm run typecheck         # types de l'interface
npm run desktop:typecheck # types du processus principal
npm run desktop:test      # 32 contrôles : OAuth/PKCE, coffre chiffré, quota,
                          # exploration, recherche, téléchargement réel, pause,
                          # révocation à la déconnexion — sans réseau, avec un
                          # faux Google local
npm run desktop:paths     # la fenêtre charge dist/ en file://, et possède ses
                          # garde-fous de démarrage (signal de vie, délai, journal)
npm run desktop:package-test # contenu de l'archive : complet, sans secret,
                             # fontes embarquées, aucune ressource distante
```

### Typographie

Deux fontes variables sont embarquées dans l'application (aucun appel réseau,
ce qui serait de toute façon sans effet en `file://`) :

| Usage | Fonte | Graisses |
| --- | --- | --- |
| Texte, navigation, boutons, formulaires | **DM Sans** | 100–1000 |
| Titres, titres de panneaux, chiffres, logo | **Manrope** | 200–800 |

- plancher de **10,5 px** pour tous les textes secondaires, corps à **14 px**,
  titres de panneaux à **14 px**, H1 à **24 px** ; les textes porteurs
  d'information (chemins, libellés, compteurs) sont remontés d'environ 1,5 px
  par rapport à la version précédente, et les rangées cliquables (navigation,
  boutons, champs, tableau) ont été rehaussées en conséquence ;
- les compteurs (classe `.tnum`) passent en **Manrope** : DM Sans n'expose pas la
  fonctionnalité `tnum`, sans quoi les chiffres danseraient pendant les
  transferts ;
- contrastes des textes secondaires portés au niveau **AA** (≥ 4,5:1) dans les
  deux thèmes, y compris sur les panneaux les plus contrastés (`--panel-3`).

### Démarrage de la fenêtre

Un défaut a été observé en usage réel : au **premier lancement après une mise à
jour**, la fenêtre s'ouvre mais aucun menu ne réagit ; fermer puis relancer
rétablit tout. La fenêtre affichait alors un document dont l'interface n'avait
pas pris la main.

Trois garde-fous empêchent désormais ce cas de passer inaperçu :

| Mécanisme | Rôle |
| --- | --- |
| **Signal de vie** (`desktop:renderer-ready`) | l'interface prévient dès qu'elle est montée ; c'est la preuve qu'elle répond |
| **Délai de 12 s** | sans signal, la fenêtre est rechargée **une fois** ; si elle reste muette, un message propose de relancer |
| **Journal de démarrage** | `%APPDATA%\BOITIER CLOUD MANAGER\demarrage.log` : version, mode, chargement, incidents |

En cas de défaut, le journal suffit à savoir ce qui s'est passé — plus besoin de
deviner. Les échecs de chargement (`did-fail-load`) et les arrêts du processus
d'affichage sont également interceptés et expliqués, au lieu de laisser une
fenêtre vide.

La version affichée dans **Paramètres → À propos** est lue dans `package.json`
au moment de la compilation : elle ne peut plus annoncer un numéro périmé.

### Chargement local (`file://`)

La fenêtre Electron n'ouvre pas un serveur : elle charge `dist/index.html`
directement depuis le disque. Trois réglages le garantissent, et trois contrôles
automatisés les vérifient (`npm run desktop:paths`) :

| Réglage | Raison |
| --- | --- |
| `base: './'` dans `vite.config.ts` | des chemins absolus (`/assets/…`) pointeraient vers la racine du disque |
| `inlineDynamicImports: true` | un import dynamique échouerait en `file://` (règles CORS de Chromium) |
| `__dirname` dans `desktop/main.ts` | `import.meta.url` est vide dans un bundle CommonJS |

Deux workflows GitHub Actions :

| Workflow | Déclencheur | Effet |
| --- | --- | --- |
| **Vérification** | chaque push et chaque PR | types, build, 32 contrôles Google, chemins `file://`, contenu de l'archive |
| **Installeur Windows** | tag `v*` ou lancement manuel | construit `release/BOITIER-CLOUD-MANAGER-x.y.z-setup.exe` et le joint à la release |

Pour publier une version : mettre à jour `version` dans `package.json`, puis
`git tag v0.4.0 && git push origin v0.4.0`.

## Fonctionnalités

| Écran | Contenu |
| --- | --- |
| **Accueil** | Comptes par fournisseur, occupation, transferts en cours, derniers fichiers, favoris |
| **Clouds** | 4 fournisseurs, 11 comptes MEGA, 4 Google Drive, 5 Shadow Drive, 3 TeraBox — ajout, renommage, suppression, filtres ; connexion de comptes Google réels |
| **Tous les fichiers** | Explorateur navigable : fil d’Ariane, retour, recherche, tri, filtres par type, sélection multiple ; dossiers Google Drive chargés à la demande |
| **Téléchargements** | File unifiée : progression, débit, pause/reprise, annulation ; transferts Google Drive réellement écrits sur le disque |
| **Favoris** | Collection multi-comptes, recherche, répartition par fournisseur |
| **Paramètres** | Thème sombre/clair, densité, dossier cible, transferts simultanés, réinitialisation |

Raccourcis : `Ctrl+1…4`, `Ctrl+,`, `Ctrl+A` (sélection), `Échap`, `?`.

La recherche de l’explorateur couvre **tous les comptes** : chaque résultat affiche
son cloud, son compte et son chemin ; un clic bascule automatiquement sur le bon compte.

## Architecture

```
src/
├── data/catalog.ts     Données fictives : fournisseurs, comptes, arborescences
├── lib/
│   ├── format.ts       Formatage FR (octets, dates, pourcentages)
│   ├── tree.ts         Helpers d’arborescence (aplatissement, parcours)
│   ├── downloads.ts    File de transferts (simulation + suivi des transferts réels)
│   ├── bridge.ts       Pont typé vers Electron (aucun jeton ne le traverse)
│   ├── google.ts       Conversion compte/fichier Google → modèle de l’interface
│   └── remote.ts       Cache des dossiers Drive chargés à la demande
├── store.tsx           État global (reducer), persistance locale, catalogue dérivé
├── hooks/useGoogle.ts  État du client OAuth, ajout de compte, déconnexion
├── components/         Sidebar, barre d’état, modale, toasts, dialogues Google
├── pages/              Home, Clouds, Files, Downloads, Favorites, Settings
│   └── explorer/       Bits réutilisables (fil d’Ariane, tri, cases à cocher)
└── styles.css          Design system (tokens, composants, thèmes)

build/
├── icon.ico            Icône Windows (16 → 256 px)
└── icon.png            Icône source 512 px

desktop/
├── main.ts             Fenêtre Electron, instance unique
├── paths.ts            Emplacements (dist/, preload, données) — testable
├── preload.cjs         Seul pont exposé à l’interface (CommonJS, sandbox)
├── api.ts              Canaux IPC : Google + système (dossiers, liens)
├── config.ts           Lecture de .env.local et des variables d’environnement
├── build.mjs           Build esbuild du processus principal
└── google/
    ├── oauth.ts        Boucle locale 127.0.0.1, PKCE S256, échange et révocation
    ├── vault.ts        Coffre chiffré (DPAPI via safeStorage), écriture atomique
    ├── tokens.ts       Session : rafraîchissement silencieux, quota, expiration
    ├── drive.ts        API Drive v3 en lecture seule (list, search, about, media)
    ├── downloads.ts    Téléchargement réel (.part → renommage), pause, reprise
    └── service.ts      Assemblage : comptes, sessions, exploration, transferts

desktop/test/
├── smoke.mjs           Parcours Google complet contre un faux serveur local
├── fake-google.mjs     Le faux Google (OAuth, Drive, média)
├── verify-paths.mjs    Chargement de dist/ en file://
└── verify-package.mjs  Contenu réel de l'archive de l'application
```

Toute la logique Google est en TypeScript pur, sans import d’Electron : elle est
exécutable et testable sous Node (`npm run desktop:test`). Electron n’est qu’un
conteneur (fenêtre + coffre chiffré + écriture disque).

Le point d’entrée pour les autres fournisseurs reste `src/store.tsx` : les actions
du reducer (`account/add`, `downloads/add`, `favorite/toggle`…) correspondent aux
opérations à brancher, sans toucher aux composants d’interface.
