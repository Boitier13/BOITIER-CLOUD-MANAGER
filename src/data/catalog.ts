/**
 * Données fictives de démonstration.
 * Aucune connexion réseau : tout le catalogue est généré localement.
 */

export type ProviderId = 'mega' | 'gdrive' | 'shadow' | 'terabox';

export type AccountStatus = 'connected' | 'syncing' | 'expired';

export type FileType =
  | 'folder'
  | 'video'
  | 'document'
  | 'image'
  | 'archive'
  | 'audio'
  | 'subtitle'
  | 'other';

export const KB = 1024;
export const MB = 1024 * KB;
export const GB = 1024 * MB;
export const TB = 1024 * GB;

const DAY = 86_400_000;
const NOW = Date.now();

export interface Provider {
  id: ProviderId;
  name: string;
  prefix: string;
  brand: string;
  quota: number;
  domain: string;
  tagline: string;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  mega: {
    id: 'mega',
    name: 'MEGA',
    prefix: 'MEGA',
    brand: '#d4675f',
    quota: 20 * GB,
    domain: 'mega.demo',
    tagline: 'Stockage chiffré',
  },
  gdrive: {
    id: 'gdrive',
    name: 'Google Drive',
    prefix: 'DRIVE',
    brand: '#6b93e0',
    quota: 200 * GB,
    domain: 'gmail.demo',
    tagline: 'Documents et partages',
  },
  shadow: {
    id: 'shadow',
    name: 'Shadow Drive',
    prefix: 'SHADOW',
    brand: '#8b82d8',
    quota: 2 * TB,
    domain: 'shadow.demo',
    tagline: 'Médias volumineux',
  },
  terabox: {
    id: 'terabox',
    name: 'TeraBox',
    prefix: 'TERABOX',
    brand: '#5aa7bd',
    quota: 1 * TB,
    domain: 'terabox.demo',
    tagline: 'Archives et séries',
  },
};

export const PROVIDER_IDS: ProviderId[] = ['mega', 'gdrive', 'shadow', 'terabox'];

export const PROVIDER_LIST: Provider[] = PROVIDER_IDS.map((id) => PROVIDERS[id]);

export interface Account {
  id: string;
  provider: ProviderId;
  name: string;
  email: string;
  status: AccountStatus;
  usedBytes: number;
  quotaBytes: number;
  createdAt: string;
  seed: number;
}

export interface FileNode {
  id: string;
  name: string;
  type: FileType;
  size: number;
  modified: string;
  children?: FileNode[];
}

/* ----------------------------------------------------------------------------
 * Construction des arborescences
 * ------------------------------------------------------------------------- */

interface Spec {
  name: string;
  type?: FileType;
  size?: number;
  days?: number;
  children?: Spec[];
}

const EXT_TYPES: Record<string, FileType> = {
  mkv: 'video',
  mp4: 'video',
  avi: 'video',
  mov: 'video',
  webm: 'video',
  m4v: 'video',
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  ppt: 'document',
  pptx: 'document',
  md: 'document',
  txt: 'document',
  csv: 'document',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  gif: 'image',
  heic: 'image',
  svg: 'image',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  gz: 'archive',
  iso: 'archive',
  bin: 'archive',
  dmg: 'archive',
  mp3: 'audio',
  flac: 'audio',
  wav: 'audio',
  m4a: 'audio',
  srt: 'subtitle',
  vtt: 'subtitle',
  fig: 'other',
  exe: 'other',
};

export function detectType(name: string): FileType {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return 'other';
  return EXT_TYPES[name.slice(dot + 1).toLowerCase()] ?? 'other';
}

const file = (name: string, size: number, days: number): Spec => ({
  name,
  size,
  days,
  type: detectType(name),
});

const folder = (name: string, days: number, children: Spec[]): Spec => ({
  name,
  days,
  children,
});

const pad2 = (n: number) => String(n).padStart(2, '0');

function seriesSeason(
  series: string,
  season: number,
  count: number,
  sizeMB: number,
  days: number,
  ext = 'mkv',
): Spec {
  return folder(
    `Saison ${pad2(season)}`,
    days,
    Array.from({ length: count }, (_, i) =>
      file(
        `${series} - S${pad2(season)}E${pad2(i + 1)}.${ext}`,
        (sizeMB + (i % 5) * 11) * MB,
        days + (count - i) * 2,
      ),
    ),
  );
}

/* --- MEGA ---------------------------------------------------------------- */

