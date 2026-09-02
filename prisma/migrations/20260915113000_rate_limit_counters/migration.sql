-- Rate limits become real on serverless (AUDIT.md Slice 6): the in-memory
-- fallback counted per instance, which on Netlify means counting to one.
CREATE TABLE "rate_limit_counters" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("key","windowStart")
);
