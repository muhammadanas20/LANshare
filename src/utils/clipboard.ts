/**
 * Clipboard helpers. Everything goes through the async Clipboard API when
 * available, with a `document.execCommand` fallback for older browsers and
 * non-secure contexts.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Read the clipboard, returning any text and image files the browser exposes. */
export async function readClipboard(): Promise<{ text: string | null; files: File[] }> {
  const files: File[] = [];
  let text: string | null = null;

  if (navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const extension = type.split('/')[1] ?? 'png';
            files.push(new File([blob], `pasted-image.${extension}`, { type }));
          } else if (type === 'text/plain') {
            const blob = await item.getType(type);
            text = await blob.text();
          }
        }
      }
      if (files.length > 0 || text) return { text, files };
    } catch {
      /* permission denied or unsupported — try the plain-text path below */
    }
  }

  try {
    text = (await navigator.clipboard?.readText?.()) ?? null;
  } catch {
    text = null;
  }
  return { text: text && text.length > 0 ? text : null, files };
}

/** Extract files from a paste event (screenshots arrive as clipboard items). */
export function filesFromPasteEvent(event: ClipboardEvent): { files: File[]; text: string | null } {
  const files: File[] = [];
  let text: string | null = null;
  const data = event.clipboardData;
  if (!data) return { files, text };
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  const pasted = data.getData('text/plain');
  if (pasted) text = pasted;
  return { files, text };
}
