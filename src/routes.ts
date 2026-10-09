import { createPlaywrightRouter, SessionError } from 'crawlee';
import { Actor } from 'apify';
import type { Page } from 'playwright';
import type { DetailRequestData, HotelRecord, SearchState } from './types.js';
import { PROPERTY_TYPE_HT_IDS } from './types.js';
import { enrichHotelRecord, extractBookingDetails } from './details.js';
import { parseMoney } from './money.js';
export { parseMoney } from './money.js';
import { addRateEvidence } from './rate-evidence.js';
import { pushHotelRecord } from './records.js';
import { restoreSearchState } from './search-state.js';
import { restoreSearchShell, searchRedirectDiagnostic } from './navigation.js';
import { assessSearchEvidence, browserSearchFields } from './search-evidence.js';
import { PROPERTY_CARD_SELECTOR, hydratePropertyCards, reportedPropertyCount } from './property-cards.js';

export const router = createPlaywrightRouter();
const HOTEL_SCRAPED_EVENT = 'hotel-scraped';
const DETAILED_HOTEL_SCRAPED_EVENT = 'detailed-hotel-scraped';
export const MAX_PAGES_PER_DESTINATION = 40;

export type BookingDocumentState = 'normal' | 'blocked' | 'no-results' | 'unavailable';
export type PageProgressAction = 'next' | 'stop' | 'retry';

export function searchRequestKey(kind: 'http' | 'browser', state: SearchState): string {
  return `${kind}:${state.requestNamespace ?? state.destination}:${state.offset}`;
}

export function hasSearchContext(currentUrl: string, state: SearchState): boolean {
  try {
    const current = new URL(currentUrl);
    if (current.protocol !== 'https:' || !['www.booking.com', 'booking.com'].includes(current.hostname)
      || current.username || current.password) return false;
    const expected = state.searchUrl ? new URL(state.searchUrl) : new URL(buildSearchUrl(state));
    const destination = expected.searchParams.get('ss');
    if (destination) {
      if (current.searchParams.get('ss')?.trim().toLowerCase() !== destination.trim().toLowerCase()) return false;
    } else {
      const destinationId = expected.searchParams.get('dest_id');
      if (!destinationId || current.searchParams.get('dest_id') !== destinationId) return false;
    }
    for (const key of ['dest_id', 'dest_type']) {
      if (expected.searchParams.has(key) && current.searchParams.get(key) !== expected.searchParams.get(key)) return false;
    }
    return current.searchParams.get('checkin') === state.checkIn && current.searchParams.get('checkout') === state.checkOut
      && current.searchParams.get('group_adults') === String(state.adults)
      && current.searchParams.get('no_rooms') === String(state.rooms)
      && (current.searchParams.get('group_children') ?? '0') === String((state.childrenAges ?? []).length)
      && current.searchParams.getAll('age').join(',') === (state.childrenAges ?? []).join(',')
      && current.searchParams.get('selected_currency')?.toUpperCase() === state.currency;
  } catch {
    return false;
  }
}

export function hasUsableStayPrice(record: Pick<HotelRecord, 'totalPrice' | 'pricePerNight'>): boolean {
  return (record.totalPrice !== null && record.totalPrice > 0)
    || (record.pricePerNight !== null && record.pricePerNight > 0);
}

export interface PropertyCardSnapshot {
  href: string | null;
  propertyId: string | null;
  hotelName: string | null;
  cardText: string | null;
  taxText?: string | null;
  totalText: string | null;
  perNightText: string | null;
  originalText: string | null;
  rateInfo: string | null;
  reviewScoreAria: string | null;
  reviewScoreText: string | null;
  reviewScoreLinkText: string | null;
  starLabel: string | null;
  distanceText: string | null;
  thumbnailSrc: string | null;
}