const megaSpec: Spec[] = [
  folder('Séries', 3, [
    folder('Severance', 5, [
      seriesSeason('Severance', 1, 6, 1460, 40),
      seriesSeason('Severance', 2, 4, 1520, 11),
      file('Severance - S02E01.fr.srt', 62 * KB, 11),
    ]),
    folder('Dark', 6, [seriesSeason('Dark', 1, 5, 1150, 70)]),
    folder('The Bear', 8, [seriesSeason('The Bear', 1, 4, 640, 95)]),
  ]),
  folder('Films', 4, [
    file('Dune — Deuxième partie (2024).mkv', 14.6 * GB, 5),
    file('Oppenheimer (2023).mkv', 11.9 * GB, 21),
    file('Anatomie d’une chute (2023).mkv', 5.2 * GB, 44),
    file('Le Comte de Monte-Cristo (2024).mkv', 8.8 * GB, 12),
    file('Past Lives (2023).mkv', 3.4 * GB, 63),
  ]),
  folder('Documents', 2, [
    folder('Factures', 1, [
      file('facture-orange-octobre.pdf', 184 * KB, 9),
      file('facture-hosting-2025.pdf', 96 * KB, 26),
      file('facture-mutuelle.pdf', 148 * KB, 31),
      file('facture-electricite-septembre.pdf', 212 * KB, 48),
    ]),
    folder('Contrats', 6, [
      file('contrat-location-2024.pdf', 1.2 * MB, 210),
      file('contrat-assurance-habitation.pdf', 860 * KB, 180),
    ]),
    file('CV — 2025.pdf', 240 * KB, 30),
    file('Notes de projet.md', 18 * KB, 6),
  ]),
  folder('Images', 12, [
    folder('Bretagne — été 2024', 120, [
      file('IMG_0421.jpg', 7.4 * MB, 121),
      file('IMG_0422.jpg', 6.8 * MB, 121),
      file('IMG_0435.jpg', 8.1 * MB, 120),
      file('IMG_0467.jpg', 5.9 * MB, 120),
      file('IMG_0488.jpg', 7.2 * MB, 119),
      file('IMG_0512.jpg', 6.4 * MB, 119),
    ]),
    folder('Captures', 5, [
      file('capture-2025-11-04.png', 2.4 * MB, 5),
      file('capture-2025-10-28.png', 1.8 * MB, 12),
      file('capture-2025-10-19.png', 3.1 * MB, 21),
      file('capture-2025-09-30.png', 2.2 * MB, 40),
    ]),
  ]),
  folder('Archives', 21, [
    file('sauvegarde-macbook-2024.zip', 42 * GB, 210),
    file('photos-anciennes.7z', 8.4 * GB, 340),
    file('projets-2023.tar.gz', 1.2 * GB, 400),
  ]),
  folder('Podcasts', 9, [
    file('Le code et le reste — ép. 14.mp3', 68 * MB, 9),
    file('Studio 42 — ép. 08.mp3', 54 * MB, 16),
    file('Studio 42 — ép. 09.mp3', 61 * MB, 2),
  ]),
];

/* --- Google Drive -------------------------------------------------------- */

