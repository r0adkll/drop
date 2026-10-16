-- Why a Build was deleted: by retention, or by the Deployment's operator with `./drop delete-build`
-- (docs/design.md#deleting-a-build). Its page explains each differently. Builds deleted before this
-- column existed were deleted by retention.
ALTER TABLE builds ADD COLUMN deleted_reason TEXT CHECK (deleted_reason IN ('retention', 'operator'));
UPDATE builds SET deleted_reason = 'retention' WHERE deleted_at IS NOT NULL;
