import { PROVIDERS, type FileType, type ProviderId } from '../data/catalog';
import shadowDriveLogo from '../assets/shadow-reference.png?inline';
import teraboxLogo from '../assets/terabox-reference.png?inline';

/** Icônes pleines inspirées de l'explorateur Windows, sans lecture du fichier. */
export function TypeIcon({ type, name, small = false }: {
  type: FileType; name?: string; size?: number; small?: boolean;
}) {
  const match = name?.match(/\.([a-z0-9]{1,5})$/i);
  const extension = match?.[1].toUpperCase();
  return (
    <span className={`type-icon type-icon--${type}${small ? ' type-icon--sm' : ''}`} aria-hidden="true">
      {type === 'folder' ? (
        <svg viewBox="0 0 36 32" focusable="false"><path d="M2 7a3 3 0 0 1 3-3h9l3 3h14a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" fill="#d28a08"/><path d="M3 11h30l-2.5 14a3 3 0 0 1-3 2.5H5.5a3 3 0 0 1-3-3z" fill="#ffce49"/><path d="M4 12h27" stroke="#ffe58d" strokeWidth="2"/></svg>
      ) : (
        <span className="type-icon__page">
          <span className="type-icon__fold" />
          <span className="type-icon__badge">{extension ?? ({ video: 'VID', audio: 'AUD', document: 'DOC', image: 'IMG', archive: 'ZIP', subtitle: 'SUB', application: 'APP', other: 'FIC', folder: '' }[type] || 'FIC')}</span>
        </span>
      )}
    </span>
  );
}

function ProviderLogo({ provider }: { provider: ProviderId }) {
  if (provider === 'gdrive') return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <path fill="#008c50" d="M8.2 2h6l-8.8 15.3-3-5.2z"/>
      <path fill="#ffca36" d="M8.2 2h6L23 17.3h-6z"/>
      <path fill="#3978e8" d="M5.4 17.3H23l-3 5.2H2.4z"/>
    </svg>
  );
  if (provider === 'shadow') return <img src={shadowDriveLogo} alt="" />;
  if (provider === 'terabox') return <img src={teraboxLogo} alt="" />;
  if (provider === 'mega') return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="12" fill="#df1c2b" />
      <path d="M6.8 16.6V8.2h1.3L12 12l3.9-3.8h1.3v8.4h-2.1v-5.3L12 14.2l-3.1-2.9v5.3z" fill="#fff" stroke="#fff" strokeWidth=".7" strokeLinejoin="round" />
    </svg>
  );
  // Repli neutre si un fournisseur inconnu est ajouté plus tard.
  return <svg viewBox="0 0 24 24" aria-hidden focusable="false"><path d="M7 18.5a4.5 4.5 0 0 1-.5-9 5.5 5.5 0 0 1 10.6 1.3 3.9 3.9 0 0 1-.1 7.7Z" fill="none" stroke="currentColor" strokeWidth="1.7" /></svg>;
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
