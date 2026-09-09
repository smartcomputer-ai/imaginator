import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Textarea that commits once: on blur or Enter (Shift+Enter inserts a newline),
 * reverts on Escape. Re-syncs from `value` whenever it changes while not focused.
 */
export function InlineTextarea({
  value,
  onCommit,
  placeholder,
  className,
  rows = 2,
  autoFocus,
  singleLine,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  className?: string;
  rows?: number;
  autoFocus?: boolean;
  /** Enter commits, no newlines at all. */
  singleLine?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const escaped = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const commit = () => {
    setEditing(false);
    if (escaped.current) {
      escaped.current = false;
      setDraft(value);
      return;
    }
    if (draft !== value) onCommit(draft);
  };

  return (
    <textarea
      ref={ref}
      rows={rows}
      value={draft}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={false}
      className={cn(
        'w-full resize-none overflow-hidden rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-[13px] leading-snug text-foreground placeholder:text-muted-foreground/70 hover:border-border focus:border-input focus:bg-card focus:outline-none',
        className,
      )}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(singleLine ? e.target.value.replace(/\n/g, '') : e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (singleLine || !e.shiftKey)) {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          escaped.current = true;
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
