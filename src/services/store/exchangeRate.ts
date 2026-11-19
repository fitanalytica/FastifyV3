// docs/data/api.md section 15. `payments.convert_rate`: how many units of a purchase's currency make one US dollar, as the old app stored it (a free currency list, rounded to 2 decimals;
// 1 for USD, for a currency not on the list and when the list cannot be reached, so a purchase is never held up by it). The list is kept for 6 hours (it is a daily list), and a failed
// fetch is not tried again for 5 minutes. It is fetched BEFORE the purchase's transaction starts: no lock or connection waits on the network.
const URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';
const KEEP_MS = 6 * 3600 * 1000;
const RETRY_MS = 5 * 60 * 1000;

type Rates = Record<string, number>;
type Fetcher = () => Promise<Rates>;

const download: Fetcher = async () => {
  const r = await fetch(URL, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`exchange rates: ${r.status}`);
  return ((await r.json()) as { usd: Rates }).usd;
};

let fetcher: Fetcher = download;
let held: { rates: Rates; at: number } | undefined;
let failedAt = 0;

/** A test replaces the download (nothing may reach the internet in a test); call with no argument to put the real one back. It also forgets what was kept. */
export function setExchangeFetcher(f?: Fetcher): void {
  fetcher = f ?? download;
  held = undefined;
  failedAt = 0;
}

export async function exchangeRate(currency: string | undefined, now: number = Date.now()): Promise<number> {
  const code = currency?.trim().toLowerCase();
  if (!code || code === 'usd') return 1;
  if (!held || now - held.at >= KEEP_MS) {
    if (now - failedAt >= RETRY_MS) {
      try {
        held = { rates: await fetcher(), at: now };
      } catch {
        failedAt = now;
      }
    }
  }
  const rate = held?.rates[code];
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? parseFloat(rate.toFixed(2)) : 1;
}
