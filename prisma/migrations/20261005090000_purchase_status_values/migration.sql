-- Three more places a purchase request can end up.
--
-- The workflow is request → approval → order → receipt, and the approval step
-- had two answers where the person deciding has three. REJECTED is the "no"
-- with its reason kept; RETURNED is "not like this" — the request goes back to
-- the person who raised it, editable again, and comes round once more when it
-- is corrected. CLOSED is the end of an order that is done with: fully
-- received and signed off, or closed short when the remainder is not coming.
--
-- Enum values only, in a file of their own. Postgres refuses to READ a new
-- enum value in the transaction that added it, so the columns that carry
-- them, and any row that uses them, live in the next migration.

ALTER TYPE "PurchaseStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE "PurchaseStatus" ADD VALUE IF NOT EXISTS 'RETURNED';
ALTER TYPE "PurchaseStatus" ADD VALUE IF NOT EXISTS 'CLOSED';
