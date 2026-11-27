import assert from 'node:assert/strict';
import { appendUniqueNodes } from '../../src/lib/uniqueNodes.ts';

// Compter les lectures d'identifiant vérifie la complexité sans imposer un
// délai fragile dépendant de la vitesse du PC ou de la CI.
let reads = 0;
const make = (id) => ({ get id() { reads++; return id; }, name: `fichier ${id}` });
const large = Array.from({ length: 25_000 }, (_, i) => make(`id-${i}`));
const dest = [], ids = new Set();
appendUniqueNodes(dest, large, ids);
assert.equal(dest.length, large.length);
appendUniqueNodes(dest, [large[0], make('dernier'), large[large.length - 1]], ids);
assert.equal(dest.length, large.length + 1);
assert.equal(dest.at(-1).name, 'fichier dernier');
assert.ok(reads <= 3 * (large.length + 3), `trop de comparaisons : ${reads}`);
console.log('✔ grand catalogue : ordre et dédoublonnage linéaire vérifiés (25 000 éléments)');
