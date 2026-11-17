-- LOCAL DEV ONLY. A user who has just installed the app, signed in with Google and finished the setup steps: nothing else.
--   psql -d fitanalytica_dev -f seed-new-user.sql
--
-- Login data: Google, stage 4 (the stage of a user whose health details are saved, as the existing users have).
-- Profile: gender, height, weight and birth date, and nothing more: no name, no location, no picture.
-- No activities, no steps history (walkdata), no streak, no tokens, no devices: every table that points at the user is emptied.
-- Safe to run again: it resets the user to this state (an app still signed in as them is signed out at its next call, as their tokens go).
-- Dummy data. To sign in as this user in the app, map a provider to it in FastifyV3/.env.local:
--   DEV_USER_GOOGLE=ae0e0001-0000-4000-8000-000000000001

BEGIN;

-- the data first (these tables point at userlogin), so a re-run starts from nothing
DELETE FROM usertokens  WHERE userid = 'ae0e0001-0000-4000-8000-000000000001';
DELETE FROM activities  WHERE userid = 'ae0e0001-0000-4000-8000-000000000001';
DELETE FROM walkdata    WHERE userid = 'ae0e0001-0000-4000-8000-000000000001';
DELETE FROM streak_logs WHERE userid = 'ae0e0001-0000-4000-8000-000000000001';
DELETE FROM downloads   WHERE userid = 'ae0e0001-0000-4000-8000-000000000001';
DELETE FROM userinfo    WHERE userid = 'ae0e0001-0000-4000-8000-000000000001';

INSERT INTO userlogin (userid, stage, loginused, email, applegoogleid)
VALUES ('ae0e0001-0000-4000-8000-000000000001', 4, 'google', 'new.user@example.com', 'google-newuser-001')
ON CONFLICT (userid) DO UPDATE
   SET stage = EXCLUDED.stage, loginused = EXCLUDED.loginused, email = EXCLUDED.email, applegoogleid = EXCLUDED.applegoogleid;

INSERT INTO userinfo (userid, dateregistered, dobglobal, height, weight, gender)
VALUES ('ae0e0001-0000-4000-8000-000000000001',
        EXTRACT(epoch FROM now())::int,
        EXTRACT(epoch FROM TIMESTAMPTZ '1992-03-14 00:00:00+00')::int,   -- a date label: that date at midnight UTC
        165, 60, 'female');

COMMIT;
