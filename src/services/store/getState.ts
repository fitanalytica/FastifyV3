import type { FastifyInstance } from 'fastify';
import { getAdsConfig, type AdsConfig, type AdsPlatform } from '../ads/getAdsConfig.js';
import { accountToken } from './accountToken.js';
import { getCatalog, type Catalog } from './getCatalog.js';
import { getEntitlement, type Entitlement } from './getEntitlement.js';
import { getGrants, type ProtectionGrant } from './getGrants.js';

// docs/data/api.md section 15. Everything the phone needs about what the user has and what is on sale, in one answer: asked once at the start and after sign-in, not on every screen.
// The catalogue's content comes only when the phone's version of it is not the current one (it sends the version it holds); otherwise just its version.

export interface State {
  /** Put on every purchase as the account token (Apple's `appAccountToken`); `null` until the profile exists. */
  accountToken: string | null;
  entitlement: Entitlement;
  protection: { grants: ProtectionGrant[] };
  catalog: Catalog | { version: string };
  /** The ad rules for the phone's platform (docs/data/api.md section 15): whole only when the version the phone holds is not the current one. */
  ads: AdsConfig | { version: string };
}

/** What the phone says it holds: the versions of the catalogue and of the ad rules, and its platform. */
export interface Held { catalog?: string; ads?: string; platform?: AdsPlatform }

export async function getState(app: FastifyInstance, userid: string, held: Held = {}): Promise<State> {
  const catalog = getCatalog();
  const ads = getAdsConfig(held.platform);
  const [entitlement, grants, token] = await Promise.all([getEntitlement(app, userid), getGrants(app, userid), accountToken(app, userid)]);
  return { accountToken: token, entitlement, protection: { grants }, catalog: catalog.version === held.catalog ? { version: catalog.version } : catalog, ads: ads.version === held.ads ? { version: ads.version } : ads };
}
