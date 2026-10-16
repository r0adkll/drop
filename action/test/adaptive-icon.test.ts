import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { adaptiveIconSvg, ICON_SIZE, parseResourceTable, parseXmlTree, UnsupportedIcon, type IconSource } from "../src/adaptive-icon.ts";
import { renderSvg, webpToPng } from "../src/raster.ts";

// Each fixture is a small APK built with aapt2 from an adaptive icon, plus aapt2's dumps of it.
const ICON = "res/mipmap-anydpi-v26/ic_launcher.xml";
const fixture = (name: string) => new URL(`./fixtures/adaptive/${name}`, import.meta.url);

function source(name: string): IconSource {
  const apk = readFileSync(fixture(`${name}.apk`));
  const trees = JSON.parse(readFileSync(fixture(`${name}.xmltree.json`), "utf8")) as Record<string, string>;
  return {
    resources: parseResourceTable(readFileSync(fixture(`${name}.resources.txt`), "utf8")),
    xmlTree: (path) => parseXmlTree(trees[path] ?? ""),
    file: (path) => unzipSync(apk, { filter: (entry) => entry.name === path })[path],
    webpToPng,
  };
}

async function draw(name: string) {
  const image = await renderSvg(await adaptiveIconSvg(ICON, source(name)));
  const pixel = (x: number, y: number) => {
    const i = (y * image.width + x) * 4;
    return [...image.pixels.subarray(i, i + 4)];
  };
  return { ...image, pixel };
}

describe("adaptive icons", () => {
  it("draws a bitmap foreground over a colour, cropped to the 72dp safe zone", async () => {
    const icon = await draw("bitmap");
    expect([icon.width, icon.height]).toEqual([ICON_SIZE, ICON_SIZE]);
    expect([...icon.png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    // The day colour, not the night one; the xxxhdpi foreground (white), not the mdpi one (red).
    expect(icon.pixel(2, 2)).toEqual([0x3d, 0x5a, 0xfe, 255]);
    expect(icon.pixel(96, 96)).toEqual([255, 255, 255, 255]);
  });

  it("draws vector layers with groups, clip paths, references and strokes", async () => {
    const icon = await draw("vector");
    expect(icon.pixel(2, 2)).toEqual([0x3d, 0xdc, 0x84, 255]);
    // The square, scaled to half about its centre, keeps only its left half after the clip path.
    expect(icon.pixel(60, 96)).toEqual([255, 255, 255, 255]);
    expect(icon.pixel(130, 96)).toEqual([0x3d, 0xdc, 0x84, 255]);
    // A half-transparent black line along y = 18 of the 24-unit viewport.
    const [r, g, b] = icon.pixel(96, 168);
    expect([r, g, b].map((c) => Math.round(c! / 4))).toEqual([0x3d, 0xdc, 0x84].map((c) => Math.round(c / 8)));
  });

  it("refuses what it can't draw, such as a gradient fill", async () => {
    await expect(adaptiveIconSvg(ICON, source("gradient"))).rejects.toThrow(UnsupportedIcon);
    await expect(adaptiveIconSvg(ICON, source("gradient"))).rejects.toThrow(/gradient/);
  });
});

describe("aapt2 output", () => {
  it("parses xmltree elements, attribute names and values", () => {
    const tree = parseXmlTree(
      [
        "N: android=http://schemas.android.com/apk/res/android (line=1)",
        "  E: vector (line=1)",
        "    A: http://schemas.android.com/apk/res/android:viewportWidth(0x01010402)=24",
        "      E: path (line=2)",
        '        A: http://schemas.android.com/apk/res/android:pathData(0x01010405)="M0,0h24" (Raw: "M0,0h24")',
        "      E: group (line=3)",
        "          E: path (line=4)",
        "            A: http://schemas.android.com/apk/res/android:fillColor(0x01010404)=@0x7f010000",
      ].join("\n"),
    );
    expect(tree).toEqual({
      name: "vector",
      attributes: { viewportWidth: "24" },
      children: [
        { name: "path", attributes: { pathData: "M0,0h24" }, children: [] },
        { name: "group", attributes: {}, children: [{ name: "path", attributes: { fillColor: "@0x7f010000" }, children: [] }] },
      ],
    });
  });

  it("parses each resource's values by configuration", () => {
    const table = parseResourceTable(readFileSync(fixture("bitmap.resources.txt"), "utf8"));
    expect(table.get("0x7f010000")).toEqual([
      { config: "", value: "#ff3d5afe" },
      { config: "night", value: "#ff000000" },
    ]);
  });
});
