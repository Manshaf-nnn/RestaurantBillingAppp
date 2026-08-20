-- AlterTable
ALTER TABLE "users" ADD COLUMN     "staffCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_restaurantId_staffCode_key" ON "users"("restaurantId", "staffCode");


-- Give every existing member of staff a code so nobody has to be edited by
-- hand before the feature works. W-0001 upwards, ordered by when they joined,
-- numbered per restaurant.
WITH numbered AS (
  SELECT "id", "restaurantId",
         ROW_NUMBER() OVER (PARTITION BY "restaurantId" ORDER BY "createdAt" ASC) AS n
  FROM "users"
  WHERE "staffCode" IS NULL AND "deletedAt" IS NULL AND "restaurantId" IS NOT NULL
)
UPDATE "users" u
SET "staffCode" = 'W-' || LPAD(numbered.n::text, 4, '0')
FROM numbered
WHERE u."id" = numbered."id";
