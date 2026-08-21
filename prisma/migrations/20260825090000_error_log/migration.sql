-- Recent server errors, keyed by the digest the browser shows the user.
--
-- In-memory capture came first and proved insufficient: a serverless instance is
-- short-lived, so the one that failed is rarely the one answering the diagnostic
-- endpoint, and the log read empty exactly when it mattered.
CREATE TABLE IF NOT EXISTS "error_logs" (
    "id"           TEXT NOT NULL,
    "restaurantId" TEXT,
    "digest"       TEXT,
    "route"        TEXT,
    "kind"         TEXT NOT NULL,
    "message"      TEXT NOT NULL,
    "stack"        TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "error_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "error_logs_digest_idx"    ON "error_logs"("digest");
CREATE INDEX IF NOT EXISTS "error_logs_createdAt_idx" ON "error_logs"("createdAt");
