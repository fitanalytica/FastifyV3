-- Read-only performance report for the tables in docs/data. It reads statistics only, no user data.
-- Run it on the PRIMARY (the writer endpoint, with a read-only role) in the application database. A reader only counts its own reads:
-- on a reader, sections 2, 3 and 5 show zeros or only read traffic. The queries are light (they read statistics), so they are safe on the primary.
--   psql "host=... dbname=<your db> user=<read-only user> sslmode=require" -f perf-report.sql -o perf-report.txt
-- Statistics start at the last reset, so run it after a normal busy period. Section 5 needs the pg_stat_statements extension and is skipped without it.
-- Run it with -f as above. Do NOT paste it into an open psql prompt: the terminal mangles long pasted scripts.

\pset pager off

\echo
\echo '== 1. Biggest tables, with their indexes'
SELECT c.relname AS table_name,
       c.reltuples::bigint AS approx_rows,
       pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes_size,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r' AND n.nspname = 'public'
 ORDER BY pg_total_relation_size(c.oid) DESC
 LIMIT 25;

\echo
\echo '== 2. Write rates, and how many updates were HOT (cheap: no index change)'
SELECT relname AS table_name, n_tup_ins AS inserts, n_tup_upd AS updates, n_tup_hot_upd AS hot_updates,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_pct,
       n_tup_del AS deletes, n_dead_tup AS dead_rows, last_autovacuum
  FROM pg_stat_user_tables
 ORDER BY n_tup_ins + n_tup_upd + n_tup_del DESC
 LIMIT 25;

\echo
\echo '== 3. Indexes that are never or rarely used (not primary or unique), biggest first'
SELECT s.relname AS table_name, s.indexrelname AS index_name, s.idx_scan AS scans,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
  FROM pg_stat_user_indexes s
  JOIN pg_index i ON i.indexrelid = s.indexrelid
 WHERE NOT i.indisunique AND NOT i.indisprimary
 ORDER BY s.idx_scan, pg_relation_size(s.indexrelid) DESC
 LIMIT 40;

\echo
\echo '== 4. Duplicate indexes (same table, columns, operator classes and condition)'
SELECT indrelid::regclass AS table_name, array_agg(indexrelid::regclass) AS indexes, indkey::text AS columns
  FROM pg_index
 GROUP BY indrelid, indkey::text, indclass::text, coalesce(indpred::text, ''), coalesce(indexprs::text, '')
HAVING count(*) > 1;

\echo
\echo '== 5. Queries that cost the most in total (needs pg_stat_statements; skipped if it is not installed)'
SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS has_pss \gset
\if :has_pss
SELECT calls, round(total_exec_time::numeric) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
       rows, left(regexp_replace(query, '\s+', ' ', 'g'), 140) AS query
  FROM pg_stat_statements
 ORDER BY total_exec_time DESC
 LIMIT 25;
\else
\echo 'pg_stat_statements is not installed here: section 5 skipped'
\endif

\echo
\echo '== 6. How the JSON columns are compressed (empty = the server default)'
SELECT a.attrelid::regclass AS table_name, a.attname AS column_name, a.atttypid::regtype AS type,
       CASE a.attcompression WHEN 'p' THEN 'pglz' WHEN 'l' THEN 'lz4' ELSE 'default' END AS compression
  FROM pg_attribute a
 WHERE a.attrelid IN ('activities'::regclass, 'walkdata'::regclass, 'streak_logs'::regclass, 'sync_body'::regclass)
   AND a.attnum > 0 AND NOT a.attisdropped
   AND a.atttypid IN ('json'::regtype, 'jsonb'::regtype)
 ORDER BY 1, 2;

\echo
\echo '== 7. Settings that matter here'
SHOW default_toast_compression;
SHOW shared_buffers;
SHOW max_connections;

\echo
\echo '== 8. Cache hit ratio for tables (should be close to 1)'
SELECT round(sum(heap_blks_hit)::numeric / nullif(sum(heap_blks_hit + heap_blks_read), 0), 4) AS table_hit_ratio
  FROM pg_statio_user_tables;
