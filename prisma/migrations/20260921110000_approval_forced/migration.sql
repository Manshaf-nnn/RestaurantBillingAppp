-- correctionA.md §9 — a decision that overrode the two-person rule says so.
--
-- `decidedById` already records who ruled on a request. What it cannot say is
-- whether they were allowed to by the ordinary rule or had to override it: a
-- main admin approving their own request, or someone outside the location's
-- approver list. Without this column the only trace is the audit log, and the
-- queue and the detail view would show an override as an ordinary approval —
-- which makes the control invisible exactly where it most needs reading.
--
-- Nullable and additive. Null means "decided normally", which is the correct
-- reading of every row that already exists.

ALTER TABLE "approval_requests" ADD COLUMN "forcedAt" TIMESTAMP(3);
