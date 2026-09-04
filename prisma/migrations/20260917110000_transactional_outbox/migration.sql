-- The transactional outbox (production.md §5).
--
-- Realtime emission was fire-and-forget and, on the serverless host, a no-op:
-- `realtime.orderCreated(...)` ran after commit against a Socket.IO server that
-- does not exist there. The event describing an order therefore had no durable
-- existence at all. Undelivered meant gone, with nothing to replay and nothing
-- to say afterwards what had happened.
--
-- A row here is written inside the SAME transaction as the order, payment or
-- stock movement it describes, so the two commit or roll back together. An
-- event cannot describe something that did not happen, and something that
-- happened cannot lack its event.
--
-- `seq` is a bigserial primary key: it orders events and gives the poller a
-- cursor. `id` is a stable cuid the client dedups on, so an event delivered
-- twice is applied once.

CREATE TABLE "outbox_events" (
    "seq"          BIGSERIAL NOT NULL,
    "id"           TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId"     TEXT,
    "type"         TEXT NOT NULL,
    "entity"       TEXT NOT NULL,
    "entityId"     TEXT,
    "payload"      JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("seq")
);

CREATE UNIQUE INDEX "outbox_events_id_key" ON "outbox_events"("id");

-- The poller's query: everything for one restaurant after a cursor.
CREATE INDEX "outbox_events_restaurantId_seq_idx" ON "outbox_events"("restaurantId", "seq");
-- The same, narrowed to one branch, so a Colombo screen is not woken by Kandy.
CREATE INDEX "outbox_events_restaurantId_branchId_seq_idx"
    ON "outbox_events"("restaurantId", "branchId", "seq");
-- Retention: the outbox-trim job deletes by age.
CREATE INDEX "outbox_events_createdAt_idx" ON "outbox_events"("createdAt");

ALTER TABLE "outbox_events"
    ADD CONSTRAINT "outbox_events_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
