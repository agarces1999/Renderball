-- Per-owner hourly brake on LLM-spending editor operations.
--
-- The brake existed already, in process memory. Two problems with that: it
-- reset on every deploy — and this project ships several times a day, so the
-- cap was mostly not there — and a second container would have had its own
-- copy, doubling the effective limit. Both are the kind of gap that only shows
-- up as a bill.

CREATE TABLE "OpWindow" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpWindow_pkey" PRIMARY KEY ("id")
);

-- The read path: count this owner's ops of this kind inside the window.
CREATE INDEX "OpWindow_ownerId_op_at_idx" ON "OpWindow"("ownerId", "op", "at");
-- The prune path: delete everything older than the window, across all owners.
CREATE INDEX "OpWindow_at_idx" ON "OpWindow"("at");
