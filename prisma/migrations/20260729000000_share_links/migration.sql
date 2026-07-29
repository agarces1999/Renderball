-- Public share links.
--
-- NULL shareToken means private, which is what every existing document becomes:
-- adding a nullable column cannot expose anything that was not already shared.
-- The unique index is what makes a token a usable lookup key, and guarantees two
-- documents can never answer to the same link.
ALTER TABLE "Project" ADD COLUMN "shareToken" TEXT;
ALTER TABLE "Project" ADD COLUMN "sharedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Project_shareToken_key" ON "Project"("shareToken");
