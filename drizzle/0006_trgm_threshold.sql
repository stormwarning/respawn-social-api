-- pg_trgm's word-similarity threshold is what the `%>` operator compares
-- against, and it is a per-SESSION setting. The connection pool hands out
-- whichever connection is free, so setting it per request is unreliable; it
-- belongs on the database, where every new session inherits it.
--
-- 0.6 was chosen against the real 310k-title index: lower floods short queries
-- with noise, higher starts missing folded expansion names.
DO $$
BEGIN
	EXECUTE format(
		'alter database %I set pg_trgm.word_similarity_threshold = 0.6',
		current_database()
	);
EXCEPTION WHEN insufficient_privilege THEN
	-- Some managed Postgres instances disallow this. Search still works; it just
	-- considers more candidate terms per query.
	RAISE NOTICE 'could not set pg_trgm.word_similarity_threshold at database level';
END
$$;
