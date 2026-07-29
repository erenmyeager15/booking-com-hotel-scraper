import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import type { ProxyConfiguration } from 'apify';
import type { SearchState, ActorInput } from './types.js';
import { router, buildSearchUrl, getScrapeState } from './routes.js';
import {
  normalizeInput,
  requiresCloudProxy,
  toProxyConfigurationOptions,
} from './input.js';

const SEARCH_STARTED_EVENT = 'booking-search-started';
const PAGE_SIZE = 25;

await Actor.init();

const input = normalizeInput((await Actor.getInput<ActorInput>()) ?? {});
const isCloudRun = Boolean(process.env.APIFY_ACTOR_RUN_ID);

if (requiresCloudProxy(input.proxyConfiguration, isCloudRun)) {
  await Actor.setValue('OUTPUT', {
    status: 'invalid_proxy_configuration',
    message: 'Booking.com challenges direct Apify cloud traffic. Enable Residential proxy or provide a custom proxy URL.',
    results: 0,
  });
  throw new Error(
    'Direct Apify cloud traffic is not supported because Booking.com presents a verification challenge. '
    + 'Enable Apify Residential proxy or provide a custom proxy URL.',
  );
}

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
    maxPoolSize: 10,
    sessionOptions: {
      maxUsageCount: 10,
    },
  },
  requestHandler: router,
  maxRequestRetries: 2,
  maxSessionRotations: 2,
  retryOnBlocked: true,
  maxConcurrency: 1,
  maxRequestsPerMinute: 30,
  navigationTimeoutSecs: 45,
  requestHandlerTimeoutSecs: 90,
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
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
      ],
    },
  },
  preNavigationHooks: [
    async ({ page }, gotoOptions) => {
      gotoOptions.waitUntil = 'domcontentloaded';
      gotoOptions.timeout = 45000;

      const w = 1280 + Math.floor(Math.random() * 200);
      const h = 720 + Math.floor(Math.random() * 200);
      await page.setViewportSize({ width: w, height: h });

      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        DNT: '1',
      });

      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        const url = route.request().url();
        const isTrackingRequest = /(?:google-analytics|googletagmanager|doubleclick|facebook\.com\/tr|hotjar|clarity\.ms)/i.test(url);
        if (['image', 'media', 'font', 'stylesheet'].includes(type) || isTrackingRequest) {
          route.abort().catch(() => {});
        } else {
          route.continue().catch(() => {});
        }
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
  await Actor.setValue('OUTPUT', {
    status: 'failed_no_results',
    results: 0,
    failedRequests: failedRequestCount,
    destinationsAttempted: initialRequests.length,
    spendingLimitReached: scrapeState.spendingLimitReached,
  });
  throw new Error(`No Booking.com hotel records were charged and saved. Failed requests: ${failedRequestCount}.`);
}

if (allSearchesCompletedEmpty) {
  console.info(`Booking.com returned no matching properties for ${scrapeState.noResultDestinationCount} destination search(es).`);
}

if (scrapeState.spendingLimitReached) {
  console.warn(`Booking.com crawl stopped at the user's spending limit after ${scrapeState.chargedHotelCount} charged hotel records.`);
}

await Actor.setValue('OUTPUT', {
  status: allSearchesCompletedEmpty ? 'succeeded_no_matches' : 'succeeded',
  results: scrapeState.chargedHotelCount,
  failedRequests: failedRequestCount,
  destinationsAttempted: initialRequests.length,
  noResultDestinations: scrapeState.noResultDestinationCount,
  spendingLimitReached: scrapeState.spendingLimitReached,
});

await Actor.exit();

async function chargeDestinationSearch(): Promise<boolean> {
  const pricingInfo = Actor.getChargingManager().getPricingInfo();
  if (!pricingInfo.isPayPerEvent) return true;
  if (pricingInfo.perEventPrices[SEARCH_STARTED_EVENT] === undefined) return true;

  const chargeResult = await Actor.charge({ eventName: SEARCH_STARTED_EVENT });
  return chargeResult.chargedCount >= 1;
}
