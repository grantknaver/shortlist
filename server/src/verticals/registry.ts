import type { VerticalPack } from '../core/vertical.js';
import { roofingPack } from './roofing/index.js';

/** Add salons/chiropractors here later — the core engine doesn't change. */
export const VERTICALS: Record<string, VerticalPack<any, any>> = {
  roofing: roofingPack,
};
