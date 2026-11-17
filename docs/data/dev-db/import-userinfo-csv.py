#!/usr/bin/env python3
"""Imports `userinfo` rows exported from production as CSV into the LOCAL dev database. LOCAL ONLY, safe to run again.

    python3 import-userinfo-csv.py ~/Downloads/userinfo-1.csv

The CSV is the `userinfo` table as exported by pgAdmin: `NULL` written as the text NULL, `geom` as EWKB hex.
The rows are imported AS THEY ARE (geom decoded exactly, including a wrong one); `geo_source`, which production does not have yet, stays NULL
(the docs read NULL as "IP"). A user that is already there is left alone. It prints counts only, never a value: this table is personal data
(name, birth date, height, weight, location). Keep the CSV out of the repo and delete it when done.
"""
import csv, os, struct, subprocess, sys, tempfile

PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@18/bin/psql')
DB = os.environ.get('DEV_DB', 'fitanalytica_dev')
HOST = os.environ.get('PGHOST', '')
if HOST not in ('', 'localhost', '127.0.0.1') and not HOST.startswith('/'):
    sys.exit(f'refusing to run: PGHOST={HOST} is not this machine')

# column -> the type it is cast to (what the local `userinfo` table has); geom is handled apart
TYPES = {
    'userid': 'uuid', 'store_id': 'uuid',
    'dateregistered': 'int', 'dobglobal': 'int', 'seconds_from_gmt': 'int', 'last_access_date': 'int', 'deleted_date': 'int',
    'height': 'real', 'weight': 'real', 'lat': 'real', 'lon': 'real',
    'hideprofile': 'boolean', 'gender': 'gender_enum',
    'iso': 'text', 'mailids': 'text', 'fname': 'text', 'lname': 'text', 'city': 'text', 'state': 'text',
    'profilepic': 'text', 'about': 'text', 'profilebg': 'text', 'timezone': 'text',
}

def point(ewkb_hex):
    """(x, y) of an EWKB point, little-endian, with or without an SRID."""
    raw = bytes.fromhex(ewkb_hex)
    if raw[0] != 1:
        raise ValueError('big-endian geometry is not expected')
    kind, = struct.unpack('<I', raw[1:5])
    off = 9 if kind & 0x20000000 else 5
    return struct.unpack('<dd', raw[off:off + 16])

def main(paths):
    csv.field_size_limit(10 ** 9)
    cols = list(TYPES)
    n_in = 0
    with tempfile.TemporaryDirectory() as tmp:
        merged = os.path.join(tmp, 'rows.csv')
        with open(merged, 'w', newline='', encoding='utf-8') as out:
            w = csv.writer(out)
            w.writerow(cols + ['gx', 'gy'])
            for p in paths:
                with open(os.path.expanduser(p), newline='', encoding='utf-8') as fh:
                    r = csv.DictReader(fh)
                    missing = [c for c in cols + ['geom'] if c not in (r.fieldnames or [])]
                    if missing:
                        sys.exit(f'{p}: missing columns {missing}')
                    for row in r:
                        if row['geom'] in ('NULL', ''):
                            gx = gy = 'NULL'
                        else:
                            gx, gy = (repr(v) for v in point(row['geom']))
                        w.writerow([row[c] for c in cols] + [gx, gy])
                        n_in += 1
        val = lambda c: f"NULLIF({c}, 'NULL')::{TYPES[c]}"
        sql = f"""
\\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE imp ({', '.join(c + ' text' for c in cols + ['gx', 'gy'])}) ON COMMIT DROP;
\\copy imp FROM '{merged}' CSV HEADER
INSERT INTO userlogin (userid, stage, applegoogleid)
  SELECT userid::uuid, 0, 'import-' || left(userid, 8) FROM imp ON CONFLICT DO NOTHING;
INSERT INTO userinfo ({', '.join(cols)}, geom)
  SELECT {', '.join(val(c) for c in cols)},
         CASE WHEN gx = 'NULL' THEN NULL ELSE ST_SetSRID(ST_MakePoint(gx::float8, gy::float8), 4326) END FROM imp
  ON CONFLICT (userid) DO NOTHING;
COMMIT;
"""
        subprocess.run([PSQL, '-d', DB, '-q', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, check=True)
    print(f'read {n_in} row(s) from {len(paths)} file(s)')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
