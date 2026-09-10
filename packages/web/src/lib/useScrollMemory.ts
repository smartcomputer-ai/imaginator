import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Scroll offsets of inner scroll containers, keyed by page; survives route changes within the session. */
const positions = new Map<string, { top: number; left: number }>();

/**
 * Remember and restore the scroll position of an element across navigation.
 * The browser only restores the window's scroll, and the grid scrolls inside
 * its own container, so going into a cell and back would otherwise land at the top.
 * Attach the returned ref to the scrolling element.
 */
export function useScrollMemory<T extends HTMLElement>(key: string): RefObject<T | null> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const saved = positions.get(key);
    if (saved) {
      el.scrollTop = saved.top;
      el.scrollLeft = saved.left;
    }
    const onScroll = () => positions.set(key, { top: el.scrollTop, left: el.scrollLeft });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      onScroll();
      el.removeEventListener('scroll', onScroll);
    };
  }, [key]);
  return ref;
}
