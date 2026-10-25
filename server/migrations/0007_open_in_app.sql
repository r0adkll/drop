-- The link a Build page's Open in App opens (ADR 0018), from the Action's `open-in-app` input with
-- the Build's ID filled in.
ALTER TABLE uploads ADD COLUMN open_in_app TEXT;
ALTER TABLE builds ADD COLUMN open_in_app TEXT;
