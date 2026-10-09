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
  resolveSearchContext,
} from './input.js';
import { initializeMonitoring, finishMonitoring, monitoringCounts, getSavedHotelCount } from './records.js';
import { restoreSearchState } from './search-state.js';
import { assertProxyAvailable, ProxyConfigurationError, proxyConfigurationProblem } from './proxy-check.js';
import { StartupGuard } from './startup.js';
import { bookingNavigationOptions } from './navigation.js';

const SEARCH_STARTED_EVENT = 'booking-search-started';
const DETAILED_RUN_STARTED_EVENT = 'detailed-run-started';
const PAGE_SIZE = 25;

const startup = new StartupGuard();
let sdkReady = false;

try {
  await startup.run('sdk_init', () => Actor.init());
  sdkReady = true;
  await runBooking();
} catch (error) {
  if (!sdkReady) {
    console.error('Booking.com SDK initialization failed before collection; no source request was started.');
    process.exit(1);
  }
  // Reporting must not consume the rest of the run if storage/API access failed.
  await new StartupGuard(10_000).run('failure_reporting', async () => {
    await finishMonitoring().catch(() => null);
    const message = error instanceof Error ? error.message : String(error);
    const existingOutput = await Actor.getValue<Record<string, unknown>>('OUTPUT').catch(() => null);
    await Actor.setValue('OUTPUT', { ...existingOutput, status: existingOutput?.status ?? (error instanceof ProxyConfigurationError ? 'invalid_proxy_configuration' : 'failed'), message, results: getSavedHotelCount(),
      hint: 'Review the dates, search URL, proxy configuration and run log. Expired dates and incomplete child ages are rejected before navigation.' });
    await Actor.fail(message);
  }, 10_000);
}
await Actor.exit();

