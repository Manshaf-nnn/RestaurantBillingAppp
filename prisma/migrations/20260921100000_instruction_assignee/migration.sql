-- correctionA.md §2 — a task can be given to a person, not only to a location.
--
-- Both columns are nullable and neither is backfilled: an instruction with no
-- assignee still means what it always meant, "this is for the location", which
-- is the right reading of every row that already exists and the right default
-- for a group-wide notice.
--
-- `assigneeName` sits beside the id for the same reason `createdByName` does.
-- The foreign key is ON DELETE SET NULL, so removing a member of staff would
-- otherwise erase who a finished task had been given to — and "who was asked
-- to do this" is most of what the record is for.
--
-- The index matches the query the nav badge and the task list both run:
-- what is still open, for one person, in one restaurant.

ALTER TABLE "branch_instructions" ADD COLUMN "assigneeId" TEXT;
ALTER TABLE "branch_instructions" ADD COLUMN "assigneeName" TEXT;

ALTER TABLE "branch_instructions"
  ADD CONSTRAINT "branch_instructions_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "branch_instructions_restaurantId_assigneeId_status_idx"
  ON "branch_instructions"("restaurantId", "assigneeId", "status");