const gdriveSpec: Spec[] = [
  folder('Travail', 2, [
    folder('Projets', 3, [
      folder('Refonte site', 4, [
        file('Brief créatif.pdf', 820 * KB, 5),
        file('Wireframes v3.fig', 24 * MB, 6),
        file('Budget prévisionnel.xlsx', 96 * KB, 8),
        file('Planning équipe.docx', 142 * KB, 9),
      ]),
      folder('Application mobile', 3, [
        file('Spécifications techniques.pdf', 1.4 * MB, 14),
        file('Maquettes iOS.fig', 38 * MB, 15),
      ]),
    ]),
    folder('Présentations', 6, [
      file('Kickoff 2026.pptx', 12 * MB, 7),
      file('Bilan T3.pptx', 9 * MB, 40),
      file('Roadmap produit.pdf', 3.2 * MB, 18),
    ]),
    folder('Contrats', 6, [
      file('Prestation — Studio Nord.pdf', 640 * KB, 22),
      file('NDA — Fournisseur.pdf', 320 * KB, 51),
    ]),
  ]),
  folder('Administratif', 3, [
    file('Avis d’imposition 2025.pdf', 780 * KB, 60),
    file('Assurance habitation.pdf', 1.1 * MB, 90),
    file('Bail — appartement.pdf', 2.3 * MB, 150),
    file('Attestation mutuelle.pdf', 410 * KB, 25),
  ]),
  folder('Photos', 5, [
    folder('Été 2025', 4, [
      file('DSC_1042.jpg', 9.2 * MB, 96),
      file('DSC_1055.jpg', 8.7 * MB, 96),
      file('DSC_1088.jpg', 10.1 * MB, 95),
      file('DSC_1103.jpg', 7.8 * MB, 95),
      file('DSC_1120.jpg', 9.6 * MB, 94),
    ]),
    folder('Portraits', 4, [
      file('portrait-studio-01.jpg', 12.4 * MB, 30),
      file('portrait-studio-02.jpg', 11.8 * MB, 30),
      file('portrait-exterieur-01.jpg', 9.1 * MB, 44),
      file('portrait-exterieur-02.jpg', 8.6 * MB, 44),
    ]),
    folder('Captures', 4, [
      file('maquette-dashboard.png', 3.6 * MB, 6),
      file('maquette-mobile.png', 2.8 * MB, 6),
      file('reference-typo.png', 1.4 * MB, 17),
    ]),
  ]),
  folder('Modèles', 20, [
    file('Modèle de facture.docx', 84 * KB, 30),
    file('Modèle de devis.xlsx', 62 * KB, 30),
    file('Charte graphique.pdf', 4.6 * MB, 120),
  ]),
];

/* --- Shadow Drive -------------------------------------------------------- */

const shadowSpec: Spec[] = [
  folder('Séries VF', 3, [
    folder('Lupin', 4, [
      seriesSeason('Lupin', 1, 5, 1050, 50),
      seriesSeason('Lupin', 2, 5, 1080, 20),
    ]),
    folder('Le Bureau des légendes', 5, [
      seriesSeason('Le Bureau des légendes', 1, 4, 980, 90),
    ]),
    folder('Kaamelott', 7, [seriesSeason('Kaamelott', 1, 6, 280, 120)]),
  ]),
  folder('Films 4K', 2, [
    file('Interstellar.2014.2160p.mkv', 24.5 * GB, 15),
    file('Blade Runner 2049.2017.2160p.mkv', 19.2 * GB, 30),
    file('The Batman.2022.2160p.mkv', 21.4 * GB, 44),
    file('Portrait de la jeune fille en feu.2019.mkv', 8.6 * GB, 70),
  ]),
  folder('Jeux PC', 3, [
    folder('Baldur’s Gate 3', 5, [
      file('bg3-setup-1.bin', 8.2 * GB, 60),
      file('bg3-setup-2.bin', 6.4 * GB, 60),
      file('bg3-install.exe', 18 * MB, 60),
    ]),
    folder('Elden Ring', 4, [
      file('eldenring.iso', 46 * GB, 130),
      file('eldenring-patch-1.12.zip', 2.1 * GB, 100),
    ]),
  ]),
  folder('Musique', 6, [
    folder('Daft Punk — Discovery', 5, [
      file('01 One More Time.mp3', 12 * MB, 220),
      file('02 Aerodynamic.mp3', 9.4 * MB, 220),
      file('03 Digital Love.mp3', 11.2 * MB, 220),
      file('04 Something About Us.mp3', 8.8 * MB, 220),
      file('cover.jpg', 1.2 * MB, 220),
    ]),
    folder('Air — Moon Safari', 5, [
      file('01 La Femme d’Argent.mp3', 16 * MB, 240),
      file('02 Sexy Boy.mp3', 10.4 * MB, 240),
      file('03 All I Need.mp3', 9.8 * MB, 240),
    ]),
  ]),
  folder('Sauvegardes', 8, [
    file('shadow-backup-novembre.zip', 64 * GB, 18),
    file('ps5-save-data.zip', 342 * MB, 33),
  ]),
];

/* --- TeraBox ------------------------------------------------------------- */

