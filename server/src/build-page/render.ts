import { closedPullRequestHours } from "../config";
import { DROP_ICON_SVG } from "../icon";
import { qrSvg } from "../qr";
import { buildDays, pullRequestBuildDays, type Kept } from "../retention";
import type { BuildPageModel, LinkedBuild, PageBuild } from "./model";

// The Build page (docs/design.md#build-pages), rendered on the server as one self-contained
// document: system fonts, inline CSS, an inline QR code and one small inline script, so a Tester's
// browser makes no request beyond this deployment.

export interface RenderedPage {
  status: 200 | 403 | 404;
  html: string;
}

export interface RenderContext {
  /** The deployment's URL, without a trailing slash. */
  baseUrl: string;
}

export function renderBuildPage(model: BuildPageModel, ctx: RenderContext): RenderedPage {
  switch (model.kind) {
    case "not_found":
      return { status: 404, html: notFoundPage(ctx) };
    case "private":
      return { status: 403, html: privatePage(ctx) };
    case "available":
      return { status: 200, html: availablePage(model.build, model.newer, model.kept, ctx) };
    case "expired":
      return { status: 200, html: expiredPage(model.build, model.next, ctx) };
  }
}

// ---------------------------------------------------------------------------------------------
// Pages

function availablePage(build: PageBuild, newer: LinkedBuild | null, kept: Kept, ctx: RenderContext): string {
  const url = pageUrl(ctx, build.id);
  const download = `/b/${build.id}/download`;
  const { headline, commitLine } = headlineOf(build);
  const ended = build.channel.endedAt !== null;
  const chips =
    `<span class="chip">${esc(build.channel.name)}</span>` +
    (ended ? `<span class="chip">Ended</span>` : newer === null ? `<span class="chip new">Newest on ${esc(build.channel.name)}</span>` : "");

  const banner = newer
    ? `<div class="banner" role="note"><p><b>A newer Build is on ${esc(build.channel.name)}</b></p>` +
      `<p>${esc(version(newer))}, uploaded ${time(newer.uploadedAt)}.</p>` +
      `<a class="btn quiet" href="/b/${esc(newer.id)}">Open the newest Build</a></div>`
    : "";

  const facts: [string, string][] = [];
  if (build.channel.pullRequest !== null) facts.push(["Pull request", pullRequestLink(build)]);
  if (commitLine === null) facts.push(["Commit", commitLink(build)]);
  facts.push(
    ["CI run", runLink(build)],
    ["Uploaded", time(build.uploadedAt, true)],
    ["Size", esc(formatSize(build.fileSize))],
    ["Kept", keptText(build, kept)],
  );

  const help =
    `<div class="help phone-only"><p><b>First install from Drop?</b> Tap Install, then open the downloaded file. ` +
    `Android asks you to allow installs from this browser once.</p>` +
    `<p><b>“App not installed”?</b> The copy on your phone was signed with a different key. Uninstall it, then install this Build.</p></div>`;

  const qrPanel =
    `<aside class="panel qr-panel" aria-label="Install on your Android phone"><p class="label">Install on your Android phone</p>` +
    `<div class="qr">${qrSvg(url)}</div>` +
    `<ol class="steps"><li>Scan the code with your phone’s camera.</li><li>Tap Install on the page that opens.</li>` +
    `<li>If Android asks, allow installs from your browser. It only asks once.</li></ol>` +
    `<div class="btns"><a class="btn quiet" href="${download}">Download APK</a>` +
    `<button class="btn quiet" type="button" id="copy-link" hidden>Copy link</button></div>` +
    `<input class="copy-field" id="copy-field" type="text" readonly value="${esc(url)}" aria-label="Build page link" hidden></aside>`;

  const body =
    `<header class="head"><div class="wrap">${banner}${appRow(build, chips)}` +
    `<div class="hero"><h1>${esc(headline)}</h1>${commitLine ?? ""}</div></div></header>` +
    `<main class="wrap body"><section class="details" aria-labelledby="about"><h2 class="label" id="about">About this Build</h2>` +
    `${dl(facts)}${help}${technical(build)}</section>${qrPanel}</main>` +
    footer(ctx) +
    `<div class="install-bar phone-only"><a class="btn primary" href="${download}">${DOWNLOAD_ICON}Install · ${esc(formatSize(build.fileSize))}</a></div>`;

  return document(
    {
      title: `${build.name} ${version(build)} · ${build.channel.name}`,
      description: `${headline} · ${build.channel.name}`,
      ogTitle: `${build.name} ${version(build)}`,
      url,
      image: build.hasIcon ? `${ctx.baseUrl}/b/${build.id}/icon` : null,
    },
    body,
  );
}

