/**
 * Messages d'erreur destinés à l'écran.
 *
 * Une erreur remontée par le processus principal arrive encapsulée par
 * Electron : `Error invoking remote method 'mega:list': Error: EBLOCKED (-16):
 * User blocked`. Affiché tel quel sous le titre « Google Drive est
 * injoignable », cela ne dit rien à personne et se trompe même de
 * fournisseur. Ce module traduit, une fois pour toutes.
 */

/** Préfixe ajouté par Electron autour de toute erreur IPC. */
const PREFIXE_IPC = /^Error invoking remote method '[^']*':\s*/;
/** Préfixe `Error: ` éventuellement empilé plusieurs fois. */
const PREFIXE_ERREUR = /^Error:\s*/;

/** Codes MEGA écrits en clair dans le texte, quand `code` manque. */
const CODES_MEGA: { motif: RegExp; message: string }[] = [
  {
    motif: /EBLOCKED|\(-16\)/,
    message:
      'MEGA bloque temporairement ce compte (trop de connexions depuis la même adresse) : patientez quelques minutes, puis réessayez.',
  },
  { motif: /EEXPIRED|ESID|\(-15\)/, message: 'Session MEGA expirée : reconnectez ce compte.' },
  { motif: /EOVERQUOTA|\(-17\)/, message: 'Quota de transfert MEGA épuisé pour aujourd’hui.' },
  { motif: /ETOOMANY|\(-19\)/, message: 'Trop de connexions simultanées vers MEGA : réessayez dans un instant.' },
  { motif: /EMFAREQUIRED|\(-26\)/, message: 'MEGA demande un code de vérification en deux étapes.' },
  { motif: /EAGAIN|ETEMPUNAVAIL|\(-3\)|\(-4\)/, message: 'MEGA est momentanément indisponible : réessayez dans un instant.' },
  { motif: /ENOENT|\(-9\)/, message: 'Élément introuvable dans ce compte : il a peut-être été déplacé ou supprimé.' },
];

/** Erreurs réseau, reconnaissables à leur formulation. */
const RESEAU = /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|network|offline|internet/i;

/**
 * Nettoie et traduit une erreur avant affichage.
 *
 * Le texte d'origine est conservé quand il est déjà en français et lisible ;
 * sinon une phrase courte est renvoyée. Jamais de `EBLOCKED (-16)` à l'écran.
 */
export function messageLisible(cause: unknown): string {
  const brut =
    typeof cause === 'string' ? cause : ((cause as Error | null)?.message ?? '').toString();
  let texte = brut.trim();
  // Electron empile les préfixes ; deux passes suffisent, on en fait trois.
  for (let passe = 0; passe < 3; passe += 1) {
    texte = texte.replace(PREFIXE_IPC, '').replace(PREFIXE_ERREUR, '');
  }

  for (const { motif, message } of CODES_MEGA) {
    if (motif.test(texte)) return message;
  }
  if (RESEAU.test(texte)) {
    return 'Le réseau ne répond pas : vérifiez la connexion, puis réessayez.';
  }
  // Message déjà rédigé par l'application (français, ponctué).
  if (/[àâçéèêëîïôûùüÿœ]/i.test(texte) || /^(le|la|les|un|une|ce|cette|trop|session|quota|adresse|accès|compte|dossier|élément)\b/i.test(texte)) {
    return texte;
  }
  // Dernier recours : une erreur technique n'a pas sa place telle quelle.
  return 'Le fournisseur n’a pas répondu : réessayez dans un instant.';
}
