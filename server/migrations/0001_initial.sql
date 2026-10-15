-- Times are Unix epoch milliseconds. Rows are never deleted: a deleted Build keeps its row without
-- its file, and an ended Channel keeps its row, so expired Build pages and ended-Channel answers
-- keep working (docs/design.md#retention).

CREATE TABLE products (
  -- A Product is its application ID (ADR 0015).
  application_id TEXT PRIMARY KEY NOT NULL,
  -- Android only for now; the column keeps iOS additive (ADR 0002).
  platform TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('android')),
  -- Bound on first upload; uploads of this application ID from any other repository are rejected.
  repository_id INTEGER NOT NULL,
  -- owner/name as of the latest upload. For display only: renames do not change repository_id.
  repository TEXT NOT NULL,
  -- The repository_visibility claim of the latest upload. Whether the Product is public also
  -- depends on the deployment config, which can force it private (ADR 0010).
  repository_visibility TEXT NOT NULL CHECK (repository_visibility IN ('public', 'private', 'internal')),
  created_at INTEGER NOT NULL
);

CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES products (application_id),
  name TEXT NOT NULL,
  -- The Channel the Product's default-branch Builds go to.
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  -- Set on a Pull request channel (pr/<number>).
  pull_request INTEGER,
  created_at INTEGER NOT NULL,
  -- When the pull request was merged or closed.
  ended_at INTEGER,
  UNIQUE (application_id, name),
  CHECK (pull_request IS NULL OR is_default = 0),
  CHECK (ended_at IS NULL OR pull_request IS NOT NULL)
);

CREATE UNIQUE INDEX channels_one_default ON channels (application_id) WHERE is_default = 1;

-- Confirmed Builds only: a Build appears here once its files are uploaded and checked. Uploads in
-- flight live in `uploads`, so a later attempt of a run replaces a Build without taking it offline
-- (ADR 0013).
CREATE TABLE builds (
  -- 8 random base62 characters: opaque so Build page URLs can't be enumerated once private
  -- Products exist, and short so their QR codes stay sparse.
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 8),
  application_id TEXT NOT NULL REFERENCES products (application_id),
  channel_id INTEGER NOT NULL REFERENCES channels (id),
  -- From the upload's OIDC token. Orders Builds within a Channel (ADR 0009) and, with the
  -- application ID, is what a Stamp names (ADR 0013).
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  -- The token's workflow and run_number claims, shown as "Android #1876".
  workflow TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  ref TEXT NOT NULL,
  -- The commit people recognise, shown and linked: the pull request's head commit on
  -- pull_request runs (sent by the Action), otherwise the same as built_sha.
  commit_sha TEXT NOT NULL,
  -- The token's sha claim: what was checked out and built. On pull_request runs this is the
  -- temporary merge commit.
  built_sha TEXT NOT NULL,
  -- Sent by the Action from the event payload, or the commit message from the checkout when the
  -- payload has none; absent when neither is available.
  commit_message TEXT,
  pull_request_title TEXT,
  -- Read from the APK by the Action.
  version_code INTEGER NOT NULL,
  version_name TEXT,
  label TEXT,
  -- SHA-256 of the signing certificate (ADR 0006), lowercase hex.
  signer_sha256 TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  -- SHA-256 of the APK, lowercase hex. Checked against R2 before the upload is accepted.
  file_sha256 TEXT NOT NULL,
  file_key TEXT NOT NULL,
  icon_key TEXT,
  -- When the files were confirmed: the upload time that retention counts from.
  uploaded_at INTEGER NOT NULL,
  -- When retention or an operator deleted the file.
  deleted_at INTEGER,
  UNIQUE (application_id, run_id)
);

-- The newest Build of a Channel: highest run ID, upload time breaking ties (ADR 0009).
CREATE INDEX builds_by_channel ON builds (channel_id, run_id DESC, uploaded_at DESC);

-- Uploads in flight: one per Product and run, holding the attempt's values until its files are
-- confirmed and copied into `builds`. A new Build's ID is reserved here; a later attempt of a
-- confirmed Build reuses that Build's ID. Abandoned rows are left for the retention job.
CREATE TABLE uploads (
  build_id TEXT PRIMARY KEY NOT NULL CHECK (length(build_id) = 8),
  application_id TEXT NOT NULL REFERENCES products (application_id),
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
  version_code INTEGER NOT NULL,
  version_name TEXT,
  label TEXT,
  signer_sha256 TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_sha256 TEXT NOT NULL,
  file_key TEXT NOT NULL,
  icon_key TEXT,
  -- When the upload was started.
  created_at INTEGER NOT NULL,
  UNIQUE (application_id, run_id)
);
