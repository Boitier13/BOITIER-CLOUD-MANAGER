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

```bash
npm run desktop:dev   # Vite + fenêtre Electron, avec rechargement à chaud
npm run desktop       # build complet puis fenêtre Electron
npm run desktop:test  # vérification de bout en bout hors ligne (faux Google)
```

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
npm run typecheck        # interface
npm run desktop:typecheck
npm run desktop:test     # 30 contrôles : OAuth/PKCE, coffre chiffré, quota,
                         # exploration, recherche, téléchargement réel, pause,
                         # révocation — sans réseau, avec un faux Google local
```

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

desktop/
├── main.ts             Fenêtre Electron, chemins, instance unique
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
```

Toute la logique Google est en TypeScript pur, sans import d’Electron : elle est
exécutable et testable sous Node (`npm run desktop:test`). Electron n’est qu’un
conteneur (fenêtre + coffre chiffré + écriture disque).

Le point d’entrée pour les autres fournisseurs reste `src/store.tsx` : les actions
du reducer (`account/add`, `downloads/add`, `favorite/toggle`…) correspondent aux
opérations à brancher, sans toucher aux composants d’interface.
