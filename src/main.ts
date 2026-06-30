import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import type { ProxyConfiguration } from 'apify';
import type { SearchState, ActorInput } from './types.js';
import { router, buildSearchUrl, getScrapeState } from './routes.js';
import { normalizeInput } from './input.js';

const SEARCH_STARTED_EVENT = 'booking-search-started';
const PAGE_SIZE = 25;

await Actor.init();

const input = normalizeInput((await Actor.getInput<ActorInput>()) ?? {});

const initialRequests: Array<{ url: string; userData: { state: SearchState }; label: string }> = [];
let searchChargeLimitReached = false;

for (const destination of input.destinations) {
  const charged = await chargeDestinationSearch();
  if (!charged) {
    searchChargeLimitReached = true;
    break;
  }

  const state: SearchState = {
    destination,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    adults: input.adults,
    rooms: input.rooms,
    propertyTypes: input.propertyTypes,
    minReviewScore: input.minReviewScore,
    maxResults: input.maxResults,
    currency: input.currency,
    collectedCount: 0,
    seenIds: [],
    offset: 0,
    pageSize: PAGE_SIZE,
    hasMore: true,
  };

  const url = buildSearchUrl(state);
  initialRequests.push({ url, userData: { state }, label: 'search' });
}

if (initialRequests.length === 0) {
  await Actor.fail('Maximum cost per run was reached before starting any Booking.com destination search.');
}

if (searchChargeLimitReached) {
  console.warn(`Maximum cost per run reached after ${initialRequests.length} charged destination search(es); only those searches will run.`);
}

let proxyConfiguration: ProxyConfiguration | undefined;
try {
  proxyConfiguration = await Actor.createProxyConfiguration({
    useApifyProxy: input.proxyConfiguration?.useApifyProxy ?? true,
    groups: input.proxyConfiguration?.apifyProxyGroups ?? ['RESIDENTIAL'],
  });
} catch {
  proxyConfiguration = undefined;
}

let failedRequestCount = 0;

const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  useSessionPool: true,
  persistCookiesPerSession: true,
  sessionPoolOptions: {
    maxPoolSize: 100,
    sessionOptions: {
      maxUsageCount: 30,
    },
  },
  requestHandler: router,
  maxRequestRetries: 3,
  maxSessionRotations: 3,
  retryOnBlocked: true,
  navigationTimeoutSecs: 60,
  requestHandlerTimeoutSecs: 120,
  maxRequestsPerCrawl: 2000,
  failedRequestHandler: async ({ request, log }, error) => {
    failedRequestCount++;
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Booking.com request failed after retries: ${request.url}`, { error: message });
  },
  launchContext: {
    launchOptions: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    },
  },
  preNavigationHooks: [
    async ({ page }) => {
      const w = 1280 + Math.floor(Math.random() * 200);
      const h = 720 + Math.floor(Math.random() * 200);
      await page.setViewportSize({ width: w, height: h });

      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Sec-Ch-Ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      });
    },
  ],
});

try {
  await crawler.run(initialRequests);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Crawler failed: ${message}`);
  throw err;
}

const scrapeState = getScrapeState();
if (scrapeState.chargedHotelCount === 0) {
  throw new Error(`No Booking.com hotel records were charged and saved. Failed requests: ${failedRequestCount}.`);
}

if (scrapeState.spendingLimitReached) {
  console.warn(`Booking.com crawl stopped at the user's spending limit after ${scrapeState.chargedHotelCount} charged hotel records.`);
}

await Actor.exit();

async function chargeDestinationSearch(): Promise<boolean> {
  const pricingInfo = Actor.getChargingManager().getPricingInfo();
  if (!pricingInfo.isPayPerEvent) return true;
  if (pricingInfo.perEventPrices[SEARCH_STARTED_EVENT] === undefined) return true;

  const chargeResult = await Actor.charge({ eventName: SEARCH_STARTED_EVENT });
  return chargeResult.chargedCount >= 1;
}
