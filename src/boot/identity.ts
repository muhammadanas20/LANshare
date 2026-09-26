const MAX_NAME = 32;

/** Trim, collapse whitespace and clamp a display name so the server never rejects it. */
export function normalizeDisplayName(name: string | null | undefined, fallback = 'LANShare device'): string {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return cleaned || fallback;
}
