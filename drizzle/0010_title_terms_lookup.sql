-- Exact lookup of a normalized term.
--
-- The trigram index answers similarity and prefix queries; it is no use for
-- equality. The delete-redirect heuristic (§7.3) needs exactly that: "which
-- live title has this normalized name?" — because matching a deleted duplicate
-- to its survivor means seeing through accents and punctuation, which a SQL
-- prefix comparison cannot do.
CREATE INDEX IF NOT EXISTS "title_terms_term_norm_kind_idx"
	ON "title_terms" ("term_norm", "kind");
