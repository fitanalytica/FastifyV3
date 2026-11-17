-- Read-only report of the tables in docs/data/schema.pg.md.
-- It reads the catalogue (columns, constraints, indexes, sizes) and no user data, except the one block marked OPTIONAL at the end (commented out).
--
-- Run it against the database that holds the tables (not the default "postgres" database):
--   psql "host=... port=5432 dbname=<your db> user=<read-only user> sslmode=require" -f schema-report.sql -o schema-report.txt
-- then paste schema-report.txt.

\pset pager off
\pset format aligned

\echo
\echo '== 1. Where the tables are'
SELECT table_schema, table_name
  FROM information_schema.tables
 WHERE table_name IN ('activities', 'userinfo', 'downloads', 'userlogin', 'usertokens')
   AND table_schema NOT IN ('pg_catalog', 'information_schema')
 ORDER BY table_schema, table_name;

\echo
\echo '== 2. Columns'
SELECT c.table_name, c.ordinal_position AS pos, c.column_name, c.data_type, c.udt_name,
       c.character_maximum_length AS len, c.is_nullable AS nullable, c.column_default
  FROM information_schema.columns c
 WHERE c.table_name IN ('activities', 'userinfo', 'downloads', 'userlogin', 'usertokens')
   AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
 ORDER BY c.table_name, c.ordinal_position;

\echo
\echo '== 3. Constraints on these tables (primary key, unique, check, foreign key)'
SELECT cl.relname AS table_name, co.conname, co.contype, pg_get_constraintdef(co.oid) AS definition
  FROM pg_constraint co
  JOIN pg_class cl ON cl.oid = co.conrelid
 WHERE cl.relname IN ('activities', 'userinfo', 'downloads', 'userlogin', 'usertokens')
 ORDER BY cl.relname, co.contype, co.conname;

\echo
\echo '== 4. Foreign keys from other tables that point at these tables'
SELECT cl.relname AS from_table, co.conname, pg_get_constraintdef(co.oid) AS definition
  FROM pg_constraint co
  JOIN pg_class cl ON cl.oid = co.conrelid
  JOIN pg_class rf ON rf.oid = co.confrelid
 WHERE co.contype = 'f'
   AND rf.relname IN ('activities', 'userinfo', 'downloads', 'userlogin', 'usertokens')
   AND cl.relname NOT IN ('activities', 'userinfo', 'downloads', 'userlogin', 'usertokens')
 ORDER BY cl.relname, co.conname;

\echo
\echo '== 5. Indexes'
SELECT schemaname, tablename, indexname, indexdef
  FROM pg_indexes
 WHERE tablename IN ('activities', 'userinfo', 'downloads', 'userlogin', 'usertokens')
 ORDER BY tablename, indexname;

\echo
\echo '== 6. Triggers'
SELECT event_object_table AS table_name, trigger_name, action_timing, event_manipulation
  FROM information_schema.triggers
 WHERE event_object_table IN ('activities', 'userinfo', 'downloads', 'userlogin', 'usertokens')
 ORDER BY 1, 2;

\echo
\echo '== 7. Enum types and their values'
SELECT t.typname, string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS labels
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
 GROUP BY t.typname
 ORDER BY t.typname;

\echo
\echo '== 8. Size and approximate row count (decides how to run the lat/lon type change)'
SELECT c.relname AS table_name,
       c.reltuples::bigint AS approx_rows,
       pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_with_indexes
  FROM pg_class c
 WHERE c.relkind = 'r'
   AND c.relname IN ('activities', 'userinfo', 'downloads', 'userlogin', 'usertokens')
 ORDER BY pg_total_relation_size(c.oid) DESC;

\echo
\echo '== 9. Extensions'
SELECT extname, extversion FROM pg_extension ORDER BY extname;

\echo
\echo '== 10. Which values the device columns take (counts only)'
SELECT 'usertokens.device' AS what, device::text AS value, count(*) AS n FROM usertokens GROUP BY device
UNION ALL
SELECT 'downloads.device_type', device_type::text, count(*) FROM downloads GROUP BY device_type
UNION ALL
SELECT 'downloads.platform', platform::text, count(*) FROM downloads GROUP BY platform
 ORDER BY 1, 2;

\echo
\echo '== 11. How many activities use each tosend value (counts only)'
SELECT tosend, iswatch, count(*) AS n FROM activities GROUP BY tosend, iswatch ORDER BY 1, 2;

-- OPTIONAL: what the old track columns hold. This reads one activity (its route is a person's location),
-- so use your OWN test account's userid. Remove the leading "-- " from the lines to run it.
--
-- \echo
-- \echo '== 12. One activity of my own: the old format'
-- SELECT activityid, startdate, lat, lon,
--        left(activitylat::text, 120)      AS activitylat,
--        left(activitylon::text, 120)      AS activitylon,
--        left(activitytimenow::text, 120)  AS activitytimenow,
--        left(activityelevation::text, 120) AS activityelevation,
--        left(activitydistance::text, 120) AS activitydistance,
--        left(activitydetail::text, 80)    AS activitydetail,
--        left(activitybpm::text, 80)       AS activitybpm,
--        left(media::text, 100)            AS media,
--        left(media_details::text, 160)    AS media_details
--   FROM activities
--  WHERE userid = '<your own userid>'
--  ORDER BY startdate DESC
--  LIMIT 1;
