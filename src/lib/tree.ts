import type { FileNode } from '../data/catalog';

export interface TreeEntry {
  node: FileNode;
  path: string[];
  parentPath: string[];
}

/** Aplatit une arborescence en conservant le chemin logique de chaque entrée. */
export function flattenTree(nodes: FileNode[], prefix: string[] = []): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const node of nodes) {
    const path = [...prefix, node.name];
    entries.push({ node, path, parentPath: prefix });
    if (node.children?.length) {
      entries.push(...flattenTree(node.children, path));
    }
  }
  return entries;
}

export function getChildren(tree: FileNode[], path: string[]): FileNode[] | null {
  if (path.length === 0) return tree;
  let level = tree;
  let current: FileNode | undefined;
  for (const segment of path) {
    current = level.find((node) => node.name === segment);
    if (!current) return null;
    level = current.children ?? [];
  }
  return current?.children ?? [];
}

export function getNode(tree: FileNode[], path: string[]): FileNode | undefined {
  if (path.length === 0) return undefined;
  const parent = getChildren(tree, path.slice(0, -1));
  return parent?.find((node) => node.name === path[path.length - 1]);
}

export function pathKey(accountId: string, path: string[]): string {
  return `${accountId}::${path.join('/')}`;
}

export function joinPath(path: string[]): string {
  return `/${path.join('/')}`;
}

export function countTree(nodes: FileNode[]): { files: number; folders: number } {
  let files = 0;
  let folders = 0;
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.children) {
        folders += 1;
        walk(node.children);
      } else {
        files += 1;
      }
    }
  };
  walk(nodes);
  return { files, folders };
}
