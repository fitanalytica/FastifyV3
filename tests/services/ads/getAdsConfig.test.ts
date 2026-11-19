import { test, expect } from 'vitest';
import { ADS_DATA, type AdsData } from '../../../src/services/ads/adsData.js';
import { adsDataProblems, buildAdsConfig, getAdsConfig, mergePlatform } from '../../../src/services/ads/getAdsConfig.js';

// The ad rules (docs/data/api.md section 15): plain data, a version that is a hash of the content, one platform's changes laid over the rest.
const copy = (): AdsData => JSON.parse(JSON.stringify(ADS_DATA));

test('the data the server ships is valid, with a 1 day grace for new accounts', () => {
  expect(adsDataProblems(ADS_DATA)).toEqual([]);
  expect(ADS_DATA.graceDays).toBe(1);
  expect(getAdsConfig('ios').version).toMatch(/^[0-9a-f]{12}$/);
});

test('the version follows the content: the same data gives the same version, a change gives another', () => {
  const a = buildAdsConfig(copy(), 'ios');
  expect(buildAdsConfig(copy(), 'ios').version).toBe(a.version);
  const changed = copy();
  changed.graceDays = 2;
  expect(buildAdsConfig(changed, 'ios').version).not.toBe(a.version);
});

test("a platform's changes are laid over the base, and the other platform is left as it was", () => {
  const data = copy();
  data.platforms = { android: { graceDays: 3, events: { activity_recorded: { enabled: false, format: 'interstitial', maxPerDay: 1, cooldownSeconds: 60 } } } };
  const android = buildAdsConfig(data, 'android');
  const ios = buildAdsConfig(data, 'ios');
  expect(android.graceDays).toBe(3);
  expect(android.events.activity_recorded.enabled).toBe(false);
  expect(android.events.app_open).toEqual(data.events.app_open);
  expect(ios.graceDays).toBe(1);
  expect(ios.events.activity_recorded.enabled).toBe(true);
  expect(android.version).not.toBe(ios.version);
  expect((android as Record<string, unknown>).platforms).toBeUndefined();
  expect(mergePlatform(data, 'ios')).not.toHaveProperty('platforms');
});

test('a bad edit is named, base or platform', () => {
  const bad = copy();
  bad.rolloutPercent = 150;
  bad.graceDays = -1;
  bad.events.app_open.maxPerDay = 1.5;
  bad.placements.feed_inline.every = 1;
  bad.placements.home_inline.formats = [];
  expect(adsDataProblems(bad)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('rolloutPercent'),
      expect.stringContaining('graceDays'),
      expect.stringContaining('event app_open'),
      expect.stringContaining('placement feed_inline'),
      expect.stringContaining('placement home_inline'),
    ]),
  );
  const platformBad = copy();
  platformBad.platforms = { ios: { rolloutPercent: 101 } };
  expect(adsDataProblems(platformBad).some((p) => p.startsWith('ios:'))).toBe(true);
});
