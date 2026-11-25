// docs/data/api.md section 15. What the app offers to buy, as plain data (the old payload's shape). It lives in the server's code for now: a change is a deploy. Prices are NOT here:
// the stores own them and the phone reads them from the store. `kind` is what a purchase does (`subscription`: a plan, one membership row; `groups`: a pack of memberships with
// invite codes, one for the buyer; `streak`: protection days), `billingType` is how the store treats it, `active: false` takes it off sale (purchases already made still work).
export interface ProductData {
  productId: string;
  kind: 'subscription' | 'groups' | 'streak';
  billingType: 'consumable' | 'one-time' | 'subscription';
  /** Groups: how many memberships the pack holds. */
  membership?: number;
  /** Streak: how many protection days it adds. */
  frequency?: number;
  active?: boolean;
  /** The card's texts and look; `--` in a description stands for the per-member price, in `buyDescription` for the whole price. */
  display: Record<string, unknown>;
}
export interface SectionData {
  primaryTitle: string | null;
  secondaryTitle: string | null;
  subtitle: string | null;
  howItWorks: unknown[];
  communication: unknown;
  products: ProductData[];
}
export interface CatalogData { subscription: SectionData; streak: SectionData }

const howItWorks = [
  { id: 'f8a9b2c3-4d5e-6f7a-8b9c-0d1e2f3a4b5c', question: 'Buy a Lifetime Plan', platform: 'all', content: [{ type: 'Para', items: ['Get your unique membership codes.'] }] },
  { id: 'c1d2e3f4-5a6b-7c8d-9e0f-1a2b3c4d5e6f', question: 'Share the Codes', platform: 'all', content: [{ type: 'Para', items: ['Share them with anyone. Codes can be reshared until they are redeemed.'] }] },
  { id: 'b5c6d7e8-f9a0-1b2c-3d4e-5f6a7b8c9d0e', question: 'Redeem on iOS or Android', platform: 'all', content: [{ type: 'Para', items: ['Recipient taps the link in the shared message to redeem. If needed, they\u2019ll be directed to the App Store or Play Store to install fitAnalytica.'] }] },
  { id: 'e9f0a1b2-c3d4-e5f6-a7b8-c9d0e1f2a3b4', question: 'Track Code Usage', platform: 'all', content: [{ type: 'Para', items: ['See which codes have been redeemed and which are still available.'] }] },
  { id: 'd4e5f6a7-b8c9-d0e1-f2a3-b4c5d6e7f8a9', platform: 'all', content: [{ type: 'Para', items: ['Not a Pro member yet? Your first code will be automatically activated on your account.'] }] },
];

/** The message a buyer shares with a code (`--` is the code). */
const communication = {
  title: '\u{1F381} Your fitAnalytica Lifetime Plan!',
  body: 'Hey!\n\nI got us a lifetime plan! Use the link below to get your lifetime membership.\n\nDownload the app here: https://invite.fitanalytica.com/--\n\nIf you already have the app installed, please update it to the latest version before redeeming.\n\nOnce the app is updated or downloaded, click the same link again to redeem your lifetime membership.',
};

const GREEN = '#558B2F';
const alert = (title: string, subtitle: string) => ({ header: 'Congratulations', headerColor: GREEN, showConfetti: true, title, subtitle });

export const CATALOG_DATA: CatalogData = {
  subscription: {
    primaryTitle: null,
    secondaryTitle: 'Gift Lifetime Memberships to the Ones You Love.',
    subtitle: 'For you, your family, or your friends.',
    howItWorks,
    communication,
    products: [
      {
        productId: 'fitanalytica.groups.lifetime.49', kind: 'groups', billingType: 'consumable', membership: 5,
        display: { title: '5 LIFETIME MEMBERSHIPS', buyButton: 'GET 5 MEMBERSHIPS', buyDescription: 'One-time payment. No renewals.', description: 'Only -- per member', descriptionAlt: 'Only -- per member', tagText: '', isBigCard: true, icon: 'pro.outline', alert: alert('5 Memberships Unlocked', 'Share them with friends and family') },
      },
      {
        productId: 'fitanalytica.groups.lifetime.39', kind: 'groups', billingType: 'consumable', membership: 2,
        display: { title: '2 LIFETIME MEMBERSHIPS', buyButton: 'GET 2 MEMBERSHIPS', buyDescription: 'One-time payment. No renewals.', description: 'Only -- per member', descriptionAlt: 'Only -- per member', tagText: '', isBigCard: false, icon: 'pro.outline', alert: alert('2 Memberships Unlocked', 'Give lifetime access to someone special') },
      },
      {
        productId: 'fitanalytica.groups.lifetime.29', kind: 'groups', billingType: 'consumable', membership: 1,
        display: { title: '1 LIFETIME MEMBERSHIP', buyButton: 'GET LIFETIME ACCESS', buyDescription: 'One-time payment. No renewals.', description: 'Just for you', descriptionAlt: 'Just for you', tagText: '', isBigCard: false, icon: 'pro.outline', alert: alert('Membership Unlocked', "You've unlocked 1 membership code to share") },
      },
    ],
  },
  streak: {
    primaryTitle: 'Protect Your Streak',
    secondaryTitle: null,
    subtitle: 'Miss a day? Your streak stays protected.',
    howItWorks: [],
    communication: null,
    products: [
      {
        productId: 'fitanalytica.streak.19', kind: 'streak', billingType: 'consumable', frequency: 25,
        display: { title: 'STANDARD', buyButton: 'BUY NOW', buyDescription: 'Protect 25 Future Streaks', description: '25 Protection Days', descriptionAlt: '', tagText: '', isBigCard: false, icon: 'shield.check', alert: alert('+25 Protection Days', 'Added to your account') },
      },
      {
        productId: 'fitanalytica.streak.29', kind: 'streak', billingType: 'consumable', frequency: 50,
        display: { title: 'BEST VALUE', buyButton: 'BUY NOW', buyDescription: 'Protect 50 Future Streaks', description: '50 Protection Days', descriptionAlt: '', tagText: '', isBigCard: true, icon: 'shield.check', alert: alert('+50 Protection Days', 'Added to your account') },
      },
    ],
  },
};

/** The pop-up's words for a code redeemed (the words of the purchases' alerts are in the products above). */
export const REDEEM_ALERT = { header: 'Congratulations', headerColor: GREEN, showConfetti: true, title: "You're now Pro", subtitle: 'All premium features unlocked' };
