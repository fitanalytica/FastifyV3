import { createHash } from 'node:crypto';
import { CATALOG_DATA, type CatalogData, type ProductData, type SectionData } from './catalogData.js';

// docs/data/api.md section 15. What the app offers to buy, built from the data in `catalogData.ts` (the old payload's sections and options). Prices are not here (the stores own them).
// The version is a hash of the content, so the phone sends back the one it holds and gets the catalogue only when it changed. The data does not change while the server runs, so it is built once.

export interface CatalogOption {
  /** The position in its section. */
  id: number;
  productId: string;
  kind: ProductData['kind'];
  billingType: ProductData['billingType'];
  /** Groups: how many memberships the pack holds. */
  membership?: number;
  /** Streak: how many protection days it adds. */
  frequency?: number;
  [text: string]: unknown;
}
export interface CatalogSection extends Omit<SectionData, 'products'> {
  /** `subscription` only: `lifetime` (one-time packs) or `subscription` (a plan is on sale). */
  mode?: 'lifetime' | 'subscription';
  options: CatalogOption[];
}
export interface Catalog { version: string; subscription: CatalogSection; streak: CatalogSection }

const onSale = (p: ProductData) => p.active !== false;

function section(data: SectionData, withMode: boolean): CatalogSection {
  const { products, ...texts } = data;
  const options = products.filter(onSale).map((p, id): CatalogOption => ({
    ...p.display,
    id,
    productId: p.productId,
    kind: p.kind,
    billingType: p.billingType,
    ...(p.membership !== undefined ? { membership: p.membership } : {}),
    ...(p.frequency !== undefined ? { frequency: p.frequency } : {}),
  }));
  return { ...(withMode ? { mode: options.some((o) => o.kind === 'subscription') ? ('subscription' as const) : ('lifetime' as const) } : {}), ...texts, options };
}

/** The catalogue of some data (the server's own is `getCatalog()`). */
export function buildCatalog(data: CatalogData): Catalog {
  const content = { subscription: section(data.subscription, true), streak: section(data.streak, false) };
  return { version: createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 12), ...content };
}

const catalog = buildCatalog(CATALOG_DATA);

export const getCatalog = (): Catalog => catalog;

/** A product by its store id, on sale or not (a purchase made before it was taken off sale must still be recognised). */
export const findProduct = (productId: string): ProductData | undefined =>
  [...CATALOG_DATA.subscription.products, ...CATALOG_DATA.streak.products].find((p) => p.productId === productId);
