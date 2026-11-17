import { describe, test, expect } from 'vitest';
import { collectDownloadIds, invalidReason, parseActivity } from '../../src/services/activities/validate.js';
import { activity } from '../helpers/fixtures.js';

const DL = '11111111-1111-4111-8111-111111111111';
const owned = new Set([DL]);
const ok = (over: Record<string, unknown> = {}) => activity(DL, over);

describe('invalidReason', () => {
  test('a good activity passes', () => expect(invalidReason(ok(), owned)).toBeNull());
  test.each([
    [{ startdate: 1.5 }, 'bad_dates'], [{ enddate: 1 }, 'bad_dates'], [{ startdate: '1' }, 'bad_dates'],
    [{ lat: 90.1 }, 'bad_location'], [{ lon: -181 }, 'bad_location'], [{ lat: null }, 'bad_location'],
    [{ duration: -1 }, 'bad_duration'], [{ stepcount: 2 ** 31 }, 'bad_stepcount'],
    [{ temp: 32768 }, 'bad_temp'], [{ aqi: 'x' }, 'bad_aqi'], [{ wind: NaN }, 'bad_wind'],
    [{ city: 5 }, 'bad_city'], [{ iswatch: 'yes' }, 'bad_iswatch'],
    [{ activitylat: 'x' }, 'bad_track'], [{ activitytimenow: [1] }, 'bad_track'],
    [{ activitydetail_v2: [] }, 'bad_activitydetail_v2'], [{ activitydetail_v2: null }, 'missing_activitydetail_v2'], [{ activitydetail_v2: undefined }, 'missing_activitydetail_v2'], [{ device: 'x' }, 'bad_device'],
    [{ media_v2: {} }, 'bad_media'], [{ description: 'x'.repeat(201) }, 'description_too_long'],
    [{ downloadid: '22222222-2222-4222-8222-222222222222' }, 'bad_downloadid'],
  ])('%j is refused as %s', (over, why) => expect(invalidReason(ok(over), owned)).toBe(why));

  test('a resend without a track may leave activitydetail_v2 out too', () => {
    const noTrack = { ...ok({ activitydetail_v2: undefined }) } as Record<string, unknown>;
    for (const k of ['activitylat', 'activitylon', 'activitytimenow', 'activityelevation', 'activitydistance']) delete noTrack[k];
    expect(invalidReason(noTrack, owned)).toBeNull();
  });

  test('optional fields may be null or missing', () => {
    expect(invalidReason(ok({ temp: null, wind: undefined, media_v2: null, activitybpm_v2: null, description: null }), owned)).toBeNull();
  });
});

describe('parseActivity', () => {
  test('drops userid, lower-cases the id, defaults downloadid to the token device', () => {
    const raw = { ...ok({ activityid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', userid: 'x' }) } as Record<string, unknown>;
    delete raw.downloadid;
    const p = parseActivity(raw, owned, DL);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.row.activityid).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(p.row.downloadid).toBe(DL);
      expect('userid' in p.row).toBe(false);
    }
  });
  test('not an object, bad id', () => {
    expect(parseActivity('x', owned, DL)).toEqual({ ok: false, activityid: null, error: 'not_an_object' });
    expect(parseActivity([], owned, DL)).toMatchObject({ ok: false, error: 'not_an_object' });
    expect(parseActivity({ activityid: 'nope' }, owned, DL)).toEqual({ ok: false, activityid: null, error: 'bad_activityid' });
  });
  test('a refused item still reports its id', () => {
    expect(parseActivity(ok({ enddate: 1 }), owned, DL)).toMatchObject({ ok: false, error: 'bad_dates', activityid: expect.any(String) });
  });
});

test('collectDownloadIds: valid uuids only, the fallback for items without one', () => {
  const ids = collectDownloadIds([{ downloadid: DL }, {}, { downloadid: 'bad' }, null], '33333333-3333-4333-8333-333333333333');
  expect(ids.sort()).toEqual([DL, '33333333-3333-4333-8333-333333333333']);
});
