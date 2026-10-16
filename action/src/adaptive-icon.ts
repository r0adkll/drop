/**
 * Draws an adaptive launcher icon as SVG from the APK's compiled resources, for apps whose icon has
 * no bitmap. Supports colour, bitmap and vector-drawable layers; anything else throws
 * {@link UnsupportedIcon}, and the Build goes without an icon.
 */

export class UnsupportedIcon extends Error {}

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
}

/** Parses `aapt2 dump xmltree --file <path> <apk>` output into its root element. */
export function parseXmlTree(output: string): XmlElement {
  const stack: { depth: number; element: XmlElement }[] = [];
  let root: XmlElement | undefined;
  for (const line of output.split(/\r?\n/)) {
    const element = /^( *)E: (\S+)/.exec(line);
    if (element) {
      const depth = element[1]!.length;
      while (stack.length > 0 && stack.at(-1)!.depth >= depth) stack.pop();
      const node: XmlElement = { name: element[2]!, attributes: {}, children: [] };
      if (stack.length > 0) stack.at(-1)!.element.children.push(node);
      else root ??= node;
      stack.push({ depth, element: node });
      continue;
    }
    // A: http://schemas.android.com/apk/res/android:fillColor(0x01010404)=#ff3ddc84
    const attribute = /^ *A: (?:.*:)?([\w-]+)(?:\(0x[0-9a-f]+\))?=(.*)$/.exec(line);
    if (attribute && stack.length > 0) stack.at(-1)!.element.attributes[attribute[1]!] = attributeValue(attribute[2]!);
  }
  if (!root) throw new UnsupportedIcon("aapt2 printed no XML elements for the icon");
  return root;
}

function attributeValue(raw: string): string {
  const quoted = /^"(.*)"(?: \(Raw: ".*"\))?$/.exec(raw);
  return quoted ? quoted[1]! : raw;
}

/** One configuration's value of a resource, as `aapt2 dump resources` prints it. */
export interface ResourceValue {
  config: string;
  value: string;
}

/** Parses `aapt2 dump resources <apk>` output into each resource ID's values. */
export function parseResourceTable(output: string): Map<string, ResourceValue[]> {
  const table = new Map<string, ResourceValue[]>();
  let current: ResourceValue[] | undefined;
  for (const line of output.split(/\r?\n/)) {
    const resource = /^ {4}resource (0x[0-9a-f]{8}) /.exec(line);
    if (resource) {
      current = [];
      table.set(resource[1]!, current);
      continue;
    }
    const value = /^ {6}\(([^)]*)\) (.*)$/.exec(line);
    if (value && current) current.push({ config: value[1]!, value: value[2]! });
  }
  return table;
}

/** What the icon needs from the APK. */
export interface IconSource {
  resources: Map<string, ResourceValue[]>;
  xmlTree(path: string): XmlElement;
  file(path: string): Uint8Array | undefined;
  /** Converts WebP bytes to PNG, which is all resvg reads besides JPEG. */
  webpToPng(bytes: Uint8Array): Promise<Uint8Array>;
}

/** The icon's size in pixels: Android's 48dp launcher icon at xxxhdpi. */
export const ICON_SIZE = 192;

/**
 * An SVG of the adaptive icon at `path`: the background and foreground layers drawn over 108dp and
 * cropped to the inner 72dp that every launcher mask shows, as a full-bleed square.
 */
