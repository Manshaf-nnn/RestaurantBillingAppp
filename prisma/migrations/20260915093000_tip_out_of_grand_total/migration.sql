-- Tips leave grandTotal (AUDIT.md C9 groundwork, spec §110).
--
-- Settlement used to fold the tip INTO grandTotal, so every report summing
-- grandTotal counted the staff's money as the restaurant's income. The code no
-- longer writes tips there; this takes them back out of the rows written under
-- the old rule. paidTotal is untouched — the guest really did hand that over —
-- so paidTotal = grandTotal + tipAmount still holds on settled bills.
UPDATE "orders"
SET "grandTotal" = "grandTotal" - "tipAmount"
WHERE "tipAmount" > 0
  AND "grandTotal" >= "tipAmount";
