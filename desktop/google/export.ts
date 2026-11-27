/** Formats d'export par défaut des documents Google Workspace. */
export type ExportFormat = { mimeType: string; extension: string };

const formats: Record<string, ExportFormat> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx',
  },
};

export function formatExport(mimeType: string): ExportFormat | undefined {
  return formats[mimeType];
}

/** Évite la double extension et réserve la place avant l'assainissement Windows. */
export function nomExporte(nom: string, format: ExportFormat): string {
  const suffixe = format.extension;
  if (nom.toLowerCase().endsWith(suffixe)) {
    return nom.slice(0, -suffixe.length).slice(0, 180 - suffixe.length) + suffixe;
  }
  return nom.slice(0, 180 - suffixe.length) + suffixe;
}