const teraboxSpec: Spec[] = [
  folder('Anime', 2, [
    folder('Frieren', 3, [seriesSeason('Frieren', 1, 6, 720, 16)]),
    folder('Jujutsu Kaisen', 4, [
      seriesSeason('Jujutsu Kaisen', 2, 5, 780, 35),
    ]),
  ]),
  folder('Cours', 6, [
    folder('Développement web', 4, [
      file('01 — HTML et CSS.mp4', 420 * MB, 12),
      file('02 — JavaScript moderne.mp4', 610 * MB, 13),
      file('03 — React en pratique.mp4', 720 * MB, 14),
      file('04 — TypeScript avancé.mp4', 540 * MB, 15),
      file('Support de cours.pdf', 6.2 * MB, 15),
    ]),
    folder('Anglais', 7, [
      file('Unit 1 — Listening.mp3', 28 * MB, 22),
      file('Unit 2 — Grammar.mp3', 32 * MB, 23),
      file('Vocabulaire — fiche.pdf', 1.2 * MB, 24),
    ]),
  ]),
  folder('Logiciels', 10, [
    file('suite-graphique-2025.iso', 4.8 * GB, 40),
    file('ide-community.dmg', 1.1 * GB, 55),
    file('bureautique-libre.zip', 680 * MB, 80),
  ]),
  folder('Divers', 11, [
    folder('Scans', 3, [
      file('scan-identite.pdf', 1.8 * MB, 28),
      file('scan-justificatif-domicile.pdf', 940 * KB, 28),
      file('scan-diplome.pdf', 2.4 * MB, 64),
    ]),
    folder('Captures', 2, [
      file('capture-idee-01.png', 1.6 * MB, 2),
      file('capture-idee-02.png', 2.1 * MB, 2),
      file('capture-idee-03.png', 1.2 * MB, 3),
    ]),
    file('à-trier.zip', 1.8 * GB, 5),
  ]),
];

const TEMPLATES: Record<ProviderId, Spec[]> = {
  mega: megaSpec,
  gdrive: gdriveSpec,
  shadow: shadowSpec,
  terabox: teraboxSpec,
};

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Petite variation déterministe pour que chaque compte ait des tailles/dates propres. */
function jitter(key: string, min: number, max: number): number {
  const ratio = (hashString(key) % 10_000) / 10_000;
  return min + ratio * (max - min);
}

function expandSpecs(
  specs: Spec[],
  accountId: string,
  parentPath: string[],
  seed: number,
): FileNode[] {
  return specs.map((spec) => {
    const path = [...parentPath, spec.name];
    const id = `${accountId}:${path.join('/')}`;
    const children = spec.children
      ? expandSpecs(spec.children, accountId, path, seed)
      : undefined;

    // Décalage toujours dans le passé : les dates restent crédibles.
    const dayOffset = jitter(`${id}:${seed}:day`, 0.2, 3.4);
    const days = Math.max(0.12, (spec.days ?? 1) + dayOffset);
    const hourOffset = jitter(`${id}:hour`, 0, 22);
    const modified = new Date(NOW - days * DAY - hourOffset * 3_600_000).toISOString();

    const size = children
      ? children.reduce((total, child) => total + child.size, 0)
      : Math.round((spec.size ?? 0) * jitter(`${id}:${seed}:size`, 0.9, 1.12));

    return {
      id,
      name: spec.name,
      type: children ? 'folder' : (spec.type ?? 'other'),
      size,
      modified,
      ...(children ? { children } : {}),
    };
  });
}

export function buildAccountTree(account: Account): FileNode[] {
  return expandSpecs(TEMPLATES[account.provider], account.id, [], account.seed);
}

/* ----------------------------------------------------------------------------
 * Comptes de démonstration
 * ------------------------------------------------------------------------- */

const usageRatio = (quota: number, ratio: number) =>
  Math.round((quota * ratio) / (10 * MB)) * (10 * MB);

interface SeedAccount {
  name: string;
  email: string;
  ratio: number;
  status: AccountStatus;
}

function buildSeeds(
  provider: ProviderId,
  seeds: SeedAccount[],
  startIndex = 0,
): Account[] {
  const providerDef = PROVIDERS[provider];
  return seeds.map((seed, index) => ({
    id: `${provider}-${pad2(startIndex + index + 1)}`,
    provider,
    name: seed.name,
    email: seed.email,
    status: seed.status,
    usedBytes: usageRatio(providerDef.quota, seed.ratio),
    quotaBytes: providerDef.quota,
    createdAt: new Date(NOW - (620 - (index + startIndex) * 19) * DAY).toISOString(),
    seed: index + startIndex + 1,
  }));
}

