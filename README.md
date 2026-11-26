# BOITIER CLOUD MANAGER

Application de bureau personnelle pour parcourir et télécharger les fichiers de
vos comptes **Google Drive** depuis une interface unique.

> **Uniquement de vrais comptes.** L’application ne présente aucune donnée
> inventée : sans compte connecté, elle affiche un écran vide qui explique quoi
> faire. Toutes les informations affichées — comptes, dossiers, tailles, quotas —
> viennent de Google.
>
> L’accès est **en lecture seule** : l’application ne peut ni modifier, ni
> déplacer, ni supprimer un fichier chez Google. Aucun mot de passe ne lui est
> transmis : la connexion a lieu dans votre navigateur.

## Démarrer

```bash
npm install
npm run dev      # http://localhost:5173 — interface, sans accès aux fichiers
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
| Mode *Testing* : reconnexion hebdomadaire | Google expire les jetons au bout de **7 jours** tant que l’application reste en *Testing*. **Une seule action gratuite supprime cette limite pour toujours** : cf. la section suivante. Avec plusieurs comptes, cette contrainte se paie une fois par compte et par semaine. |
| Écran « Google n’a pas vérifié cette application » | Normal pour un projet personnel non vérifié : *Paramètres avancés → Continuer*. **Publier l’application ne change rien à cet écran** : il apparaît déjà aujourd’hui, et il réapparaît une fois après la publication. |
| Documents Google natifs | Docs, Sheets et Slides n’ont pas de fichier binaire : ils doivent être exportés depuis Google Drive. L’application l’indique clairement. |
| Pause et reprise | Une pause annule le flux réseau et supprime le fichier partiel ; la reprise repart du début. |
| Comptes professionnels | Un administrateur Google Workspace peut interdire les applications tierces. |

### Plusieurs comptes Gmail, et les alias

Gmail ignore les points et tout ce qui suit un `+` dans l’adresse :

| Adresse demandée | Boîte réellement ouverte |
| --- | --- |
| `firstboitier1@gmail.com` | `firstboitier1@gmail.com` |
| `first.boitier1@gmail.com` | `firstboitier1@gmail.com` |
| `firstboitier1+2@gmail.com` | `firstboitier1@gmail.com` |
| `firstboitier1@googlemail.com` | `firstboitier1@gmail.com` |

Ce ne sont pas quatre comptes : c’est **une seule boîte**, donc **un seul Drive**,
un seul quota. Google renvoie d’ailleurs toujours l’adresse principale, jamais
l’alias.

Conséquence dans l’application :

- l’identifiant d’un compte est calculé sur la **forme canonique** de son
  adresse, si bien qu’une variante retombe sur le compte existant ;
- si le compte était déjà connecté, la connexion le **met à jour** et l’interface
  le dit (« était déjà connecté — informations mises à jour ») au lieu de laisser
  croire à un ajout ;
- l’écran **Google Drive** signale les adresses qui sont des variantes, pour
  éviter de chercher un compte qui n’existe pas.

La règle ne s’applique **qu’à Gmail** : sur un domaine d’entreprise,
`jean+compta@` et `jean+paie@` peuvent être deux boîtes distinctes. Ces adresses
sont donc laissées intactes.

> **Ce que ce n’est pas.** L’application ne devine jamais qu’un alias est un
> doublon : elle le constate quand Google renvoie deux adresses identiques. Une
> détection approximative pourrait fusionner deux comptes réellement distincts.

### Télécharger un fichier : ce qui doit se passer

Un transfert passe par le processus principal, qui écrit sur le disque. Deux
garde-fous ont été ajoutés après un blocage réel à 0 % :

- **un refus est écrit dans la file.** Si le processus principal refuse le
  transfert, la ligne passe en « Échec » avec le motif. Avant, seule une
  notification fugace l'annonçait et la ligne restait « En cours » à 0 % ;
- **un flux muet est abandonné au bout de 20 secondes** avec un message
  explicite, au lieu d'attendre indéfiniment.

Le dossier de destination n'est plus une liste de chemins inventés
(`D:\Médias\…`) : vide, il désigne le dossier du système, et le bouton
**Choisir…** ouvre la boîte de dialogue de Windows.

**La cause du 0 % figé** — deux défauts se cumulaient :

1. la préparation (création du dossier, choix du nom libre) se faisait **hors**
   du bloc de gestion d'erreur. Un chemin impossible y levait une exception qui
   s'évaporait : aucun message, aucun événement, la ligne restait à 0 % pour
   toujours. Elle est désormais dans le `try`, avec un motif lisible
   (« Dossier introuvable : … Choisissez un autre dossier dans Paramètres. ») ;
2. un transfert restauré du stockage local restait marqué « en cours » alors
   qu'aucun processus ne le pilotait. Au démarrage il est désormais déclaré
   interrompu, avec un bouton de relance qui redemande un vrai transfert.

### Thème clair, taille du texte

Le thème clair suit une palette froide — fond `#f5f7fb`, surfaces blanches,
accent bleu `#2f6bff`, sélection de navigation en bleu pâle. La profondeur vient
des bordures, pas des ombres.

