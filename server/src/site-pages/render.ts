// The index, Product and Channel pages (docs/design.md#site-pages), in the Build page's document,
// styles and script, as agreed on the site pages canvas.

import { ago, date, document, esc, footer, formatSize, icon, time, version, type RenderContext, type RenderedPage } from "../build-page/render";
import { closedPullRequestHours } from "../config";
import { DROP_ICON_SVG } from "../icon";
import { qrSvg } from "../qr";
import { buildDays, pullRequestBuildDays } from "../retention";
import type { ChannelBuild, ChannelPageModel, ChannelSummary, ProductPageModel, ProductSummary } from "./model";

const HOUR = 3_600_000;

export const productPath = (applicationId: string) => `/p/${encodeURIComponent(applicationId)}`;
export const channelPath = (applicationId: string, channel: string) =>
  `${productPath(applicationId)}/c/${channel.split("/").map(encodeURIComponent).join("/")}`;

const github = (repository: string) => `https://github.com/${repository.split("/").map(encodeURIComponent).join("/")}`;
const buildPath = (id: string) => `/b/${id}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function renderIndex(products: ProductSummary[], ctx: RenderContext): RenderedPage {
  const host = esc(new URL(ctx.baseUrl).host);
  const cards = products.map((product) => indexCard(product, ctx)).join("");
  const body =
    `<header class="head"><div class="wrap"><div class="hero">` +
    `<p class="brand"><span class="logo" aria-hidden="true">${DROP_ICON_SVG}</span>${host}</p><h1>Apps</h1>` +
    `<p class="lede">Test builds from CI. Scan a code with your Android phone, or open an app to see its channels.</p>` +
    `</div></div></header>` +
    `<main class="wrap site">${products.length > 0 ? `<div class="cards">${cards}</div>` : `<p class="muted">No apps have Builds here yet.</p>`}</main>` +
    footer(ctx);
  return { status: 200, html: document({ title: `Apps · ${new URL(ctx.baseUrl).host}`, description: null, ogTitle: null, url: null, image: null }, body) };
}

function indexCard(product: ProductSummary, ctx: RenderContext): string {
  const home = product.channels.find((c) => c.isDefault);
  const named = product.channels.filter((c) => !c.isDefault && c.pullRequest === null);
  const pullRequests = product.channels.filter((c) => c.pullRequest !== null).length;
  const chips = [
    home ? `<a class="chip new" href="${channelPath(product.applicationId, home.name)}">${esc(home.name)}</a>` : "",
    ...named.map((c) => `<a class="chip" href="${channelPath(product.applicationId, c.name)}">${esc(c.name)}</a>`),
    pullRequests > 0 ? `<a class="chip" href="${productPath(product.applicationId)}">${plural(pullRequests, "pull request", "pull requests")}</a>` : "",
  ].join("");
  const middle = home
    ? `<div class="card-mid"><div class="stack">` +
      `<p class="label">Newest on ${esc(home.name)}</p>` +
      `<div><b>${esc(version(home.newest))}</b></div><div>${esc(home.newest.headline)}</div>` +
      `<div class="small">${ago(home.newest.uploadedAt)} · ${formatSize(home.newest.fileSize)}</div>` +
      `<a href="${buildPath(home.newest.id)}">Open its Build page</a>` +
      `<a class="btn primary phone-flex" href="${buildPath(home.newest.id)}/download">Install · ${formatSize(home.newest.fileSize)}</a>` +
      `</div><div class="qr" role="img" aria-label="QR code for its Build page">${qrSvg(`${ctx.baseUrl}${buildPath(home.newest.id)}`)}</div></div>`
    : `<div class="stack"><p class="label">No Builds on its default channel yet</p>` +
      `<div class="muted">Its other channels have Builds; open the app to see them.</div></div>`;
  return (
    `<article class="card">${productHeading(product, false)}${middle}` +
    `<div class="card-foot">${chips}<a class="all" href="${productPath(product.applicationId)}">All channels</a></div></article>`
  );
}

function productHeading(product: ProductSummary, big: boolean): string {
  const src = product.iconBuildId ? `${buildPath(product.iconBuildId)}/icon` : null;
  const name = big ? `<h1>${esc(product.name)}</h1>` : `<a class="card-name" href="${productPath(product.applicationId)}">${esc(product.name)}</a>`;
  return (
    `<div class="card-top">${icon(src, false).replace('class="icon', big ? 'class="icon big' : 'class="icon')}` +
    `<div class="stack">${name}<div class="small"><a href="${github(product.repository)}">${esc(product.repository)}</a>` +
    (big ? ` · <span class="mono">${esc(product.applicationId)}</span>` : "") +
    `</div></div></div>`
  );
}

export function renderProductPage(model: ProductPageModel, ctx: RenderContext): RenderedPage {
  if (model.kind !== "product") return refusal(model.kind, ctx);
  const { product } = model;
  const channels = product.channels.filter((c) => c.pullRequest === null);
  const pullRequests = product.channels.filter((c) => c.pullRequest !== null);
  const body =
    `<header class="head"><div class="wrap"><p class="crumbs"><a href="/">Apps</a> / ${esc(product.name)}</p>${productHeading(product, true)}</div></header>` +
    `<main class="wrap site">` +
    (channels.length > 0 ? section("Channels", channels.map((c) => channelRow(product, c)).join("")) : "") +
    (pullRequests.length > 0 ? section("Pull requests", pullRequests.map((c) => pullRequestRow(product, c)).join("")) : "") +
    `</main>` +
    footer(ctx);
  return { status: 200, html: document({ title: `${product.name} · Drop`, description: null, ogTitle: null, url: null, image: null }, body) };
}

const section = (label: string, rows: string) => `<section class="stack"><h2 class="label">${esc(label)}</h2><div class="list">${rows}</div></section>`;

function channelRow(product: ProductSummary, channel: ChannelSummary): string {
  const href = channelPath(product.applicationId, channel.name);
  return (
    `<div class="item"><div class="stack">` +
    `<div class="item-head"><a class="chip${channel.isDefault ? " new" : ""}" href="${href}">${esc(channel.name)}</a>` +
    (channel.isDefault ? `<span class="small">Default channel</span>` : "") +
    `</div><div><b>${esc(version(channel.newest))}</b> · ${esc(channel.newest.headline)}</div>` +
    `<div class="small">${ago(channel.newest.uploadedAt)} · ${plural(channel.liveBuilds, "Build", "Builds")}</div>` +
    `</div><a href="${href}">View channel</a></div>`
  );
}

function pullRequestRow(product: ProductSummary, channel: ChannelSummary): string {
  const href = channelPath(product.applicationId, channel.name);
  const title = channel.pullRequestTitle ? esc(channel.pullRequestTitle) : `Pull request #${channel.pullRequest}`;
  const ended = channel.endedAt !== null;
  const status = ended
    ? `${channel.merged ? "Merged" : "Closed"} ${ago(channel.endedAt!)} · its ${plural(channel.liveBuilds, "Build is", "Builds are")} deleted ${time(channel.endedAt! + closedPullRequestHours(product.applicationId) * HOUR)}`
    : `Open · newest ${esc(version(channel.newest))}, ${ago(channel.newest.uploadedAt)} · ${plural(channel.liveBuilds, "Build", "Builds")}`;
  return (
    `<div class="item"><div class="stack">` +
    `<div class="item-head"><a class="chip${ended ? " dim" : ""}" href="${href}">${esc(channel.name)}</a><span${ended ? ' class="muted"' : ""}>${title}</span></div>` +
    `<div class="small">${status}</div></div><a href="${href}">View channel</a></div>`
  );
}

