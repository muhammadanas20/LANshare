import { config } from '../config';

/** Reserved DOS device names (Windows) — neutralised so downloads never collide. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

/**
 * Turn an untrusted, peer-supplied filename into something safe to display and save.
 * Strips directory components, control characters, leading dots and reserved names.
 */
export function sanitizeFilename(rawName: string, fallback = 'file'): string {
  let name = String(rawName ?? '');
  // Some browsers/OSes send \ as separator; take the last component either way.
  name = name.split(/[\\/]/).pop() ?? name;
  name = name
    .replace(CONTROL_CHARS, '')
    .replace(ILLEGAL_CHARS, '_')
    .replace(/_{2,}/g, '_')
    .trim();
  name = name.replace(/^\.+/, ''); // no hidden files / ".."
  name = name.replace(/\s+/g, ' ');
  if (RESERVED.test(name)) name = `_${name}`;
  // Keep extensions meaningful, cap overall length.
  if (name.length > 180) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot).slice(0, 16) : '';
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name || fallback;
}

/** Keep the relative folder path for display, but never let it escape anywhere. */
export function sanitizeRelativePath(rawPath: string | undefined, filename: string): string | undefined {
  if (!rawPath) return undefined;
  const parts = String(rawPath)
    .split(/[\\/]/)
    .map((p) => p.replace(CONTROL_CHARS, '').trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts.length <= 1) return undefined;
  const joined = parts.slice(0, -1).join('/');
  const safe = sanitizeRelativePathString(joined);
  return safe ? `${safe}/${filename}` : filename;
}

function sanitizeRelativePathString(path: string): string {
  return path
    .split('/')
    .map((part) => part.replace(ILLEGAL_CHARS, '_').replace(/^\.+/, '').trim())
    .filter(Boolean)
    .slice(0, 12)
    .join('/');
}

/** Ensure a name is unique within a list: report.pdf, report (2).pdf … */
export function uniqueFilename(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) {
    taken.add(name.toLowerCase());
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let counter = 2;
  let candidate = `${stem} (${counter})${ext}`;
  while (taken.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = `${stem} (${counter})${ext}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/i;

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Split text into segments so URLs can be rendered as non-clickable, styled links. */
export type TextSegment = { type: 'text' | 'url'; value: string };

export function linkifyText(text: string, maxSegments = 400): TextSegment[] {
  const segments: TextSegment[] = [];
  const pattern = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null && segments.length < maxSegments) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    const candidate = match[0].replace(/[.,;:!?)\]]+$/, '');
    segments.push({ type: 'url', value: candidate });
    lastIndex = match.index + candidate.length;
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) });
  return segments.length ? segments : [{ type: 'text', value: text }];
}

export function firstUrl(text: string): string | null {
  const match = URL_PATTERN.exec(text);
  if (!match) return null;
  const candidate = match[0].replace(/[.,;:!?)\]]+$/, '');
  return isHttpUrl(candidate) ? candidate : null;
}

/** Hostname only, for the compact link chip ("github.com/path" -> "github.com"). */
export function urlHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

export interface FileValidationIssue {
  name: string;
  reason: string;
}

export interface FileValidationResult {
  accepted: File[];
  issues: FileValidationIssue[];
  totalBytes: number;
}

/**
 * Applies the configured size/count guards. File *types* are never restricted —
 * anything the browser can read can be sent.
 */
export function validateFiles(incoming: File[], existingCount = 0): FileValidationResult {
  const accepted: File[] = [];
  const issues: FileValidationIssue[] = [];
  let totalBytes = 0;
  let overflow = false;

  for (const file of incoming) {
    if (existingCount + accepted.length >= config.maxFileCount) {
      overflow = true;
      continue;
    }
    if (file.size <= 0 && file.type === '') {
      issues.push({ name: file.name, reason: 'The file appears to be empty or unreadable.' });
      continue;
    }
    if (file.size > config.maxSingleFileBytes) {
      issues.push({ name: file.name, reason: 'That file is larger than the supported limit.' });
      continue;
    }
    if (totalBytes + file.size > config.maxTotalBytes) {
      issues.push({ name: file.name, reason: 'Adding it would exceed the total transfer limit.' });
      continue;
    }
    totalBytes += file.size;
    accepted.push(file);
  }

  if (overflow) {
    issues.push({
      name: 'Additional files',
      reason: `A transfer can hold up to ${config.maxFileCount} files. Extra files were skipped.`,
    });
  }

  return { accepted, issues, totalBytes };
}

/** Normalise an untrusted mime string. */
export function safeMime(mime: string | undefined, fallback = 'application/octet-stream'): string {
  const value = String(mime ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]*$/.test(value)) return fallback;
  return value;
}

/** Validate a room code coming from a URL before it is used. */
export function normaliseRoomCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (code.length < 2 || code.length > 32) return null;
  return code;
}

/** Text is always rendered as text nodes, but clamp absurd payloads defensively. */
export function clampText(text: string, max = config.maxTextLength): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated)`;
}
