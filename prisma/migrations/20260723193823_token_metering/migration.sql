-- CreateTable
CREATE TABLE "TokenUsage" (
    "ownerId" TEXT NOT NULL,
    "totalTokens" BIGINT NOT NULL DEFAULT 0,
    "billedTokens" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenUsage_pkey" PRIMARY KEY ("ownerId")
);

-- CreateTable
CREATE TABLE "MeterEventOutbox" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "MeterEventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeterEventOutbox_status_createdAt_idx" ON "MeterEventOutbox"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MeterEventOutbox_ownerId_idx" ON "MeterEventOutbox"("ownerId");

-- AddForeignKey
ALTER TABLE "TokenUsage" ADD CONSTRAINT "TokenUsage_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