**Taille du texte** (Paramètres) : quatre paliers, 100 à 130 %, appliqués au zoom
natif de la fenêtre — donc au texte, aux icônes et aux marges à la fois. Le
choix est conservé d'une session à l'autre ; par défaut 110 %. L'ancien réglage
« Densité d'affichage » a été retiré : il ne modifiait que deux ou trois listes
et donnait l'impression de ne rien faire.

### Savoir quelles autorisations sont durables

Chaque compte porte la **date de son dernier consentement Google**, affichée sous
son adresse. Un compte **sans date** a été autorisé avant que l'application ne
l'enregistre : son jeton date de la période de test et expirera au bout de sept
jours. Un bandeau compte ces comptes, et le bouton ↻ de la ligne les renouvelle
— après quoi la date apparaît et le bandeau disparaît.

### Où va le fichier

Chaque ligne de la file affiche le **dossier de destination réel**, précédé d'une
icône de dossier : le chemin complet, jamais tronqué, qui passe à la ligne si
besoin. Un clic l'ouvre dans l'explorateur. La pastille « Dossier cible » en
haut de l'écran donne le même chemin, au lieu du vague « dossier système ».

Pour un transfert terminé, c'est le dossier du fichier réellement écrit qui est
affiché ; pour un transfert en cours ou en échec, celui visé.

Les **Paramètres** montrent le même chemin, et non un libellé : c'est lui qui
décide de la destination. Le bouton **Choisir…** ouvre la boîte de dialogue de
Windows ; **Système** ramène au dossier par défaut. Un clic sur le chemin
l'ouvre dans l'explorateur.

### Téléverser : ce que l'application ne fait pas

L'application demande une seule autorisation, `drive.readonly` : elle ne peut
techniquement rien écrire chez Google — ni renommer, ni supprimer, ni envoyer.
Le bouton **Ouvrir dans Drive** comble le manque sans changer cette promesse :
il ouvre le dossier consulté dans Google Drive, où le glisser-déposer est prévu
pour cela. Aucune reconnexion de compte n'est nécessaire.

### Ce que les chiffres du stockage veulent dire

Deux confusions rendaient l’écran Stockage trompeur ; les deux sont corrigées.

**L’espace affiché est celui du compte entier.** Google distingue `usage`
(Drive + Gmail + Photos) de `usageInDrive`. L’application prenait le second pour
le total : un compte à 5 Go de Gmail s’affichait « 6 Mo utilisés, 0 % ». C’est
maintenant le total qui s’affiche, et l’écart entre les deux qui alimente la
ligne « Gmail et Photos ».

**La répartition ne compte que vos propres fichiers.** Les requêtes de mesure
filtrent désormais sur `'me' in owners` et `trashed = false`. Sans ce filtre, les
fichiers que d’autres personnes partagent avec vous entraient dans les sommes
alors qu’ils n’occupent pas votre quota : on pouvait lire 13 Go d’archives sous
un compte à quelques mégaoctets.

Trois contrôles protègent ces règles : la somme des catégories ne doit jamais
dépasser le quota annoncé, un fichier partagé par un tiers doit compter pour
zéro, un fichier en corbeille aussi.

### Beaucoup de comptes

Le volet des comptes de l’explorateur reste utilisable au-delà de quelques
comptes :

- au-delà de cinq comptes, un **filtre** apparaît en tête du volet : il cherche
  dans le nom et l’adresse, et dit clairement quand rien ne correspond ;
- chaque compte porte une **marque de couleur** stable, calculée sur son adresse.
  Deux comptes voisins (`boitierfirst7`, `boitierfirst8`, `boitierfirst82`) se
  distinguent sans lire ;
- la ligne affiche l’**adresse** plutôt qu’un libellé répétitif : c’est ce qui
  différencie deux comptes créés dans la même minute.

### Éviter la reconnexion chaque semaine (gratuit, 5 minutes)

Par défaut, un projet Google Cloud reste en **Testing** : Google invalide alors
chaque jeton de rafraîchissement au bout de **7 jours**. Avec un seul compte,
c’est une reconnexion hebdomadaire ; avec treize, c’est treize reconnexions.

