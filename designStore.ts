export type SavedDesign = {
  id: string;
  title: string;
  symbol: string;
  imageUri: string | null;
  background: string;
  targetPackage: string | null;
  targetLabel: string | null;
  updatedAt: number;
};

export type EncodedImage = { base64: string; ext: string };
export type ParsedBackup = { designs: SavedDesign[]; images: Record<string, EncodedImage> };

const DEFAULT_BACKGROUND = '#F4C542';

// ---------------------------------------------------------------- colors

/** Accepts "#abc", "abc", "#AABBCC" or "aabbcc" and returns "#AABBCC", or null when invalid. */
export function normalizeHex(input: string): string | null {
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(input.trim());
  if (!match) return null;
  let hex = match[1].toUpperCase();
  if (hex.length === 3) hex = hex.split('').map((char) => char + char).join('');
  return `#${hex}`;
}

// ---------------------------------------------------------------- library operations

export function upsertDesign(items: SavedDesign[], item: SavedDesign, editingId: string | null): SavedDesign[] {
  if (!editingId) return [item, ...items];
  const exists = items.some((saved) => saved.id === editingId);
  if (!exists) return [item, ...items];
  return items.map((saved) => saved.id === editingId ? item : saved);
}

export function removeDesign(items: SavedDesign[], id: string): SavedDesign[] {
  return items.filter((item) => item.id !== id);
}

/** Inserts a copy of design `id` right after the original. The copy shares the same image file. */
export function duplicateDesign(items: SavedDesign[], id: string, newId: string, now: number, suffix: string): SavedDesign[] {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return items;
  const original = items[index];
  const title = `${original.title.slice(0, Math.max(1, 40 - suffix.length - 1))} ${suffix}`.trim();
  const copy: SavedDesign = { ...original, id: newId, title, updatedAt: now };
  return [...items.slice(0, index + 1), copy, ...items.slice(index + 1)];
}

/** Adds the incoming designs whose id is not already in the library. */
export function mergeDesigns(existing: SavedDesign[], incoming: SavedDesign[]): { designs: SavedDesign[]; added: number } {
  const ids = new Set(existing.map((item) => item.id));
  const fresh = incoming.filter((item) => !ids.has(item.id));
  return { designs: [...existing, ...fresh], added: fresh.length };
}

export function filterDesigns(items: SavedDesign[], query: string): SavedDesign[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    item.title.toLocaleLowerCase().includes(needle) || (item.targetLabel ?? '').toLocaleLowerCase().includes(needle));
}

/** Image files referenced before the change that no design references after it. */
export function unusedImageUris(before: SavedDesign[], after: SavedDesign[]): string[] {
  const stillUsed = new Set(after.map((item) => item.imageUri).filter((uri): uri is string => !!uri));
  const unused = new Set<string>();
  for (const item of before) {
    if (item.imageUri && !stillUsed.has(item.imageUri)) unused.add(item.imageUri);
  }
  return [...unused];
}

// ---------------------------------------------------------------- persistence format

/** Returns a clean design, or null when the entry is unusable. Never throws. */
export function sanitizeDesign(raw: unknown): SavedDesign | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || entry.id === '' || typeof entry.title !== 'string') return null;
  const background = typeof entry.background === 'string' ? normalizeHex(entry.background) : null;
  return {
    id: entry.id,
    title: entry.title,
    symbol: typeof entry.symbol === 'string' ? entry.symbol : '✦',
    imageUri: typeof entry.imageUri === 'string' && entry.imageUri !== '' ? entry.imageUri : null,
    background: background ?? DEFAULT_BACKGROUND,
    targetPackage: typeof entry.targetPackage === 'string' ? entry.targetPackage : null,
    targetLabel: typeof entry.targetLabel === 'string' ? entry.targetLabel : null,
    updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
  };
}

/** Cleans a list of designs: drops invalid entries and duplicate ids. Throws only when the input is not an array. */
export function sanitizeDesigns(raw: unknown): SavedDesign[] {
  if (!Array.isArray(raw)) throw new Error('Saved designs must be an array');
  const seen = new Set<string>();
  const result: SavedDesign[] = [];
  for (const entry of raw) {
    const design = sanitizeDesign(entry);
    if (design && !seen.has(design.id)) {
      seen.add(design.id);
      result.push(design);
    }
  }
  return result;
}

export function restoreDesigns(serialized: string | null): SavedDesign[] {
  if (!serialized) return [];
  return sanitizeDesigns(JSON.parse(serialized));
}

export function serializeDesigns(items: SavedDesign[]): string {
  return JSON.stringify(items);
}

export function buildShareRequest(imageUri: string | null, symbol: string, backgroundColor: string) {
  return { iconUri: imageUri, symbol: symbol || "✦", backgroundColor };
}

// ---------------------------------------------------------------- backup (v2 embeds the images)

export function buildBackup(designs: SavedDesign[], images: Record<string, EncodedImage>, now: number): string {
  return JSON.stringify({
    app: 'icon-changer',
    version: 2,
    exportedAt: now,
    designs: designs.map((design) => ({ ...design, image: images[design.id] ?? null })),
  });
}

/** Reads both the old format (a bare array, no images) and the v2 format. Throws on anything else. */
export function parseBackup(text: string): ParsedBackup {
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return { designs: sanitizeDesigns(parsed), images: {} };
  const container = parsed as { designs?: unknown } | null;
  if (typeof container !== 'object' || container === null || !Array.isArray(container.designs)) {
    throw new Error('Unrecognized backup format');
  }
  const rawDesigns = container.designs as unknown[];
  const designs = sanitizeDesigns(rawDesigns);
  const wanted = new Set(designs.map((design) => design.id));
  const images: Record<string, EncodedImage> = {};
  for (const entry of rawDesigns) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, image } = entry as { id?: unknown; image?: unknown };
    if (typeof id !== 'string' || !wanted.has(id) || typeof image !== 'object' || image === null) continue;
    const { base64, ext } = image as { base64?: unknown; ext?: unknown };
    if (typeof base64 !== 'string' || base64 === '' || typeof ext !== 'string' || !/^(png|jpe?g|webp)$/i.test(ext)) continue;
    images[id] = { base64, ext: ext.toLowerCase() };
  }
  return { designs, images };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Pure-JS base64 decoder (no dependency on atob/Buffer being present). */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  if (clean.length % 4 === 1) throw new Error('Invalid base64 length');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let written = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = BASE64_ALPHABET.indexOf(clean[i]);
    const b = BASE64_ALPHABET.indexOf(clean[i + 1]);
    const c = i + 2 < clean.length ? BASE64_ALPHABET.indexOf(clean[i + 2]) : -1;
    const d = i + 3 < clean.length ? BASE64_ALPHABET.indexOf(clean[i + 3]) : -1;
    out[written++] = (a << 2) | (b >> 4);
    if (c >= 0) out[written++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) out[written++] = ((c & 3) << 6) | d;
  }
  return out.slice(0, written);
}
