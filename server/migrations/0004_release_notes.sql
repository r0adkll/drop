-- Release notes a workflow passes to the Action's `notes` input (docs/design.md#build-pages): the
-- first line is the Build's headline and the rest is What's new.
ALTER TABLE uploads ADD COLUMN release_notes TEXT;
ALTER TABLE builds ADD COLUMN release_notes TEXT;