function expiredPage(build: PageBuild, next: Extract<BuildPageModel, { kind: "expired" }>["next"], ctx: RenderContext): string {
  const channel = build.channel.name;
  const chips = `<span class="chip">${esc(channel)}</span><span class="chip">Expired</span>`;

  let explanation: string;
  if (next.because === "channel_ended" && build.channel.pullRequest !== null && build.channel.endedAt !== null) {
    explanation =
      `Pull request #${build.channel.pullRequest} was closed on ${date(build.channel.endedAt)}, and the Builds on ` +
      `<code>${esc(channel)}</code> were deleted ${hoursLater(closedPullRequestHours(build.applicationId))}.`;
  } else {
    const days = build.channel.pullRequest !== null ? pullRequestBuildDays(build.applicationId) : buildDays(build.applicationId);
    explanation =
      `Builds on <code>${esc(channel)}</code> are deleted ${days} days after upload, unless they are the newest. ` +
      `This one was uploaded on ${date(build.uploadedAt)} and deleted on ${date(build.deletedAt!)}.`;
  }

  let nextPanel: string;
  if (next.build) {
    nextPanel =
      `<aside class="panel next-panel" aria-labelledby="newest"><p class="label" id="newest">Newest on ${esc(next.channel!)}</p>` +
      `<div class="app">${icon(next.build.hasIcon ? `/b/${next.build.id}/icon` : null, false)}<div><span class="app-name">${esc(next.build.name)}</span>` +
      `<span class="ver">${esc(version(next.build))} · ${time(next.build.uploadedAt)}</span></div></div>` +
      `<a class="btn primary" href="/b/${esc(next.build.id)}">Open its Build page</a></aside>`;
  } else {
    const sentence =
      next.channel === null
        ? `${esc(build.name)} has no default Channel yet, so there is no newer Build to offer.`
        : `There is no Build on <code>${esc(next.channel)}</code> to offer instead yet.`;
    nextPanel = `<aside class="panel next-panel"><p class="muted">${sentence}</p></aside>`;
  }

  const facts: [string, string][] = [];
  if (build.channel.pullRequest !== null) facts.push(["Pull request", pullRequestLink(build, true)]);
  facts.push(
    ["Commit", commitLink(build, true)],
    ["CI run", runLink(build)],
    ["Uploaded", time(build.uploadedAt)],
    ["Deleted", time(build.deletedAt!)],
  );

  const body =
    `<header class="head"><div class="wrap">${appRow(build, chips, true)}` +
    `<div class="hero"><h1>This Build has expired</h1><p class="lede">${explanation}</p></div></div></header>` +
    `<main class="wrap body"><section class="details" aria-labelledby="about"><h2 class="label" id="about">About this Build</h2>` +
    `${dl(facts)}${technical(build)}</section>${nextPanel}</main>${footer(ctx)}`;

  return document(
    {
      title: `Expired: ${build.name} ${version(build)}`,
      description: "This Build has expired.",
      ogTitle: `${build.name} ${version(build)} (expired)`,
      url: pageUrl(ctx, build.id),
      image: build.hasIcon ? `${ctx.baseUrl}/b/${build.id}/icon` : null,
    },
    body,
  );
}

// Minimal placeholders: neither page has been through a design pass yet (AGENTS.md, Design before UI).

function notFoundPage(ctx: RenderContext): string {
  return messagePage("No Build here", "There is no Build at this address. Check the link, or ask whoever sent it for a new one.", ctx);
}