const MEGA_SEEDS: SeedAccount[] = ([
  { ratio: 0.42, status: 'connected' },
  { ratio: 0.71, status: 'connected' },
  { ratio: 0.23, status: 'syncing' },
  { ratio: 0.88, status: 'connected' },
  { ratio: 0.15, status: 'connected' },
  { ratio: 0.55, status: 'connected' },
  { ratio: 0.64, status: 'expired' },
  { ratio: 0.31, status: 'connected' },
  { ratio: 0.08, status: 'connected' },
  { ratio: 0.92, status: 'connected' },
  { ratio: 0.47, status: 'connected' },
] as const).map((seed, index) => ({
  ...seed,
  name: `MEGA${pad2(index + 1)}`,
  email: `mega${pad2(index + 1)}@mega.demo`,
}));

const GDRIVE_SEEDS: SeedAccount[] = [
  { name: 'DRIVE PERSO', email: 'perso.boitier@gmail.demo', ratio: 0.34, status: 'connected' },
  { name: 'DRIVE PRO', email: 'pro.boitier@gmail.demo', ratio: 0.62, status: 'connected' },
  { name: 'DRIVE FAMILLE', email: 'famille.boitier@gmail.demo', ratio: 0.81, status: 'connected' },
  { name: 'DRIVE ARCHIVES', email: 'archives.boitier@gmail.demo', ratio: 0.19, status: 'expired' },
];

const SHADOW_SEEDS: SeedAccount[] = Array.from({ length: 5 }, (_, index) => ({
  name: `SHADOW${pad2(index + 1)}`,
  email: `shadow${pad2(index + 1)}@shadow.demo`,
  ratio: [0.58, 0.27, 0.74, 0.41, 0.12][index],
  status: (index === 3 ? 'syncing' : 'connected') as AccountStatus,
}));

const TERABOX_SEEDS: SeedAccount[] = Array.from({ length: 3 }, (_, index) => ({
  name: `TERABOX${pad2(index + 1)}`,
  email: `terabox${pad2(index + 1)}@terabox.demo`,
  ratio: [0.36, 0.67, 0.21][index],
  status: 'connected' as AccountStatus,
}));

export function makeSeedAccounts(): Account[] {
  return [
    ...buildSeeds('mega', MEGA_SEEDS),
    ...buildSeeds('gdrive', GDRIVE_SEEDS, 0),
    ...buildSeeds('shadow', SHADOW_SEEDS, 0),
    ...buildSeeds('terabox', TERABOX_SEEDS, 0),
  ];
}

export function nextAccountDraft(
  provider: ProviderId,
  accounts: Account[],
): { name: string; email: string; quotaBytes: number } {
  const providerDef = PROVIDERS[provider];
  const existing = accounts.filter((account) => account.provider === provider);
  let index = existing.length + 1;
  let name = `${providerDef.prefix}${pad2(index)}`;
  while (existing.some((account) => account.name === name)) {
    index += 1;
    name = `${providerDef.prefix}${pad2(index)}`;
  }
  return {
    name,
    email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}@${providerDef.domain}`,
    quotaBytes: providerDef.quota,
  };
}

/* ----------------------------------------------------------------------------
 * Transferts de démonstration
 * ------------------------------------------------------------------------- */

export interface DownloadSeed {
  name: string;
  type: FileType;
  provider: ProviderId;
  accountName: string;
  size: number;
  received: number;
  speed: number;
  status: 'active' | 'paused' | 'queued' | 'done';
  minutesAgo: number;
}

export const DOWNLOAD_SEEDS: DownloadSeed[] = [
  {
    name: 'Severance - S02E02.mkv',
    type: 'video',
    provider: 'mega',
    accountName: 'MEGA03',
    size: 1.58 * GB,
    received: 0.46 * 1.58 * GB,
    speed: 34 * MB,
    status: 'active',
    minutesAgo: 4,
  },
  {
    name: 'Dune — Deuxième partie (2024).mkv',
    type: 'video',
    provider: 'mega',
    accountName: 'MEGA01',
    size: 14.6 * GB,
    received: 0.18 * 14.6 * GB,
    speed: 52 * MB,
    status: 'active',
    minutesAgo: 11,
  },
  {
    name: 'Portrait de la jeune fille en feu.2019.mkv',
    type: 'video',
    provider: 'shadow',
    accountName: 'SHADOW02',
    size: 8.6 * GB,
    received: 0.63 * 8.6 * GB,
    speed: 22 * MB,
    status: 'paused',
    minutesAgo: 26,
  },
  {
    name: 'Spécifications techniques.pdf',
    type: 'document',
    provider: 'gdrive',
    accountName: 'DRIVE PRO',
    size: 1.4 * MB,
    received: 1.4 * MB,
    speed: 3 * MB,
    status: 'done',
    minutesAgo: 48,
  },
];
