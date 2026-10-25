import { describe, expect, it } from "vitest";
import type { BuildPageModel, LinkedBuild, PageBuild } from "../../src/build-page/model";
import { colonHex, formatSize, formatUtc, renderBuildPage } from "../../src/build-page/render";
import { keptUntil } from "../../src/retention";

const CTX = { baseUrl: "https://drop.example.com" };
const UPLOADED = Date.UTC(2026, 9, 15, 14, 2);
const DAY = 86_400_000;

export function pageBuild(overrides: Partial<PageBuild> = {}): PageBuild {
  return {
    id: "k7Qm2xPa",
    applicationId: "com.example.trailhead",
    name: "Trailhead",
    versionName: "2.8.0",
    versionCode: 4127,
    repository: "your-org/trailhead",
    channel: { name: "pr/142", pullRequest: 142, endedAt: null },
    runId: 11384729304,
    runNumber: 1876,
    workflow: "Android",
    commitSha: "9f3c2a1".padEnd(40, "0"),
    commitMessage: "Cache map tiles in the background when a trail is saved\n\nLonger body.",
    pullRequestTitle: "Offline map tiles for saved trails",
    releaseNotes: null,
    openInApp: null,
    uploadedAt: UPLOADED,
    fileSize: 38_412_345,
    fileSha256: "b41c".padEnd(64, "0"),
    signerSha256: "3a9fc2".padEnd(64, "0"),
    hasIcon: true,
    deletedAt: null,
    deletedReason: null,
    formFactor: "mobile",
    sibling: null,
    ...overrides,
  };
}

const newerBuild: LinkedBuild = { id: "Rt4wN8cZ", name: "Trailhead", versionName: "2.8.0", versionCode: 4129, uploadedAt: UPLOADED + 3600_000, hasIcon: true };

function render(model: BuildPageModel) {
  return renderBuildPage(model, CTX);
}

