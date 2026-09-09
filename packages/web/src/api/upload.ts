import { useCallback, useState } from 'react';
import type { AssetView } from '@imaginator/core';
import { toast } from 'sonner';
import { fileToBase64 } from '@/lib/utils';
import { useApi } from './queries';

export const ASSET_DRAG_TYPE = 'application/x-imaginator-asset';

/** Uploads files via `assets.upload` (base64 JSON body). Returns the created assets. */
export function useUploadFiles() {
  const api = useApi();
  const [uploading, setUploading] = useState(0);
  const upload = useCallback(
    async (files: Iterable<File>, label?: string): Promise<AssetView[]> => {
      const list = [...files].filter((f) => f.type.startsWith('image/') || f.type === '');
      if (!list.length) return [];
      setUploading((n) => n + list.length);
      const out: AssetView[] = [];
      try {
        for (const file of list) {
          const bytes = await fileToBase64(file);
          const res = await api('assets.upload', {
            bytes,
            mime: file.type || undefined,
            label: label ?? (file.name ? file.name.replace(/\.[a-z0-9]+$/i, '') : undefined),
          });
          out.push(res.asset);
        }
        if (out.length) toast.success(out.length === 1 ? `Uploaded ${out[0]!.id}` : `Uploaded ${out.length} images`);
      } finally {
        setUploading((n) => n - list.length);
      }
      return out;
    },
    [api],
  );
  return { upload, uploading: uploading > 0 };
}

/** Files from a paste or drop event, plus a dragged asset id if any. */
export function extractDropPayload(dt: DataTransfer | null): { files: File[]; assetId?: string } {
  if (!dt) return { files: [] };
  const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
  const assetId = dt.getData(ASSET_DRAG_TYPE) || undefined;
  return { files, assetId };
}
