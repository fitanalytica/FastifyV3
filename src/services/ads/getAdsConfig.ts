import { createHash } from 'node:crypto';
import { ADS_DATA, type AdsData } from './adsData.js';

// docs/data/api.md section 15. The ad rules for one platform, with a version that is a hash of the content: the phone sends back the one it holds and gets the rules only when they changed.
// The data does not change while the server runs, so each platform's rules are built once.

export type AdsPlatform = 'ios' | 'android';
export type AdsConfig = Omit<AdsData, 'platforms'> & { version: string };

/** What is wrong with some data (empty when it is fine). Checked when the server starts, so a bad edit fails the deploy and not the phones. */
export function adsDataProblems(data: AdsData): string[] {
  const problems: string[] = [];
  const whole = (n: number) => Number.isInteger(n) && n >= 0;
  const check = (label: string, d: Omit<AdsData, 'platforms'>) => {
    if (!(Number.isInteger(d.rolloutPercent) && d.rolloutPercent >= 0 && d.rolloutPercent <= 100)) problems.push(`${label}: rolloutPercent is 0 to 100`);
    if (!whole(d.graceDays)) problems.push(`${label}: graceDays is a whole number of days`);
    if (!whole(d.quietHoursAfterPurchase)) problems.push(`${label}: quietHoursAfterPurchase is a whole number of hours`);
    if (!whole(d.fullScreen.minGapSeconds) || !whole(d.fullScreen.maxPerSession)) problems.push(`${label}: fullScreen gap and cap are whole numbers`);
    for (const [key, rule] of Object.entries(d.events)) {
      if (!whole(rule.maxPerDay) || !whole(rule.cooldownSeconds)) problems.push(`${label}: event ${key} needs whole numbers`);
      if (rule.format !== 'app_open' && rule.format !== 'interstitial') problems.push(`${label}: event ${key} has an unknown format`);
    }
    for (const [key, rule] of Object.entries(d.placements)) {
      if (rule.formats.length === 0 || rule.formats.some((f) => f !== 'native' && f !== 'banner')) problems.push(`${label}: placement ${key} needs native and/or banner`);
      if (rule.every !== undefined && !(Number.isInteger(rule.every) && rule.every >= 2)) problems.push(`${label}: placement ${key} \`every\` is 2 or more`);
    }
  };
  check('base', data);
  for (const platform of ['ios', 'android'] as const) check(platform, mergePlatform(data, platform));
  return problems;
}

/** The base rules with one platform's changes laid over. */
export function mergePlatform(data: AdsData, platform: AdsPlatform): Omit<AdsData, 'platforms'> {
  const { platforms, ...base } = data;
  const over = platforms?.[platform];
  if (!over) return base;
  const { events, placements, ...numbers } = over;
  return { ...base, ...numbers, events: { ...base.events, ...events }, placements: { ...base.placements, ...placements } };
}

/** The rules of some data for a platform (the server's own are `getAdsConfig(platform)`). */
export function buildAdsConfig(data: AdsData, platform: AdsPlatform): AdsConfig {
  const content = mergePlatform(data, platform);
  return { version: createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 12), ...content };
}

const problems = adsDataProblems(ADS_DATA);
if (problems.length) {
  throw new Error(`ADS_DATA is not valid: ${problems.join('; ')}`);
}

const built: Record<AdsPlatform, AdsConfig> = { ios: buildAdsConfig(ADS_DATA, 'ios'), android: buildAdsConfig(ADS_DATA, 'android') };

export const getAdsConfig = (platform: AdsPlatform = 'ios'): AdsConfig => built[platform];
