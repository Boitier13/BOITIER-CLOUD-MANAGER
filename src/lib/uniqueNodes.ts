/** Ajoute les nouveaux nœuds dans l'ordre, sans comparer chaque paire. */
export function appendUniqueNodes<T extends { id: string }>(
  destination: T[],
  source: readonly T[],
  ids: Set<string>,
): void {
  for (const node of source) {
    if (ids.has(node.id)) continue;
    ids.add(node.id);
    destination.push(node);
  }
}
