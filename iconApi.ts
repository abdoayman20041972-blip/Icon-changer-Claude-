import AsyncStorage from '@react-native-async-storage/async-storage';

export type IconShape = { prefix: string; name: string };

const ICONIFY_BASE = 'https://api.iconify.design';
const SEARCH_CACHE_PREFIX = 'icon-changer.search-cache.';
const BUNDLE_CACHE_PREFIX = 'icon-changer.bundle-cache.';

export type ShapeCategory = { label: string; query: string };

export const SHAPE_CATEGORIES: ShapeCategory[] = [
  { label: 'نجوم', query: 'star' },
  { label: 'قلوب', query: 'heart' },
  { label: 'موسيقى', query: 'music' },
  { label: 'كاميرا', query: 'camera' },
  { label: 'ألعاب', query: 'gamepad' },
  { label: 'قهوة', query: 'coffee' },
  { label: 'طبيعة', query: 'flower' },
  { label: 'طاقة', query: 'bolt' },
  { label: 'دردشة', query: 'chat' },
  { label: 'رياضة', query: 'fitness' },
];

export async function searchShapes(query: string, limit = 30): Promise<IconShape[]> {
  const url = `${ICONIFY_BASE}/search?query=${encodeURIComponent(query.trim())}&limit=${limit}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Icon search failed: ${response.status}`);
  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { icons?: unknown }).icons)) {
    throw new Error('Unexpected icon search response');
  }
  const ids = (data as { icons: string[] }).icons;
  const results = ids.flatMap((id) => {
    const [prefix, name] = id.split(':');
    if (!prefix || !name) return [];
    return [{ prefix, name }];
  });
  if (results.length > 0) {
    try { await AsyncStorage.setItem(SEARCH_CACHE_PREFIX + query.trim().toLowerCase(), JSON.stringify(results)); } catch {}
  }
  return results;
}

// Falls back to the last successful search results when the network is unavailable.
export async function searchShapesCached(query: string, limit = 30): Promise<{ results: IconShape[]; fromCache: boolean }> {
  try {
    const results = await searchShapes(query, limit);
    return { results, fromCache: false };
  } catch (error) {
    const cached = await AsyncStorage.getItem(SEARCH_CACHE_PREFIX + query.trim().toLowerCase());
    if (!cached) throw error;
    const results = JSON.parse(cached) as IconShape[];
    if (!Array.isArray(results) || results.length === 0) throw error;
    return { results, fromCache: true };
  }
}

export function shapeSvgUri(shape: IconShape, color: string, size = 64): string {
  return `${ICONIFY_BASE}/${shape.prefix}/${shape.name}.svg?color=${encodeURIComponent(color)}&height=${size}`;
}

export function shapeKey(shape: IconShape): string {
  return `${shape.prefix}:${shape.name}`;
}

type IconifyBundle = {
  prefix: string;
  icons: Record<string, { body: string }>;
  width?: number;
  height?: number;
};

function colorize(body: string, color: string): string {
  return body.replace(/currentColor/g, color);
}

// Fetches a whole result set in one request per prefix instead of one request
// per icon, which avoids the Iconify API rate limits.
export async function fetchShapeBundle(shapes: IconShape[], color: string): Promise<Record<string, string>> {
  const byPrefix = new Map<string, string[]>();
  for (const shape of shapes) {
    const names = byPrefix.get(shape.prefix) ?? [];
    names.push(shape.name);
    byPrefix.set(shape.prefix, names);
  }
  const entries = await Promise.all([...byPrefix.entries()].map(async ([prefix, names]) => {
    const url = `${ICONIFY_BASE}/${prefix}.json?icons=${names.join(',')}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Icon bundle failed: ${response.status}`);
    const data = (await response.json()) as IconifyBundle;
    const result: [string, string][] = [];
    for (const name of names) {
      const icon = data.icons?.[name];
      if (!icon?.body) continue;
      const width = data.width ?? 24;
      const height = data.height ?? 24;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${colorize(icon.body, color)}</svg>`;
      result.push([shapeKey({ prefix, name }), svg]);
    }
    return result;
  }));
  return Object.fromEntries(entries.flat());
}

export async function fetchShapeBundleCached(shapes: IconShape[], color: string): Promise<{ bundle: Record<string, string>; fromCache: boolean }> {
  const cacheKey = BUNDLE_CACHE_PREFIX + color + '|' + shapes.map(shapeKey).sort().join(',');
  try {
    const bundle = await fetchShapeBundle(shapes, color);
    if (Object.keys(bundle).length > 0) {
      try { await AsyncStorage.setItem(cacheKey, JSON.stringify(bundle)); } catch {}
    }
    return { bundle, fromCache: false };
  } catch (error) {
    const cached = await AsyncStorage.getItem(cacheKey);
    if (!cached) throw error;
    const bundle = JSON.parse(cached) as Record<string, string>;
    if (!bundle || Object.keys(bundle).length === 0) throw error;
    return { bundle, fromCache: true };
  }
}

export const ICON_PACKS: { label: string; color: string; shape: IconShape }[] = [
  { label: 'كلاسيك', color: '#F4C542', shape: { prefix: 'ph', name: 'star-fill' } },
  { label: 'رومانسي', color: '#E8A06A', shape: { prefix: 'ph', name: 'heart-fill' } },
  { label: 'تصوير', color: '#A8B89A', shape: { prefix: 'ph', name: 'camera-fill' } },
  { label: 'دردشة', color: '#E8B832', shape: { prefix: 'ph', name: 'chat-circle-fill' } },
  { label: 'موسيقى', color: '#D6C6A5', shape: { prefix: 'ph', name: 'music-notes-fill' } },
  { label: 'تسوق', color: '#FFE27A', shape: { prefix: 'ph', name: 'bag-fill' } },
  { label: 'قهوة', color: '#31352D', shape: { prefix: 'ph', name: 'coffee-fill' } },
  { label: 'ألعاب', color: '#E8A06A', shape: { prefix: 'ph', name: 'game-controller-fill' } },
  { label: 'طبيعة', color: '#A8B89A', shape: { prefix: 'ph', name: 'flower' } },
  { label: 'طاقة', color: '#F4C542', shape: { prefix: 'mdi', name: 'flash' } },
  { label: 'رياضة', color: '#E8B832', shape: { prefix: 'mdi', name: 'football' } },
];

export function contrastColor(hex: string): string {
  const clean = hex.replace('#', '');
  if (clean.length < 6) return '#FFFFFF';
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.65 ? '#3A331C' : '#FFFFFF';
}
