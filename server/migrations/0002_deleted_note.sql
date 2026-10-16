-- When retention edited a closed pull request's comment down to the note that its Builds were
-- deleted (docs/design.md#pull-request-comments). Set once; the comment isn't edited again.
ALTER TABLE pull_request_comments ADD COLUMN deleted_note_at INTEGER;
