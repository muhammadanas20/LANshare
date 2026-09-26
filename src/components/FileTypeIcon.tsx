import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  Presentation,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { fileCategory, type FileCategory } from '../utils/fileKind';
import { cn } from '../utils/cn';

const ICON_BY_CATEGORY: Record<FileCategory, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  archive: FileArchive,
  code: FileCode2,
  text: FileText,
  font: FileType2,
  other: FileIcon,
};

/** Category tint applied to the glyph only (never the sole state indicator). */
const TONE_BY_CATEGORY: Record<FileCategory, string> = {
  image: 'text-[color:var(--accent)]',
  video: 'text-[color:var(--accent)]',
  audio: 'text-[color:var(--success)]',
  pdf: 'text-[color:var(--danger)]',
  document: 'text-[color:var(--accent)]',
  spreadsheet: 'text-[color:var(--success)]',
  presentation: 'text-[color:var(--warning)]',
  archive: 'text-[color:var(--warning)]',
  code: 'text-[color:var(--accent)]',
  text: 'text-muted',
  font: 'text-muted',
  other: 'text-muted',
};

export function FileTypeIcon({
  mime,
  name,
  size = 20,
  className,
}: {
  mime: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const category = fileCategory(mime, name);
  const Icon = ICON_BY_CATEGORY[category] ?? FileIcon;
  return <Icon size={size} className={cn(TONE_BY_CATEGORY[category], className)} aria-hidden="true" />;
}
