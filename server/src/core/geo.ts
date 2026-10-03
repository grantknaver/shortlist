import type { GeoPoint } from './types.js';

const R_MI = 3958.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in miles. Deterministic — never ask an LLM whether a point is "near". */
export function distanceMi(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.sqrt(h));
}

/** Bounding box around a point (for API spatial filters). */
export function bboxAround(c: GeoPoint, radiusMi: number) {
  const dLat = radiusMi / 69.0;
  const dLon = radiusMi / (69.0 * Math.cos(toRad(c.lat)));
  return { minLat: c.lat - dLat, maxLat: c.lat + dLat, minLon: c.lon - dLon, maxLon: c.lon + dLon };
}

/** Linear interpolation over sorted [x, y] points, clamped at the ends. */
export function interp(x: number, table: [number, number][]): number {
  if (!table.length) return 0;
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    const [x0, y0] = table[i - 1];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return table[table.length - 1][1];
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Crude but deterministic clustering of points into focus areas (to limit API queries). */
export function clusterPoints(points: GeoPoint[], radiusMi: number): { center: GeoPoint; radiusMi: number }[] {
  const clusters: { center: GeoPoint; members: GeoPoint[] }[] = [];
  for (const p of points) {
    const hit = clusters.find((c) => distanceMi(c.center, p) <= radiusMi);
    if (hit) {
      hit.members.push(p);
      hit.center = {
        lat: hit.members.reduce((s, m) => s + m.lat, 0) / hit.members.length,
        lon: hit.members.reduce((s, m) => s + m.lon, 0) / hit.members.length,
      };
    } else clusters.push({ center: p, members: [p] });
  }
  return clusters.map((c) => ({
    center: c.center,
    radiusMi: radiusMi + Math.max(0, ...c.members.map((m) => distanceMi(c.center, m))),
  }));
}
