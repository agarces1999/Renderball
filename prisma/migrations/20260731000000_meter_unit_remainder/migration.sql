-- Partial billing units, carried forward.
--
-- Processors bill in integer quantities. At a ~3x markup a token costs
-- $0.00001, which most processors will not accept as a unit price, so the unit
-- becomes 1,000 tokens (RB_METER_UNIT_TOKENS) and reported quantities are
-- tokens/1000. Anything below a whole unit has to wait here for the next
-- report rather than being rounded away — otherwise every small operation
-- undercharges silently, forever.

ALTER TABLE "TokenUsage" ADD COLUMN "remainderTokens" INTEGER NOT NULL DEFAULT 0;
