-- The user's own name for a saved brand ("Fuse"), set in the brand ceremony.
-- Nullable on purpose: legacy kits created by the brief flow were never named,
-- and the picker only offers kits a user has named.
ALTER TABLE "BrandKit" ADD COLUMN "name" TEXT;
