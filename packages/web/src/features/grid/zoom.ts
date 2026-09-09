import { useCallback, useState } from 'react';

/** Cell edge lengths in px, smallest to largest. */
export const ZOOM_STEPS = [72, 100, 148, 200, 280, 400] as const;
export const DEFAULT_CELL_SIZE = 200;
const STORAGE_KEY = 'imaginator.cellSize';

function readStored(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    if ((ZOOM_STEPS as readonly number[]).includes(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_CELL_SIZE;
}

/** Grid zoom level, persisted per browser. */
export function useCellSize() {
  const [cellSize, setCellSize] = useState(readStored);
  const index = ZOOM_STEPS.indexOf(cellSize as (typeof ZOOM_STEPS)[number]);
  const set = useCallback((size: number) => {
    setCellSize(size);
    try {
      localStorage.setItem(STORAGE_KEY, String(size));
    } catch {
      /* ignore */
    }
  }, []);
  const zoomIn = useCallback(() => {
    const next = ZOOM_STEPS[Math.min(index + 1, ZOOM_STEPS.length - 1)];
    if (next !== undefined) set(next);
  }, [index, set]);
  const zoomOut = useCallback(() => {
    const next = ZOOM_STEPS[Math.max(index - 1, 0)];
    if (next !== undefined) set(next);
  }, [index, set]);
  return {
    cellSize,
    zoomIn,
    zoomOut,
    canZoomIn: index < ZOOM_STEPS.length - 1,
    canZoomOut: index > 0,
  };
}