function privatePage(ctx: RenderContext): string {
  return messagePage(
    "This Build needs sign-in",
    "Its app is private, and Testers of private apps sign in with GitHub. This Drop deployment doesn’t offer sign-in yet.",
    ctx,
  );
}

function messagePage(heading: string, text: string, ctx: RenderContext): string {
  return document(
    { title: heading, description: null, ogTitle: null, url: null, image: null },
    `<header class="head"><div class="wrap"><div class="hero"><h1>${esc(heading)}</h1><p class="lede">${esc(text)}</p></div></div></header>${footer(ctx)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Pieces

function headlineOf(build: PageBuild): { headline: string; commitLine: string | null } {
  const message = firstLine(build.commitMessage);
  const commitSpan = (text: string | null) =>
    `<p class="commit">${commitLink(build)}${text ? `<span>${esc(text)}</span>` : ""}</p>`;
  if (build.pullRequestTitle) return { headline: build.pullRequestTitle, commitLine: commitSpan(message) };
  if (message) return { headline: message, commitLine: commitSpan(null) };
  // With neither, the app name leads and the commit moves into the details.
  return { headline: build.name, commitLine: null };
}

function appRow(build: PageBuild, chips: string, gone = false): string {
  return (
    `<div class="app-row"><div class="app">${icon(build.hasIcon ? `/b/${build.id}/icon` : null, gone)}` +
    `<div><span class="app-name">${esc(build.name)}</span><span class="ver mono">${esc(version(build))}</span></div></div>` +
    `<div class="chips">${chips}</div></div>`
  );
}

export function icon(src: string | null, gone: boolean): string {
  const cls = `icon${gone ? " gone" : ""}`;
  return src ? `<span class="${cls}"><img src="${esc(src)}" alt="" width="44" height="44"></span>` : `<span class="${cls}" aria-hidden="true"></span>`;
}

function technical(build: PageBuild): string {
  return (
    `<details class="tech"><summary>Technical details</summary>` +
    dl([
      ["Application ID", `<span class="mono">${esc(build.applicationId)}</span>`],
      ["Version code", `<span class="mono">${build.versionCode}</span>`],
      ["Signer SHA-256", `<span class="mono">${esc(colonHex(build.signerSha256))}</span>`],
      ["APK SHA-256", `<span class="mono">${esc(build.fileSha256)}</span>`],
      ["Run ID", `<span class="mono">${build.runId}</span>`],
    ]) +
    `</details>`
  );
}

function keptText(build: PageBuild, kept: Kept): string {
  if (kept.kind === "while_newest") return `While it is the newest on <code>${esc(build.channel.name)}</code>`;
  if (kept.reason === "channel_ended") {
    const hours = closedPullRequestHours(build.applicationId);
    const when = hours === 0 ? "when" : `${duration(hours)} after`;
    return `Until ${time(kept.at)}, ${when} pull request #${build.channel.pullRequest} closed`;
  }
  const days = build.channel.pullRequest !== null ? pullRequestBuildDays(build.applicationId) : buildDays(build.applicationId);
  return `Until ${time(kept.at)}, ${days} days after upload`;
}

