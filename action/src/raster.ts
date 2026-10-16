import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import decodeWebp, { init as initWebpDecoder } from "@jsquash/webp/decode.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

// The build copies each WebAssembly binary next to dist/index.mjs; tests load them from node_modules.
const WASM = {
  resvg: { dist: "resvg.wasm", module: "@resvg/resvg-wasm/index_bg.wasm" },
  webp: { dist: "webp_dec.wasm", module: "@jsquash/webp/codec/dec/webp_dec.wasm" },
};

function wasmBytes(wasm: (typeof WASM)[keyof typeof WASM]): Buffer {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, wasm.dist);
  return readFileSync(existsSync(bundled) ? bundled : join(here, "..", "node_modules", wasm.module));
}

let resvgReady: Promise<void> | undefined;
let webpReady: Promise<void> | undefined;

/** Renders an SVG to PNG, along with its RGBA pixels. */
export async function renderSvg(svg: string): Promise<{ png: Uint8Array; pixels: Uint8Array; width: number; height: number }> {
  resvgReady ??= initWasm(wasmBytes(WASM.resvg));
  await resvgReady;
  const image = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  try {
    return { png: image.asPng(), pixels: image.pixels, width: image.width, height: image.height };
  } finally {
    image.free();
  }
}

/** Decodes a WebP image and re-encodes it as PNG. */
export async function webpToPng(bytes: Uint8Array): Promise<Uint8Array> {
  webpReady ??= initWebpDecoder({ wasmBinary: wasmBytes(WASM.webp) } as Parameters<typeof initWebpDecoder>[0]);
  await webpReady;
  const copy = bytes.slice().buffer;
  const image = (await decodeWebp(copy)) as { width: number; height: number; data: Uint8ClampedArray };
  return encodePng(image.width, image.height, image.data);
}

/** A minimal RGBA PNG encoder: one IDAT, no filtering. */
export function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, deflate, no filter method, no interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
