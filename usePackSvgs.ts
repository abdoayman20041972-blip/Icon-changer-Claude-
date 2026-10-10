import { useEffect, useState } from 'react';
import { ICON_PACKS, contrastColor, fetchShapeBundleCached, shapeKey } from './iconApi';

/**
 * Loads the SVG of every ready-made pack with at most two bundled requests (one per
 * glyph color), instead of one network request per pack. Results are cached offline.
 */
export function usePackSvgs(): Record<string, string> {
  const [svgs, setSvgs] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    (async () => {
      const groups = new Map<string, typeof ICON_PACKS>();
      for (const pack of ICON_PACKS) {
        const color = contrastColor(pack.color);
        groups.set(color, [...(groups.get(color) ?? []), pack]);
      }
      const result: Record<string, string> = {};
      await Promise.all([...groups.entries()].map(async ([color, packs]) => {
        try {
          const { bundle } = await fetchShapeBundleCached(packs.map((pack) => pack.shape), color);
          for (const pack of packs) {
            const svg = bundle[shapeKey(pack.shape)];
            if (svg) result[pack.label] = svg;
          }
        } catch {
          // offline and not cached yet: the pack keeps its loading indicator
        }
      }));
      if (active) setSvgs(result);
    })();
    return () => { active = false; };
  }, []);
  return svgs;
}
