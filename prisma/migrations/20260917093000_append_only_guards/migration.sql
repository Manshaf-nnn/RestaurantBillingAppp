-- Financial and inventory history cannot be silently overwritten (production.md §1).
--
-- These invariants were previously held by convention alone: `assertAuditImmutable`
-- existed in src/server/audit.ts and was never called from anywhere, so the only
-- thing stopping an audit row being edited was that no code happened to do it.
-- A guarantee that depends on nobody writing the wrong line is not a guarantee,
-- and it is worth least in exactly the scenario it exists for.
--
-- Enforced in the database so it holds against application code, a stray script,
-- a future migration and a hand-typed psql session alike.
--
-- Each guard is scoped to what genuinely must not change, NOT to the whole row,
-- because several of these tables have legitimate post-insert writes and a
-- blanket trigger would have broken them:
--
--   * stock_movements are updated three times in the codebase (goods receipt,
--     wastage, production) purely to backfill batchId / batchNo / referenceId
--     immediately after the row is created, inside the same transaction. Those
--     are links, not ledger facts, so they stay allowed; quantity, cost,
--     balance, type and ownership do not.
--   * payments legitimately move UNPAID -> PAID (a QR intent being captured
--     sets its amount at that moment) and PAID -> REFUNDED. What must not
--     change is the amount of a payment that has already been taken.
--   * audit_logs and refunds are never updated anywhere, so they are frozen
--     outright.
--
-- DELETE is deliberately NOT blocked. Deleting a restaurant cascades to its
-- audit log and its ledger, and removing a tenant's data on request is a
-- legitimate operation; the property being protected here is that a row's
-- CONTENT cannot change under anyone, not that tenants are permanent.

-- ── audit_logs: frozen ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tableflow_audit_logs_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: a log that can be edited is a diary, not an audit trail'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION tableflow_audit_logs_append_only();

-- ── refunds: frozen ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tableflow_refunds_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'refunds is append-only: correct a refund by recording another movement, never by editing this one'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refunds_append_only
  BEFORE UPDATE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION tableflow_refunds_append_only();

-- ── stock_movements: the ledger facts are frozen, the links are not ──────────
CREATE OR REPLACE FUNCTION tableflow_stock_movements_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW."quantity"     IS DISTINCT FROM OLD."quantity"
  OR NEW."unitCost"     IS DISTINCT FROM OLD."unitCost"
  OR NEW."balanceAfter" IS DISTINCT FROM OLD."balanceAfter"
  OR NEW."type"         IS DISTINCT FROM OLD."type"
  OR NEW."itemId"       IS DISTINCT FROM OLD."itemId"
  OR NEW."restaurantId" IS DISTINCT FROM OLD."restaurantId"
  THEN
    RAISE EXCEPTION 'stock_movements ledger facts are immutable (attempted to change quantity, cost, balance, type or ownership); reverse the movement instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movements_immutable
  BEFORE UPDATE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION tableflow_stock_movements_immutable();

-- ── payments: what has been taken cannot change ─────────────────────────────
CREATE OR REPLACE FUNCTION tableflow_payments_settled_immutable()
RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('PAID', 'REFUNDED') AND (
       NEW."amount"       IS DISTINCT FROM OLD."amount"
    OR NEW."orderId"      IS DISTINCT FROM OLD."orderId"
    OR NEW."restaurantId" IS DISTINCT FROM OLD."restaurantId"
  ) THEN
    RAISE EXCEPTION 'a settled payment is a fact: record a refund rather than editing its amount'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_settled_immutable
  BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION tableflow_payments_settled_immutable();