export function renderChannelPage(model: ChannelPageModel, ctx: RenderContext): RenderedPage {
  if (model.kind === "private" || model.kind === "not_found") return refusal(model.kind, ctx);
  const { product } = model;
  const crumbs = `<p class="crumbs"><a href="/">Apps</a> / <a href="${productPath(product.applicationId)}">${esc(product.name)}</a> / ${esc(model.channel.name)}</p>`;
  const pr = model.channel.pullRequest;
  const prLink = pr !== null ? `<a href="${github(product.repository)}/pull/${pr}">#${pr}</a>` : "";

  if (model.kind === "ended") {
    const { channel, next } = model;
    const state = channel.merged ? "merged" : "closed";
    const heading = channel.pullRequestTitle ?? channel.name;
    const offered = next
      ? `<div class="card-top">${icon(product.iconBuildId ? `${buildPath(product.iconBuildId)}/icon` : null, false)}` +
        `<div class="stack"><div><b>${esc(version(next.build))}</b> · newest on <span class="mono">${esc(next.channel)}</span></div>` +
        `<div class="small">${ago(next.build.uploadedAt)}</div></div></div>` +
        `<a class="btn primary" href="${channelPath(product.applicationId, next.channel)}">Open ${esc(next.channel)}</a>`
      : `<p class="muted">${esc(product.name)} has no default channel yet, so there is nothing newer to offer.</p>`;
    const body =
      `<header class="head"><div class="wrap"><div class="hero">${crumbs}` +
      `<div class="item-head"><span class="chip">${esc(channel.name)}</span>${pr !== null ? `<span class="small">Pull request ${prLink} · ${state}</span>` : ""}</div>` +
      `<h1>${esc(heading)}</h1></div></div></header>` +
      `<main class="wrap site"><section class="panel ended"><h2 style="margin:0;font-size:18px">This channel has ended</h2>` +
      `<p>${pr !== null ? `Pull request #${pr} was ${state}` : `${esc(channel.name)} ended`} on ${date(channel.endedAt)}, and its Builds were deleted after that.</p>` +
      `<p class="muted">Testers on one of its Builds are offered the newest on ${next ? `<span class="mono">${esc(next.channel)}</span>` : "the default channel"}.</p>` +
      offered +
      `</section></main>` +
      footer(ctx);
    return { status: 200, html: document({ title: `${product.name} on ${channel.name} · Drop`, description: null, ogTitle: null, url: null, image: null }, body) };
  }

  const { channel, builds } = model;
  const heading = channel.pullRequestTitle && pr !== null ? channel.pullRequestTitle : `${product.name} on ${channel.name}`;
  const state = channel.endedAt === null ? "open" : channel.merged ? "merged" : "closed";
  const days = pr !== null ? pullRequestBuildDays(product.applicationId) : buildDays(product.applicationId);
  const keptLine =
    channel.endedAt === null
      ? `Each upload adds a Build. The newest is kept while ${pr !== null ? "the pull request is open" : "it is the newest"}; older ones are deleted ${days} days after upload.`
      : `This pull request was ${state}; its Builds are deleted ${time(channel.endedAt + closedPullRequestHours(product.applicationId) * HOUR)}.`;
  const body =
    `<header class="head"><div class="wrap"><div class="hero">${crumbs}` +
    `<div class="item-head"><span class="chip${channel.isDefault ? " new" : ""}">${esc(channel.name)}</span>` +
    (pr !== null ? `<span class="small">Pull request ${prLink} · ${state}</span>` : channel.isDefault ? `<span class="small">Default channel</span>` : "") +
    `</div><h1>${esc(heading)}</h1><p class="lede">${keptLine}</p></div></div></header>` +
    `<main class="wrap site">${section("Builds", builds.map((build) => buildRow(product, build)).join(""))}</main>` +
    footer(ctx);
  return { status: 200, html: document({ title: `${product.name} on ${channel.name} · Drop`, description: null, ogTitle: null, url: null, image: null }, body) };
}

