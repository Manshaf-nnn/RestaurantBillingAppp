-- CreateIndex
CREATE INDEX "users_restaurantId_branchId_idx" ON "users"("restaurantId", "branchId");

-- CreateIndex
CREATE INDEX "restaurant_tables_restaurantId_branchId_idx" ON "restaurant_tables"("restaurantId", "branchId");

-- CreateIndex
CREATE INDEX "orders_restaurantId_branchId_placedAt_idx" ON "orders"("restaurantId", "branchId", "placedAt");

-- CreateIndex
CREATE INDEX "order_items_orderId_status_idx" ON "order_items"("orderId", "status");

-- CreateIndex
CREATE INDEX "coupons_restaurantId_branchId_isActive_idx" ON "coupons"("restaurantId", "branchId", "isActive");

-- CreateIndex
CREATE INDEX "inventory_items_restaurantId_supplierId_idx" ON "inventory_items"("restaurantId", "supplierId");

-- CreateIndex
CREATE INDEX "stock_movements_restaurantId_branchId_createdAt_idx" ON "stock_movements"("restaurantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_orderId_idx" ON "stock_movements"("orderId");

-- CreateIndex
CREATE INDEX "stock_movements_purchaseId_idx" ON "stock_movements"("purchaseId");

-- CreateIndex
CREATE INDEX "purchases_restaurantId_supplierId_createdAt_idx" ON "purchases"("restaurantId", "supplierId", "createdAt");

-- CreateIndex
CREATE INDEX "purchases_restaurantId_branchId_idx" ON "purchases"("restaurantId", "branchId");

-- CreateIndex
CREATE INDEX "purchase_items_itemId_idx" ON "purchase_items"("itemId");

-- CreateIndex
CREATE INDEX "audit_logs_restaurantId_branchId_createdAt_idx" ON "audit_logs"("restaurantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_restaurantId_action_createdAt_idx" ON "audit_logs"("restaurantId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "cash_drawer_sessions_restaurantId_branchId_openedAt_idx" ON "cash_drawer_sessions"("restaurantId", "branchId", "openedAt");

-- CreateIndex
CREATE INDEX "storage_locations_restaurantId_branchId_idx" ON "storage_locations"("restaurantId", "branchId");

-- CreateIndex
CREATE INDEX "stock_counts_restaurantId_branchId_countedAt_idx" ON "stock_counts"("restaurantId", "branchId", "countedAt");

-- CreateIndex
CREATE INDEX "purchase_returns_restaurantId_supplierId_idx" ON "purchase_returns"("restaurantId", "supplierId");

-- CreateIndex
CREATE INDEX "stock_batches_restaurantId_branchId_idx" ON "stock_batches"("restaurantId", "branchId");

-- CreateIndex
CREATE INDEX "wastage_records_restaurantId_branchId_createdAt_idx" ON "wastage_records"("restaurantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "wastage_records_itemId_createdAt_idx" ON "wastage_records"("itemId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_transfers_restaurantId_requestedAt_idx" ON "stock_transfers"("restaurantId", "requestedAt");

-- CreateIndex
CREATE INDEX "production_consumption_itemId_idx" ON "production_consumption"("itemId");

-- CreateIndex
CREATE INDEX "production_outputs_itemId_idx" ON "production_outputs"("itemId");

-- CreateIndex
CREATE INDEX "approval_requests_restaurantId_branchId_status_idx" ON "approval_requests"("restaurantId", "branchId", "status");

