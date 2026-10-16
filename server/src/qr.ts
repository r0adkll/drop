import { encode } from "uqr";

/** Modules of white around the code; scanners need at least four. */
const QUIET_ZONE = 4;

/**
 * An SVG QR code for `text`: black on white whatever the theme, since scanners need the contrast,
 * and scalable so a pull request comment can draw it at 128px.
 */
export function qrSvg(text: string): string {
  const { data, size } = encode(text, { ecc: "M", border: QUIET_ZONE });
  let path = "";
  data.forEach((row, y) => {
    // One rectangle per run of dark modules keeps the path short.
    for (let x = 0; x < size; x++) {
      if (!row[x]) continue;
      let run = 1;
      while (x + run < size && row[x + run]) run++;
      path += `M${x} ${y}h${run}v1h-${run}z`;
      x += run - 1;
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${path}"/></svg>`
  );
}

/**
 * A PNG QR code for `text`, for chat apps that don't render SVG (docs/design.md#notifications):
 * black on white, `scale` pixels per module.
 */
export async function qrPng(text: string, scale = 8): Promise<Uint8Array<ArrayBuffer>> {
  const { data, size } = encode(text, { ecc: "M", border: QUIET_ZONE });
  const width = size * scale;
  // 8-bit grayscale scanlines, each led by filter byte 0.
  const raw = new Uint8Array((width + 1) * width);
  for (let y = 0; y < width; y++) {
    const row = data[Math.floor(y / scale)]!;
    const offset = y * (width + 1);
    for (let x = 0; x < width; x++) raw[offset + 1 + x] = row[Math.floor(x / scale)] ? 0 : 255;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, width);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit grayscale, deflate, no filter method, no interlace
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([new TextEncoder().encode(type), data]);
  const out = new Uint8Array(body.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(body.length + 4, crc32(body));
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
