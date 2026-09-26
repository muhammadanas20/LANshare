import { formatBytes } from './format';

export type FileCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'code'
  | 'text'
  | 'font'
  | 'other';

const EXT_MAP: Record<string, { category: FileCategory; label: string }> = {
  // images
  jpg: { category: 'image', label: 'JPEG image' },
  jpeg: { category: 'image', label: 'JPEG image' },
  png: { category: 'image', label: 'PNG image' },
  gif: { category: 'image', label: 'GIF' },
  webp: { category: 'image', label: 'WEBP image' },
  avif: { category: 'image', label: 'AVIF image' },
  svg: { category: 'image', label: 'SVG image' },
  bmp: { category: 'image', label: 'BMP image' },
  ico: { category: 'image', label: 'Icon' },
  heic: { category: 'image', label: 'HEIC image' },
  heif: { category: 'image', label: 'HEIF image' },
  tif: { category: 'image', label: 'TIFF image' },
  tiff: { category: 'image', label: 'TIFF image' },
  // video
  mp4: { category: 'video', label: 'MP4 video' },
  m4v: { category: 'video', label: 'M4V video' },
  webm: { category: 'video', label: 'WEBM video' },
  mov: { category: 'video', label: 'QuickTime video' },
  mkv: { category: 'video', label: 'Matroska video' },
  avi: { category: 'video', label: 'AVI video' },
  ogv: { category: 'video', label: 'OGG video' },
  // audio
  mp3: { category: 'audio', label: 'MP3 audio' },
  m4a: { category: 'audio', label: 'M4A audio' },
  wav: { category: 'audio', label: 'WAV audio' },
  ogg: { category: 'audio', label: 'OGG audio' },
  oga: { category: 'audio', label: 'OGG audio' },
  opus: { category: 'audio', label: 'Opus audio' },
  flac: { category: 'audio', label: 'FLAC audio' },
  aac: { category: 'audio', label: 'AAC audio' },
  weba: { category: 'audio', label: 'WEBM audio' },
  // docs
  pdf: { category: 'pdf', label: 'PDF' },
  doc: { category: 'document', label: 'Word document' },
  docx: { category: 'document', label: 'Word document' },
  odt: { category: 'document', label: 'OpenDocument text' },
  rtf: { category: 'document', label: 'Rich text' },
  pages: { category: 'document', label: 'Pages document' },
  xls: { category: 'spreadsheet', label: 'Excel spreadsheet' },
  xlsx: { category: 'spreadsheet', label: 'Excel spreadsheet' },
  ods: { category: 'spreadsheet', label: 'OpenDocument sheet' },
  csv: { category: 'spreadsheet', label: 'CSV' },
  tsv: { category: 'spreadsheet', label: 'TSV' },
  numbers: { category: 'spreadsheet', label: 'Numbers sheet' },
  ppt: { category: 'presentation', label: 'PowerPoint' },
  pptx: { category: 'presentation', label: 'PowerPoint' },
  odp: { category: 'presentation', label: 'OpenDocument slides' },
  key: { category: 'presentation', label: 'Keynote' },
  // archives
  zip: { category: 'archive', label: 'ZIP archive' },
  rar: { category: 'archive', label: 'RAR archive' },
  '7z': { category: 'archive', label: '7-Zip archive' },
  tar: { category: 'archive', label: 'TAR archive' },
  gz: { category: 'archive', label: 'Gzip archive' },
  bz2: { category: 'archive', label: 'Bzip2 archive' },
  // plain text / code
  txt: { category: 'text', label: 'Text' },
  md: { category: 'text', label: 'Markdown' },
  log: { category: 'text', label: 'Log file' },
  json: { category: 'code', label: 'JSON' },
  xml: { category: 'code', label: 'XML' },
  yml: { category: 'code', label: 'YAML' },
  yaml: { category: 'code', label: 'YAML' },
  js: { category: 'code', label: 'JavaScript' },
  mjs: { category: 'code', label: 'JavaScript' },
  cjs: { category: 'code', label: 'JavaScript' },
  ts: { category: 'code', label: 'TypeScript' },
  tsx: { category: 'code', label: 'TypeScript' },
  jsx: { category: 'code', label: 'JavaScript' },
  html: { category: 'code', label: 'HTML' },
  css: { category: 'code', label: 'CSS' },
  scss: { category: 'code', label: 'SCSS' },
  py: { category: 'code', label: 'Python' },
  rb: { category: 'code', label: 'Ruby' },
  go: { category: 'code', label: 'Go' },
  rs: { category: 'code', label: 'Rust' },
  java: { category: 'code', label: 'Java' },
  kt: { category: 'code', label: 'Kotlin' },
  c: { category: 'code', label: 'C source' },
  h: { category: 'code', label: 'C header' },
  cpp: { category: 'code', label: 'C++ source' },
  cs: { category: 'code', label: 'C# source' },
  php: { category: 'code', label: 'PHP' },
  sh: { category: 'code', label: 'Shell script' },
  sql: { category: 'code', label: 'SQL' },
  // fonts
  ttf: { category: 'font', label: 'TrueType font' },
  otf: { category: 'font', label: 'OpenType font' },
  woff: { category: 'font', label: 'Web font' },
  woff2: { category: 'font', label: 'Web font' },
  // apps / misc
  apk: { category: 'other', label: 'Android package' },
  exe: { category: 'other', label: 'Windows executable' },
  dmg: { category: 'other', label: 'macOS disk image' },
  iso: { category: 'other', label: 'Disk image' },
};

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase().slice(0, 12);
}

