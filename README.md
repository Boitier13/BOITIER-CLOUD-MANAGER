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
| Pause et reprise | Une pause arrête le flux et **conserve le fichier partiel** ; la reprise demande à Drive la suite (`Range`) et repart de l’octet reçu. Seule l’annulation efface ce qui a été reçu. Si le serveur ignore la plage, le partiel est remplacé — jamais allongé. |
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
  explicite, au lieu d'attendre indéfiniment ;
- **une notification Windows annonce la fin du transfert**, réussite ou échec,
  avec le nom du fichier et sa taille. Elle n'est pas conditionnée au premier
  plan : un transfert long se termine rarement sous les yeux de l'utilisateur,
  et l'écran des téléchargements reste ouvert pendant ce temps. Un clic sur la
  bulle ramène la fenêtre. Si Windows refuse l'affichage, la raison est écrite
  dans le journal (`notification : refusée par Windows — …`) au lieu de
  disparaître en silence.

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

### Neuf comptes, tous visibles

Sur l'écran **Stockage**, le sélecteur de compte ne défile plus horizontalement
(le neuvième compte sortait de l'écran) : les onglets passent à la ligne
suivante, libellés intacts, avec un espacement vertical serré (4 px) pour que
les rangées se lisent comme une seule liste.

### Rangement des téléchargements

Chaque fichier est rangé par cloud puis par nature, sous le dossier de base :

```
C:\Users\…\Downloads\Google Drive\Videos
C:\Users\…\Downloads\Google Drive\Documents
```

Videos, Audio, Images, Documents, Archives, Sous-titres, Autres. **Aucun accent
dans les noms de dossiers** : un `é` traverse mal un ZIP, un partage réseau ou un
enchaînement de commandes. Un dossier
téléchargé en entier conserve son arborescence, sous le nom du cloud. Le
réglage **Ranger par cloud et par type** (Paramètres, actif par défaut) permet
de revenir à un dossier unique.

### Recherche : tous les comptes, ou un seul

Un écran **Recherche** (menu de gauche, ou `Ctrl + 7`) interroge **tous** les
comptes d'un coup, ou **un seul** — les deux portées coexistent, il suffit de
choisir un onglet.

- la frappe est laissée tranquille **400 ms** avant d'interroger : neuf comptes
  fois chaque lettre serait un gaspillage ;
- les résultats sont **regroupés par compte**, avec la date, la taille et la
  nature de chaque fichier ;
- **Ouvrir le dossier** mène à l'emplacement réel du fichier : Drive ne renvoie
  jamais un chemin, seulement l'identifiant du dossier parent, que l'application
  remonte jusqu'à la racine du compte (`google:locate`) ;
- **Télécharger** range le fichier comme n'importe quel autre transfert ;
- un compte qui refuse (autorisation expirée, quota) est **annoncé** sous les
  résultats, jamais passé sous silence.

Le champ de l'explorateur reste ce qu'il était : la recherche dans un compte,
sur la vue courante.

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

## MEGA

MEGA est connecté comme un fournisseur à part entière : il apparaît dans la
barre latérale, l'explorateur le parcourt comme Google Drive, et ses transferts
partagent la même file, la même progression et les mêmes reprises.

**Connexion.** MEGA n'a pas d'OAuth : il faut l'adresse et le mot de passe du
compte (un compte gratuit suffit). La vérification en deux étapes est demandée
seulement si MEGA la réclame, au lieu d'échouer sur un code d'erreur.

**Ce qui est conservé.** Le **mot de passe n'est jamais enregistré**. Ce qui est
écrit sur le disque est la *session* obtenue — clé maître et identifiant de
session — chiffrée par Windows (DPAPI) dans
`%APPDATA%\BOITIER CLOUD MANAGER\mega-sessions.enc`. Conséquence assumée : si
vous changez votre mot de passe MEGA ou fermez la session ailleurs, la session
locale devient invalide et l'application redemande le mot de passe. Elle ne
reconnecte jamais silencieusement un compte que MEGA a révoqué.

**Lecture et téléversement.** Dossiers, recherche, ouverture de fichier et
téléchargement fonctionnent comme chez Google, avec la même garantie : un
fichier n'apparaît qu'entier (écriture en `.part`, puis renommage), et une pause
conserve le partiel. L'envoi se fait par le bouton **Envoyer sur MEGA**, présent
sur les dossiers MEGA : le choix du fichier passe par la boîte de dialogue du
système, la progression s'affiche, et le dossier est relu à la fin.

**Dossier entier.** Un dossier MEGA se télécharge aussi d'un bloc, avec le même
dialogue que chez Google : le plan (nombre de fichiers, sous-dossiers, taille)
est calculé avant tout transfert, puis chaque fichier arrive à sa place dans
l'arborescence.

**Ce que MEGA ne permet pas ici.** Ni suppression ni déplacement ni renommage :
l'application ne fait que lire, télécharger et envoyer. Les dossiers partagés
d'un autre compte ne sont pas listés — MEGA n'a pas d'équivalent au « partagé
avec moi » de Drive.

**Limites des comptes gratuits.** MEGA applique un **quota de transfert**
distinct du stockage : au-delà, les téléchargements et les envois sont refusés.
L'erreur est traduite en clair (« quota de transfert MEGA épuisé pour
aujourd'hui ») au lieu d'afficher un code négatif, et le partiel déjà reçu reste
sur le disque pour la reprise du lendemain.

### Téléverser : ce que l'application ne fait pas

L'application demande une seule autorisation, `drive.readonly` : elle ne peut
techniquement rien écrire chez Google — ni renommer, ni supprimer, ni envoyer.
Le bouton **Ouvrir dans Drive** comble le manque sans changer cette promesse :
il ouvre le dossier consulté dans Google Drive, où le glisser-déposer est prévu
pour cela. Aucune reconnexion de compte n'est nécessaire.

### Les comptes ne doivent jamais disparaître

Un incident réel : après la connexion de 11 comptes MEGA, la liste est tombée de
9 à 2 comptes Google. Trois défauts pouvaient produire ce genre de perte ; les
trois sont désormais interdits.

| Défaut possible | Correction |
| --- | --- |
| La synchronisation Google retirait **tout compte « réel » absent du coffre** — depuis que MEGA est un fournisseur réel, cela effaçait les comptes MEGA à chaque démarrage | la règle ne concerne plus que les comptes Google, et vit dans `src/lib/accountSync.ts`, vérifiée par un test |
| Un **échec** d'appel au processus principal était confondu avec « aucun compte » : la liste vide effaçait alors tous les comptes de l'écran | `probeAccountsStrict()` distingue les deux ; sur un échec, la synchronisation **s'abstient** |
| Un coffre **illisible** (profil Windows, antivirus, fichier verrouillé) repartait d'un coffre vide, et la première écriture écrasait les jetons | un coffre illisible **refuse toute écriture**, une copie de secours `.bak` est tenue à jour et restaurée au lancement, et les écritures sont sérialisées |

Le journal de démarrage dit désormais, à chaque lancement :

```
coffre : 9 compte(s) Google relu(s)
```

et signale toute écriture qui ferait **baisser** ce nombre :

```
coffre : 2 compte(s) écrit(s), contre 9 avant
```

C'est la trace qui manquait pour comprendre une disparition. Un jeton Google ne
se reconstitue pas : si le coffre a réellement perdu des comptes, il faut les
reconnecter — mais l'application ne peut plus le faire en silence.

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
npm run desktop:test      # 154 contrôles : OAuth/PKCE, coffre chiffré, quota,
                          # adresses Gmail et alias,
                          # exploration, fichiers partagés, recherche,
                          # téléchargement réel, dossier entier, stockage,
                          # flux des récents, pause, reprise à l'octet reçu,
                          # révocation à la déconnexion, démarrage (journal,
                          # instance unique,
                          # écran de démarrage, chemin d'un résultat,
                          # recherche à deux portées, mise à jour
                          # automatique, trace avant chargement, verrou
                          # patient, défilement, traces de mise à jour,
                          # notification de fin de transfert, repères de
                          # démarrage, MEGA : session chiffrée et
                          # conversions de fichiers, coffre protégé contre
                          # la perte de comptes) —
                          # sans réseau, faux Google
npm run verify:interface  # les écrans sans compte, avec un compte simulé,
                          # avec neuf comptes, et la recherche à deux portées
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

`npm run verify:interface` parcourt les écrans dans cinq situations (sans
compte, avec un compte connecté simulé, avec neuf comptes, avec une mise à jour
prête, dans un navigateur), vérifie qu'aucun décor fictif ne subsiste, **saisit
une recherche** dans deux comptes simulés (regroupement, portée « un seul
compte », ouverture de l'emplacement réel) et vérifie qu'une mise à jour prête
ne s'installe **qu'après un clic**.

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

La fenêtre s'affiche **dès que le document est prêt**, et non plus après le
premier rendu de l'interface : l'écran de démarrage est du HTML dont les styles
sont en ligne, il ne dépend d'aucun fichier. Les anciennes mesures montraient
`fenêtre affichée +3483 ms` alors que l'écran de démarrage était prêt bien plus
tôt — la fenêtre restait simplement invisible.

Le journal découpe désormais le lancement en étapes datées :

```
chargement demandé · +352 ms
document prêt · +988 ms
fenêtre affichée (écran de démarrage) · +991 ms
document chargé · +4460 ms
interface : bundle exécuté (3820 ms) · +4210 ms
interface : premier rendu (4180 ms) · +4570 ms
interface : peinture (3900 ms) · +4571 ms
interface : polices prêtes (4300 ms) · +4702 ms
```

En cas de défaut, le journal suffit à savoir ce qui s'est passé — plus besoin de
deviner. Les échecs de chargement (`did-fail-load`) et les arrêts du processus
d'affichage sont également interceptés et expliqués, au lieu de laisser une
fenêtre vide.

### Lenteur et « l'application ne s'ouvre pas »

Le journal a montré deux choses distinctes, mesurées sur dix-sept lancements :

| Situation | Durée avant la fenêtre |
| --- | --- |
| lancement ordinaire | **0,7 s** |
| premier lancement après installation | **4 à 14 s** |

Le second cas est Windows lui-même : l'antivirus analyse un exécutable qu'il
n'a jamais vu. Aucun code ne peut accélérer cela — mais l'application peut
**montrer qu'elle démarre** au lieu de laisser l'écran vide :

- **écran de démarrage peint avec la page** : marque, « Préparation de vos
  comptes… », fine barre de progression — styles en ligne, aucun fichier à
  charger, donc visible en quelques dizaines de millisecondes ; il est retiré
  dès que l'interface prend la main. Une seconde fenêtre avait été essayée :
  elle s'affichait comme un carré vide, elle a été supprimée ;
- **thème appliqué avant le premier pixel** : le réglage enregistré est lu par
  un script en ligne, sans clignotement d'un thème vers l'autre ;
- **fond de fenêtre** aux couleurs du thème clair : plus d'aplat sombre devant
  une interface claire ;
- **journal ouvert avant le contrôle d'instance unique** : un lancement refusé
  laisse désormais une ligne (`une instance est déjà ouverte…`) au lieu de
  sortir en silence ;
- **second clic sur l'icône** : la fenêtre existante est restaurée, ramenée au
  premier plan et focalisée, au lieu de ne rien faire.

Ces points sont verrouillés par des contrôles automatiques, vus échouer avant
correction.

La version affichée dans **Paramètres → À propos** est lue dans `package.json`
au moment de la compilation : elle ne peut plus annoncer un numéro périmé.

### Mise à jour automatique

L'application vérifie d'elle-même, **douze secondes après le démarrage** puis
toutes les six heures, si une version plus récente est publiée. Rien ne bloque
l'interface : la vérification se fait en arrière-plan.

| Étape | Qui décide |
| --- | --- |
| vérification | l'application (au démarrage, puis toutes les 6 h) |
| téléchargement | l'application, en arrière-plan |
| **installation** | **vous**, par un clic sur « Redémarrer et installer » |

`autoInstallOnAppQuit` est explicitement désactivé : fermer la fenêtre
n'installe jamais une version que personne n'a demandée. L'installeur s'affiche
ensuite comme lors d'une installation habituelle, pour que rien ne se produise
en silence.

**Ce que le journal montre.** `demarrage.log` (dossier de données de
l'application, ajout seul, rotation à 64 Ko) reçoit chaque étape :

```
mise à jour : première vérification dans 12 s
mise à jour : vérification demandée
mise à jour : checking
mise à jour : available 0.22.5
mise à jour : downloading 0.22.5 0 %
mise à jour : downloading 0.22.5 40 %
mise à jour : downloading 0.22.5 90 %
mise à jour : ready 0.22.5
mise à jour : installation demandée 0.22.5
mise à jour : installeur lancé, fermeture de l’application
```

Deux règles apprises sur un journal réel : **une seule ligne par état
réellement différent** (la vérification était écrite deux fois, par notre code
et par la bibliothèque) et **la progression par paliers de 10 %** (elle était
écrite à chaque paquet — des centaines de lignes sur une connexion lente, qui
finissaient par effacer l'historique des démarrages à la rotation).

La ligne `installation demandée` est la seule preuve du clic : les états se
lisent déjà, mais pas l'intention. Si l'installeur refuse de partir, la ligne
`installeur impossible — …` et un message dans l'écran le disent, au lieu d'un
bouton qui semble n'avoir aucun effet.

**Ce que l'écran montre.** « À jour — version 0.22.3 vérifiée à 16 h 14 » :
l'heure compte, sans elle on ne distingue pas une vérification faite à
l'instant d'une vérification faite au démarrage. Pendant le téléchargement,
une barre de progression remplace le pourcentage qui sautait, et le bouton
annonce « Téléchargement… » plutôt que « Vérification… ».

**Le manifeste fait partie de la release.** `latest.yml` (et les `.blockmap`)
décrivent la version disponible et son empreinte. Le flux de publication les
joint à chaque version et **échoue** s'ils manquent : sans eux, l'application
verrait le dépôt sans jamais trouver de fichier à télécharger.

**Signature.** L'installeur n'est pas signé ; `win.verifyUpdateCodeSignature`
est donc désactivé **explicitement** dans la configuration de construction.
C'est le seul réglage honnête dans ce cas : sans lui, `electron-builder` 27
refuse de construire, et `electron-updater` 7 rejette toute mise à jour avec
`ERR_UPDATER_INVALID_SIGNATURE`. Conséquence assumée : l'empreinte SHA-512 de
`latest.yml` protège du téléchargement corrompu, **pas** d'un dépôt compromis.
Une signature de code (≈ 120 €/an chez Microsoft Trusted Signing) lèverait
cette limite ; elle n'est pas au programme.

**La bibliothèque est compilée dans le processus principal** (`esbuild`), pas
chargée depuis `node_modules` : l'archive n'embarque aucun module et
`desktop:test` vérifie qu'aucun `require('electron-updater')` ne subsiste dans
`desktop/dist/main.cjs`. Une dépendance laissée externe aurait produit une
application qui démarre puis échoue à la première vérification.

**Première installation manuelle.** Les versions ≤ 0.21.0 ne connaissent pas ce
mécanisme : il faut installer la 0.22.0 une dernière fois à la main. Ensuite,
les mises à jour arrivent seules, sans passer par la page des releases.

### Pourquoi « l'application ne s'ouvre pas » est désormais impossible en silence

L'installeur Windows ferme l'application avant de la remplacer, puis la relance
(case « Lancer l'application » cochée). Trois mécanismes produisaient le même
symptôme — rien à l'écran, aucune trace :

| Cause | Ce qui l'empêche maintenant |
| --- | --- |
| échec au chargement d'un module | `boot.ts` ouvre le journal **avant** de charger le code applicatif ; `uncaughtException` écrit la pile et montre une boîte de dialogue |
| l'ancien processus meurt encore, le verrou refuse | le verrou est retenté 6 fois sur ~8,5 s avant d'abandonner, et chaque tentative est journalisée |
| la page ne peint jamais | la fenêtre s'affiche de toute force après 2,5 s, et les messages d'erreur ne sont plus attachés à une fenêtre invisible |

Le journal `%APPDATA%\BOITIER CLOUD MANAGER\demarrage.log` contient donc, pour
chaque lancement : `processus démarré`, les tentatives de verrou, `fenêtre
affichée`, `interface prête`, puis les étapes de mise à jour.

### Une file vide ne doit réveiller personne

Défaut signalé : « l'application se fige beaucoup, elle est devenue instable ».

La cause tenait en une ligne : `advanceDownloads` construisait **un tableau neuf
à chaque appel**, et l'application l'appelait toutes les 900 ms. Un tableau
neuf, c'est un nouvel état global : toute l'interface repeinte et le stockage
local réécrit — indéfiniment, même quand aucun transfert n'avançait. Le
minuteur ne s'arrêtait jamais dès qu'un seul transfert, **même terminé**,
figurait dans la liste.

Trois corrections, chacune vérifiée par un contrôle :

| Avant | Après |
| --- | --- |
| tableau neuf à chaque tick | **même référence** quand rien ne change → aucun rendu |
| minuteur permanent (900 ms) | minuteur **uniquement** s'il reste un transfert à faire avancer |
| stockage réécrit à chaque point de progression | écriture sur changement **structurel** seulement |

S'y ajoute une sentinelle, en trois mesures complémentaires, parce qu'un gel
peut venir de deux endroits très différents :

| Mesure | Ce qu'elle attrape |
| --- | --- |
| minuteur de 500 ms | un gel franc de l'interface (> 600 ms) |
| observateur de tâches longues | les à-coups de 250 ms à 1 s, qui rendent pâteux sans arrêter |
| aller-retour `ping` toutes les 2 s | un **processus principal** bloqué : la fenêtre peint mais n'accepte plus rien |

Chaque ligne porte l'écran où cela s'est produit :

```
figement 2.3 s — interface · écran files
figement 0.9 s — tâche longue · écran clouds
figement 1.4 s — processus principal · écran settings
```

Le journal s'ouvre désormais depuis **Paramètres → Données locales → Journal de
démarrage → Ouvrir** : plus besoin de retrouver `%APPDATA%` à la main.

### Chaque étape du démarrage porte son temps

Depuis 0.22.5, le journal date chaque étape **en millisecondes depuis le
lancement du processus** :

```
processus démarré · 0.22.5 · installée · Electron 40.10.6
démarrage 0.22.5 · installée · Electron 40.10.6 · win32
fenêtre créée · +412 ms
document chargé · +1806 ms
interface prête · +1830 ms
fenêtre affichée (prête à peindre) · +1854 ms
```

Raison d'être : sur une installation réelle, la fenêtre s'affichait par le
filet de sécurité (`délai d'affichage atteint`) au lieu de `prête à peindre`, et
`document chargé` a mis une fois **9,8 secondes**. Sans mesure, impossible de
savoir si le temps se perd avant Electron, dans le chargement de la page, ou
dans les appels à Google. Mesurer d'abord, corriger ensuite.

### Le bas d'une page ne doit jamais être coupé

Défaut constaté sur deux captures : le bas des **Paramètres** (« Ranger par
cloud et par type ») et le **neuvième compte** de la page Google Drive
sortaient de la fenêtre, sans barre de défilement.

La cause n'est pas la mise en page mais une règle CSS manquante : dans une
colonne flexible, un enfant refuse de rétrécir sous la hauteur de son contenu
(`min-height: auto`). La zone de contenu ne pouvait donc pas défiler : elle
s'étirait et débordait de la fenêtre, qui la coupait.

```css
.app__main    { min-height: 0; overflow: hidden; }
.app__content { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
```

La hauteur minimale fixe du tableau (`min-height: 380px`) a également été
remplacée par une valeur relative : un texte agrandi à 130 % sur une fenêtre
courte forçait sinon un débordement. Trois contrôles verrouillent ces règles.

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
| **Clouds** | Comptes connectés — Google et MEGA : quota réel, état, renommage, déconnexion ; connexion d’un nouveau compte |
| **Tous les fichiers** | Explorateur navigable, quel que soit le fournisseur : fil d’Ariane, retour, recherche, tri, filtres par type, sélection multiple ; dossiers Google Drive chargés à la demande ; sous-vue **Partagés avec moi** (ce que d’autres ont partagé avec le compte, indépendamment de vos dossiers) |
| **Téléchargements** | File unifiée : progression, débit, pause/reprise, annulation ; transferts Google Drive et MEGA réellement écrits sur le disque, y compris **un dossier entier** (arborescence conservée) |
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

L’architecture multi-fournisseurs est désormais éprouvée par deux cas réels :
Google Drive (OAuth, lecture seule) et MEGA (adresse + mot de passe, envoi
compris). Ajouter un troisième fournisseur revient à :

1. déclarer son entrée dans `PROVIDERS` (`src/data/catalog.ts`) ;
2. écrire un module dans `desktop/<fournisseur>/` qui produit les mêmes formes
   que `RemoteFile` et `DownloadEvent` (voir `desktop/mega/files.ts`) ;
3. brancher les canaux dans `desktop/api.ts`, `desktop/preload.cjs` et
   `src/lib/bridge.ts` ;
4. ajouter son cas dans `src/lib/cloud.ts`, le seul endroit qui aiguille un
   appel vers un fournisseur.

Aucun écran n’est à réécrire : l’explorateur, la file de transferts, les
favoris, la recherche et le stockage ne connaissent que ces formes communes.
