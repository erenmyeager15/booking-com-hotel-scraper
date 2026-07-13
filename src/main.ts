import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import type { ProxyConfiguration } from 'apify';
import type { SearchState, ActorInput } from './types.js';
import { router, buildSearchUrl, getScrapeState } from './routes.js';
import { normalizeInput, toProxyConfigurationOptions } from './input.js';

const SEARCH_STARTED_EVENT = 'booking-search-started';
const PAGE_SIZE = 25;

await Actor.init();

const input = normalizeInput((await Actor.getInput<ActorInput>()) ?? {});

let proxyConfiguration: ProxyConfiguration | undefined;
try {
  proxyConfiguration = await Actor.createProxyConfiguration(
    toProxyConfigurationOptions(input.proxyConfiguration),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Booking.com proxy configuration failed: ${message}`);
}

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
    examinedCount: 0,
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
  maxConcurrency: 3,
  maxRequestsPerMinute: 30,
  navigationTimeoutSecs: 90,
  requestHandlerTimeoutSecs: 180,
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
const allSearchesCompletedEmpty = scrapeState.noResultDestinationCount === initialRequests.length
  && failedRequestCount === 0;
if (scrapeState.chargedHotelCount === 0 && !allSearchesCompletedEmpty) {
  throw new Error(`No Booking.com hotel records were charged and saved. Failed requests: ${failedRequestCount}.`);
}

if (allSearchesCompletedEmpty) {
  console.info(`Booking.com returned no matching properties for ${scrapeState.noResultDestinationCount} destination search(es).`);
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