export function fileCategory(mime: string, name: string): FileCategory {
  const type = (mime || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('font/')) return 'font';
  if (/zip|rar|7z|tar|gzip|compressed|x-archive/.test(type)) return 'archive';
  if (/spreadsheet|excel|csv/.test(type)) return 'spreadsheet';
  if (/presentation|powerpoint/.test(type)) return 'presentation';
  if (/word|opendocument\.text|rtf/.test(type)) return 'document';
  if (/json|xml|javascript|typescript|x-sh|sql|yaml/.test(type)) return 'code';
  if (type.startsWith('text/')) {
    const ext = fileExtension(name);
    if (['json', 'xml', 'yml', 'yaml', 'js', 'ts', 'html', 'css', 'svg'].includes(ext)) return 'code';
    return 'text';
  }
  const byExt = EXT_MAP[fileExtension(name)];
  if (byExt) return byExt.category;
  return 'other';
}

/** Human label shown on file cards, e.g. "PDF", "MP4 video", "ZIP archive". */
export function fileTypeLabel(mime: string, name: string): string {
  const type = (mime || '').toLowerCase();
  if (type === 'application/octet-stream' || !type) {
    const byExt = EXT_MAP[fileExtension(name)];
    return byExt ? byExt.label : fileExtension(name).toUpperCase() || 'File';
  }
  if (type === 'application/pdf') return 'PDF';
  if (type === 'text/plain') return 'Text';
  const subtype = type.slice(type.indexOf('/') + 1).replace(/^x-/, '').replace(/\+.*$/, '');
  if (type.startsWith('image/')) return subtype === 'jpeg' ? 'JPEG image' : `${subtype.toUpperCase()} image`;
  if (type.startsWith('video/')) return `${subtype.toUpperCase()} video`;
  if (type.startsWith('audio/')) return `${subtype.toUpperCase()} audio`;
  const byExt = EXT_MAP[fileExtension(name)];
  if (byExt) return byExt.label;
  return subtype.toUpperCase() || 'File';
}

export function isPreviewableImage(mime: string, name: string): boolean {
  const cat = fileCategory(mime, name);
  if (cat !== 'image') return false;
  const ext = fileExtension(name);
  // SVG previews are safe inside <img>, but avoid exotic formats the browser cannot decode.
  return !['heic', 'heif', 'tif', 'tiff'].includes(ext);
}

export function isPreviewableVideo(mime: string, name: string): boolean {
  if (fileCategory(mime, name) !== 'video') return false;
  return ['mp4', 'm4v', 'webm', 'ogv', 'mov'].includes(fileExtension(name)) ||
    mime.startsWith('video/mp4') || mime.startsWith('video/webm');
}

export function isPreviewableAudio(mime: string, name: string): boolean {
  return fileCategory(mime, name) === 'audio';
}

/** Compact one-line description: "PDF · 4.2 MB" */
export function describeFile(mime: string, name: string, size: number): string {
  return `${fileTypeLabel(mime, name)} · ${formatBytes(size)}`;
}

/**
 * Browser-readable text/code files only (used by the inline "view as text" preview).
 * Deliberately conservative: unknown binaries are never decoded.
 */
export function isBrowserReadableText(mime: string, name: string): boolean {
  const cat = fileCategory(mime, name);
  if (cat === 'text' || cat === 'code') return true;
  if (cat === 'spreadsheet' && ['csv', 'tsv'].includes(fileExtension(name))) return true;
  return false;
}

export function isImportableArchive(mime: string, name: string): boolean {
  if (fileCategory(mime, name) !== 'archive') return false;
  const ext = fileExtension(name);
  return ext === 'zip' || ext === 'tar' || ext === 'gz' || mime.includes('zip');
}
