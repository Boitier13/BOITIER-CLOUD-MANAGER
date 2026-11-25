/** Formatage FR, sans dépendance externe. */

const numberFr = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const integerFr = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

const dateFr = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const dateShortFr = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
});

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 o';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  const formatted = value.toLocaleString('fr-FR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${formatted} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatNumber(value: number): string {
  return integerFr.format(value);
}

export function formatDecimal(value: number): string {
  return numberFr.format(value);
}

export function formatDate(iso: string): string {
  return dateFr.format(new Date(iso));
}

export function formatShortDate(iso: string): string {
  return dateShortFr.format(new Date(iso));
}

export function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 2) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'hier';
  if (days < 7) return `il y a ${days} j`;
  if (days < 31) return `il y a ${Math.round(days / 7)} sem.`;
  return formatDate(iso);
}

export function percent(value: number): string {
  return `${Math.round(value * 100)} %`;
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${formatNumber(count)} ${count > 1 ? (pluralForm ?? `${singular}s`) : singular}`;
}

export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function fileTypeLabel(type: string): string {
  switch (type) {
    case 'folder':
      return 'Dossier';
    case 'video':
      return 'Vidéo';
    case 'document':
      return 'Document';
    case 'image':
      return 'Image';
    case 'archive':
      return 'Archive';
    case 'audio':
      return 'Audio';
    case 'subtitle':
      return 'Sous-titre';
    default:
      return 'Fichier';
  }
}

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function folderLabel(path: string[]): string {
  return path.length ? `/${path.join('/')}` : 'Racine du compte';
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
