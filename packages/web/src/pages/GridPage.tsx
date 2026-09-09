import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { Columns3, Rows3 } from 'lucide-react';
import { useEvents } from '@/api/events';
import { useCollection, useModels } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { AddColumnDialog } from '@/features/grid/AddColumnDialog';
import { AddRowDialog } from '@/features/grid/AddRowDialog';
import { ColumnHeader } from '@/features/grid/ColumnHeader';
import { CELL_SIZE, GridCell } from '@/features/grid/GridCell';
import { GridHeader } from '@/features/grid/GridHeader';
import { RowHeader } from '@/features/grid/RowHeader';

const ROW_HEADER_WIDTH = 300;

export function GridPage() {
  const { slug = '' } = useParams();
  useEvents(slug);
  const { data: collection, isLoading, error } = useCollection(slug);
  const models = useModels();
  const [addColumn, setAddColumn] = useState(false);
  const [addRow, setAddRow] = useState(false);

  const modelById = useMemo(() => new Map((models.data?.models ?? []).map((m) => [m.id, m])), [models.data]);
  const columns = useMemo(() => [...(collection?.columns ?? [])].sort((a, b) => a.position - b.position), [collection]);
  const rows = useMemo(() => [...(collection?.rows ?? [])].sort((a, b) => a.position - b.position), [collection]);
  const cellMap = useMemo(() => new Map((collection?.cells ?? []).map((c) => [`${c.row}/${c.column}`, c])), [collection]);
  const columnOrder = useMemo(() => columns.map((c) => c.id), [columns]);
  const rowOrder = useMemo(() => rows.map((r) => r.id), [rows]);

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
      <GridHeader collection={collection} />
      <div className="min-h-0 flex-1 overflow-auto">
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
                  <th key={col.id} className="sticky top-0 z-10 border-b border-r bg-card p-0 align-top font-normal" style={{ minWidth: CELL_SIZE + 12, width: CELL_SIZE + 12 }}>
                    <ColumnHeader slug={slug} column={col} model={modelById.get(col.model)} index={i} total={columns.length} order={columnOrder} />
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
                <tr key={row.id}>
                  <td className="sticky left-0 z-10 border-b border-r bg-card p-0 align-top" style={{ minWidth: ROW_HEADER_WIDTH, width: ROW_HEADER_WIDTH }}>
                    <RowHeader slug={slug} row={row} defaults={collection.defaults} index={i} total={rows.length} order={rowOrder} />
                  </td>
                  {columns.map((col) => (
                    <td key={col.id} className="border-b border-r p-1.5 align-top">
                      <GridCell slug={slug} cell={cellMap.get(`${row.id}/${col.id}`)} />
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