**Publier l’application met fin à cette limite, sans rien payer et sans demander
la vérification de Google.**

1. Google Cloud Console → **API et services** → **Écran de consentement OAuth**
   (ou *Google Auth Platform* → **Audience**).
2. Sous « État de publication », cliquer **Publier l’application** puis confirmer.
   L’état passe de *Testing* à *En production*.
3. Reconnecter **une dernière fois** chaque compte dans l’application : Google
   n’émet un jeton durable qu’au moment où le consentement est donné. Le bouton
   ↻ de la ligne du compte, dans **Google Drive**, renouvelle l’autorisation sans
   retirer le compte — nom choisi, ordre et favoris restent en place.

**Si le bouton « Publier » est grisé**, c’est que Google exige une configuration
de marque avant publication. Trois champs suffisent, tous gratuits :

- **Page d’accueil** de l’application (une page publique qui la décrit) ;
- **Politique de confidentialité** (une page publique également) ;
- **Domaine autorisé** : le domaine qui héberge ces deux pages.

Une page GitHub Pages convient parfaitement : c’est gratuit, public, et le
domaine est vérifiable. Renseigner les trois champs dans **Branding**, enregistrer,
puis revenir sur **Audience** pour publier.

Les deux pages sont dans le dépôt, sous `docs/`, et publiées par GitHub Pages :

- accueil : `https://boitier13.github.io/BOITIER-CLOUD-MANAGER/`
- confidentialité : `https://boitier13.github.io/BOITIER-CLOUD-MANAGER/confidentialite.html`

**Réserve honnête** : `github.io` figure sur la liste publique des suffixes. Google
refuse parfois d’y voir un domaine vérifiable — le champ **Domaines autorisés**
rejette alors la valeur. Dans ce cas seulement, un nom de domaine propre (10 à
15 € par an) lève le blocage. À essayer avec `github.io` d’abord : c’est gratuit.

#### Ce que la publication ne demande pas

- **Aucun paiement.** La vérification des périmètres restreints (dont
  `drive.readonly`) est gratuite. L’audit de sécurité annuel payant (CASA) ne
  concerne que les applications qui font transiter les données des utilisateurs
  par un serveur : ce n’est pas le cas ici, l’application parle directement de
  la machine à Google.
- **Aucune vérification.** Rester « publié mais non vérifié » est un état stable
  et autorisé. L’application fonctionne intégralement.
- **Aucun changement pour l’écran d’avertissement** : il s’affiche comme
  aujourd’hui, et une fois de plus après la publication.

#### Et le plafond de 100 utilisateurs ?

Il ne s’applique pas à un usage personnel : chaque compte ajouté est une
autorisation que **vous** donnez, pas un nouvel utilisateur de l’application.
Vous en restez l’unique utilisateur, quel que soit le nombre de vos comptes.

## Vérification

