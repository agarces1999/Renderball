-- CreateTable
CREATE TABLE "ScriptDoc" (
    "id" TEXT NOT NULL,
    "json" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptDoc_pkey" PRIMARY KEY ("id")
);
