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
import shadowDriveLogo from '../assets/shadow-drive.png?inline';

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

/**
 * Logo officiel d'un fournisseur.
 *
 * Les initiales dans un carré coloré ne se distinguaient pas assez (un `G` et
 * un `M` se ressemblent, et la couleur du cadre était la seule différence) :
 * chaque cloud porte donc son vrai logo, reconnaissable au premier regard, y
 * compris en petite taille dans la barre latérale.
 *
 * Un fournisseur pas encore dessiné reçoit un nuage neutre — jamais une
 * initiale — pour que l'ajout de Shadow Drive et TeraBox ne casse pas
 * l'ensemble.
 */
function ProviderLogo({ provider }: { provider: ProviderId }) {
  if (provider === 'gdrive') {
    // Triangle tricolore officiel : vert à gauche, jaune à droite, bleu en bas.
    return (
      <svg viewBox="0 0 24 24" aria-hidden focusable="false">
        <path d="M12 2.4 2.7 18.6 12 13.2Z" fill="#34a853" />
        <path d="M12 2.4 21.3 18.6 12 13.2Z" fill="#fbbc04" />
        <path d="M2.7 18.6h18.6L12 13.2Z" fill="#4285f4" />
      </svg>
    );
  }
  if (provider === 'shadow') return <img src={shadowDriveLogo} alt="" />;
  if (provider === 'mega') {
    // Le « M » rouge de MEGA, tracé comme une arête double.
    return (
      <svg viewBox="0 0 24 24" aria-hidden focusable="false">
        <path
          d="M4 18.4V7.2l4.3 4.3L12 7.2l3.7 4.3L20 7.2v11.2"
          fill="none"
          stroke="#d9272e"
          strokeWidth="2.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        d="M7 18.5a4.5 4.5 0 0 1-.5-8.97 5.5 5.5 0 0 1 10.6 1.3A3.9 3.9 0 0 1 17 18.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
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
  return (
    <span
      className={`provider-mark${size === 'sm' ? ' provider-mark--sm' : size === 'lg' ? ' provider-mark--lg' : ''}`}
      style={{ ['--brand' as string]: def.brand }}
      title={def.name}
      role="img"
      aria-label={def.name}
    >
      <ProviderLogo provider={provider} />
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
