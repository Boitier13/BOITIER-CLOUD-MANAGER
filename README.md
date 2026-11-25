# BOITIER CLOUD MANAGER

Application de bureau personnelle pour réunir plusieurs comptes de stockage cloud
(MEGA, Google Drive, Shadow Drive, TeraBox) dans une interface unique : parcourir
les fichiers, lancer des téléchargements, retrouver ses favoris.

> **Version 0.1.0 — front-end uniquement.**
> Aucune connexion cloud réelle, aucun téléchargement réel, aucune API externe.
> Toutes les données sont fictives et stockées localement dans le navigateur.

## Démarrer

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # vérification TypeScript + build de production
npm run preview  # prévisualiser le build
```

## Fonctionnalités

| Écran | Contenu |
| --- | --- |
| **Accueil** | Comptes par fournisseur, occupation, transferts en cours, derniers fichiers, favoris |
| **Clouds** | 4 fournisseurs, 11 comptes MEGA, 4 Google Drive, 5 Shadow Drive, 3 TeraBox — ajout, renommage, suppression, filtres |
| **Tous les fichiers** | Explorateur navigable : fil d’Ariane, retour, recherche, tri, filtres par type, sélection multiple |
| **Téléchargements** | File simulée : progression, débit, pause/reprise, annulation, limite de simultanéité |
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
│   └── downloads.ts    Moteur de simulation de la file de transferts
├── store.tsx           État global (reducer), persistance locale, catalogue dérivé
├── components/         Sidebar, barre d’état, modale, toasts, monogramme
├── pages/              Home, Clouds, Files, Downloads, Favorites, Settings
│   └── explorer/       Bits réutilisables (fil d’Ariane, tri, cases à cocher)
└── styles.css          Design system (tokens, composants, thèmes)
```

Le point d’entrée pour un futur back-end est `src/store.tsx` : les actions du
reducer (`account/add`, `downloads/add`, `favorite/toggle`…) correspondent aux
opérations à brancher sur l’API, sans toucher aux composants d’interface.