export function classifyBookingDocument(
  title: string,
  bodyText: string,
  hasChallengeElement = false,
): BookingDocumentState {
  const text = `${title} ${bodyText}`.toLowerCase();
  if (
    hasChallengeElement
    || /verify (?:that )?you are (?:a )?(?:human|robot)|verify you're human|not a robot|robot check|captcha/.test(text)
    || /access denied|unusual traffic|security check|automated requests/.test(text)
  ) return 'blocked';

  // Booking can serve its own error page with HTTP 202. This is neither hotel
  // availability nor evidence of bot blocking. Skip all card/price waits.
  if (/something went wrong on our end/.test(text)
    && /error code:\s*50[0234]\b/.test(text)) return 'unavailable';

  if (
    // HTML text extraction can concatenate a preceding button label with "0".
    // Exclude numeric prefixes, not all word prefixes, to keep a genuine zero
    // count recognizable without matching the tail of "100 properties found".
    /\b(?:no properties found|no results found)\b|(?<![\d.,])0 properties (?:found|are available)\b/.test(text)
    || /we (?:couldn't|could not) find any properties|nothing matches your search/.test(text)
    || /no availability for (?:your|these) dates/.test(text)
  ) return 'no-results';

  return 'normal';
}

export function decidePageProgress(input: {
  cardCount: number;
  extractedCount: number;
  newCount: number;
  duplicateCount: number;
  filteredCount: number;
  offset: number;
  pageSize: number;
  hasNextPage?: boolean;
}): PageProgressAction {
  if (input.extractedCount === 0) return 'retry';

  const currentPage = Math.floor(input.offset / input.pageSize) + 1;
  if (currentPage >= MAX_PAGES_PER_DESTINATION) return 'stop';
  if (input.cardCount < input.pageSize && !input.hasNextPage) return 'stop';

  const onlyDuplicates = input.newCount === 0
    && input.duplicateCount > 0
    && input.filteredCount === 0;
  if (onlyDuplicates) return 'stop';

  return 'next';
}

let chargedHotelCount = 0;
let spendingLimitReached = false;
const noResultDestinations = new Set<string>();
const queuedDetailKeys = new Set<string>();

export function getScrapeState() {
  return {
    chargedHotelCount,
    spendingLimitReached,
    noResultDestinationCount: noResultDestinations.size,
  };
}

/**
 * Clears the per-attempt "no results" set before another proxy tier is tried, so a
 * destination that only looked empty because the previous tier was blocked is not
 * reported as genuinely empty. Charge counters stay cumulative because they reflect
 * real charges already made.
 */
export function resetNoResultDestinations(): void {
  noResultDestinations.clear();
}

router.addHandler('detail', async ({ page, request, crawler, session, log }) => {
  const data = request.userData as DetailRequestData;
  const record = data.record;
  const state = restoreSearchState(data.state);

  if (spendingLimitReached) {
    request.noRetry = true;
    return;
  }

  const initialDetailState = await inspectPropertyPageAfterChallengeGrace(page);
  if (initialDetailState === 'unavailable') throw new Error('BOOKING_SOURCE_UNAVAILABLE: property error page');
  if (initialDetailState === 'blocked') {
    session?.retire();
    throw new SessionError(`BOOKING_DETAIL_BLOCKED: ${record.propertyId}`);
  }

  await handleCookieConsent(page);
  const detailDocumentState = await inspectBookingPage(page);
  if (detailDocumentState === 'unavailable') throw new Error('BOOKING_SOURCE_UNAVAILABLE: property error page');
  if (detailDocumentState === 'blocked') {
    session?.retire();
    throw new SessionError(`BOOKING_DETAIL_BLOCKED_AFTER_INTERACTION: ${record.propertyId}`);
  }

  await page.waitForSelector([
    'h2[data-testid="title"]',
    'h1[data-testid="title"]',
    '#hp_hotel_name',
    '#hprt-table',
  ].join(','), { timeout: 15000 }).catch(() => null);

  const snapshot = await extractBookingDetails(page, state.maxImages ?? 10);
  const enrichedRecord: HotelRecord = {
    ...enrichHotelRecord(record, snapshot, state.maxImages ?? 10),
    billingTier: 'detailed-datacenter',
  };
  if (!snapshot.title && !snapshot.address && snapshot.roomRows.length === 0 && snapshot.facilities.length === 0) {
    throw new Error('BOOKING_DETAIL_CONTENT_MISSING');
  }
  const chargeResult = await pushHotelRecord(enrichedRecord, detailedResultEvent());
  const recordWasSaved = chargeResult.chargedCount > 0 || !chargeResult.eventChargeLimitReached;

  if (!recordWasSaved) {
    spendingLimitReached = true;
    await crawler.autoscaledPool?.abort();
    return;
  }

  chargedHotelCount++;
  log.info(`Saved detailed property ${record.hotelName ?? record.propertyId} with ${enrichedRecord.roomOptions.length} room option(s).`);

  if (chargeResult.eventChargeLimitReached) {
    spendingLimitReached = true;
    await crawler.autoscaledPool?.abort();
  }
});

router.addDefaultHandler(async ({ page, request, crawler, session, log }) => {
  const state = restoreSearchState(request.userData.state as SearchState);

  if (spendingLimitReached) {
    request.noRetry = true;
    log.info('Charge limit already reached; skipping remaining Booking.com requests.');
    return;
  }

  if (!state.hasMore) {
    log.info(`No more pages for "${state.destination}" - hasMore=false`);
    return;
  }

  log.info(`Page offset=${state.offset} for "${state.destination}" (${state.collectedCount}/${state.maxResults})`);

  const initialDocumentState = await inspectBookingPageAfterChallengeGrace(page);
  if (initialDocumentState === 'unavailable') throw new Error('BOOKING_SOURCE_UNAVAILABLE: search error page');
  if (initialDocumentState === 'blocked') {
    session?.retire();
    throw new SessionError(`BOOKING_BLOCKED: ${state.destination} offset ${state.offset}`);
  }

  try {
    if (await restoreSearchShell(page, request.url, initialDocumentState, request.userData)) {
      log.info('Restored the requested search once after a same-site context-losing redirect.');
    }
  } catch (error) {
    // Do not multiply context-restoration attempts through Crawlee retries.
    request.noRetry = true;
    // Crawlee's request.loadedUrl is captured before this handler. An inner
    // page.goto() may redirect again without updating it; record the current
    // route anonymously rather than diagnosing from that stale URL.
    log.warning('Booking search restoration failed; retained hotels are not charged again.', {
      ...searchRedirectDiagnostic(page.url()),
      restorationAttempted: request.userData.bookingSearchShellRestoreAttempted === true,
      retainedHotels: state.collectedCount,
    });
    throw error;
  }

  await handleCookieConsent(page);

  const searchDocumentState = await inspectBookingPage(page);
  if (searchDocumentState === 'unavailable') throw new Error('BOOKING_SOURCE_UNAVAILABLE: search error page');
  if (searchDocumentState === 'blocked') {
    session?.retire();
    throw new SessionError(`BOOKING_BLOCKED_AFTER_INTERACTION: ${state.destination} offset ${state.offset}`);
  }

  // Search controls vary between Booking layouts and may be read-only or hidden.
  // Do not make editing that form a prerequisite for collecting priced cards.
  // Assess the rendered stay after hydration: contradictions are rejected and
  // incomplete evidence disables rate comparisons, not ordinary collection.
  if (!hasSearchContext(page.url(), state)) {
    log.warning('Booking search URL context was not retained.', searchRedirectDiagnostic(page.url()));
    request.noRetry = true;
    throw new Error('BOOKING_SEARCH_CONTEXT_MISMATCH: loaded search does not match the requested stay and guests');
  }
  const readSearchEvidence = async () => {
    const evidence = assessSearchEvidence(await browserSearchFields(page), state);
    if (evidence.status === 'mismatch') {
      request.noRetry = true;
      throw new Error(`BOOKING_RENDERED_SEARCH_MISMATCH: ${evidence.reason}`);
    }
    return hasSearchContext(page.url(), state) && evidence.status === 'confirmed';
  };

  try {
    await page.waitForSelector(propertyCardSelector(), { timeout: 18000 });
  } catch {
    const documentState = await inspectBookingPage(page);
    if (documentState === 'unavailable') throw new Error('BOOKING_SOURCE_UNAVAILABLE: search error page');
    if (documentState === 'blocked') {
      session?.retire();
      throw new SessionError(`BOOKING_BLOCKED_WHILE_WAITING: ${state.destination} offset ${state.offset}`);
    }
    // Allow hydration to finish before rejecting a form initially rendered with defaults.
    const searchVerified = await readSearchEvidence();
    if (documentState === 'no-results' && searchVerified) {
      if (state.coverage) { state.coverage.status = state.collectedCount ? 'complete' : 'empty'; state.coverage.reason = null; }
      markNoResultIfComplete(state);
      log.info(`No more Booking.com properties at offset ${state.offset} for "${state.destination}".`);
      state.hasMore = false;
      return;
    }
    session?.retire();
    throw new Error(`PROPERTY_CARDS_NOT_RENDERED: ${state.destination} offset ${state.offset}`);
  }

  await randomDelay(page, 100, 300);

  const cards = page.locator(propertyCardSelector());
  const cardCount = await hydratePropertyCards(page, Math.min(state.pageSize, state.maxResults));
  log.info(`Found ${cardCount} cards`);

  if (cardCount === 0) {
    const documentState = await inspectBookingPage(page);
    if (documentState === 'unavailable') throw new Error('BOOKING_SOURCE_UNAVAILABLE: search error page');
    if (documentState === 'blocked') {
      session?.retire();
      throw new SessionError(`BOOKING_BLOCKED_EMPTY_CARDS: ${state.destination} offset ${state.offset}`);
    }
    if (documentState === 'no-results' && await readSearchEvidence()) {
      if (state.coverage) { state.coverage.status = state.collectedCount ? 'complete' : 'empty'; state.coverage.reason = null; }
      markNoResultIfComplete(state);
      state.hasMore = false;
      return;
    }
    session?.retire();
    throw new Error(`EMPTY_PROPERTY_CARD_SET: ${state.destination} offset ${state.offset}`);
  }

  // Some Booking responses hydrate hotel names before rates. Do not charge for
  // a whole page of price-less cards when the advertised data is still missing.
  if (!state.scrapeDetails) {
    await page.waitForSelector(
      '[data-testid="price-and-discounted-price"], [data-testid="price-for-x-nights"]',
      { timeout: 7000 },
    ).catch(() => null);
  }

  // Read every visible card in one browser round trip. Field-by-field Locator
  // calls become expensive across large result pages, especially when an
  // optional field is absent and waits for its timeout.
  const searchVerified = await readSearchEvidence();
  const cardSnapshots = await cards.evaluateAll((elements) => {
    const text = (root: Element, selector: string): string | null =>
      root.querySelector(selector)?.textContent ?? null;
    const attr = (root: Element, selector: string, name: string): string | null =>
      root.querySelector(selector)?.getAttribute(name) ?? null;
    const firstText = (root: Element, selectors: string[]): string | null => {
      for (const selector of selectors) {
        const value = text(root, selector);
        if (value) return value;
      }
      return null;
    };
    const firstAttr = (root: Element, selectors: string[], name: string): string | null => {
      for (const selector of selectors) {
        const value = attr(root, selector, name);
        if (value) return value;
      }
      return null;
    };

    return elements.map((root) => ({
      href: firstAttr(root, [
        'a[data-testid="title-link"]',
        'a[data-testid="property-card-desktop-single-image"]',
        'a[href*="/hotel/"]',
      ], 'href'),
      propertyId: root.getAttribute('data-property-id'),
      hotelName: firstText(root, [
        '[data-testid="title"]',
        '[data-testid="property-card-title"]',
      ]),
      cardText: root.textContent,
      taxText: Array.from(root.querySelectorAll('[data-testid="taxes-and-charges"], [data-testid="taxes-and-fees"]'))
        .map(element => `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`).join(' ').trim() || null,
      totalText: firstText(root, [
        '[data-testid="price-and-discounted-price"]',
        '[data-testid="price-for-x-nights"]',
      ]),
      perNightText: firstText(root, [
        '[data-testid="price-per-night"]',
        '[data-testid*="per-night"]',
      ]),
      originalText: firstText(root, [
        '[data-testid="price-for-x-nights"] [data-testid*="original"]',
        '[data-testid*="strikethrough"]',
        '[data-testid*="original-price"]',
      ]),
      rateInfo: text(root, '[data-testid="availability-rate-information"]'),
      reviewScoreAria: attr(root, '[data-testid="review-score"]', 'aria-label'),
      reviewScoreText: text(root, '[data-testid="review-score"]'),
      reviewScoreLinkText: text(root, '[data-testid="review-score-link"]'),
      starLabel: attr(root, '[aria-label*="out of 5"]', 'aria-label'),
      distanceText: text(root, '[data-testid="distance"]'),
      thumbnailSrc: firstAttr(root, [
        'img[data-testid="image"]',
        'img[data-testid*="thumbnail"]',
        'img',
      ], 'src'),
    }));
  });

  if (!state.scrapeDetails && !cardSnapshots.some((snapshot) =>
    parseMoney(snapshot.totalText) !== null || parseMoney(snapshot.perNightText) !== null
  )) {
    log.warning('Booking.com returned property cards without any stay prices; trying the next proxy tier.', {
      loadedUrl: page.url(),
      firstCardText: cardSnapshots[0]?.cardText?.slice(0, 300) ?? null,
    });
    session?.retire();
    request.noRetry = true;
    throw new Error(`BOOKING_PRICES_NOT_RENDERED: ${state.destination} offset ${state.offset}`);
  }

  let newOnPage = 0;
  let extractedOnPage = 0;
  let duplicateOnPage = 0;
  let filteredOnPage = 0;
  if (state.coverage) state.coverage.successfulPages++;

  for (const snapshot of cardSnapshots) {
    if (state.collectedCount >= state.maxResults) {
      log.info(`Reached maxResults ${state.maxResults}`);
      if (state.coverage) { state.coverage.status = 'limited'; state.coverage.reason = 'max_results'; }
      state.hasMore = false;
      return;
    }

    const extracted = extractPropertyFromSnapshot(snapshot, state);
    const record = extracted ? addRateEvidence(extracted, state, snapshot.totalText, snapshot.perNightText, snapshot.cardText ?? '', searchVerified, snapshot.taxText) : null;

    if (!record?.propertyId) continue;
    if (!state.scrapeDetails && !hasUsableStayPrice(record)) continue;
    extractedOnPage++;

    if (state.seenIds.includes(record.propertyId)) {
      duplicateOnPage++;
      continue;
    }

    const passesReviewFilter = state.minReviewScore === 0
      || (record.guestReviewScore !== null && record.guestReviewScore >= state.minReviewScore);
    if (!passesReviewFilter) {
      filteredOnPage++;
      continue;
    }

    state.seenIds.push(record.propertyId);

    if (state.scrapeDetails) {
      const detailKey = buildDetailKey(record, state);
      if (queuedDetailKeys.has(detailKey)) {
        duplicateOnPage++;
        continue;
      }

      queuedDetailKeys.add(detailKey);
      state.collectedCount++;
      newOnPage++;
      await crawler.addRequests([{
        url: buildPropertyDetailUrl(record, state),
        uniqueKey: `detail:${detailKey}`,
        label: 'detail',
        userData: { record, state } satisfies DetailRequestData,
      }]);
      log.info(`[${state.collectedCount}/${state.maxResults}] queued detailed page for ${record.hotelName}`);
      continue;
    }

    const chargeResult = await pushHotelRecord(record, HOTEL_SCRAPED_EVENT);
    const recordWasSaved = chargeResult.chargedCount > 0 || !chargeResult.eventChargeLimitReached;
    if (!recordWasSaved) {
      spendingLimitReached = true;
      state.hasMore = false;
      log.warning('Stopping crawl because hotel-scraped charge was not accepted before saving another record.');
      await crawler.autoscaledPool?.abort();
      return;
    }
    chargedHotelCount++;
    state.collectedCount++;
    newOnPage++;
    log.info(`[${state.collectedCount}/${state.maxResults}] ${record.hotelName}`);

    if (chargeResult.eventChargeLimitReached) {
      spendingLimitReached = true;
      state.hasMore = false;
      log.warning('User spending limit reached; stopping after the last charged hotel record.');
      await crawler.autoscaledPool?.abort();
      return;
    }

    if (state.collectedCount >= state.maxResults) {
      log.info(`Reached maxResults ${state.maxResults}`);
      if (state.coverage) { state.coverage.status = 'limited'; state.coverage.reason = 'max_results'; }
      state.hasMore = false;
      return;
    }
  }

  state.examinedCount += extractedOnPage;


  if (state.collectedCount >= state.maxResults) {
    if (state.coverage) { state.coverage.status = 'limited'; state.coverage.reason = 'max_results'; }
    state.hasMore = false;
    return;
  }

  const nextPageUrl = await findNextPageUrl(page, state);
  const reportedTotal = reportedPropertyCount(await page.locator('h1').allTextContents().then(text => text.join(' ')));
  if (cardCount < state.pageSize && !nextPageUrl && reportedTotal !== null && reportedTotal > state.offset + cardCount) {
    state.hasMore = false;
    if (state.coverage) { state.coverage.status = 'limited'; state.coverage.reason = 'lazy_load_incomplete'; }
    log.warning('More properties were reported, but the bounded lazy-load window did not fill this page. Coverage is limited, not complete.');
    return;
  }
  const progressAction = decidePageProgress({
    cardCount,
    extractedCount: extractedOnPage,
    newCount: newOnPage,
    duplicateCount: duplicateOnPage,
    filteredCount: filteredOnPage,
    offset: state.offset,
    pageSize: state.pageSize,
    hasNextPage: Boolean(nextPageUrl),
  });

  if (progressAction === 'retry') {
    session?.retire();
    throw new Error(`NO_VALID_PROPERTY_CARDS: ${state.destination} offset ${state.offset}`);
  }

  if (progressAction === 'stop') {
    if (state.coverage) {
      const duplicate = newOnPage === 0 && duplicateOnPage > 0;
      const capped = Math.floor(state.offset / state.pageSize) + 1 >= (state.maxPages ?? MAX_PAGES_PER_DESTINATION);
      state.coverage.status = duplicate || capped ? 'limited' : state.collectedCount ? 'complete' : 'empty';
      state.coverage.reason = duplicate ? 'repeated_page' : capped ? 'page_cap' : null;
    }
    markNoResultIfComplete(state);
    log.info(`Stopping pagination at offset ${state.offset}: cards=${cardCount}, extracted=${extractedOnPage}, new=${newOnPage}, duplicates=${duplicateOnPage}, filtered=${filteredOnPage}.`);
    state.hasMore = false;
    return;
  }

  if (Math.floor(state.offset / state.pageSize) + 1 >= (state.maxPages ?? MAX_PAGES_PER_DESTINATION)) {
    state.hasMore = false;
    if (state.coverage) { state.coverage.status = 'limited'; state.coverage.reason = 'page_cap'; }
    return;
  }

  state.offset += state.pageSize;
  const nextUrl = nextPageUrl ?? buildSearchUrl(state, page.url());

  log.info(`Enqueuing offset ${state.offset}`);
  await randomDelay(page, 1500, 3000);

  await crawler.addRequests([{
    url: nextUrl,
    uniqueKey: searchRequestKey('browser', state),
    userData: { state },
    label: 'search',
  }]);

});

function markNoResultIfComplete(state: SearchState): void {
  if (state.collectedCount === 0 && (state.offset === 0 || state.examinedCount > 0)) {
    noResultDestinations.add(state.requestNamespace ?? state.destination);
  }
}

function propertyCardSelector(): string {
  return PROPERTY_CARD_SELECTOR;
}

export function buildSearchUrl(state: SearchState, currentUrl?: string): string {
  const preservedUrl = currentUrl ?? state.searchUrl;
  if (preservedUrl) {
    const url = new URL(preservedUrl);
    url.hash = '';
    url.searchParams.set('offset', String(state.offset));
    if (!url.searchParams.has('rows')) url.searchParams.set('rows', String(state.pageSize));
    return url.toString();
  }

  const base = 'https://www.booking.com/searchresults.html';
  const params = new URLSearchParams();

  params.set('ss', state.destination);
  params.set('checkin', state.checkIn);
  params.set('checkout', state.checkOut);
  params.set('group_adults', String(state.adults));
  params.set('no_rooms', String(state.rooms));
  const childrenAges = state.childrenAges ?? [];
  params.set('group_children', String(childrenAges.length));
  for (const age of childrenAges) params.append('age', String(age));
  params.set('offset', String(state.offset));
  params.set('rows', String(state.pageSize));
  params.set('selected_currency', state.currency);
  params.set('lang', state.language ?? 'en-us');

  const filters = state.propertyTypes
      .map((t) => PROPERTY_TYPE_HT_IDS[t])
      .filter(Boolean);
  for (const star of state.stars ?? []) filters.push(`class=${star}`);
  if ((state.minPrice ?? null) !== null || (state.maxPrice ?? null) !== null) {
    filters.push(`price=${state.currency}-${state.minPrice ?? 0}-${state.maxPrice ?? 999999999}-1`);
  }
  if (state.minReviewScore >= 6) {
    filters.push(`review_score=${Math.floor(state.minReviewScore) * 10}`);
  }
  if (filters.length > 0) {
    params.set('nflt', filters.join(';'));
  }

  const sortOrder: string | undefined = ({
    priceLowToHigh: 'price',
    reviewScore: 'bayesian_review_score',
    distance: 'distance_from_search',
  } as Partial<Record<NonNullable<SearchState['sortBy']>, string>>)[state.sortBy ?? 'popularity'];
  if (sortOrder) params.set('order', sortOrder);

  return `${base}?${params.toString()}`;
}

async function findNextPageUrl(page: Page, state: SearchState): Promise<string | null> {
  const href = await page.locator([
    '[data-testid="pagination"] a[aria-label="Next page"]',
    '[data-testid="pagination"] a[aria-label*="Next"]',
    'a[aria-label="Next page"]',
    'a.paging-next',
  ].join(',')).evaluateAll(elements => elements[0]?.getAttribute('href') ?? null);
  if (!href) return null;

  try {
    const url = new URL(href, page.url());
    url.hash = '';
    if (!url.searchParams.has('offset')) {
      url.searchParams.set('offset', String(state.offset + state.pageSize));
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function inspectBookingPage(page: Page): Promise<BookingDocumentState> {
  const snapshot = await page.evaluate(() => ({
    title: document.title || '',
    bodyText: (document.body?.innerText || '').slice(0, 5000),
    hasChallengeElement: Boolean(document.querySelector(
      'iframe[src*="captcha"], [data-testid*="captcha"], #challenge-running, '
      + '#challenge-container, script[src*="/__challenge_"], [class*="captcha"]',
    )) || Boolean((window as typeof window & { awsWafCookieDomainList?: string[] }).awsWafCookieDomainList),
  })).catch(() => ({ title: '', bodyText: '', hasChallengeElement: false }));

  return classifyBookingDocument(
    snapshot.title,
    snapshot.bodyText,
    snapshot.hasChallengeElement,
  );
}

async function inspectBookingPageAfterChallengeGrace(page: Page): Promise<BookingDocumentState> {
  const initialState = await inspectBookingPage(page);
  if (initialState !== 'blocked') return initialState;

  // Booking can briefly show its challenge shell before a valid residential
  // session resolves and renders property cards. Do not retire that IP too early.
  await page.waitForSelector(propertyCardSelector(), { timeout: 8000 }).catch(() => null);
  return inspectBookingPage(page);
}

async function inspectPropertyPageAfterChallengeGrace(page: Page): Promise<BookingDocumentState> {
  const initialState = await inspectBookingPage(page);
  if (initialState !== 'blocked') return initialState;

  await page.waitForSelector([
    'h2[data-testid="title"]',
    'h1[data-testid="title"]',
    '#hp_hotel_name',
    '#hprt-table',
  ].join(','), { timeout: 8000 }).catch(() => null);
  return inspectBookingPage(page);
}

async function handleCookieConsent(page: Page): Promise<boolean> {
  try {
    const selectors = [
      '#onetrust-accept-btn-handler',
      'button[aria-label*="Accept all"]',
      'button:has-text("Accept all")',
      '[data-testid="accept-cookies"]',
      'button:has-text("I Accept")',
      'button:has-text("Accept")',
    ];
    const btn = page.locator(selectors.join(',')).first();
    const visible = await btn.isVisible({ timeout: 4000 }).catch(() => false);
    if (visible) {
      await btn.click();
      await page.waitForTimeout(1200);
      return true;
    }
  } catch {
    // no consent banner
  }
  return false;
}

export function extractPropertyFromSnapshot(
  snapshot: PropertyCardSnapshot,
  state: SearchState,
  scrapedAt = new Date().toISOString(),
): HotelRecord | null {
  try {
    const href = snapshot.href;
    const propertyUrl = normalizeBookingUrl(href);

    const propertyId =
      cleanText(snapshot.propertyId) ||
      extractIdFromHref(href);

    const hotelName = cleanText(snapshot.hotelName);
    if (!hotelName || !propertyUrl) return null;

    const cardText = cleanText(snapshot.cardText) ?? '';

    const totalPrice = parseMoney(snapshot.totalText);

    let pricePerNight = parseMoney(snapshot.perNightText);

    const nights = countNights(state.checkIn, state.checkOut);
    if ((!pricePerNight || pricePerNight < 20) && totalPrice) {
      pricePerNight = Math.round((totalPrice / nights) * 100) / 100;
    }

    let originalPrice = parseMoney(snapshot.originalText);

    // Booking's rate-information block spells out "Original price US$X. Current price US$Y."
    // which is the most reliable source for the pre-discount total when shown.
    const rateInfo = cleanText(snapshot.rateInfo);
    if (!originalPrice && rateInfo) {
      const origMatch = rateInfo.match(/Original price[^0-9]*([0-9][0-9,]*)/i);
      if (origMatch) originalPrice = parseMoney(origMatch[0]);
    }

    let discountPercentage: number | null = null;
    if (originalPrice && totalPrice && originalPrice > totalPrice) {
      discountPercentage = Math.round((1 - totalPrice / originalPrice) * 100);
    }

    const reviewScoreText =
      snapshot.reviewScoreAria ||
      snapshot.reviewScoreText ||
      snapshot.reviewScoreLinkText;
    const guestReviewScore = parseReviewScore(reviewScoreText);

    const reviewCount = parseReviewCount(cardText);

    const starRating = parseStarRating(snapshot.starLabel);

    const distanceFromCityCenter = cleanText(snapshot.distanceText);

    const thumbnailImageUrl = cleanText(snapshot.thumbnailSrc);

    // Card-level benefit signals are reliably exposed as text on the search card.
    const freeCancellation = /free cancellation/i.test(cardText);

    const sustainabilityBadge = /travel sustainable|sustainability/i.test(cardText);
    const geniusDiscount = /genius/i.test(cardText);

    const [cityStr, ...countryParts] = state.destination.split(',').map((s) => s.trim());
    const city = cityStr || null;
    const country = countryParts.length ? countryParts.join(', ') : null;

    return {
      propertyId: propertyId || extractIdFromHref(propertyUrl) || propertyUrl,
      hotelName,
      starRating,
      guestReviewScore,
      reviewCount,
      city,
      country,
      distanceFromCityCenter,
      totalPrice,
      pricePerNight,
      originalPrice,
      discountPercentage,
      currency: state.currency,
      freeCancellation,
      propertyUrl,
      thumbnailImageUrl,
      sustainabilityBadge,
      geniusDiscount,
      available: true,
      availabilityStatus: 'available',
      checkIn: state.checkIn,
      checkOut: state.checkOut,
      nights,
      adults: state.adults,
      children: state.childrenAges?.length ?? 0,
      rooms: state.rooms,
      scrapeMode: 'fast',
      billingTier: 'fast',
      sourceUrl: state.searchUrl ?? buildSearchUrl({ ...state, offset: 0 }),
      address: null,
      description: null,
      latitude: null,
      longitude: null,
      checkInTime: null,
      checkOutTime: null,
      facilities: [],
      imageUrls: thumbnailImageUrl ? [thumbnailImageUrl] : [],
      roomOptions: [],
      surroundings: [],
      destination: state.destination,
      scrapedAt,
    };
  } catch {
    return null;
  }
}

export function buildPropertyDetailUrl(record: HotelRecord, state: SearchState): string {
  const url = new URL(record.propertyUrl ?? 'https://www.booking.com/');
  url.searchParams.set('checkin', state.checkIn);
  url.searchParams.set('checkout', state.checkOut);
  url.searchParams.set('group_adults', String(state.adults));
  url.searchParams.set('no_rooms', String(state.rooms));
  url.searchParams.set('group_children', String(state.childrenAges?.length ?? 0));
  url.searchParams.delete('age');
  for (const age of state.childrenAges ?? []) url.searchParams.append('age', String(age));
  url.searchParams.set('selected_currency', state.currency);
  url.searchParams.set('lang', state.language ?? 'en-us');
  return url.toString();
}

function buildDetailKey(record: HotelRecord, state: SearchState): string {
  return [
    record.propertyId,
    state.checkIn,
    state.checkOut,
    state.adults,
    state.rooms,
    (state.childrenAges ?? []).join('-'),
    state.currency,
  ].join(':');
}

function detailedResultEvent(): string {
  const pricingInfo = Actor.getChargingManager().getPricingInfo();
  if (!pricingInfo.isPayPerEvent) return DETAILED_HOTEL_SCRAPED_EVENT;

  return selectDetailedResultEvent(pricingInfo.perEventPrices);
}

export function selectDetailedResultEvent(
  perEventPrices: Record<string, number>,
): string {
  // Adding paid events to an existing public Actor has a 14-day notice period.
  // During that transition, fall back to the existing result event instead of
  // invoking an unknown event (which Apify otherwise prices at its default).
  if (perEventPrices[DETAILED_HOTEL_SCRAPED_EVENT] !== undefined) {
    return DETAILED_HOTEL_SCRAPED_EVENT;
  }
  return HOTEL_SCRAPED_EVENT;
}

export function extractIdFromHref(href: string | null): string | null {
  if (!href) return null;
  const m = href.match(/\/hotel\/(?:[^/]+\/)?([^.?&/]+)/);
  return m?.[1] ?? null;
}

export function parseReviewScore(text: string | null): number | null {
  const normalized = cleanText(text)?.replace(/,/g, '.');
  if (!normalized) return null;

  const scored = normalized.match(/Scored\s*([0-9](?:\.[0-9])?|10(?:\.0)?)/i);
  const generic = normalized.match(/\b([0-9](?:\.[0-9])?|10(?:\.0)?)\b/);
  const parsed = Number.parseFloat((scored ?? generic)?.[1] ?? '');

  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : null;
}

export function parseReviewCount(text: string | null): number | null {
  const normalized = cleanText(text);
  if (!normalized) return null;

  const match = normalized.match(/([0-9][0-9,]*)\s+reviews?/i);
  if (!match) return null;

  const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseStarRating(text: string | null): number | null {
  const normalized = cleanText(text);
  if (!normalized) return null;

  const match = normalized.match(/([0-9](?:\.[0-9])?)\s*(?:out of\s*)?(?:star|stars|5)/i);
  const parsed = Number.parseFloat(match?.[1] ?? '');
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? parsed : null;
}

export function countNights(checkIn: string, checkOut: string): number {
  const start = Date.parse(checkIn);
  const end = Date.parse(checkOut);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;
  return Math.max(1, Math.round((end - start) / 86400000));
}

export function normalizeBookingUrl(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, 'https://www.booking.com');
    if (url.protocol !== 'https:' || !['www.booking.com', 'booking.com'].includes(url.hostname)
      || url.username || url.password || !url.pathname.startsWith('/hotel/')) return null;
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function cleanText(value: string | null): string | null {
  if (!value) return null;
  const cleaned = repairMojibake(value).replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function repairMojibake(value: string): string {
  if (!/[\u00c3\u00c2\u00e2]/.test(value)) return value;

  try {
    const repaired = Buffer.from(value, 'latin1').toString('utf8');
    return mojibakeScore(repaired) < mojibakeScore(value) ? repaired : value;
  } catch {
    return value;
  }
}

function mojibakeScore(value: string): number {
  return (value.match(/[\u00c3\u00c2\u00e2]/g) ?? []).length;
}

async function randomDelay(_page: Page, min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}
