-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'SALE_REVERSAL';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "recipeId" TEXT;

-- CreateTable
CREATE TABLE "recipes" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "foodId" TEXT,
    "producesItemId" TEXT,
    "name" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "yieldQty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "yieldUnit" "StockUnit",
    "prepNotes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_ingredients" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "subRecipeId" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" "StockUnit" NOT NULL,
    "wastagePercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_stock_depletions" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "appliedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_stock_depletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recipes_restaurantId_foodId_isActive_idx" ON "recipes"("restaurantId", "foodId", "isActive");

-- CreateIndex
CREATE INDEX "recipes_restaurantId_producesItemId_isActive_idx" ON "recipes"("restaurantId", "producesItemId", "isActive");

-- CreateIndex
CREATE INDEX "recipe_ingredients_recipeId_idx" ON "recipe_ingredients"("recipeId");

-- CreateIndex
CREATE INDEX "recipe_ingredients_inventoryItemId_idx" ON "recipe_ingredients"("inventoryItemId");

-- CreateIndex
CREATE INDEX "recipe_ingredients_subRecipeId_idx" ON "recipe_ingredients"("subRecipeId");

-- CreateIndex
CREATE INDEX "order_stock_depletions_restaurantId_orderId_idx" ON "order_stock_depletions"("restaurantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "order_stock_depletions_orderId_itemId_key" ON "order_stock_depletions"("orderId", "itemId");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_foodId_fkey" FOREIGN KEY ("foodId") REFERENCES "foods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_producesItemId_fkey" FOREIGN KEY ("producesItemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_subRecipeId_fkey" FOREIGN KEY ("subRecipeId") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stock_depletions" ADD CONSTRAINT "order_stock_depletions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stock_depletions" ADD CONSTRAINT "order_stock_depletions_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

