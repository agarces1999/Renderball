-- Provider spend ledger — one durable row per paid provider call.
--
-- August 2026: Fireworks' dashboard said $37.69, our own records covered
-- $6.52, and there is NO usage or billing API on Fireworks to reconcile
-- against (probed: /v1/accounts/{id}/usage, /billing, /invoices all 404).
-- So this table has to BE the exact number. It can be — every completion
-- response carries exact prompt_tokens / completion_tokens; the gap was that
-- recording was a per-call-site convention that new surfaces never opted into.
-- The write now lives inside the transports themselves.
--
-- Postgres and not .data/usage.jsonl because .dockerignore excludes .data,
-- Railway's disk is ephemeral, and a volume attaches to one instance — the
-- same three reasons that already moved decks to R2 and briefs to pg.

CREATE TABLE "SpendRecord" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT NOT NULL DEFAULT 'fireworks',
    "model" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'unattributed',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "images" INTEGER NOT NULL DEFAULT 0,
    -- NUMERIC, not DOUBLE PRECISION: SUM(numeric) is exact. The whole point
    -- of this table is a number that does not drift.
    "costUsd" DECIMAL(14,8) NOT NULL,
    "rateVersion" TEXT NOT NULL,
    -- Nullable, and no FK to "User": offline scripts and the dev loop have no
    -- owner, and that spend is real money. A foreign key would reject exactly
    -- the rows that went missing.
    "ownerId" TEXT,
    "scriptId" TEXT,
    "runId" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    -- The provider may have billed but reported no usage we could read (a
    -- timeout mid-generation). Tokens and cost stay ZERO; this flag plus
    -- latencyMs is the honest floor, never a fabricated estimate.
    "tokensUnknown" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER,
    "origin" TEXT NOT NULL DEFAULT 'web',

    CONSTRAINT "SpendRecord_pkey" PRIMARY KEY ("id")
);

-- "what did we spend today / this month" — the founder's question, verbatim.
CREATE INDEX "SpendRecord_at_idx" ON "SpendRecord"("at");
-- "which part of the product is expensive" — the thing a per-build aggregate
-- row destroys by construction.
CREATE INDEX "SpendRecord_stage_at_idx" ON "SpendRecord"("stage", "at");
-- "did a routing change move the bill" — the wire id is what gets billed.
CREATE INDEX "SpendRecord_model_at_idx" ON "SpendRecord"("model", "at");
-- "what did THIS deck cost" — unit economics.
CREATE INDEX "SpendRecord_scriptId_idx" ON "SpendRecord"("scriptId");
-- "what is this customer costing us".
CREATE INDEX "SpendRecord_ownerId_at_idx" ON "SpendRecord"("ownerId", "at");
