-- Which of the restaurant's own accounts an outgoing payment is paid from.
-- Null on every existing row: nobody was asked.
ALTER TABLE "outgoing_payments" ADD COLUMN "payFromAccountId" TEXT;

ALTER TABLE "outgoing_payments"
  ADD CONSTRAINT "outgoing_payments_payFromAccountId_fkey"
  FOREIGN KEY ("payFromAccountId") REFERENCES "payment_accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
