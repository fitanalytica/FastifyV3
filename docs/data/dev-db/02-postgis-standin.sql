-- A stand-in for the few PostGIS pieces this project uses, for LOCAL TESTS ONLY. It is not PostGIS.
--   psql -d fitanalytica_dev -f 02-postgis-standin.sql
-- Production has real PostGIS. Here the column type geometry(Point,4326) becomes the built-in point type
-- (load the schema dump through: sed 's/public\.geometry(Point,4326)/point/g'), and the functions the queries call exist:
--   ST_MakePoint(x, y)  ST_SetSRID(geom, srid)  ST_X(geom)  ST_Y(geom)
-- x is longitude and y is latitude, as in PostGIS. A GiST index on a point column works as it does on geometry.

CREATE OR REPLACE FUNCTION ST_MakePoint(x double precision, y double precision) RETURNS point
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT point(x, y) $$;

CREATE OR REPLACE FUNCTION ST_SetSRID(g point, srid integer) RETURNS point
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT g $$;

CREATE OR REPLACE FUNCTION ST_X(g point) RETURNS double precision
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT g[0] $$;

CREATE OR REPLACE FUNCTION ST_Y(g point) RETURNS double precision
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT g[1] $$;
