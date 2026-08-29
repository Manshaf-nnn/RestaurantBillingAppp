-- Feature plans: what each restaurant has bought.
--
-- No backfill, on purpose. `enabledFeatures` defaults to an empty array and an
-- empty array means EVERYTHING — so every restaurant that exists today keeps
-- every feature, and the platform operator opts a tenant into a narrower set by
-- writing a list rather than by having one written for them.
--
-- Disabling a feature never deletes anything. It is a read-side gate; the rows
-- stay exactly where they are and reappear the moment it is switched back on.

CREATE TABLE "feature_packages" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "featureKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "feature_packages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "feature_packages_name_key" ON "feature_packages"("name");

ALTER TABLE "restaurants"
  ADD COLUMN "enabledFeatures"  TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "featurePackageId" TEXT;

ALTER TABLE "restaurants"
  ADD CONSTRAINT "restaurants_featurePackageId_fkey"
  FOREIGN KEY ("featurePackageId") REFERENCES "feature_packages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
