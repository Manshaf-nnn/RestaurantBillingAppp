-- acCal.md — the Accountant Control Center's storage: signed notes,
-- bank-statement reconciliation, and the owner's food-cost target.
-- Everything here is additive; nothing rewrites existing rows.

-- The owner's expected food-cost share of sales, in basis points. Null = no
-- target set.
ALTER TABLE "restaurants" ADD COLUMN "targetFoodCostBps" INTEGER;

-- CreateEnum
CREATE TYPE "BankLineStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'DUPLICATE', 'IGNORED');

-- CreateTable: accountant_notes (append-only by construction — the app ships
-- no UPDATE or DELETE for these rows).
CREATE TABLE "accountant_notes" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accountant_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "accountant_notes_restaurantId_entity_entityId_createdAt_idx"
    ON "accountant_notes"("restaurantId", "entity", "entityId", "createdAt");

ALTER TABLE "accountant_notes"
    ADD CONSTRAINT "accountant_notes_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accountant_notes"
    ADD CONSTRAINT "accountant_notes_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A note must say something.
ALTER TABLE "accountant_notes" ADD CONSTRAINT "accountant_notes_body_not_blank"
    CHECK (length(btrim("body")) > 0);

-- CreateTable: bank_statements
CREATE TABLE "bank_statements" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT,
    "fileName" TEXT NOT NULL,
    "importHash" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "uploadedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bank_statements_restaurantId_importHash_key"
    ON "bank_statements"("restaurantId", "importHash");

ALTER TABLE "bank_statements"
    ADD CONSTRAINT "bank_statements_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_statements"
    ADD CONSTRAINT "bank_statements_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: bank_statement_lines
CREATE TABLE "bank_statement_lines" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "lineDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amount" INTEGER NOT NULL,
    "lineHash" TEXT NOT NULL,
    "status" "BankLineStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedType" TEXT,
    "matchedId" TEXT,
    "matchedById" TEXT,
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bank_statement_lines_restaurantId_status_lineDate_idx"
    ON "bank_statement_lines"("restaurantId", "status", "lineDate");
CREATE INDEX "bank_statement_lines_restaurantId_lineHash_idx"
    ON "bank_statement_lines"("restaurantId", "lineHash");
CREATE INDEX "bank_statement_lines_statementId_idx"
    ON "bank_statement_lines"("statementId");

ALTER TABLE "bank_statement_lines"
    ADD CONSTRAINT "bank_statement_lines_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_statement_lines"
    ADD CONSTRAINT "bank_statement_lines_statementId_fkey"
    FOREIGN KEY ("statementId") REFERENCES "bank_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_statement_lines"
    ADD CONSTRAINT "bank_statement_lines_matchedById_fkey"
    FOREIGN KEY ("matchedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A matched line must say what it matched; an unmatched line must not.
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_match_shape"
    CHECK (("status" = 'MATCHED') = ("matchedType" IS NOT NULL AND "matchedId" IS NOT NULL));
