// What a Build says changed (CONTEXT.md, Headline and Release notes): its release notes' first line,
// else its pull request title, else its commit message's first line, else the app's name. The rest
// of the release notes is What's new, shown on the Build page and in the Update sheet.

export interface ChangeSource {
  release_notes: string | null;
  pull_request_title: string | null;
  commit_message: string | null;
}

export interface Change {
  headline: string;
  /** The release notes after their first line, if any. */
  whatsNew: string | null;
  /** The commit message's first line. */
  commitLine: string | null;
}

export function describeChange(build: ChangeSource, name: string): Change {
  const commitLine = firstLine(build.commit_message);
  const notes = build.release_notes?.trim();
  if (notes) {
    const [headline = "", ...rest] = notes.split(/\r?\n/);
    const whatsNew = rest.join("\n").trim();
    return { headline: headline.trim(), whatsNew: whatsNew || null, commitLine };
  }
  return { headline: build.pull_request_title || commitLine || name, whatsNew: null, commitLine };
}

export function firstLine(text: string | null): string | null {
  const line = text?.split(/\r?\n/, 1)[0]?.trim();
  return line ? line : null;
}

/** Release notes as stored: line endings normalised and outer whitespace trimmed; empty is none. */
export function normaliseReleaseNotes(text: string | undefined): string | null {
  const notes = text?.replace(/\r\n?/g, "\n").trim();
  return notes ? notes : null;
}
