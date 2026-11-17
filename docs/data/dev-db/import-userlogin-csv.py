#!/usr/bin/env python3
"""Imports `userlogin` rows exported from production as CSV into the LOCAL dev database. LOCAL ONLY, safe to run again.

    python3 import-userlogin-csv.py ~/Downloads/userlogin-1.csv

Columns: userid, stage, loginused, email, applegoogleid (`NULL` written as the text NULL). A user that is already there is UPDATED:
the importers of activities and userinfo create a placeholder row ('import-<first 8 of the userid>', stage 0) so their foreign keys hold,
and this fills it in with the real values. Keep the CSV out of the repo and delete it when done (it has e-mail addresses).
"""
import csv, os, subprocess, sys, tempfile

PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@18/bin/psql')
DB = os.environ.get('DEV_DB', 'fitanalytica_dev')
HOST = os.environ.get('PGHOST', '')
if HOST not in ('', 'localhost', '127.0.0.1') and not HOST.startswith('/'):
    sys.exit(f'refusing to run: PGHOST={HOST} is not this machine')

COLS = ['userid', 'stage', 'loginused', 'email', 'applegoogleid']

def main(paths):
    n = 0
    with tempfile.TemporaryDirectory() as tmp:
        merged = os.path.join(tmp, 'rows.csv')
        with open(merged, 'w', newline='', encoding='utf-8') as out:
            w = csv.writer(out)
            w.writerow(COLS)
            for p in paths:
                with open(os.path.expanduser(p), newline='', encoding='utf-8') as fh:
                    r = csv.DictReader(fh)
                    missing = [c for c in COLS if c not in (r.fieldnames or [])]
                    if missing:
                        sys.exit(f'{p}: missing columns {missing}')
                    for row in r:
                        w.writerow([row[c] for c in COLS])
                        n += 1
        sql = f"""
\\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE imp (userid text, stage text, loginused text, email text, applegoogleid text) ON COMMIT DROP;
\\copy imp FROM '{merged}' CSV HEADER
INSERT INTO userlogin (userid, stage, loginused, email, applegoogleid)
  SELECT userid::uuid, NULLIF(stage, 'NULL')::smallint, NULLIF(loginused, 'NULL')::login_type_enum, NULLIF(email, 'NULL'), applegoogleid FROM imp
  ON CONFLICT (userid) DO UPDATE SET stage = EXCLUDED.stage, loginused = EXCLUDED.loginused, email = EXCLUDED.email, applegoogleid = EXCLUDED.applegoogleid;
COMMIT;
"""
        subprocess.run([PSQL, '-d', DB, '-q', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, check=True)
    print(f'read {n} row(s) from {len(paths)} file(s)')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
