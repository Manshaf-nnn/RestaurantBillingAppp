-- A rewards catalogue: the thing a guest recognises, rather than a flat rate
-- off a bill. Retired with `isActive`, never deleted, because a redeemed
-- reward is part of somebody's history.
CREATE TABLE "loyalty_rewards" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pointsCost" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    "minOrderAmount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "loyalty_rewards_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "loyalty_rewards_restaurantId_isActive_idx" ON "loyalty_rewards"("restaurantId", "isActive");

ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What a reward costs and is worth cannot be negative, and a reward that costs
-- nothing is a bug rather than a gift.
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_points_positive" CHECK ("pointsCost" > 0);
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_value_nonneg" CHECK ("value" >= 0);
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_min_nonneg" CHECK ("minOrderAmount" >= 0);
