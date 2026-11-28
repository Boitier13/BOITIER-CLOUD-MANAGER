import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  Minus,
  MoreHorizontal,
} from 'lucide-react';
import type { FileNode } from '../../data/catalog';

export type SortKey = 'name' | 'type' | 'size' | 'date';
export type Sort = { key: SortKey; dir: 'asc' | 'desc' };

export const TYPE_FILTERS = [
  { id: 'all', label: 'Tout' },
  { id: 'folder', label: 'Dossiers' },
  { id: 'video', label: 'Vidéos' },
  { id: 'audio', label: 'Audio' },
  { id: 'application', label: 'Applications' },
  { id: 'document', label: 'Documents' },
  { id: 'image', label: 'Images' },
  { id: 'archive', label: 'Archives' },
] as const;

export type TypeFilter = (typeof TYPE_FILTERS)[number]['id'];

export function countForType(nodes: FileNode[], filter: TypeFilter): number {
  if (filter === 'all') return nodes.length;
  if (filter === 'folder') return nodes.filter((node) => node.children).length;
  return nodes.filter((node) => node.type === filter).length;
}

export function SortMenu({
  sort,
  onChange,
}: {
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onChange: (sort: { key: SortKey; dir: 'asc' | 'desc' }) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const options: { key: SortKey; dir: 'asc' | 'desc'; label: string }[] = [
    { key: 'name', dir: 'asc', label: 'Nom · croissant' },
    { key: 'name', dir: 'desc', label: 'Nom · décroissant' },
    { key: 'date', dir: 'desc', label: 'Modification récente' },
    { key: 'date', dir: 'asc', label: 'Modification ancienne' },
    { key: 'size', dir: 'desc', label: 'Taille décroissante' },
    { key: 'size', dir: 'asc', label: 'Taille croissante' },
    { key: 'type', dir: 'asc', label: 'Type de fichier' },
  ];
  const current = options.find((option) => option.key === sort.key && option.dir === sort.dir);

  return (
    <div className="sortmenu" ref={ref}>
      <button
        type="button"
        className={`btn btn--sm${open ? ' is-open' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <ArrowUpDown size={12} />
        <span className="sortmenu__label">{current?.label ?? 'Trier'}</span>
        <ChevronDown size={12} className="sortmenu__caret" />
      </button>
      {open ? (
        <div className="sortmenu__list" role="listbox">
          {options.map((option) => {
            const active = option.key === sort.key && option.dir === sort.dir;
            return (
              <button
                key={`${option.key}-${option.dir}`}
                type="button"
                role="option"
                aria-selected={active}
                className={`sortmenu__item${active ? ' is-active' : ''}`}
                onClick={() => {
                  onChange({ key: option.key, dir: option.dir });
                  setOpen(false);
                }}
              >
                {option.label}
                {active ? <Check size={12} strokeWidth={2.6} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Fil d'Ariane : le dossier courant et le compte restent toujours accessibles,
 * les niveaux intermédiaires se replient dans un menu compact.
 */
export function Breadcrumbs({
  accountName,
  brand,
  path,
  onRoot,
  onNavigate,
}: {
  accountName: string;
  brand: string;
  path: string[];
  onRoot: () => void;
  onNavigate: (target: string[]) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuOpen]);

  const collapsed = path.length > 2;
  const visible = collapsed ? path.slice(-2) : path;
  const hidden = collapsed ? path.slice(0, -2) : [];
  const hiddenStart = path.length - 2;

  const renderCrumb = (segment: string, indexIn_path: number) => {
    const isLast = indexIn_path === path.length - 1;
    return (
      <span className="crumb-seg" key={`${segment}-${indexIn_path}`}>
        <span className="crumb-sep">
          <ChevronRight size={12} />
        </span>
        <button
          type="button"
          className={`crumb${isLast ? ' is-current' : ''}`}
          title={segment}
          onClick={() => {
            if (!isLast) onNavigate(path.slice(0, indexIn_path + 1));
          }}
        >
          {segment}
        </button>
      </span>
    );
  };

  return (
    <nav className="crumbs" aria-label="Fil d’Ariane">
      <button
        type="button"
        className={`crumb crumb--root${path.length === 0 ? ' is-current' : ''}`}
        onClick={onRoot}
        title={accountName}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: 99,
            background: brand,
            flex: 'none',
          }}
        />
        <span className="crumb__label">{accountName}</span>
      </button>

      {hidden.length ? (
        <span className="crumb-seg" ref={menuRef}>
          <span className="crumb-sep">
            <ChevronRight size={12} />
          </span>
          <button
            type="button"
            className="crumb crumb--ellipsis"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Afficher les dossiers parents"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={13} />
          </button>
          {menuOpen ? (
            <div className="crumb-menu">
              <div className="crumb-menu__label">Remonter à</div>
              {hidden.map((segment, index) => (
                <button
                  key={`${segment}-${index}`}
                  type="button"
                  className="crumb-menu__item"
                  onClick={() => {
                    setMenuOpen(false);
                    onNavigate(path.slice(0, hiddenStart + index + 1));
                  }}
                >
                  <Folder size={12} />
                  {segment}
                </button>
              ))}
            </div>
          ) : null}
        </span>
      ) : null}

      {visible.map((segment, index) =>
        renderCrumb(segment, collapsed ? hiddenStart + index : index),
      )}
    </nav>
  );
}

export function Checkbox({
  checked,
  mixed,
  onChange,
  label,
}: {
  checked: boolean;
  mixed: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      className={`checkbox${checked ? ' is-checked' : ''}${mixed ? ' is-mixed' : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        onChange();
      }}
    >
      {mixed ? (
        <Minus size={9} />
      ) : checked ? (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="m4 12 5.5 5.5L20 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </button>
  );
}

export function ProviderDot({ brand }: { brand: string }) {
  return (
    <span
      style={{
        width: 5,
        height: 5,
        borderRadius: 99,
        background: brand,
        display: 'inline-block',
        flex: 'none',
      }}
    />
  );
}

export function labelFor(node: FileNode): string {
  const labels: Record<string, string> = {
    video: 'Vidéo',
    document: 'Document',
    image: 'Image',
    archive: 'Archive',
    audio: 'Audio',
    subtitle: 'Sous-titre',
    application: 'Application',
    other: 'Fichier',
  };
  return labels[node.type] ?? 'Fichier';
}
