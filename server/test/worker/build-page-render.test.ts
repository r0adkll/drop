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
    uploadedAt: UPLOADED,
    fileSize: 38_412_345,
    fileSha256: "b41c".padEnd(64, "0"),
    signerSha256: "3a9fc2".padEnd(64, "0"),
    hasIcon: true,
    deletedAt: null,
    deletedReason: null,
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