function duration(hours: number): string {
  if (hours === 24) return "a day";
  if (hours % 24 === 0) return `${hours / 24} days`;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function hoursLater(hours: number): string {
  return hours === 0 ? "right away" : `${duration(hours)} later`;
}

const github = (build: PageBuild) => `https://github.com/${build.repository.split("/").map(encodeURIComponent).join("/")}`;

function pullRequestLink(build: PageBuild, withTitle = false): string {
  const title = withTitle && build.pullRequestTitle ? ` <span class="muted">${esc(build.pullRequestTitle)}</span>` : "";
  return `<a class="ext" href="${github(build)}/pull/${build.channel.pullRequest}">#${build.channel.pullRequest}</a>${title}`;
}

function commitLink(build: PageBuild, withMessage = false): string {
  const message = withMessage ? firstLine(build.commitMessage) : null;
  return (
    `<a class="mono sha" href="${github(build)}/commit/${esc(build.commitSha)}">${esc(build.commitSha.slice(0, 7))}</a>` +
    (message ? ` <span class="muted">${esc(message)}</span>` : "")
  );
}

function runLink(build: PageBuild): string {
  return `<a class="ext" href="${github(build)}/actions/runs/${build.runId}">${esc(build.workflow)} #${build.runNumber}</a>`;
}

function dl(rows: [string, string][]): string {
  return `<dl class="facts">${rows.map(([term, value]) => `<dt>${esc(term)}</dt><dd>${value}</dd>`).join("")}</dl>`;
}

export function footer(ctx: RenderContext): string {
  return `<footer class="wrap foot"><span class="mark" aria-hidden="true">${DROP_ICON_SVG}</span>Served by Drop · ${esc(new URL(ctx.baseUrl).host)}</footer>`;
}

/** UTC on the server; the page's script rewrites it in the Tester's own time zone. */
export function time(at: number, relative = false): string {
  return `<time datetime="${new Date(at).toISOString()}"${relative ? " data-relative" : ""}>${formatUtc(at)}</time>`;
}

/** "2 hours ago" once the page's script runs; the UTC date and time until then. */
export function ago(at: number): string {
  return `<time datetime="${new Date(at).toISOString()}" data-ago>${formatUtc(at)}</time>`;
}

/** A date alone, for running sentences; localized by the page's script like time(). */
export function date(at: number): string {
  return `<time datetime="${new Date(at).toISOString()}" data-date>${formatUtcDate(at)}</time>`;
}

// ---------------------------------------------------------------------------------------------
// Document

export interface Meta {
  title: string;
  description: string | null;
  ogTitle: string | null;
  url: string | null;
  image: string | null;
}

export function document(meta: Meta, body: string): string {
  const og = meta.ogTitle
    ? [
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="Drop">`,
        `<meta property="og:title" content="${esc(meta.ogTitle)}">`,
        meta.description ? `<meta property="og:description" content="${esc(meta.description)}">` : "",
        meta.url ? `<meta property="og:url" content="${esc(meta.url)}">` : "",
        meta.image ? `<meta property="og:image" content="${esc(meta.image)}">` : "",
        `<meta name="twitter:card" content="summary">`,
      ].join("")
    : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
    `<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">` +
    `<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">` +
    `<meta name="theme-color" content="#161D1A" media="(prefers-color-scheme: dark)">` +
    `<title>${esc(meta.title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">` +
    (meta.description ? `<meta name="description" content="${esc(meta.description)}">` : "") +
    og +
    `<style>${STYLES}</style></head><body>${body}<script>${PAGE_SCRIPT}</script></body></html>`
  );
}

// ---------------------------------------------------------------------------------------------
// Formatting

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatUtc(at: number): string {
  const d = new Date(at);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatUtcDate(at)}, ${hh}:${mm} UTC`;
}

export function formatUtcDate(at: number): string {
  const d = new Date(at);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Decimal units, as Android's own storage screens show them. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** A certificate digest the way keytool and Play Console print it. */
export function colonHex(hex: string): string {
  return hex.toUpperCase().match(/.{1,2}/g)?.join(":") ?? hex;
}

export function version(build: { versionName: string | null; versionCode: number }): string {
  return build.versionName ? `${build.versionName} (${build.versionCode})` : `(${build.versionCode})`;
}

export function firstLine(text: string | null): string | null {
  const line = text?.split(/\r?\n/, 1)[0]?.trim();
  return line ? line : null;
}

function pageUrl(ctx: RenderContext, id: string): string {
  return `${ctx.baseUrl}/b/${id}`;
}

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const DOWNLOAD_ICON =
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
  `stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>`;

// ---------------------------------------------------------------------------------------------
// Inline assets. The script is constant so the Content-Security-Policy can allow it by hash.

/** Localizes times and wires up Copy link; the page works without it. */
export const PAGE_SCRIPT = `(() => {
  const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const rel = typeof Intl.RelativeTimeFormat === "function" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;
  for (const t of document.querySelectorAll("time[datetime]")) {
    const d = new Date(t.getAttribute("datetime"));
    if (isNaN(d.getTime())) continue;
    if (rel && t.hasAttribute("data-ago")) {
      const s = (d.getTime() - Date.now()) / 1000, a = Math.abs(s);
      const [v, u] = a < 3600 ? [s / 60, "minute"] : a < 86400 ? [s / 3600, "hour"] : [s / 86400, "day"];
      t.title = full.format(d);
      t.textContent = rel.format(Math.round(v), u);
      continue;
    }
    t.textContent = (t.hasAttribute("data-date") ? day : full).format(d);
    if (rel && t.hasAttribute("data-relative")) {
      const s = (d.getTime() - Date.now()) / 1000, a = Math.abs(s);
      const [v, u] = a < 3600 ? [s / 60, "minute"] : a < 86400 ? [s / 3600, "hour"] : [s / 86400, "day"];
      const span = document.createElement("span");
      span.className = "muted";
      span.textContent = " · " + rel.format(Math.round(v), u);
      t.after(span);
    }
  }
  const copy = document.getElementById("copy-link"), field = document.getElementById("copy-field");
  if (copy && field) {
    copy.hidden = false;
    copy.addEventListener("click", () => {
      const fallback = () => { field.hidden = false; field.select(); };
      if (!navigator.clipboard) return fallback();
      navigator.clipboard.writeText(field.value).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy link"; }, 1600);
      }, fallback);
    });
  }
})();`;

const STYLES = `
:root{color-scheme:light dark;
--bg:#F4F5F3;--surface:#FFFFFF;--fg:#16201C;--muted:#5C6863;--line:#DCE1DE;--chip:#E8ECEA;
--accent:#0B7A66;--on-accent:#FFFFFF;--accent-soft:#DDF1EB;--accent-text:#0A6A58;--info-bg:#E6EEF9;--info-fg:#1D3A66;
--qr-bg:#FFFFFF}
@media (prefers-color-scheme:dark){:root{
--bg:#0E1311;--surface:#161D1A;--fg:#E5ECE8;--muted:#97A49E;--line:#28322E;--chip:#1E2724;
--accent:#3CCBAA;--on-accent:#04201A;--accent-soft:#12352C;--accent-text:#5ED8BB;--info-bg:#16243A;--info-fg:#BFD3F2}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.mono,code{font-family:ui-monospace,"SF Mono","Roboto Mono",Menlo,Consolas,monospace;font-size:.93em}
a{color:var(--accent-text);text-underline-offset:2px;text-decoration-thickness:1px}
a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.muted{color:var(--muted)}
[hidden]{display:none!important}
.wrap{max-width:1040px;margin:0 auto;padding-left:max(48px,env(safe-area-inset-left));padding-right:max(48px,env(safe-area-inset-right))}
.head{background:var(--surface);border-bottom:1px solid var(--line)}
.head .wrap{padding-block:36px 28px;display:grid;gap:22px}
.app-row{display:flex;justify-content:space-between;align-items:center;gap:12px 16px;flex-wrap:wrap}
.app{display:flex;gap:12px;align-items:center;min-width:0}
.app-name{display:block;font-weight:600;overflow-wrap:anywhere}
.ver{display:block;color:var(--muted);font-size:13px}
.icon{display:block;width:44px;height:44px;flex:none;border-radius:22%;overflow:hidden;background:var(--chip);box-shadow:0 0 0 1px var(--line)}
.icon img{display:block;width:100%;height:100%}
.icon.gone{filter:grayscale(1);opacity:.55}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-family:ui-monospace,"SF Mono","Roboto Mono",Menlo,monospace;font-size:12.5px;line-height:1.2;padding:4px 9px;border-radius:999px;background:var(--chip);color:var(--fg)}
.chip.new{background:var(--accent-soft);color:var(--accent-text)}
.hero{display:grid;gap:10px;max-width:46rem;min-width:0}
h1{margin:0;font-size:32px;line-height:1.15;letter-spacing:-.01em;font-weight:700;text-wrap:balance;overflow-wrap:anywhere}
.lede{margin:0;color:var(--muted);max-width:40rem}
.commit{margin:0;display:flex;gap:10px;align-items:baseline;color:var(--muted);min-width:0}
.commit .sha{flex:none}
.commit span{overflow-wrap:anywhere}
.body{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:48px;align-items:start;padding-block:32px 24px}
.details{display:grid;gap:22px;min-width:0}
.label{margin:0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:10px 22px;margin:0}
.facts dt{color:var(--muted)}
.facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
.ext::after{content:"\\2009\\2197";color:var(--muted);font-size:.85em}
.tech summary{cursor:pointer;color:var(--muted);font-size:14px}
.tech .facts{margin-top:12px;font-size:13.5px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:22px;display:grid;gap:16px;align-content:start;min-width:0}
.panel p{margin:0}
.qr{justify-self:center;background:var(--qr-bg);border:1px solid var(--line);border-radius:14px;padding:12px;line-height:0}
.qr svg{display:block;width:200px;height:200px}
.steps{margin:0;padding-left:20px;display:grid;gap:6px}
.btns{display:flex;flex-wrap:wrap;gap:8px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:12px;padding:14px 18px;font:inherit;font-size:16px;font-weight:600;text-decoration:none;cursor:pointer}
.btn.primary{background:var(--accent);color:var(--on-accent)}
.btn.quiet{background:var(--surface);color:var(--fg);border:1px solid var(--line);font-size:14px;font-weight:500;padding:9px 14px}
.copy-field{width:100%;font-family:ui-monospace,"SF Mono","Roboto Mono",Menlo,monospace;font-size:13px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.banner{display:grid;gap:8px;background:var(--info-bg);color:var(--info-fg);border-radius:12px;padding:12px 14px;font-size:14px}
.banner p{margin:0}
.banner .btn{justify-self:start}
.help{display:grid;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px;font-size:14px}
.help p{margin:0}
.next-panel .btn{width:100%}
.foot{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12.5px;padding-block:8px 28px}
.foot .mark svg{display:block;width:14px;height:14px}
.phone-only{display:none}
.install-bar.phone-only{display:none}
@media (max-width:720px){
body{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column}
.body{flex:1 0 auto;align-content:start}
.body,.foot{width:100%}
.wrap{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}
.head .wrap{padding-block:18px 20px;gap:16px}
h1{font-size:22px}
.body{grid-template-columns:minmax(0,1fr);gap:18px;padding-block:18px 20px}
.qr-panel{display:none}
.next-panel{order:-1}
.help.phone-only{display:grid}
.install-bar.phone-only{display:block;position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--line);
padding:12px max(16px,env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
.install-bar .btn{width:100%}}
.crumbs{font-size:13px;color:var(--muted);margin:0}
.site{padding-block:28px 24px;display:grid;gap:28px}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:22px;display:grid;gap:16px;align-content:start;min-width:0}
.card-top{display:flex;gap:12px;align-items:center;min-width:0}
.card-name{font-weight:600;font-size:17px;color:var(--fg);text-decoration:none;overflow-wrap:anywhere}
.card-mid{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}
.card-mid .qr{padding:8px;border-radius:12px}
.card-mid .qr svg{width:120px;height:120px}
.card-foot{display:flex;flex-wrap:wrap;gap:6px;align-items:center;border-top:1px solid var(--line);padding-top:14px}
.card-foot .all{margin-left:auto;font-size:14px}
a.chip{text-decoration:none}
.stack{display:grid;gap:4px;min-width:0}
.small{font-size:13px;color:var(--muted)}
.list{background:var(--surface);border:1px solid var(--line);border-radius:18px;overflow:hidden}
.item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 20px;align-items:center;padding:16px 20px;border-top:1px solid var(--line)}
.item:first-child{border-top:0}
.item .acts{display:flex;gap:10px;align-items:center}
.item-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dim{opacity:.75}
.icon.big{width:56px;height:56px}
.ended{max-width:560px}
.phone-flex{display:none}
@media (max-width:720px){.cards{grid-template-columns:minmax(0,1fr)}.card-mid .qr{display:none}.phone-flex{display:flex}
.item{grid-template-columns:minmax(0,1fr)}.site{padding-block:18px 20px;gap:20px}}
`;
