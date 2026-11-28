# TeraBox : intégration Web expérimentale et non officielle

Intégration provisoire **non officielle**, isolée pour faciliter un éventuel
remplacement par l'API officielle. Sous Windows, l'utilisateur a confirmé la
connexion et la persistance de trois comptes distincts, l'exploration, les
quotas et plusieurs téléchargements de fichiers et dossiers. Ces essais ne
prouvent pas la compatibilité de tous les comptes, types de fichiers ou hôtes.
La demande officielle reste en attente ; ses conditions et possibilités ne sont
pas confirmées. TeraBox peut modifier son site, ses conditions ou imposer des
vérifications/restrictions ; aucun CAPTCHA ni limitation d'offre n'est contourné.

- `login.ts` : fenêtre de connexion locale dans une partition Electron en
  mémoire distincte pour chaque tentative, sans Node ni preload. L'utilisateur
  ferme la fenêtre une fois connecté ; seul le processus principal récupère le
  cookie de session. Les différentes méthodes d’authentification et vérifications
  ne sont pas toutes validées. Aucun mot de passe ou session ne doit être demandé
  dans le chat, ni journalisé, ni envoyé à un tiers.
- `vault.ts` : coffre séparé chiffré par le système ; impossibilité d'écrire si
  le coffre est illisible ou si le chiffrement est indisponible. Les comptes ne
  sont pas créés depuis une simple adresse ; l'identité est vérifiée auprès de
  TeraBox, notamment lors d'une reconnexion.
- `provider.ts` et `service.ts` : contrat de lecture et façade séparés du
  protocole Web, comptes isolés, exploration, recherche et plan de dossier bornés.
- `web-client.ts` : session envoyée uniquement à `*.terabox.com`, sans
  redirections pour les appels API. Les liens de téléchargement sont sensibles,
  non exposés à l'interface ; pour l'instant seuls les hôtes HTTPS
  `terabox.com` et ses sous-domaines sont autorisés, sans cookie sur le flux.
  Les redirections sont contrôlées à chaque étape. Des hôtes CDN réels ou un
  besoin de cookie peuvent rendre les téléchargements impossibles ; ne jamais
  élargir cette liste sans vérifier leur appartenance et leurs exigences.
- Le gestionnaire de transferts vérifie la taille avant publication du fichier ;
  une reprise repart de zéro. La taille ne constitue pas une vérification
  cryptographique d'intégrité. Les dossiers vides sont préparés localement.
- `desktop/test/terabox-web.mjs` et le parcours d'interface utilisent des
  réponses simulées, y compris trois comptes distincts : ils ne prouvent pas
  la compatibilité du site réel, ni le fonctionnement de la fenêtre de connexion.

La branche prépare aussi un installeur Windows de test, comme artefact GitHub
Actions (pas une release ni une mise à jour). L'installeur utilise un identifiant,
un raccourci, un dossier de données et un profil Chromium différents de la
version stable ; ses mises à jour sont désactivées. Les comptes existants dans
l'application stable ne sont donc pas automatiquement visibles dans cette copie.
Les téléchargements utilisent le dossier habituel et ne remplacent pas les
fichiers existants.

Avant une diffusion large : vérifier les conditions d'utilisation et étendre
les essais réels (méthodes d’authentification, recherche, hôtes CDN, erreurs,
interruptions et reprise). La compatibilité de `/api/filemetas` n’est pas
garantie pour tous les comptes. Ne jamais consigner les cookies ni
les URL signées. Une réponse HTML de vérification ne doit pas être publiée
comme fichier téléchargé.

L'API officielle pourra nécessiter un adaptateur et un coffre OAuth distincts.
Une migration future devra vérifier explicitement l'identité et les références
locales : l'API officielle pourrait avoir un périmètre, des chemins et des
identifiants différents. Les favoris et transferts ne sont pas automatiquement
migrables.

Sources d'étude : https://github.com/seiya-npm/terabox-api (MIT),
https://github.com/seiya-dev/terabox-node,
https://github.com/rclone/rclone/pull/8508 et
https://www.terabox.com/integrations/docs (API officielle distincte).

## File de transferts expérimentale

La file limite les lancements réels depuis l'interface, tous fournisseurs
confondus, selon le réglage (1 à 6). Les changements à la baisse ne coupent pas
les flux déjà actifs ; ils attendent que le nombre redescende. Pause, reprise,
annulation et erreurs sont couvertes par des essais simulés. Lors d'un
rechargement ou d'un crash de l'interface, le processus principal demande la
pause des flux actifs et bloque les nouveaux départs jusqu'à leur arrêt. Après
30 secondes d'attente, un nouveau départ échoue explicitement plutôt que de
contourner cette barrière ; il peut être retenté après l'arrêt des anciens flux.
La file elle-même ne survit pas au rechargement : les transferts en attente ne
sont pas automatiquement restaurés, et les fichiers partiels peuvent rester
sur le disque. Relancer les téléchargements depuis les fichiers si nécessaire.
Le comportement après rechargement et les notifications d’annulation restent à confirmer sous Windows.
