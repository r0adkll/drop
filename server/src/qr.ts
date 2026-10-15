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
