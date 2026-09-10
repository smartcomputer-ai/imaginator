import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Tallest an editor grows while focused before it scrolls instead. */
const EDIT_MAX_VH = 0.45;

function Key({ children }: { children: ReactNode }) {
  return <kbd className="rounded border bg-muted px-1 py-px font-sans text-[10px] text-foreground">{children}</kbd>;
}

/** Fixed hint at the bottom of the viewport while an inline editor has focus. */
function EditHint({ singleLine, saveNote }: { singleLine?: boolean; saveNote?: string }) {
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex justify-center">
      <div className="flex items-center gap-1.5 rounded-full border bg-popover/95 px-3 py-1 text-[11px] text-muted-foreground shadow-md backdrop-blur">
        <Key>Enter</Key> or click away saves{saveNote ? ` · ${saveNote}` : ''}
        {!singleLine && (
          <>
            <span className="text-border">|</span>
            <Key>Shift</Key>+<Key>Enter</Key> new line
          </>
        )}
        <span className="text-border">|</span>
        <Key>Esc</Key> discards
      </div>
    </div>,
    document.body,
  );
}

/**
 * Textarea that commits once: on blur or Enter (Shift+Enter inserts a newline),
 * reverts on Escape. Re-syncs from `value` whenever it changes while not focused.
 *
 * With `maxRows`, long text is clipped to that many lines while idle (hover
 * shows the full text in a tooltip) and expands to fit when focused, up to
 * about half the viewport, beyond which it scrolls.
 */
export function InlineTextarea({
  value,
  onCommit,
  placeholder,
  className,
  rows = 2,
  maxRows,
  autoFocus,
  singleLine,
  saveNote,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  className?: string;
  rows?: number;
  /** Lines shown while not editing; omit to always show everything. */
  maxRows?: number;
  autoFocus?: boolean;
  /** Enter commits, no newlines at all. */
  singleLine?: boolean;
  /** What saving does, shown in the editing hint (e.g. "changes regenerate this row"). */
  saveNote?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [clipped, setClipped] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const escaped = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    const full = el.scrollHeight;
    let limit = Infinity;
    if (editing) {
      limit = Math.max(window.innerHeight * EDIT_MAX_VH, 120);
    } else if (maxRows !== undefined) {
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.375;
      limit = Math.ceil(line * maxRows + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth));
    }
    const height = Math.min(full, limit);
    el.style.height = `${height}px`;
    // Scroll only while editing; idle text is clipped and readable via the tooltip.
    el.style.overflowY = editing && full > limit ? 'auto' : 'hidden';
    setClipped(!editing && full > limit + 1);
  }, [draft, editing, maxRows]);

  const commit = () => {
    setEditing(false);
    if (escaped.current) {
      escaped.current = false;
      setDraft(value);
      return;
    }
    if (draft !== value) onCommit(draft);
  };

  const hint = editing && <EditHint singleLine={singleLine} saveNote={saveNote} />;

  const textarea = (
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
      onFocus={() => {
        setEditing(true);
        setTipOpen(false);
      }}
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

  if (maxRows === undefined) {
    return (
      <>
        {textarea}
        {hint}
      </>
    );
  }
  // Controlled so the tooltip only ever shows for clipped, idle text; the textarea never remounts.
  return (
    <>
      <Tooltip open={tipOpen && clipped && !editing} onOpenChange={setTipOpen}>
        <TooltipTrigger asChild>{textarea}</TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-h-[60vh] max-w-md overflow-auto whitespace-pre-wrap">
          {draft}
        </TooltipContent>
      </Tooltip>
      {hint}
    </>
  );
}