export async function adaptiveIconSvg(path: string, source: IconSource): Promise<string> {
  const icon = source.xmlTree(path);
  if (icon.name !== "adaptive-icon") throw new UnsupportedIcon(`a <${icon.name}> launcher icon`);
  const ids = { next: 0 };
  const layers: string[] = [];
  for (const name of ["background", "foreground"]) {
    const layer = icon.children.find((child) => child.name === name);
    if (!layer) continue;
    const drawable = layer.attributes.drawable;
    if (!drawable) throw new UnsupportedIcon(`an inline <${layer.children[0]?.name ?? name}> ${name} layer`);
    layers.push(await drawLayer(drawable, source, ids));
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="18 18 72 72">${layers.join("")}</svg>`
  );
}

const LAYER = 'x="0" y="0" width="108" height="108"';

async function drawLayer(reference: string, source: IconSource, ids: { next: number }): Promise<string> {
  const resolved = resolve(reference, source.resources);
  if (resolved.kind === "color") return `<rect ${LAYER} ${paint("fill", resolved.color)}/>`;
  const { path } = resolved;
  if (/\.(png|webp|jpe?g)$/i.test(path)) {
    let bytes = source.file(path);
    if (!bytes) throw new UnsupportedIcon(`a layer missing from the APK (${path})`);
    let type = /\.png$/i.test(path) ? "image/png" : "image/jpeg";
    if (/\.webp$/i.test(path)) {
      bytes = await source.webpToPng(bytes);
      type = "image/png";
    }
    return `<image ${LAYER} preserveAspectRatio="none" xlink:href="data:${type};base64,${Buffer.from(bytes).toString("base64")}"/>`;
  }
  if (!/\.xml$/i.test(path)) throw new UnsupportedIcon(`a layer of an unknown type (${path})`);
  const root = source.xmlTree(path);
  if (root.name !== "vector") throw new UnsupportedIcon(`a <${root.name}> layer`);
  return drawVector(root, source.resources, ids);
}

type Resolved = { kind: "color"; color: Color } | { kind: "file"; path: string };

/** Follows a reference through the resource table to a colour or a file. */
function resolve(value: string, resources: Map<string, ResourceValue[]>, depth = 0): Resolved {
  if (value.startsWith("#")) return { kind: "color", color: parseColor(value) };
  if (depth > 8) throw new UnsupportedIcon("a resource reference loop");
  const reference = /^@(0x[0-9a-f]{8})$/.exec(value);
  if (!reference) throw new UnsupportedIcon(value.startsWith("?") ? "a theme attribute" : `the value ${value}`);
  const id = reference[1]!;
  if (id.startsWith("0x01")) throw new UnsupportedIcon("an Android framework resource");
  const chosen = chooseConfig(resources.get(id) ?? []);
  if (!chosen) throw new UnsupportedIcon(`a resource with no default value (${id})`);
  const file = /^\(file\) (\S+)/.exec(chosen.value);
  if (file) return { kind: "file", path: file[1]! };
  return resolve(chosen.value, resources, depth + 1);
}

const DENSITIES: Record<string, number> = { ldpi: 120, mdpi: 160, tvdpi: 213, hdpi: 240, xhdpi: 320, xxhdpi: 480, xxxhdpi: 640, nodpi: 0 };

/**
 * The configuration a phone would use: `anydpi` (a vector), otherwise the highest density. Values
 * qualified by anything besides density and SDK version (night mode, locale, layout direction…)
 * are skipped.
 */
function chooseConfig(values: ResourceValue[]): ResourceValue | undefined {
  const rank = (config: string): number | undefined => {
    let density = 0;
    for (const qualifier of config.split("-").filter(Boolean)) {
      if (/^v\d+$/.test(qualifier)) continue;
      if (qualifier === "anydpi") density = Infinity;
      else if (qualifier in DENSITIES) density = DENSITIES[qualifier]!;
      else if (/^\d+dpi$/.test(qualifier)) density = Number.parseInt(qualifier, 10);
      else return undefined;
    }
    return density;
  };
  let best: { value: ResourceValue; rank: number } | undefined;
  for (const value of values) {
    const score = rank(value.config);
    if (score !== undefined && (!best || score > best.rank)) best = { value, rank: score };
  }
  return best?.value;
}

interface Color {
  rgb: string;
  alpha: number;
}

function parseColor(value: string): Color {
  const hex = value.slice(1);
  const expanded = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(expanded)) throw new UnsupportedIcon(`the colour ${value}`);
  const argb = expanded.length === 6 ? `ff${expanded}` : expanded;
  return { rgb: `#${argb.slice(2).toLowerCase()}`, alpha: Number.parseInt(argb.slice(0, 2), 16) / 255 };
}

function paint(kind: "fill" | "stroke", color: Color, alpha = 1): string {
  const opacity = round(color.alpha * alpha);
  return `${kind}="${color.rgb}"${opacity < 1 ? ` ${kind}-opacity="${opacity}"` : ""}`;
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

// android:fillType, strokeLineCap and strokeLineJoin enum values.
const FILL_RULES = ["nonzero", "evenodd"];
const LINE_CAPS = ["butt", "round", "square"];
const LINE_JOINS = ["miter", "round", "bevel"];
const TINT_MODE_SRC_IN = "5";

interface VectorContext {
  resources: Map<string, ResourceValue[]>;
  ids: { next: number };
  /** `android:tint` in SRC_IN mode, which recolours every path while keeping its alpha. */
  tint?: Color;
}

/** A vector drawable stretched over the 108dp layer, as Android draws it. */
function drawVector(vector: XmlElement, resources: Map<string, ResourceValue[]>, ids: { next: number }): string {
  const attrs = vector.attributes;
  const context: VectorContext = { resources, ids };
  if (attrs.tint) {
    if (attrs.tintMode && attrs.tintMode !== TINT_MODE_SRC_IN) throw new UnsupportedIcon("a vector tint mode other than src_in");
    context.tint = color(attrs.tint, context);
  }
  const width = number(attrs.viewportWidth, context);
  const height = number(attrs.viewportHeight, context);
  if (!(width > 0 && height > 0)) throw new UnsupportedIcon("a vector without a viewport");
  const alpha = attrs.alpha === undefined ? 1 : number(attrs.alpha, context);
  return (
    `<svg ${LAYER} viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"${alpha < 1 ? ` opacity="${round(alpha)}"` : ""}>` +
    drawChildren(vector.children, context) +
    "</svg>"
  );
}

/** Draws elements in order; a clip-path clips the siblings drawn after it, as on Android. */
function drawChildren(children: XmlElement[], context: VectorContext): string {
  let out = "";
  for (const [index, child] of children.entries()) {
    if (child.name === "clip-path") {
      const id = `c${context.ids.next++}`;
      const d = pathData(child.attributes.pathData, context);
      return `${out}<clipPath id="${id}"><path d="${d}"/></clipPath><g clip-path="url(#${id})">${drawChildren(children.slice(index + 1), context)}</g>`;
    }
    if (child.name === "group") out += drawGroup(child, context);
    else if (child.name === "path") out += drawPath(child, context);
    else throw new UnsupportedIcon(`a vector <${child.name}> element`);
  }
  return out;
}

function drawGroup(group: XmlElement, context: VectorContext): string {
  const value = (name: string, fallback: number) => (group.attributes[name] === undefined ? fallback : number(group.attributes[name], context));
  const px = value("pivotX", 0);
  const py = value("pivotY", 0);
  const sx = value("scaleX", 1);
  const sy = value("scaleY", 1);
  const rotation = value("rotation", 0);
  const tx = value("translateX", 0);
  const ty = value("translateY", 0);
  // VectorDrawable's group matrix: translate by -pivot, scale, rotate, translate by pivot + translate.
  const parts: string[] = [];
  if (tx + px !== 0 || ty + py !== 0) parts.push(`translate(${round(tx + px)} ${round(ty + py)})`);
  if (rotation !== 0) parts.push(`rotate(${round(rotation)})`);
  if (sx !== 1 || sy !== 1) parts.push(`scale(${round(sx)} ${round(sy)})`);
  if (px !== 0 || py !== 0) parts.push(`translate(${round(-px)} ${round(-py)})`);
  const transform = parts.length > 0 ? ` transform="${parts.join(" ")}"` : "";
  return `<g${transform}>${drawChildren(group.children, context)}</g>`;
}

function drawPath(path: XmlElement, context: VectorContext): string {
  const attrs = path.attributes;
  const optional = (name: string, fallback: number) => (attrs[name] === undefined ? fallback : number(attrs[name], context));
  if (optional("trimPathStart", 0) !== 0 || optional("trimPathEnd", 1) !== 1 || optional("trimPathOffset", 0) !== 0) {
    throw new UnsupportedIcon("a trimmed vector path");
  }
  const parts = [`d="${pathData(attrs.pathData, context)}"`];
  const fill = attrs.fillColor === undefined ? undefined : color(attrs.fillColor, context);
  parts.push(fill ? paint("fill", context.tint ?? fill, (context.tint ? fill.alpha : 1) * optional("fillAlpha", 1)) : 'fill="none"');
  if (attrs.fillType !== undefined) parts.push(`fill-rule="${FILL_RULES[Number(attrs.fillType)] ?? "nonzero"}"`);
  const stroke = attrs.strokeColor === undefined ? undefined : color(attrs.strokeColor, context);
  const strokeWidth = optional("strokeWidth", 0);
  if (stroke && strokeWidth > 0) {
    parts.push(paint("stroke", context.tint ?? stroke, (context.tint ? stroke.alpha : 1) * optional("strokeAlpha", 1)));
    parts.push(`stroke-width="${round(strokeWidth)}"`);
    if (attrs.strokeLineCap !== undefined) parts.push(`stroke-linecap="${LINE_CAPS[Number(attrs.strokeLineCap)] ?? "butt"}"`);
    if (attrs.strokeLineJoin !== undefined) parts.push(`stroke-linejoin="${LINE_JOINS[Number(attrs.strokeLineJoin)] ?? "miter"}"`);
    if (attrs.strokeMiterLimit !== undefined) parts.push(`stroke-miterlimit="${round(number(attrs.strokeMiterLimit, context))}"`);
  }
  return `<path ${parts.join(" ")}/>`;
}

function color(value: string, context: VectorContext): Color {
  const resolved = resolve(value, context.resources);
  if (resolved.kind === "file") throw new UnsupportedIcon("a gradient or colour state list");
  return resolved.color;
}

/** A float attribute, such as `24`, `108.000000dp` or a reference to a dimension resource. */
function number(value: string | undefined, context: VectorContext, depth = 0): number {
  if (value === undefined) return Number.NaN;
  const reference = /^@(0x7f[0-9a-f]{6})$/.exec(value);
  if (reference && depth < 8) {
    const chosen = chooseConfig(context.resources.get(reference[1]!) ?? []);
    if (chosen) return number(chosen.value, context, depth + 1);
  }
  const parsed = /^(-?[\d.]+(?:e[-+]?\d+)?)(?:dp|dip|px)?$/i.exec(value);
  if (!parsed) throw new UnsupportedIcon(`the number ${value}`);
  return Number.parseFloat(parsed[1]!);
}

function pathData(value: string | undefined, context: VectorContext): string {
  if (value === undefined) throw new UnsupportedIcon("a vector path without pathData");
  let data = value;
  if (/^@0x/.test(value)) {
    const chosen = chooseConfig(context.resources.get(value.slice(1)) ?? []);
    const string = chosen && /^"(.*)"$/.exec(chosen.value);
    if (!string) throw new UnsupportedIcon("path data from a resource");
    data = string[1]!;
  }
  return data.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
