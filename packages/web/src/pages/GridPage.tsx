import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Columns3, Rows3 } from 'lucide-react';
import { useEvents } from '@/api/events';
import { useCollection, useModels } from '@/api/queries';
import { useEscapeTo } from '@/lib/useEscapeTo';
import { useScrollMemory } from '@/lib/useScrollMemory';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { AddColumnDialog } from '@/features/grid/AddColumnDialog';
import { AddRowDialog } from '@/features/grid/AddRowDialog';
import { ColumnHeader } from '@/features/grid/ColumnHeader';
import { GridCell } from '@/features/grid/GridCell';
import { useCellSize } from '@/features/grid/zoom';
import { GridHeader } from '@/features/grid/GridHeader';
import { RowHeader } from '@/features/grid/RowHeader';

const ROW_HEADER_WIDTH = 300;

/** Grid selection, persisted in the URL fragment: `#r3` (a row) or `#r3/flux` (a cell). */
export type GridSelection = { row: string; column?: string };

export function parseSelection(hash: string): GridSelection | undefined {
  const raw = decodeURIComponent(hash.replace(/^#/, ''));
  if (!raw) return undefined;
  const [row, column] = raw.split('/');
  if (!row) return undefined;
  return column ? { row, column } : { row };
}

export function selectionHash(sel: GridSelection | undefined): string {
  return sel ? `#${sel.column ? `${sel.row}/${sel.column}` : sel.row}` : '';
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null;
}

export function GridPage() {
  const { slug = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  useEscapeTo('/');
  const scrollRef = useScrollMemory<HTMLDivElement>(`grid:${slug}`);
  useEvents(slug);
  const { data: collection, isLoading, error } = useCollection(slug);
  const models = useModels();
  const [addColumn, setAddColumn] = useState(false);
  const [addRow, setAddRow] = useState(false);
  const zoom = useCellSize();

  const modelById = useMemo(() => new Map((models.data?.models ?? []).map((m) => [m.id, m])), [models.data]);
  const columns = useMemo(() => [...(collection?.columns ?? [])].sort((a, b) => a.position - b.position), [collection]);
  const rows = useMemo(() => [...(collection?.rows ?? [])].sort((a, b) => a.position - b.position), [collection]);
  const cellMap = useMemo(() => new Map((collection?.cells ?? []).map((c) => [`${c.row}/${c.column}`, c])), [collection]);
  const columnOrder = useMemo(() => columns.map((c) => c.id), [columns]);
  const spendByColumn = useMemo(() => {
    const totals = new Map<string, number>();
    for (const c of collection?.cells ?? []) if (c.cost !== undefined) totals.set(c.column, (totals.get(c.column) ?? 0) + c.cost);
    return totals;
  }, [collection]);
  const rowOrder = useMemo(() => rows.map((r) => r.id), [rows]);

  // Selection: a row or a cell, kept in the fragment so grids can be linked into.
  const selection = useMemo(() => {
    const sel = parseSelection(location.hash);
    if (!sel || !rowOrder.includes(sel.row)) return undefined;
    if (sel.column && !columnOrder.includes(sel.column)) return { row: sel.row };
    return sel;
  }, [location.hash, rowOrder, columnOrder]);
  const select = (sel: GridSelection | undefined) => navigate({ hash: selectionHash(sel) }, { replace: true });

  useEffect(() => {
    if (!selection) return;
    const id = selection.column ? `cell-${selection.row}-${selection.column}` : `row-${selection.row}`;
    document.getElementById(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selection]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isEditable(e.target)) return;
      if (e.key === 'Escape' && selection) {
        // Escape clears the selection first; a second Escape leaves the grid (useEscapeTo honors preventDefault).
        e.preventDefault();
        select(undefined);
        return;
      }
      const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '];
      if (!keys.includes(e.key) || rowOrder.length === 0) return;
      e.preventDefault();
      if (!selection) {
        select({ row: rowOrder[0]! });
        return;
      }
      const ri = rowOrder.indexOf(selection.row);
      const ci = selection.column ? columnOrder.indexOf(selection.column) : -1;
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowDown': {
          const next = rowOrder[Math.min(rowOrder.length - 1, Math.max(0, ri + (e.key === 'ArrowDown' ? 1 : -1)))]!;
          select(selection.column ? { row: next, column: selection.column } : { row: next });
          return;
        }
        case 'ArrowRight': {
          // Row → first cell; last cell → the row again.
          if (ci === columnOrder.length - 1 || columnOrder.length === 0) select({ row: selection.row });
          else select({ row: selection.row, column: columnOrder[ci + 1]! });
          return;
        }
        case 'ArrowLeft': {
          // Row → last cell; first cell → the row.
          if (ci === -1) select(columnOrder.length ? { row: selection.row, column: columnOrder[columnOrder.length - 1]! } : { row: selection.row });
          else if (ci === 0) select({ row: selection.row });
          else select({ row: selection.row, column: columnOrder[ci - 1]! });
          return;
        }
        case 'Enter':
        case ' ':
          if (selection.column) navigate(`/c/${slug}/${selection.row}/${selection.column}`);
          else if (columnOrder[0]) select({ row: selection.row, column: columnOrder[0] });
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selection, rowOrder, columnOrder, slug, navigate]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-muted-foreground">
        <Spinner /> Loading {slug}…
      </div>
    );
  }
  if (error || !collection) {
    return <div className="p-6 text-sm text-destructive">Could not load collection "{slug}": {error?.message ?? 'not found'}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <GridHeader collection={collection} zoom={zoom} />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {columns.length === 0 && rows.length === 0 ? (
          <EmptyState onAddColumn={() => setAddColumn(true)} onAddRow={() => setAddRow(true)} />
        ) : (
          <table className="border-separate border-spacing-0">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 border-b border-r bg-card px-2 py-1 text-left text-[11px] font-medium text-muted-foreground" style={{ minWidth: ROW_HEADER_WIDTH, width: ROW_HEADER_WIDTH }}>
                  {rows.length} rows × {columns.length} columns
                </th>
                {columns.map((col, i) => (
                  <th key={col.id} className="sticky top-0 z-10 border-b border-r bg-card p-0 align-top font-normal" style={{ minWidth: zoom.cellSize + 12, width: zoom.cellSize + 12, maxWidth: zoom.cellSize + 12 }}>
                    {/* Fixed-width wrapper: the image decides the column width, long ids and model names truncate. */}
                    <div className="overflow-hidden" style={{ width: zoom.cellSize + 12 }}>
                      <ColumnHeader slug={slug} column={col} model={modelById.get(col.model)} index={i} total={columns.length} order={columnOrder} spend={spendByColumn.get(col.id)} />
                    </div>
                  </th>
                ))}
                <th className="sticky top-0 z-10 border-b bg-card p-1 align-top">
                  <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setAddColumn(true)}>
                    <Columns3 /> Add column
                  </Button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.id} id={`row-${row.id}`} className={selection?.row === row.id && !selection.column ? 'bg-accent/40' : undefined}>
                  <td
                    className={`sticky left-0 z-10 border-b border-r bg-card p-0 align-top ${selection?.row === row.id && !selection.column ? 'ring-2 ring-inset ring-ring' : ''}`}
                    style={{ minWidth: ROW_HEADER_WIDTH, width: ROW_HEADER_WIDTH }}
                    onClick={(e) => {
                      // Plain clicks on the header's chrome select the row; controls keep their own behaviour.
                      if ((e.target as HTMLElement).closest('a, button, textarea, input, [role="menuitem"]')) return;
                      select({ row: row.id });
                    }}
                  >
                    <RowHeader slug={slug} row={row} defaults={collection.defaults} index={i} total={rows.length} order={rowOrder} columns={columnOrder} />
                  </td>
                  {columns.map((col) => (
                    <td key={col.id} id={`cell-${row.id}-${col.id}`} className="border-b border-r p-1.5 align-top">
                      <GridCell slug={slug} cell={cellMap.get(`${row.id}/${col.id}`)} size={zoom.cellSize} selected={selection?.row === row.id && selection.column === col.id} />
                    </td>
                  ))}
                  <td className="border-b" />
                </tr>
              ))}
              <tr>
                <td className="sticky left-0 z-10 bg-card p-1">
                  <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setAddRow(true)}>
                    <Rows3 /> Add row
                  </Button>
                </td>
                <td colSpan={columns.length + 1} />
              </tr>
            </tbody>
          </table>
        )}
      </div>
      <AddColumnDialog slug={slug} open={addColumn} onOpenChange={setAddColumn} existingIds={columnOrder} />
      <AddRowDialog slug={slug} open={addRow} onOpenChange={setAddRow} />
    </div>
  );
}

function EmptyState({ onAddColumn, onAddRow }: { onAddColumn: () => void; onAddRow: () => void }) {
  return (
    <div className="m-6 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
      <p>This collection is empty. Add a column (a model) and a row (a prompt) to start generating.</p>
      <div className="mt-3 flex justify-center gap-2">
        <Button variant="outline" size="sm" onClick={onAddColumn}>
          <Columns3 /> Add column
        </Button>
        <Button size="sm" onClick={onAddRow}>
          <Rows3 /> Add row
        </Button>
      </div>
    </div>
  );
}