describe("the Build page", () => {
  it("leads the newest Build with its pull request title, head commit and install paths", () => {
    const { status, html } = render({ kind: "available", build: pageBuild(), newer: null, kept: { kind: "while_newest" } });
    expect(status).toBe(200);
    expect(html).toContain("<h1>Offline map tiles for saved trails</h1>");
    expect(html).toContain(">9f3c2a1</a><span>Cache map tiles in the background when a trail is saved</span>");
    expect(html).not.toContain("Longer body");
    expect(html).toContain('<span class="chip new">Newest on pr/142</span>');
    expect(html).toContain('href="https://github.com/your-org/trailhead/pull/142">#142</a>');
    expect(html).toContain('href="https://github.com/your-org/trailhead/actions/runs/11384729304">Android #1876</a>');
    expect(html).toContain("While it is the newest on <code>pr/142</code>");
    expect(html).toContain("38.4 MB");
    expect(html).toContain('href="/b/k7Qm2xPa/download"');
    expect(html).toContain("Install · 38.4 MB");
    expect(html).toContain('<div class="qr"><svg');
    expect(html).toContain('<time datetime="2026-10-15T14:02:00.000Z" data-relative>Oct 15, 2026, 14:02 UTC</time>');
    expect(html).toContain("3A:9F:C2:00");
    expect(html).toContain('<meta property="og:title" content="Trailhead 2.8.0 (4127)">');
    expect(html).toContain('<meta property="og:description" content="Offline map tiles for saved trails · pr/142">');
    expect(html).toContain('<meta property="og:image" content="https://drop.example.com/b/k7Qm2xPa/icon">');
    expect(html).toContain('<meta property="og:url" content="https://drop.example.com/b/k7Qm2xPa">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).not.toContain("A newer Build");
    expect(html).not.toContain("Watch app");
  });

  it("links a phone Build to the watch Build from its run", () => {
    const watch: LinkedBuild = { id: "Wq3eR5tY", name: "Trailhead", versionName: "2.8.0", versionCode: 4127, uploadedAt: UPLOADED, hasIcon: true };
    const { html } = render({ kind: "available", build: pageBuild({ sibling: watch }), newer: null, kept: { kind: "while_newest" } });
    expect(html).toContain('<dt>Watch app</dt><dd><a href="/b/Wq3eR5tY">2.8.0 (4127)</a> <span class="muted">· Wear OS Build from this run</span></dd>');
  });

  it("gives a Wear Build adb steps instead of a QR code and an Install button", () => {
    const phone: LinkedBuild = { id: "k7Qm2xPa", name: "Trailhead", versionName: "2.8.0", versionCode: 4127, uploadedAt: UPLOADED, hasIcon: true };
    const build = pageBuild({ id: "Wq3eR5tY", formFactor: "wear", sibling: phone, fileSize: 9_812_345 });
    const { html } = render({ kind: "available", build, newer: null, kept: { kind: "while_newest" } });
    expect(html).toContain('<span class="chip wear">Wear OS</span><span class="chip">pr/142</span>');
    expect(html).toContain('<p class="label">Install on your Wear OS watch</p>');
    expect(html).toContain('<pre class="cmd">adb connect &lt;address on your watch&gt;</pre>');
    expect(html).toContain(
      '<pre class="cmd" id="watch-commands">curl -fLo trailhead-wear.apk https://drop.example.com/b/Wq3eR5tY/download\nadb install -r trailhead-wear.apk</pre>',
    );
    expect(html).toContain('data-copy="watch-commands"');
    expect(html).toContain('<a class="sibling" href="/b/k7Qm2xPa">');
    expect(html).toContain("<b>This is the watch app.</b> Your phone can’t install it.");
    expect(html).toContain('<p><a href="/b/k7Qm2xPa">Open the phone app from this run</a></p>');
    expect(html).toContain("Download APK · 9.8 MB");
    expect(html).toContain('<meta property="og:title" content="Trailhead 2.8.0 (4127) for Wear OS">');
    expect(html).not.toContain('<div class="qr">');
    expect(html).not.toContain("Install · ");
    expect(html).not.toContain("<dt>Watch app</dt>");
  });

  it("adds Open in App under Install, aimed at the Product's package with the page as its fallback", () => {
    const build = pageBuild({ openInApp: "trailhead://drop/k7Qm2xPa?from=drop&tab=map" });
    const { html } = render({ kind: "available", build, newer: newerBuild, kept: { kind: "while_newest" } });
    expect(html).toContain(
      '<div class="install-bar phone-only"><div class="bar-btns"><a class="btn primary" href="/b/k7Qm2xPa/download">' +
        '<svg viewBox="0 0 24 24" width="18" height="18"',
    );
    expect(html).toContain(
      '<a class="btn quiet" href="intent://drop/k7Qm2xPa?from=drop&amp;tab=map#Intent;scheme=trailhead;package=com.example.trailhead;' +
        'S.browser_fallback_url=https%3A%2F%2Fdrop.example.com%2Fb%2Fk7Qm2xPa%3Fopen%3Dfailed;end"><svg',
    );
    expect(html).toContain("Open in App</a></div></div>");
    expect(html).not.toContain("didn’t open");
  });

  it("says the app didn't open when Open in App falls back to the page", () => {
    const model = (openInApp: string | null): BuildPageModel => ({ kind: "available", build: pageBuild({ openInApp }), newer: null, kept: { kind: "while_newest" } });
    const { html } = renderBuildPage(model("trailhead://drop/k7Qm2xPa"), { ...CTX, openFailed: true });
    expect(html).toContain(
      '<section class="details" aria-labelledby="about"><div class="banner" role="status"><p><b>Trailhead didn’t open.</b> It isn’t on this phone, ' +
        "or the copy you have doesn’t support Open in App yet. Tap Install to get this Build.</p></div>",
    );
    // Without a link, nothing could have failed to open.
    expect(renderBuildPage(model(null), { ...CTX, openFailed: true }).html).not.toContain("didn’t open");
  });

  it("leaves Open in App off pages without a link and off Wear Builds", () => {
    const page = (overrides: Partial<PageBuild>) => render({ kind: "available", build: pageBuild(overrides), newer: null, kept: { kind: "while_newest" } }).html;
    expect(page({})).not.toContain("Open in App");
    expect(page({})).toContain('<div class="install-bar phone-only"><a class="btn primary" href="/b/k7Qm2xPa/download">');
    expect(page({ formFactor: "wear", openInApp: "trailhead://drop/k7Qm2xPa" })).not.toContain("Open in App");
  });

  it("falls back to the commit message, then the app name, as the headline", () => {
    const fromMessage = render({ kind: "available", build: pageBuild({ pullRequestTitle: null, channel: { name: "main", pullRequest: null, endedAt: null } }), newer: null, kept: { kind: "while_newest" } });
    expect(fromMessage.html).toContain("<h1>Cache map tiles in the background when a trail is saved</h1>");
    expect(fromMessage.html).not.toContain("Pull request</dt>");

    const fromName = render({ kind: "available", build: pageBuild({ pullRequestTitle: null, commitMessage: null }), newer: null, kept: { kind: "while_newest" } });
    expect(fromName.html).toContain("<h1>Trailhead</h1>");
    expect(fromName.html).toContain("<dt>Commit</dt>");
  });

  it("leads with release notes' first line and shows the rest as What's new, links and line breaks kept", () => {
    const releaseNotes = "Trail difficulty filters\n\n• Filter by difficulty.\nFull notes: https://github.com/your-org/trailhead/releases/tag/v2.9.0.";
    const { html } = render({ kind: "available", build: pageBuild({ releaseNotes }), newer: null, kept: { kind: "while_newest" } });
    expect(html).toContain("<h1>Trail difficulty filters</h1>");
    expect(html).toContain(">9f3c2a1</a><span>Cache map tiles in the background when a trail is saved</span>");
    expect(html).toContain('<meta name="description" content="Trail difficulty filters · pr/142">');
    expect(html).toMatch(/<section class="details"[^>]*><section class="notes" aria-labelledby="whats-new"><h2 class="label" id="whats-new">What’s new<\/h2>/);
    expect(html).toContain(
      '<p class="notes-text">• Filter by difficulty.\nFull notes: <a href="https://github.com/your-org/trailhead/releases/tag/v2.9.0">https://github.com/your-org/trailhead/releases/tag/v2.9.0</a>.</p>',
    );

    const headlineOnly = render({ kind: "available", build: pageBuild({ releaseNotes: "Just a headline" }), newer: null, kept: { kind: "while_newest" } });
    expect(headlineOnly.html).toContain("<h1>Just a headline</h1>");
    expect(headlineOnly.html).not.toContain("What’s new");
  });

  it("points a superseded Build at its Channel's newest and says when it goes", () => {
    const at = UPLOADED + 7 * DAY;
    const { html } = render({ kind: "available", build: pageBuild(), newer: newerBuild, kept: { kind: "until", at, reason: "age" } });
    expect(html).toContain("<b>A newer Build is on pr/142</b>");
    expect(html).toContain("2.8.0 (4129), uploaded");
    expect(html).toContain('href="/b/Rt4wN8cZ">Open the newest Build</a>');
    expect(html).not.toContain("Newest on pr/142");
    expect(html).toContain("Until <time datetime=\"2026-10-22T14:02:00.000Z\">Oct 22, 2026, 14:02 UTC</time>, 7 days after upload");
  });

  it("says plainly that the operator removed a Build, still linking to the newest", () => {
    const build = pageBuild({ deletedAt: UPLOADED + DAY, deletedReason: "operator" });
    const { html } = render({ kind: "expired", build, next: { channel: "pr/142", build: newerBuild, because: "channel_open" } });
    expect(html).toContain("<h1>This Build was removed</h1>");
    expect(html).toMatch(/This Drop deployment’s operator removed it on <time [^>]*data-date>/);
    expect(html).toContain('<span class="chip">Removed</span>');
    expect(html).toContain("<dt>Removed</dt>");
    expect(html).not.toContain("are deleted");
    expect(html).toContain('href="/b/Rt4wN8cZ">Open its Build page</a>');
    expect(html).toContain('<meta property="og:title" content="Trailhead 2.8.0 (4127) (removed)">');
  });

  it("explains an expired Build on an open Channel and links to its newest", () => {
    const build = pageBuild({ versionCode: 4098, uploadedAt: UPLOADED - 12 * DAY, deletedAt: UPLOADED - 5 * DAY });
    const { status, html } = render({ kind: "expired", build, next: { channel: "pr/142", build: newerBuild, because: "channel_open" } });
    expect(status).toBe(200);
    expect(html).toContain("<h1>This Build has expired</h1>");
    expect(html).toContain("Builds on <code>pr/142</code> are deleted 7 days after upload, unless they are the newest.");
    // Running prose gives dates alone, as the agreed mockup does; the details list keeps times.
    expect(html).toMatch(/This one was uploaded on <time [^>]*data-date>[A-Z][a-z]{2} \d{1,2}, \d{4}<\/time> and deleted on <time [^>]*data-date>/);
    expect(html).toContain('<span class="icon gone">');
    expect(html).toContain('id="newest">Newest on pr/142</p>');
    expect(html).toContain('href="/b/Rt4wN8cZ">Open its Build page</a>');
    expect(html).not.toContain("/download");
    expect(html).not.toContain('<div class="qr">');
    expect(html).toContain("<dt>Deleted</dt>");
  });

  it("sends an expired Build on an ended Channel to the default Channel", () => {
    const build = pageBuild({ channel: { name: "pr/138", pullRequest: 138, endedAt: UPLOADED - 3 * DAY }, deletedAt: UPLOADED - 2 * DAY });
    const main = { ...newerBuild, id: "Hc2pQ7ve", versionCode: 4125 };
    const { html } = render({ kind: "expired", build, next: { channel: "main", build: main, because: "channel_ended" } });
    expect(html).toContain("Pull request #138 was closed on");
    expect(html).toContain("the Builds on <code>pr/138</code> were deleted a day later.");
    expect(html).toContain('id="newest">Newest on main</p>');
    expect(html).toContain('href="/b/Hc2pQ7ve">Open its Build page</a>');
  });

  it("says plainly when there is no newer Build to offer", () => {
    const build = pageBuild({ deletedAt: UPLOADED + DAY });
    const none = render({ kind: "expired", build, next: { channel: "main", build: null, because: "channel_ended" } });
    expect(none.html).toContain("There is no Build on <code>main</code> to offer instead yet.");
    const noDefault = render({ kind: "expired", build, next: { channel: null, build: null, because: "channel_ended" } });
    expect(noDefault.html).toContain("Trailhead has no default Channel yet, so there is no newer Build to offer.");
  });

  it("gives private and unknown Builds a minimal page that reveals nothing", () => {
    const privatePage = render({ kind: "private" });
    expect(privatePage.status).toBe(403);
    expect(privatePage.html).toContain("This Build needs sign-in");
    expect(privatePage.html).not.toContain("og:");
    const missing = render({ kind: "not_found" });
    expect(missing.status).toBe(404);
    expect(missing.html).toContain("There is no Build at this address.");
  });

  it("escapes every value that came from an upload", () => {
    const hostile = '"><script>alert(1)</script>';
    const build = pageBuild({ name: hostile, pullRequestTitle: hostile, commitMessage: hostile, releaseNotes: `${hostile}\n${hostile} javascript:alert(1) https://x.example/"onmouseover=alert(1)`, workflow: hostile, versionName: hostile, channel: { name: "pr/142", pullRequest: 142, endedAt: null } });
    const { html } = render({ kind: "available", build, newer: { ...newerBuild, name: hostile, versionName: hostile }, kept: { kind: "while_newest" } });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('"onmouseover');
  });
});

describe("formatting", () => {
  it("formats times, sizes and certificate digests", () => {
    expect(formatUtc(UPLOADED)).toBe("Oct 15, 2026, 14:02 UTC");
    expect(formatSize(999)).toBe("999 bytes");
    expect(formatSize(38_412_345)).toBe("38.4 MB");
    expect(formatSize(1_500_000_000)).toBe("1.5 GB");
    expect(colonHex("3a9f")).toBe("3A:9F");
  });
});

describe("retention", () => {
  const base = { applicationId: "com.example.trailhead", uploadedAt: UPLOADED };
  it("keeps the newest Build of an open Channel", () => {
    expect(keptUntil({ ...base, pullRequest: true, channelEndedAt: null, newest: true })).toEqual({ kind: "while_newest" });
  });
  it("deletes older Builds 30 days, or 7 on a Pull request channel, after upload", () => {
    expect(keptUntil({ ...base, pullRequest: false, channelEndedAt: null, newest: false })).toEqual({ kind: "until", at: UPLOADED + 30 * DAY, reason: "age" });
    expect(keptUntil({ ...base, pullRequest: true, channelEndedAt: null, newest: false })).toEqual({ kind: "until", at: UPLOADED + 7 * DAY, reason: "age" });
  });
  it("deletes everything on an ended Channel 24 hours after it ends, unless age comes first", () => {
    const endedAt = UPLOADED + DAY;
    expect(keptUntil({ ...base, pullRequest: true, channelEndedAt: endedAt, newest: true })).toEqual({ kind: "until", at: endedAt + DAY, reason: "channel_ended" });
    const old = { ...base, uploadedAt: UPLOADED - 6.5 * DAY };
    expect(keptUntil({ ...old, pullRequest: true, channelEndedAt: endedAt, newest: false })).toEqual({ kind: "until", at: old.uploadedAt + 7 * DAY, reason: "age" });
  });
});
