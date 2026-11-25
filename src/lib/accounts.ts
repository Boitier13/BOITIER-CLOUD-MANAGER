/**
 * Reconnaissance d'un compte Google à partir des adresses qu'on lui connaît.
 *
 * Gmail applique deux règles qu'on ne peut pas ignorer quand on gère plusieurs
 * comptes :
 *
 *   1. **Les points sont ignorés** : `first.boitier1@gmail.com` est
 *      `firstboitier1@gmail.com`.
 *   2. **Le `+` coupe l'adresse** : `firstboitier1+2@gmail.com` arrive dans la
 *      boîte de `firstboitier1@gmail.com`, avec le même Drive, le même quota.
 *
 * En pratique : demander `firstboitier1+2@gmail.com`, c'est demander
 * `firstboitier1@gmail.com`. Google renvoie d'ailleurs toujours l'adresse
 * principale, jamais l'alias.
 *
 * Ce module ne **détecte** pas les alias : il les *reconnaît* quand Google
 * renvoie deux adresses. La différence compte — une détection approximative
 * pourrait fusionner deux comptes réellement distincts, alors qu'une adresse
 * renvoyée par Google est une preuve.
 *
 * Aucun import ici : ce fichier est utilisé par le processus principal (Node) et
 * par l'interface (navigateur, aperçu sans pont).
 */

/**
 * Forme canonique d'une adresse Gmail, ou `null` si l'adresse n'est pas Gmail.
 *
 * On ne touche pas aux autres domaines : `boitier@monentreprise.fr` peut très
 * bien distinguer `jean+compta@` de `jean+paie@` avec des boîtes différentes.
 * Google Workspace peut aussi configurer ses propres règles.
 */
export function canonicalGmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = trimmed.slice(at + 1);
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return null;

  const plus = trimmed.indexOf('+', 0);
  const local = trimmed.slice(0, at);
  const withoutTag = plus >= 0 && plus < at ? local.slice(0, plus) : local;
  // Les points sont ignorés dans la partie locale, pour Gmail uniquement.
  const squashed = withoutTag.replace(/\./g, '');
  if (!squashed) return null;
  // `googlemail.com` et `gmail.com` désignent la même boîte.
  return `${squashed}@gmail.com`;
}

/** Vrai si l'adresse est une variante `+` ou à points d'une autre adresse. */
export function looksLikeGmailVariant(email: string): boolean {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = trimmed.slice(at + 1);
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return false;
  return trimmed.slice(0, at).includes('+') || trimmed.slice(0, at).includes('.');
}

export type AliasCheck = {
  /** Compte déjà connu qui correspond à cette adresse, s'il y en a un. */
  duplicateOf?: { id: string; email: string };
  /** Vrai si l'adresse saisie passera par une variante (`+` ou points). */
  variant: boolean;
};

/**
 * Cherche, parmi les comptes déjà connectés, celui que cette adresse désigne.
 *
 * `known` contient les adresses telles que Google les a renvoyées. On compare
 * sur la forme canonique : c'est ce qui fait apparaître qu'une adresse `+2`
 * désigne un compte déjà présent.
 */
export function findAlias(
  email: string,
  known: { id: string; email: string }[],
): AliasCheck {
  const variant = looksLikeGmailVariant(email);
  const canonical = canonicalGmail(email);
  if (!canonical) return { variant };
  const match = known.find((item) => canonicalGmail(item.email) === canonical);
  return {
    ...(match ? { duplicateOf: { id: match.id, email: match.email } } : {}),
    variant,
  };
}

/**
 * Couleur stable associée à un compte.
 *
 * Deux adresses voisines (`boitierfirst7`, `boitierfirst8`, `boitierfirst82`) se
 * ressemblent au point de se confondre dans une liste. Une teinte calculée sur
 * l'adresse reste la même d'une session à l'autre, sans rien stocker.
 *
 * Les teintes sont volontairement désaturées et de luminosité voisine : elles
 * servent de repère, pas de décoration.
 */
const MARKS = [
  '#6b93e0', // bleu
  '#5aa9a0', // turquoise
  '#8f7fd0', // violet
  '#c08a5a', // ambre
  '#6aa86a', // vert
  '#c07a8a', // rose
  '#8a93a8', // ardoise
  '#b09a5a', // ocre
] as const;

export function accountMark(email: string): string {
  const key = canonicalGmail(email) ?? email.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 100000;
  }
  return MARKS[hash % MARKS.length];
}

/** Nom court lisible : la partie avant le `@`, tronquée proprement. */
export function shortAddress(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local.length > 22 ? `${local.slice(0, 21)}…` : local;
}

/**
 * Nom lisible d'un compte, quand Google n'en fournit pas d'assez distinctif.
 *
 * Deux comptes d'une même personne portent souvent le même nom d'affichage
 * (« saturnin youkpo »), ce qui rend la liste illisible. On ajoute donc les
 * chiffres de l'adresse quand ils manquent, et on met une majuscule à chaque
 * mot : `saturninyoukpo13@gmail.com` devient « Saturnin Youkpo13 ».
 *
 * Un nom déjà distinctif (`Boitier First7`) n'est pas modifié.
 */
export function suggestedName(info: { name?: string; email: string }): string {
  const base = titleCase(info.name?.trim() || info.email.split('@')[0] || info.email);
  const local = info.email.split('@')[0] ?? '';
  const trailing = /\d+$/.exec(local)?.[0];
  if (!trailing) return base;
  // Les chiffres figurent déjà dans le nom : rien à ajouter.
  if (base.endsWith(trailing)) return base;
  return `${base}${trailing}`;
}

/** Majuscule au premier caractère de chaque mot, sans toucher au reste. */
function titleCase(value: string): string {
  return value.replace(/(^|[\s._-])([\p{Ll}])/gu, (_match, sep: string, letter: string) =>
    `${sep}${letter.toUpperCase()}`,
  );
}