async function runBooking(): Promise<void> {

const input = normalizeInput((await startup.run('load_input', () => Actor.getInput<ActorInput>(), 10_000)) ?? {});
// Resolve every saved URL before opening proxies, charging setup, or fetching pages.
const resolvedUrls = input.searchUrls.map(url => resolveSearchContext(url, input));
const isCloudRun = Boolean(process.env.APIFY_ACTOR_RUN_ID);
interface SearchSource {
  destination: string;
  searchUrl?: string;
}

const searchSources: SearchSource[] = input.searchUrls.length > 0
  ? resolvedUrls.map(({ searchUrl }, index) => ({
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

// Residential fallback is an explicit fast-mode choice, capped to one page. It
// can improve access but is not guaranteed to be profitable at the fixed price.
const proxyTiers = buildProxyTiers(input.proxyConfiguration, !input.scrapeDetails && input.allowResidentialFallback);

const chargedSearches: SearchSource[] = [];
let searchChargeLimitReached = false;

for (const source of searchSources) {
  const charged = await startup.run('search_budget', chargeDestinationSearch, 10_000);
  if (!charged) {
    searchChargeLimitReached = true;
    break;
  }
  chargedSearches.push(source);
}

if (chargedSearches.length === 0) {
  await Actor.setValue('OUTPUT', { status: 'stopped_charge_limit', results: 0, spendingLimitReached: true,
    message: 'Maximum charge was reached before starting any Booking.com search.' });
  return;
}

if (searchChargeLimitReached) {
  console.warn(`Maximum cost per run reached after ${chargedSearches.length} charged search(es); only those searches will run.`);
}

let failedRequestCount = 0;
let chargedHotelCount = 0;
let noResultDestinationCount = 0;
let spendingLimitReached = false;
let finalStates: SearchState[] = [];
let monitoringInitialized = false;

// Retry another tier only when explicitly enabled and nothing was saved. Never
// restart productive searches on a costlier tier just to disguise partial coverage.
for (const [tierIndex, tier] of proxyTiers.entries()) {
  if (tierIndex > 0) {
    console.warn(`No Booking.com properties were collected using ${proxyTiers[tierIndex - 1].label}; retrying with ${tier.label}.`);
    resetNoResultDestinations();
  }

  let proxyConfiguration: ProxyConfiguration | undefined;
  try {
    // Only startup uses the global guard. A later explicitly opted-in proxy tier
    // gets its own bounded setup window after the prior crawl has finished.
    const setup = tierIndex === 0 ? startup : new StartupGuard(35_000);
    proxyConfiguration = await setup.run('proxy_setup', () => Actor.createProxyConfiguration(tier.options), 20_000);
    await setup.run('proxy_preflight', () => assertProxyAvailable(proxyConfiguration, 'countryCode' in tier.options ? tier.options.countryCode : undefined), 12_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (tierIndex < proxyTiers.length - 1) {
      console.warn(`Could not configure ${tier.label}: ${message}. Trying the next proxy option.`);
      continue;
    }
    throw new ProxyConfigurationError(`Booking.com proxy configuration failed: ${message}`);
  }

  if (!monitoringInitialized) {
    await startup.run('history_setup', () => initializeMonitoring(input), 15_000);
    monitoringInitialized = true;
  }
  if (input.scrapeDetails && !(await startup.run('detail_budget', chargeDetailedRunSetup, 10_000))) {
    await Actor.setValue('OUTPUT', { status: 'stopped_charge_limit', results: 0, spendingLimitReached: true,
      message: 'Maximum charge was reached before detailed-mode browser setup.' });
    return;
  }

  console.info(`Starting ${input.scrapeDetails ? 'detailed' : 'fast'} Booking.com scrape for ${chargedSearches.length} search source(s) using ${tier.label}.`);
  failedRequestCount = 0;
  finalStates = [];

  const initialRequests: SearchRequest[] = chargedSearches.map((source, sourceIndex) => {
    const state = restoreSearchState(createSearchState(source, `${tierIndex}:${sourceIndex}`));
    if ('groups' in tier.options && tier.options.groups?.includes('RESIDENTIAL')) state.maxPages = 1;
    finalStates.push(state);
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
    proxyError: null as string | null,
  };

  try {
    if (input.scrapeDetails) {
      await crawler.run(initialRequests);
    } else {
      httpResult = await runHttpFastPath(initialRequests, proxyConfiguration);
      if (httpResult.proxyError) throw new ProxyConfigurationError(httpResult.proxyError);
      if (!httpResult.spendingLimitReached && httpResult.fallbackRequests.length > 0) {
        console.info(`Using browser fallback for ${httpResult.fallbackRequests.length} unresolved Booking.com page(s).`);
        await crawler.run(httpResult.fallbackRequests);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Crawler failed: ${message}`);
    if (getSavedHotelCount() > 0) { chargedHotelCount = getSavedHotelCount(); failedRequestCount++; break; }
    if (tierIndex >= proxyTiers.length - 1) throw err;
    continue;
  }

  const scrapeState = getScrapeState();
  chargedHotelCount = getSavedHotelCount();
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
if (chargedHotelCount === 0 && !allSearchesCompletedEmpty && !spendingLimitReached) {
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

await finishMonitoring();
for (const state of finalStates) {
  if (state.coverage?.status === 'pending') {
    state.coverage.status = spendingLimitReached ? 'limited' : 'failed';
    state.coverage.reason = spendingLimitReached ? 'spending_limit' : 'incomplete_search';
  }
}

if (spendingLimitReached) {
  console.warn(`Booking.com crawl stopped at the user's spending limit after ${chargedHotelCount} charged hotel records.`);
}

await Actor.setValue('OUTPUT', {
  status: allSearchesCompletedEmpty ? 'succeeded_no_matches' : failedRequestCount > 0 || finalStates.some(s => s.coverage?.status === 'failed') ? 'partial' : 'succeeded',
  mode: input.scrapeDetails ? 'detailed' : 'fast',
  results: chargedHotelCount,
  failedRequests: failedRequestCount,
  searchesAttempted: chargedSearches.length,
  noResultDestinations: noResultDestinationCount,
  spendingLimitReached,
  searchCoverage: finalStates.map(s => ({ destination: s.destination, checkIn: s.checkIn, checkOut: s.checkOut,
    ...s.coverage, savedOrQueued: s.collectedCount, maxPages: s.maxPages })),
  monitoring: { enabled: input.trackChanges, ...monitoringCounts,
    note: 'Missing hotels are not inferred to be sold out. Comparisons refer to the displayed hotel offer, not a guaranteed identical room or bookable final price.' },
});


function createSearchState(source: SearchSource, requestNamespace: string): SearchState {
  const url = source.searchUrl ? new URL(source.searchUrl) : null;
  const resolved = source.searchUrl ? resolveSearchContext(source.searchUrl, input) : null;
  const urlCheckIn = resolved?.checkIn;
  const urlCheckOut = resolved?.checkOut;
  const childrenAges = url
    ? url.searchParams.getAll('age').map(Number).filter((age) => Number.isInteger(age) && age >= 0 && age <= 17)
    : input.childrenAges;

  return {
    destination: source.destination,
    requestNamespace,
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
    maxPages: input.maxPagesPerSearch,
    coverage: { status: 'pending', successfulPages: 0, reason: null },
  };
}

function destinationFromSearchUrl(searchUrl: string): string | null {
  const destination = new URL(searchUrl).searchParams.get('ss')?.replace(/\s+/g, ' ').trim();
  return destination || null;
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
    maxRequestRetries: 1,
    maxSessionRotations: 1,
    errorHandler: async ({ request }, error) => {
      if (proxyConfigurationProblem(error)) request.noRetry = true;
    },
    retryOnBlocked: true,
    maxConcurrency: 1,
    maxRequestsPerMinute: 30,
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 90,
    maxRequestsPerCrawl: 2000,
    failedRequestHandler: async ({ request, log }, error) => {
      failedRequestCount++;
      const state = restoreSearchState(request.userData.state as SearchState);
      if (state?.coverage) { state.coverage.status = 'failed'; state.coverage.reason = request.label === 'detail' ? 'detail_request_failed' : 'search_request_failed'; }
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
      async ({ page }, gotoOptions) => {
        Object.assign(gotoOptions, bookingNavigationOptions());
        const w = 1280 + Math.floor(Math.random() * 200);
        const h = 720 + Math.floor(Math.random() * 200);
        await page.setViewportSize({ width: w, height: h });

        await page.setExtraHTTPHeaders({
          'Accept-Language': 'en-US,en;q=0.9',
        });

        await page.route('**/*', (route) => {
          const type = route.request().resourceType();
          // Keep styles: Booking's lazy-load observer needs real layout.
          // Dropping CSS can leave an incomplete first batch.
          if (['image', 'media', 'font'].includes(type)) {
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
