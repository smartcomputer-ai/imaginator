import sharp from 'sharp';

/** Solid-color PNG as base64. */
export async function pngBase64(width: number, height: number, color = { r: 200, g: 40, b: 40, alpha: 1 }): Promise<string> {
  const buf = await sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
  return buf.toString('base64');
}

export async function pngBytes(width: number, height: number, color = { r: 40, g: 200, b: 40, alpha: 1 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}
