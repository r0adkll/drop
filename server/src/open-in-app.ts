// Open in App (docs/design.md#open-in-app, ADR 0018): the link a Build's upload gives, and the
// intent: URL its Build page opens it with.

/** The longest template an upload may give. */
export const OPEN_IN_APP_MAX = 2000;

const PLACEHOLDER = "{build}";
// A scheme, then anything a URI may hold except whitespace, quotes, angle brackets and `#`, which
// would end the link inside an intent: URL.
const LINK = /^([A-Za-z][A-Za-z0-9+.-]*):[^\s#"'<>\\^`|]+$/;
// Schemes a page must never open through the app: web pages, scripts, intents, local files and
// inline data. An https App Link is still allowed, since the page aims it at the app's package.
const REFUSED_SCHEMES = new Set(["http", "javascript", "intent", "file", "content", "data"]);

/** Why a template can't be used, or null when it can. */
export function openInAppProblem(template: string): string | null {
  if (!template.includes(PLACEHOLDER)) return `must contain ${PLACEHOLDER}, which Drop fills in with the Build's ID`;
  const scheme = LINK.exec(fill(template, "AbCd1234"))?.[1];
  if (!scheme) return "must be a URI such as yourapp://drop/{build}, without whitespace or #";
  if (REFUSED_SCHEMES.has(scheme.toLowerCase())) return `may not use the ${scheme} scheme`;
  return null;
}

/** The template with every `{build}` filled in. */
export function fill(template: string, buildId: string): string {
  return template.replaceAll(PLACEHOLDER, buildId);
}

/**
 * The intent: URL that opens [link] in [applicationId] only, loading [fallbackUrl] when no
 * activity in that package handles it (docs/implementation-notes.md#android).
 */
export function intentUrl(link: string, applicationId: string, fallbackUrl: string): string {
  // trailhead://drop/x becomes intent://drop/x#Intent;scheme=trailhead;…, and an opaque
  // trailhead:x becomes intent:x#Intent;scheme=trailhead;….
  const colon = link.indexOf(":");
  const scheme = link.slice(0, colon);
  return (
    `intent:${link.slice(colon + 1)}#Intent;scheme=${scheme};package=${applicationId};` +
    `S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end`
  );
}