function buildRow(product: ProductSummary, build: ChannelBuild): string {
  const kept = build.kept.kind === "while_newest" ? "kept while newest" : `deleted ${date(build.kept.at)}`;
  const commit = `<span class="mono"><a href="${github(product.repository)}/commit/${esc(build.commitSha)}">${esc(build.commitSha.slice(0, 7))}</a></span>`;
  return (
    `<div class="item"><div class="stack">` +
    `<div class="item-head"><b>${esc(version(build))}</b>${build.newest ? `<span class="chip new">Newest</span>` : ""}</div>` +
    `<div>${commit} ${esc(build.commitLine ?? build.headline)}</div>` +
    `<div class="small"><a href="${github(product.repository)}/actions/runs/${build.runId}">${esc(build.workflow)} #${build.runNumber}</a> · ${ago(build.uploadedAt)} · ${formatSize(build.fileSize)} · ${kept}</div>` +
    `</div><div class="acts">` +
    (build.newest ? `<a class="btn primary phone-flex" href="${buildPath(build.id)}/download">Install</a>` : "") +
    `<a href="${buildPath(build.id)}">Build page</a></div></div>`
  );
}

function refusal(kind: "private" | "not_found", ctx: RenderContext): RenderedPage {
  const [status, heading, text] =
    kind === "private"
      ? ([403, "This app needs sign-in", "Its repository is private, and Testers of private apps sign in with GitHub. This Drop deployment doesn’t offer sign-in yet."] as const)
      : ([404, "Nothing here", "There is no app or channel at this address. Check the link, or start from the list of apps."] as const);
  const body =
    `<header class="head"><div class="wrap"><div class="hero"><h1>${esc(heading)}</h1><p class="lede">${esc(text)}</p>` +
    (kind === "not_found" ? `<p><a href="/">See all apps</a></p>` : "") +
    `</div></div></header>${footer(ctx)}`;
  return { status, html: document({ title: heading, description: null, ogTitle: null, url: null, image: null }, body) };
}

