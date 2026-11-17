#!/usr/bin/env python3
"""Imports activities exported from production as CSV into the LOCAL dev database. LOCAL ONLY, safe to run again.

    python3 import-activities-csv.py ~/Downloads/data-1.csv ~/Downloads/data-2.csv

The CSV is the `activities` table as exported by pgAdmin: 37 columns, `NULL` written as the text NULL, `geom` as EWKB hex.
What it does (the data is imported AS IT IS, so local shows what production really holds):
  - NULL text becomes SQL NULL; JSON columns are kept as the text they are.
  - geom is decoded exactly (x, y) and stored as the dev stand-in point, including rows where production has it swapped or (0, 0).
  - tosend, iswatch, dtgraph and the old-format columns are kept (a row with tosend = 0 stays hidden, as it is in production).
  - It creates the parents the foreign keys need: a `userlogin` row per user (applegoogleid 'import-<first 8 of the userid>', no email)
    and a `downloads` row per downloadid (device_type 'watch'/platform 'watchos' if every activity of it has iswatch = true, else 'phone'/'ios': a GUESS, the CSV has no device data).
  - Rows that already exist (same activityid) are left alone.
The CSVs hold real users' routes: keep them out of the repo, and delete them when done. Nothing here is committed or sent anywhere.
"""
import csv, os, struct, subprocess, sys, tempfile

PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@18/bin/psql')
DB = os.environ.get('DEV_DB', 'fitanalytica_dev')
HOST = os.environ.get('PGHOST', '')
if HOST not in ('', 'localhost', '127.0.0.1') and not HOST.startswith('/'):
    sys.exit(f'refusing to run: PGHOST={HOST} is not this machine')

# column -> the type it is cast to (what the local `activities` table has)
TYPES = {
    'activityid': 'uuid', 'userid': 'uuid', 'downloadid': 'uuid',
    'startdate': 'int', 'enddate': 'int', 'dtgraph': 'int', 'ddate': 'int', 'duration': 'int', 'stepcount': 'int', 'distance': 'int',
    'lat': 'real', 'lon': 'real', 'wind': 'real', 'uvi': 'real',
    'temp': 'smallint', 'realfeel': 'smallint', 'humidity': 'smallint', 'aqi': 'smallint', 'tosend': 'smallint',
    'iso': 'text', 'weathericon': 'text', 'weather': 'text', 'city': 'text', 'state': 'text', 'description': 'text',
    'iswatch': 'boolean',
    'activitydetail': 'json', 'activitydistance': 'json', 'activityelevation': 'json', 'activitylat': 'json', 'activitylon': 'json',
    'activitytimenow': 'json', 'activitybpm': 'json', 'device': 'json', 'media': 'jsonb', 'media_details': 'jsonb',
}

def point(ewkb_hex):
    """(x, y) of an EWKB point, little-endian, with or without an SRID."""
    raw = bytes.fromhex(ewkb_hex)
    if raw[0] != 1:
        raise ValueError('big-endian geometry is not expected')
    kind, = struct.unpack('<I', raw[1:5])
    off = 9 if kind & 0x20000000 else 5
    x, y = struct.unpack('<dd', raw[off:off + 16])
    return x, y

def main(paths):
    csv.field_size_limit(10 ** 9)
    cols = list(TYPES)
    out_cols = cols + ['gx', 'gy']
    n_in = 0
    with tempfile.TemporaryDirectory() as tmp:
        merged = os.path.join(tmp, 'rows.csv')
        with open(merged, 'w', newline='', encoding='utf-8') as out:
            w = csv.writer(out)
            w.writerow(out_cols)
            for p in paths:
                with open(os.path.expanduser(p), newline='', encoding='utf-8') as fh:
                    r = csv.DictReader(fh)
                    missing = [c for c in cols + ['geom'] if c not in (r.fieldnames or [])]
                    if missing:
                        sys.exit(f'{p}: missing columns {missing}')
                    for row in r:
                        gx, gy = point(row['geom'])
                        w.writerow([row[c] for c in cols] + [repr(gx), repr(gy)])
                        n_in += 1
        def val(c):
            return f"NULLIF({c}, 'NULL')::{TYPES[c]}"
        sql = f"""
\\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE imp ({', '.join(c + ' text' for c in out_cols)}) ON COMMIT DROP;
\\copy imp FROM '{merged}' CSV HEADER
INSERT INTO userlogin (userid, stage, applegoogleid)
  SELECT DISTINCT userid::uuid, 0, 'import-' || left(userid, 8) FROM imp ON CONFLICT DO NOTHING;
INSERT INTO downloads (downloadid, userid, device_type, platform)
  SELECT downloadid::uuid, min(userid)::uuid,
         CASE WHEN bool_and(iswatch = 'True') THEN 'watch' ELSE 'phone' END::device_type_enum,
         CASE WHEN bool_and(iswatch = 'True') THEN 'watchos' ELSE 'ios' END::platform_type_enum
    FROM imp GROUP BY downloadid ON CONFLICT DO NOTHING;
INSERT INTO activities ({', '.join(cols)}, geom)
  SELECT {', '.join(val(c) for c in cols)}, ST_SetSRID(ST_MakePoint(gx::float8, gy::float8), 4326) FROM imp
  ON CONFLICT (activityid) DO NOTHING;
COMMIT;
"""
        subprocess.run([PSQL, '-d', DB, '-q', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, check=True)
    print(f'read {n_in} rows from {len(paths)} file(s)')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
