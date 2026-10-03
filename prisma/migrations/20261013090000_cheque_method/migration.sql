-- Cheque as a payment method: money out is often paid by cheque, and the
-- method has to show wherever a payment method is named.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CHEQUE';