```bash
npm run verify:desktop    # enchaîne tout ce qui suit
npm run typecheck         # types de l'interface
npm run desktop:typecheck # types du processus principal
npm run desktop:test      # 55 contrôles : OAuth/PKCE, coffre chiffré, quota,
                          # adresses Gmail et alias,
                          # exploration, fichiers partagés, recherche,
                          # téléchargement réel, dossier entier, stockage,
                          # flux des récents, pause, révocation à la
                          # déconnexion — sans réseau, avec un faux Google local
npm run verify:interface  # six écrans sans compte puis avec un compte simulé
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

### État vide et comptes

Depuis la version 0.5.0, l'application ne contient plus aucune donnée fictive :
les fournisseurs MEGA, Shadow Drive et TeraBox, leurs 25 comptes inventés et les
transferts simulés ont été retirés. Conséquences à connaître :

| Situation | Ce que montre l'application |
| --- | --- |
| Aucun compte connecté | un accueil qui explique ce que fait l'application et comment connecter Google Drive |
| Comptes de démonstration d'une version antérieure | écartés au chargement ; les comptes Google, eux, sont conservés |
| Aperçu navigateur | les écrans restent consultables, mais les fichiers ne sont pas accessibles (la connexion Google exige la fenêtre Windows) |

`npm run verify:interface` parcourt les six écrans dans les deux situations
(sans compte, puis avec un compte connecté simulé) et vérifie qu'aucun décor
fictif ne subsiste.

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
`git tag v0.4.1 && git push origin v0.4.1`.

## Fonctionnalités

| Écran | Contenu |
| --- | --- |
| **Accueil** | Sans compte : présentation et invitation à connecter. Avec : occupation, transferts en cours, derniers fichiers, favoris |
| **Clouds** | Comptes Google connectés : quota réel, état, renommage, déconnexion ; connexion d’un nouveau compte |
| **Tous les fichiers** | Explorateur navigable : fil d’Ariane, retour, recherche, tri, filtres par type, sélection multiple ; dossiers Google Drive chargés à la demande ; sous-vue **Partagés avec moi** (ce que d’autres ont partagé avec le compte, indépendamment de vos dossiers) |
| **Téléchargements** | File unifiée : progression, débit, pause/reprise, annulation ; transferts Google Drive réellement écrits sur le disque, y compris **un dossier entier** (arborescence conservée) |
| **Favoris** | Collection multi-comptes, recherche, répartition par type |
| **Récents** | Flux transversal des derniers fichiers **modifiés** (7 / 30 / 90 jours), filtre par nom, téléchargement direct ; la limite de l’API — Google ne transmet pas la date d’ouverture — est écrite sur l’écran |
| **Stockage** | Espace **total** du compte (Drive + Gmail + Photos) et répartition mesurée par type de fichier ; ce qui n’est pas mesurable est annoncé comme tel, jamais estimé |
| **Paramètres** | Thème sombre/clair, densité, dossier cible, transferts simultanés, réinitialisation |

Raccourcis : `Ctrl+1…6`, `Ctrl+,`, `Ctrl+A` (sélection), `Échap`, `?`.

La recherche de l’explorateur couvre **tous les comptes** : chaque résultat affiche
son cloud, son compte et son chemin ; un clic bascule automatiquement sur le bon compte.

**Télécharger un dossier entier.** La commande se trouve sur chaque dossier réel
(icône dédiée dans la liste, ou bouton « Télécharger » sur une sélection). Le
dossier n’est pas lu par l’interface : le processus principal en parcourt
l’arborescence et renvoie un **plan** — nombre de fichiers, sous-dossiers, taille
totale — affiché avant tout transfert. Rien ne s’écrit avant la confirmation.
Chaque fichier arrive à sa place (`Téléchargements/Projets/2026/Devis.pdf`) ; les
documents Google natifs sont comptés puis écartés, et un dossier très volumineux
annonce un plan partiel plutôt que de bloquer la fenêtre.

**Récents.** Un flux unique, tous comptes confondus, trié par date de modification.
La nuance est assumée et écrite sur l’écran : Google Drive n’expose **pas** la
date d’ouverture d’un fichier, seulement sa date de modification. Un fichier
consulté tous les jours mais jamais modifié n’y apparaîtra donc pas — c’est une
limite de l’API, pas un oubli. Les fenêtres proposées (7 / 30 / 90 jours)
bornent la requête côté Google, et un plafond de 200 éléments borne le volume.

**Partagés avec moi.** Un fichier qu’une autre personne partage avec vous n’est
rangé dans aucun de vos dossiers : sans cette vue, il resterait invisible dans
l’application. L’entrée apparaît sous le compte concerné, dans le volet des
comptes de l’explorateur. La liste vient de la requête Drive `sharedWithMe = true`
(triée par date de modification) ; double-cliquer sur un dossier partagé l’ouvre
comme n’importe quel dossier.

## Architecture

```
src/
├── data/catalog.ts     Fournisseurs, types de fichiers, modèle de compte
├── lib/
│   ├── format.ts       Formatage FR (octets, dates, pourcentages)
│   ├── tree.ts         Helpers d’arborescence (aplatissement, parcours)
│   ├── downloads.ts    File de transferts et suivi de leur progression réelle
│   ├── bridge.ts       Pont typé vers Electron (aucun jeton ne le traverse)
│   ├── google.ts       Conversion compte/fichier Google → modèle de l’interface
│   └── remote.ts       Cache des dossiers Drive chargés à la demande
├── store.tsx           État global (reducer), persistance locale, catalogue dérivé
├── hooks/useGoogle.ts  État du client OAuth, ajout de compte, déconnexion
├── components/         Sidebar, barre d’état, modale, toasts, dialogues Google,
│                       préparation d’un téléchargement de dossier
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
    ├── tree.ts         Parcours d'un dossier pour un téléchargement en lot (plan)
    ├── storage.ts      Répartition du stockage : quota exact + sommes bornées
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

### Ajouter un fournisseur plus tard

L’architecture multi-fournisseurs est conservée : `PROVIDERS` dans
`src/data/catalog.ts`, la barre latérale et les fiches fournisseur fonctionnent
par identifiant. Ajouter MEGA revient à déclarer son entrée, à fournir un module
de lecture (comme `desktop/google/drive.ts`) et à brancher les actions du
reducer (`account/sync`, `downloads/add`, `favorite/toggle`). Aucun composant
d’interface n’est à réécrire.
