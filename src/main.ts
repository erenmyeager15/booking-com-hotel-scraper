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
const DETAILED_RUN_STARTED_EVENT = 'detailed-run-started';
const PAGE_SIZE = 25;

await Actor.init();

const input = normalizeInput((await Actor.getInput<ActorInput>()) ?? {});
const isCloudRun = Boolean(process.env.APIFY_ACTOR_RUN_ID);
interface SearchSource {
  destination: string;
  searchUrl?: string;
}

const searchSources: SearchSource[] = input.searchUrls.length > 0
  ? input.searchUrls.map((searchUrl, index) => ({
    destination: destinationFromSearchUrl(searchUrl) ?? `Booking.com URL ${index + 1}`,
    searchUrl,
  }))
  : input.destinations.map((destination) => ({ destination }));

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

// Fast mode can afford a bounded residential fallback because one search page yields
// many records. Detailed mode opens a page per hotel, so it stays on datacenter (or a
// user-supplied custom proxy) to keep its fixed result price sustainable.
const proxyTiers = buildProxyTiers(input.proxyConfiguration, !input.scrapeDetails);

const chargedSearches: SearchSource[] = [];
let searchChargeLimitReached = false;

if (input.scrapeDetails && !(await chargeDetailedRunSetup())) {
  await Actor.fail('Maximum cost per run was reached before detailed-mode browser setup.');
}

for (const source of searchSources) {
  const charged = await chargeDestinationSearch();
  if (!charged) {
    searchChargeLimitReached = true;
    break;
  }
  chargedSearches.push(source);
}

if (chargedSearches.length === 0) {
  await Actor.fail('Maximum cost per run was reached before starting any Booking.com search.');
}

if (searchChargeLimitReached) {
  console.warn(`Maximum cost per run reached after ${chargedSearches.length} charged search(es); only those searches will run.`);
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

  console.info(`Starting ${input.scrapeDetails ? 'detailed' : 'fast'} Booking.com scrape for ${chargedSearches.length} search source(s) using ${tier.label}.`);

  const initialRequests: SearchRequest[] = chargedSearches.map((source, sourceIndex) => {
    const state = createSearchState(source);
    return {
      url: buildSearchUrl(state),
      uniqueKey: `search:${tierIndex}:${sourceIndex}:0`,
      userData: { state },
      label: 'search',
    };
  });

  const crawler = createBrowserCrawler(proxyConfiguration);
  let httpResult = {
    chargedHotelCount: 0,
    noResultDestinationCount: 0,
    spendingLimitReached: false,
    fallbackRequests: [] as SearchRequest[],
  };

  try {
    if (input.scrapeDetails) {
      await crawler.run(initialRequests);
    } else {
      httpResult = await runHttpFastPath(initialRequests, proxyConfiguration);
      if (!httpResult.spendingLimitReached && httpResult.fallbackRequests.length > 0) {
        console.info(`Using browser fallback for ${httpResult.fallbackRequests.length} unresolved Booking.com page(s).`);
        await crawler.run(httpResult.fallbackRequests);
      }
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
  const everyDestinationReportedEmpty = noResultDestinationCount >= chargedSearches.length;
  if (chargedHotelCount > 0 || spendingLimitReached || everyDestinationReportedEmpty) break;
}

const allSearchesCompletedEmpty = noResultDestinationCount === chargedSearches.length
  && failedRequestCount === 0;
if (chargedHotelCount === 0 && !allSearchesCompletedEmpty) {
  await Actor.setValue('OUTPUT', {
    status: 'failed_no_results',
    results: 0,
    failedRequests: failedRequestCount,
    searchesAttempted: chargedSearches.length,
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
  mode: input.scrapeDetails ? 'detailed' : 'fast',
  results: chargedHotelCount,
  failedRequests: failedRequestCount,
  searchesAttempted: chargedSearches.length,
  noResultDestinations: noResultDestinationCount,
  spendingLimitReached,
});

await Actor.exit();

function createSearchState(source: SearchSource): SearchState {
  const url = source.searchUrl ? new URL(source.searchUrl) : null;
  const urlCheckIn = validDateParam(url?.searchParams.get('checkin'));
  const urlCheckOut = validDateParam(url?.searchParams.get('checkout'));
  const childrenAges = url
    ? url.searchParams.getAll('age').map(Number).filter((age) => Number.isInteger(age) && age >= 0 && age <= 17)
    : input.childrenAges;

  return {
    destination: source.destination,
    ...(source.searchUrl ? { searchUrl: source.searchUrl } : {}),
    checkIn: urlCheckIn ?? input.checkIn,
    checkOut: urlCheckOut ?? input.checkOut,
    adults: positiveIntegerParam(url?.searchParams.get('group_adults')) ?? input.adults,
    rooms: positiveIntegerParam(url?.searchParams.get('no_rooms')) ?? input.rooms,
    childrenAges,
    propertyTypes: input.propertyTypes,
    stars: input.stars,
    minReviewScore: input.minReviewScore,
    minPrice: input.minPrice,
    maxPrice: input.maxPrice,
    sortBy: input.sortBy,
    maxResults: input.maxResults,
    currency: (url?.searchParams.get('selected_currency') ?? input.currency).toUpperCase(),
    language: url?.searchParams.get('lang') ?? input.language,
    scrapeDetails: input.scrapeDetails,
    maxImages: input.maxImages,
    collectedCount: 0,
    examinedCount: 0,
    seenIds: [],
    offset: 0,
    pageSize: PAGE_SIZE,
    hasMore: true,
  };
}

function destinationFromSearchUrl(searchUrl: string): string | null {
  const destination = new URL(searchUrl).searchParams.get('ss')?.replace(/\s+/g, ' ').trim();
  return destination || null;
}

function validDateParam(value: string | null | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function positiveIntegerParam(value: string | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

async function chargeDetailedRunSetup(): Promise<boolean> {
  const pricingInfo = Actor.getChargingManager().getPricingInfo();
  if (!pricingInfo.isPayPerEvent) return true;

  // Keep builds safe during Apify's pricing-transition window. Until the new
  // event becomes active, detailed runs continue without trying to charge an
  // undefined event.
  if (pricingInfo.perEventPrices[DETAILED_RUN_STARTED_EVENT] === undefined) return true;

  const chargeResult = await Actor.charge({ eventName: DETAILED_RUN_STARTED_EVENT });
  return chargeResult.chargedCount >= 1;
}
