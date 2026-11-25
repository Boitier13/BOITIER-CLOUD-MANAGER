import {
  Captions,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
} from 'lucide-react';
import { PROVIDERS, type FileType, type ProviderId } from '../data/catalog';

const TYPE_ICONS: Record<FileType, typeof File> = {
  folder: Folder,
  video: FileVideo,
  document: FileText,
  image: FileImage,
  archive: FileArchive,
  audio: FileAudio,
  subtitle: Captions,
  other: File,
};

export function TypeIcon({
  type,
  size = 14,
  small = false,
}: {
  type: FileType;
  size?: number;
  small?: boolean;
}) {
  const Icon = TYPE_ICONS[type] ?? File;
  return (
    <span className={`type-icon type-icon--${type}${small ? ' type-icon--sm' : ''}`}>
      <Icon size={size} strokeWidth={type === 'folder' ? 1.9 : 1.7} />
    </span>
  );
}

export function ProviderMark({
  provider,
  size = 'md',
}: {
  provider: ProviderId;
  size?: 'sm' | 'md' | 'lg';
}) {
  const def = PROVIDERS[provider];
  const letter = def.id === 'gdrive' ? 'G' : def.name.charAt(0).toUpperCase();
  return (
    <span
      className={`provider-mark${size === 'sm' ? ' provider-mark--sm' : size === 'lg' ? ' provider-mark--lg' : ''}`}
      style={{ ['--brand' as string]: def.brand }}
      aria-hidden
    >
      {letter}
    </span>
  );
}

export function Meter({
  value,
  tall = false,
  tone,
}: {
  value: number;
  tall?: boolean;
  tone?: string;
}) {
  const ratio = Math.max(0, Math.min(1, value));
  return (
    <div
      className={`meter${tall ? ' meter--tall' : ''}${ratio >= 0.9 ? ' is-full' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
    >
      <div
        className="meter__fill"
        style={{
          width: `${Math.max(ratio * 100, ratio > 0 ? 1.5 : 0)}%`,
          ...(tone ? { ['--meter-color' as string]: tone } : {}),
        }}
      />
    </div>
  );
}
