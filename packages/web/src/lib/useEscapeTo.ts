import { useEffect } from 'react';
import { useNavigate } from 'react-router';

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Escape navigates "up" one level (cell → grid → collections). Ignored when a
 * popover, dialog or select already consumed the key (Radix calls
 * preventDefault on dismiss), while typing in a field, or with modifiers.
 */
export function useEscapeTo(to: string | undefined): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!to) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isEditable(e.target)) return;
      e.preventDefault();
      navigate(to);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [to, navigate]);
}
