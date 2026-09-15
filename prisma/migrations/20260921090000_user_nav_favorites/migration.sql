-- sidebar.md §1/§2 — the sidebar shortcuts each person pinned, in the order
-- they arranged them.
--
-- An ordered array rather than a join table: the order IS the data, a list of
-- at most twelve short strings, and it rides `USER_SELECT` — the one user row
-- every authenticated request already reads — so the sidebar costs no extra
-- query to draw. §9 asks for exactly that.
--
-- Additive, NOT NULL with a DEFAULT, so it applies to a table that already has
-- rows in it. Nothing reads this column without filtering it through
-- `permissionsFor` first, so a stale href left behind by a permission change is
-- inert rather than dangerous.

ALTER TABLE "users" ADD COLUMN "navFavorites" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
