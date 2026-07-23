-- CreateTable
CREATE TABLE "BrandKit" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "extract" JSONB NOT NULL,
    "paletteRoles" JSONB,
    "logoSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandKit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrandKit_ownerId_updatedAt_idx" ON "BrandKit"("ownerId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BrandKit_ownerId_url_key" ON "BrandKit"("ownerId", "url");

-- AddForeignKey
ALTER TABLE "BrandKit" ADD CONSTRAINT "BrandKit_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
