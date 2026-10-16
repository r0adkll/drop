-- The App's comment on the commit of each Build outside a Pull request channel
-- (docs/design.md#commit-comments). Post-only: GitHub lets the App create commit comments but not
-- edit them (ADR 0010). A row claims the Build before posting, so concurrent completions post once.
CREATE TABLE commit_comments (
  build_id TEXT PRIMARY KEY NOT NULL REFERENCES builds (id),
  -- GitHub's commit comment ID, once posted.
  comment_id INTEGER,
  created_at INTEGER NOT NULL
);
