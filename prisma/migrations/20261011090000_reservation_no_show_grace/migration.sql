-- A booking can cancel itself when the party has not arrived within a set
-- number of minutes of its time. Null keeps the old behaviour: the host decides.
ALTER TABLE "reservations" ADD COLUMN "noShowAfterMinutes" INTEGER;
