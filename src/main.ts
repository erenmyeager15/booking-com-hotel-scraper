import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import type { ProxyConfiguration } from 'apify';
import type { SearchState, ActorInput } from './types.js';
import { router, buildSearchUrl, getScrapeState, resetNoResultDestinations } from './routes.js';
import { runHttpFastPath, type SearchRequest } from './http-fast-path.js';
import {
  normalizeInput,
  requiresCloudProxy,
  buildProxyTiers,
} from './input.js';

const SEARCH_STARTED_EVENT = 'booking-search-started';
const PAGE_SIZE = 25;

await Actor.init();

const input = normalizeInput((await Actor.getInput<ActorInput>()) ?? {});
const isCloudRun = Boolean(process.env.APIFY_ACTOR_RUN_ID);

if (requiresCloudProxy(input.proxyConfiguration, isCloudRun)) {
  await Actor.setValue('OUTPUT', {
    status: 'invalid_proxy_configuration',
    message: 'Booking.com challenges direct Apify cloud traffic. Keep Apify Proxy enabled or provide a custom proxy URL.',
    results: 0,
  });
  throw new Error(
    'Direct Apify cloud traffic is not supported because Booking.com presents a verification challenge. '
    + 'Keep Apify Proxy enabled or provide a custom proxy URL.',
  );
}

const proxyTiers = buildProxyTiers(input.proxyConfiguration);

const chargedDestinations: string[] = [];
let searchChargeLimitReached = false;

for (const destination of input.destinations) {
  const charged = await chargeDestinationSearch();
  if (!charged) {
    searchChargeLimitReached = true;
    break;
  }
  chargedDestinations.push(destination);
}

if (chargedDestinations.length === 0) {
  await Actor.fail('Maximum cost per run was reached before starting any Booking.com destination search.');
}

if (searchChargeLimitReached) {
  console.warn(`Maximum cost per run reached after ${chargedDestinations.length} charged destination search(es); only those searches will run.`);
}

let failedRequestCount = 0;
let chargedHotelCount = 0;
let noResultDestinationCount = 0;
let spendingLimitReached = false;

// Try each proxy tier in turn. The first tier is the cheap datacenter pool; if it
// yields nothing, the run retries on residential rather than failing, so a datacenter
// block costs money instead of costing the user their results.
for (const [tierIndex, tier] of proxyTiers.entries()) {
  if (tierIndex > 0) {
    console.warn(`No Booking.com properties were collected using ${proxyTiers[tierIndex - 1].label}; retrying with ${tier.label}.`);
    resetNoResultDestinations();
  }

  let proxyConfiguration: ProxyConfiguration | undefined;
  try {
    proxyConfiguration = await Actor.createProxyConfiguration(tier.options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (tierIndex < proxyTiers.length - 1) {
      console.warn(`Could not configure ${tier.label}: ${message}. Trying the next proxy option.`);
      continue;
    }
    throw new Error(`Booking.com proxy configuration failed: ${message}`);
  }

  console.info(`Starting Booking.com search for ${chargedDestinations.length} destination(s) using ${tier.label}.`);

  const initialRequests: SearchRequest[] = chargedDestinations.map((destination) => {
    const state = createSearchState(destination);
    return {
      url: buildSearchUrl(state),
      uniqueKey: `http:${tierIndex}:${destination}:0`,
      userData: { state },
      label: 'search',
    };
  });

  const httpResult = await runHttpFastPath(initialRequests, proxyConfiguration);
  const crawler = createBrowserCrawler(proxyConfiguration);

  try {
    if (!httpResult.spendingLimitReached && httpResult.fallbackRequests.length > 0) {
      console.info(`Using browser fallback for ${httpResult.fallbackRequests.length} unresolved Booking.com page(s).`);
      await crawler.run(httpResult.fallbackRequests);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Crawler failed: ${message}`);
    if (tierIndex >= proxyTiers.length - 1) throw err;
    continue;
  }

  const scrapeState = getScrapeState();
  chargedHotelCount = httpResult.chargedHotelCount + scrapeState.chargedHotelCount;
  noResultDestinationCount = httpResult.noResultDestinationCount + scrapeState.noResultDestinationCount;
  spendingLimitReached = httpResult.spendingLimitReached || scrapeState.spendingLimitReached;

  // Stop once records were collected, the user's limit was hit, or Booking.com
  // genuinely reported every destination as empty. Only an unproductive, unexplained
  // attempt is worth paying for a second time on a different proxy tier.
  const everyDestinationReportedEmpty = noResultDestinationCount >= chargedDestinations.length;
  if (chargedHotelCount > 0 || spendingLimitReached || everyDestinationReportedEmpty) break;
}

const allSearchesCompletedEmpty = noResultDestinationCount === chargedDestinations.length
  && failedRequestCount === 0;
if (chargedHotelCount === 0 && !allSearchesCompletedEmpty) {
  await Actor.setValue('OUTPUT', {
    status: 'failed_no_results',
    results: 0,
    failedRequests: failedRequestCount,
    destinationsAttempted: chargedDestinations.length,
    spendingLimitReached,
  });
  throw new Error(`No Booking.com hotel records were charged and saved. Failed requests: ${failedRequestCount}.`);
}

if (allSearchesCompletedEmpty) {
  console.info(`Booking.com returned no matching properties for ${noResultDestinationCount} destination search(es).`);
}

if (spendingLimitReached) {
  console.warn(`Booking.com crawl stopped at the user's spending limit after ${chargedHotelCount} charged hotel records.`);
}

await Actor.setValue('OUTPUT', {
  status: allSearchesCompletedEmpty ? 'succeeded_no_matches' : 'succeeded',
  results: chargedHotelCount,
  failedRequests: failedRequestCount,
  destinationsAttempted: chargedDestinations.length,
  noResultDestinations: noResultDestinationCount,
  spendingLimitReached,
});

await Actor.exit();

function createSearchState(destination: string): SearchState {
  return {
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
}

function createBrowserCrawler(proxyConfiguration: ProxyConfiguration | undefined): PlaywrightCrawler {
  return new PlaywrightCrawler({
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

        await page.route('**/*', (route) => {
          const type = route.request().resourceType();
          if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
            route.abort().catch(() => {});
          } else {
            route.continue().catch(() => {});
          }
        });
      },
    ],
  });
}

async function chargeDestinationSearch(): Promise<boolean> {
  const pricingInfo = Actor.getChargingManager().getPricingInfo();
  if (!pricingInfo.isPayPerEvent) return true;
  if (pricingInfo.perEventPrices[SEARCH_STARTED_EVENT] === undefined) return true;

  const chargeResult = await Actor.charge({ eventName: SEARCH_STARTED_EVENT });
  return chargeResult.chargedCount >= 1;
}
