-- A Build's Form factor (ADR 0017): `mobile` or `wear`. A run uploads one Build per Product and
-- Form factor, so the run's uniqueness moves from (application_id, run_id) to include it. SQLite
-- can't change a table's constraints, so `builds` and `uploads` are rebuilt; every existing row is
-- `mobile`. `commit_comments` refers to `builds`, so its foreign key is checked at commit, once the
-- new table carries the old name.

PRAGMA defer_foreign_keys = true;

CREATE TABLE builds_new (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 8),
  application_id TEXT NOT NULL REFERENCES products (application_id),
  form_factor TEXT NOT NULL DEFAULT 'mobile' CHECK (form_factor IN ('mobile', 'wear')),
  channel_id INTEGER NOT NULL REFERENCES channels (id),
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  workflow TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  built_sha TEXT NOT NULL,
  commit_message TEXT,
  pull_request_title TEXT,
  release_notes TEXT,
  version_code INTEGER NOT NULL,
  version_name TEXT,
  label TEXT,
  signer_sha256 TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_sha256 TEXT NOT NULL,
  file_key TEXT NOT NULL,
  icon_key TEXT,
  uploaded_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_reason TEXT CHECK (deleted_reason IN ('retention', 'operator')),
  UNIQUE (application_id, form_factor, run_id)
);

INSERT INTO builds_new (id, application_id, form_factor, channel_id, run_id, run_attempt, workflow, run_number,
  event_name, ref, commit_sha, built_sha, commit_message, pull_request_title, release_notes, version_code,
  version_name, label, signer_sha256, file_size, file_sha256, file_key, icon_key, uploaded_at, deleted_at,
  deleted_reason)
SELECT id, application_id, 'mobile', channel_id, run_id, run_attempt, workflow, run_number,
  event_name, ref, commit_sha, built_sha, commit_message, pull_request_title, release_notes, version_code,
  version_name, label, signer_sha256, file_size, file_sha256, file_key, icon_key, uploaded_at, deleted_at,
  deleted_reason
FROM builds;

DROP TABLE builds;
ALTER TABLE builds_new RENAME TO builds;

-- The newest Build of a Channel and Form factor: highest run ID, upload time breaking ties (ADR 0009).
CREATE INDEX builds_by_channel ON builds (channel_id, form_factor, run_id DESC, uploaded_at DESC);

CREATE TABLE uploads_new (
  build_id TEXT PRIMARY KEY NOT NULL CHECK (length(build_id) = 8),
  application_id TEXT NOT NULL REFERENCES products (application_id),
  form_factor TEXT NOT NULL DEFAULT 'mobile' CHECK (form_factor IN ('mobile', 'wear')),
  channel_id INTEGER NOT NULL REFERENCES channels (id),
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  workflow TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  built_sha TEXT NOT NULL,
  commit_message TEXT,
  pull_request_title TEXT,
  release_notes TEXT,
  version_code INTEGER NOT NULL,
  version_name TEXT,
  label TEXT,
  signer_sha256 TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_sha256 TEXT NOT NULL,
  file_key TEXT NOT NULL,
  icon_key TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (application_id, form_factor, run_id)
);

INSERT INTO uploads_new (build_id, application_id, form_factor, channel_id, run_id, run_attempt, workflow,
  run_number, event_name, ref, commit_sha, built_sha, commit_message, pull_request_title, release_notes,
  version_code, version_name, label, signer_sha256, file_size, file_sha256, file_key, icon_key, created_at)
SELECT build_id, application_id, 'mobile', channel_id, run_id, run_attempt, workflow,
  run_number, event_name, ref, commit_sha, built_sha, commit_message, pull_request_title, release_notes,
  version_code, version_name, label, signer_sha256, file_size, file_sha256, file_key, icon_key, created_at
FROM uploads;

DROP TABLE uploads;
ALTER TABLE uploads_new RENAME TO uploads;

PRAGMA defer_foreign_keys = false;
