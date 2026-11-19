// docs/data/api.md section 15. The rules for showing ads, as plain data (like the catalogue): they live in the server's code for now, a change is a deploy, and nothing here is about one
// user. The phone decides (docs/data/phone.md section 9f): whether the user is Pro (no ads at all), is new, is in the rollout, is recording, and how often it has already shown. The ids of
// the ad units are in the app, not here.

/** A full-screen ad is `app_open` (when the app comes to the front) or `interstitial` (between two things). */
export type FullScreenFormat = 'app_open' | 'interstitial';
/** What an inline slot may show, tried in this order. */
export type InlineFormat = 'native' | 'banner';

export type AdEventKey = 'app_open' | 'activity_recorded';
export type AdPlacementKey = 'home_inline' | 'feed_inline' | 'activity_detail_inline' | 'navigation_banner';

export interface AdEventRule {
  enabled: boolean;
  format: FullScreenFormat;
  /** Most times in a rolling 24 hours. */
  maxPerDay: number;
  /** Least seconds between two of this event. */
  cooldownSeconds: number;
}
export interface AdPlacementRule {
  enabled: boolean;
  formats: InlineFormat[];
  /** A list shows one every this many items. */
  every?: number;
}

export interface AdsData {
  /** The kill switch: `false` and no ad is shown anywhere. */
  enabled: boolean;
  /** How many of every hundred accounts get ads (the phone works out its own place from its account token, so the same accounts stay in). */
  rolloutPercent: number;
  /** No ads for this many days after the account was made. */
  graceDays: number;
  /** No ads for this many hours after a purchase or a redeemed code. */
  quietHoursAfterPurchase: number;
  /** Across all full-screen ads, so two never come close together or pile up. */
  fullScreen: { minGapSeconds: number; maxPerSession: number };
  events: Record<AdEventKey, AdEventRule>;
  placements: Record<AdPlacementKey, AdPlacementRule>;
  /** Changes for one platform, laid over the rest: whole `events` / `placements` entries, and the top-level numbers. */
  platforms?: Partial<Record<'ios' | 'android', Partial<Omit<AdsData, 'platforms' | 'events' | 'placements'>> & { events?: Partial<AdsData['events']>; placements?: Partial<AdsData['placements']> }>>;
}

export const ADS_DATA: AdsData = {
  enabled: true,
  rolloutPercent: 100,
  graceDays: 1,
  quietHoursAfterPurchase: 24,
  fullScreen: { minGapSeconds: 300, maxPerSession: 3 },
  events: {
    app_open: { enabled: true, format: 'app_open', maxPerDay: 4, cooldownSeconds: 7200 },
    activity_recorded: { enabled: true, format: 'interstitial', maxPerDay: 3, cooldownSeconds: 3600 },
  },
  placements: {
    // The inline slots wait for their designs.
    home_inline: { enabled: false, formats: ['native', 'banner'] },
    feed_inline: { enabled: false, formats: ['native', 'banner'], every: 4 },
    activity_detail_inline: { enabled: false, formats: ['native', 'banner'] },
    navigation_banner: { enabled: false, formats: ['banner'] },
  },
};
