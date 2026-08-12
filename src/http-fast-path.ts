import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';
import type { ProxyConfiguration } from 'apify';
import type { HotelRecord, SearchState } from './types.js';
import {
  buildSearchUrl,
  classifyBookingDocument,
  countNights,
  decidePageProgress,
  extractIdFromHref,
  normalizeBookingUrl,
  parseMoney,
  parseReviewCount,
  parseReviewScore,
  parseStarRating,
} from './routes.js';

const HOTEL_SCRAPED_EVENT = 'hotel-scraped';

export interface SearchRequest {
  url: string;
  uniqueKey: string;
  userData: { state: SearchState };
  label: string;
}

export interface HttpFastPathResult {
  chargedHotelCount: number;
  noResultDestinationCount: number;
  spendingLimitReached: boolean;
  fallbackRequests: SearchRequest[];
}

interface CheerioSelection {
  attr(name: string): string | undefined;
  find(selector: string): CheerioSelection;
  first(): CheerioSelection;
  text(): string;
  readonly length: number;
}

export async function runHttpFastPath(
  initialRequests: SearchRequest[],
  proxyConfiguration: ProxyConfiguration | undefined,
): Promise<HttpFastPathResult> {
  let chargedHotelCount = 0;
  let spendingLimitReached = false;
  const noResultDestinations = new Set<string>();
  const fallbackRequests = new Map<string, SearchRequest>();

  const queueBrowserFallback = (state: SearchState): void => {
    const url = buildSearchUrl(state);
    const uniqueKey = `browser:${state.destination}:${state.offset}`;
    fallbackRequests.set(uniqueKey, {
      url,
      uniqueKey,
      userData: { state },
      label: 'search',
    });
  };

  const crawler = new CheerioCrawler({
    proxyConfiguration,
    useSessionPool: true,
    sessionPoolOptions: {
      maxPoolSize: 5,
      sessionOptions: { maxUsageCount: 20 },
    },
    maxConcurrency: 3,
    maxRequestRetries: 0,
    requestHandlerTimeoutSecs: 30,
    navigationTimeoutSecs: 20,
    additionalMimeTypes: ['application/xhtml+xml'],
    requestHandler: async ({ $, request, crawler: activeCrawler, log }) => {
      const state = request.userData.state as SearchState;
      if (spendingLimitReached || !state.hasMore) return;

      const documentState = classifyBookingDocument(
        $('title').text(),
        $('body').text().slice(0, 5000),
      );
      if (documentState === 'blocked') {
        queueBrowserFallback(state);
        return;
      }
      if (documentState === 'no-results') {
        if (state.collectedCount === 0) noResultDestinations.add(state.destination);
        state.hasMore = false;
        return;
      }

      const cards = $('[data-testid="property-card"], [data-testid="property-card-container"]');
      if (cards.length === 0) {
        queueBrowserFallback(state);
        return;
      }

      let extractedOnPage = 0;
      let newOnPage = 0;
      let duplicateOnPage = 0;
      let filteredOnPage = 0;

      for (const element of cards.toArray()) {
        if (state.collectedCount >= state.maxResults || spendingLimitReached) break;

        const record = extractPropertyFromHtml($(element), state);
        if (!record?.propertyId) continue;
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
        const chargeResult = await Actor.pushData(record, HOTEL_SCRAPED_EVENT);
        const recordWasSaved = chargeResult.chargedCount > 0 || !chargeResult.eventChargeLimitReached;
        if (!recordWasSaved) {
          spendingLimitReached = true;
          state.hasMore = false;
          await activeCrawler.autoscaledPool?.abort();
          break;
        }

        chargedHotelCount++;
        state.collectedCount++;
        newOnPage++;

        if (chargeResult.eventChargeLimitReached) {
          spendingLimitReached = true;
          state.hasMore = false;
          await activeCrawler.autoscaledPool?.abort();
          break;
        }
      }

      state.examinedCount += extractedOnPage;
      if (state.collectedCount >= state.maxResults || spendingLimitReached) {
        state.hasMore = false;
        return;
      }

      const progressAction = decidePageProgress({
        cardCount: cards.length,
        extractedCount: extractedOnPage,
        newCount: newOnPage,
        duplicateCount: duplicateOnPage,
        filteredCount: filteredOnPage,
        offset: state.offset,
        pageSize: state.pageSize,
      });

      if (progressAction === 'retry') {
        queueBrowserFallback(state);
        return;
      }
      if (progressAction === 'stop') {
        if (state.collectedCount === 0) noResultDestinations.add(state.destination);
        state.hasMore = false;
        return;
      }

      state.offset += state.pageSize;
      const nextUrl = buildSearchUrl(state);
      await activeCrawler.addRequests([{
        url: nextUrl,
        uniqueKey: `http:${state.destination}:${state.offset}`,
        userData: { state },
        label: 'search',
      }]);
    },
    failedRequestHandler: async ({ request, log }, error) => {
      const state = request.userData.state as SearchState;
      const message = error instanceof Error ? error.message : String(error);
      log.warning(`HTTP fast path unavailable; using browser fallback for ${state.destination}.`, {
        error: message,
      });
      if (!spendingLimitReached) queueBrowserFallback(state);
    },
  });

  await crawler.run(initialRequests);

  return {
    chargedHotelCount,
    noResultDestinationCount: noResultDestinations.size,
    spendingLimitReached,
    fallbackRequests: [...fallbackRequests.values()],
  };
}

export function extractPropertyFromHtml(
  card: CheerioSelection,
  state: SearchState,
  scrapedAt = new Date().toISOString(),
): HotelRecord | null {
  const href = firstAttr(card, [
    'a[data-testid="title-link"]',
    'a[data-testid="property-card-desktop-single-image"]',
    'a[href*="/hotel/"]',
  ], 'href');
  const propertyUrl = normalizeBookingUrl(href);
  const hotelName = cleanText(firstText(card, [
    '[data-testid="title"]',
    '[data-testid="property-card-title"]',
  ]));
  if (!hotelName || !propertyUrl) return null;

  const propertyId = cleanText(card.attr('data-property-id'))
    || extractIdFromHref(href)
    || propertyUrl;
  const cardText = cleanText(card.text()) ?? '';
  const totalPrice = parseMoney(firstText(card, [
    '[data-testid="price-and-discounted-price"]',
    '[data-testid="price-for-x-nights"]',
  ]));
  let pricePerNight = parseMoney(firstText(card, [
    '[data-testid="price-per-night"]',
    '[data-testid*="per-night"]',
  ]));
  if (!pricePerNight && totalPrice) {
    pricePerNight = Number((totalPrice / countNights(state.checkIn, state.checkOut)).toFixed(2));
  }

  let originalPrice = parseMoney(firstText(card, [
    '[data-testid*="strikethrough"]',
    '[data-testid*="original-price"]',
  ]));
  const rateInfo = cleanText(firstText(card, ['[data-testid="availability-rate-information"]']));
  if (!originalPrice && rateInfo) {
    const originalMatch = rateInfo.match(/Original price[^0-9]*([0-9][0-9,]*)/i);
    if (originalMatch) originalPrice = parseMoney(originalMatch[0]);
  }

  const reviewScoreElement = firstSelection(card, [
    '[data-testid="review-score"]',
    '[data-testid="review-score-link"]',
  ]);
  const reviewScoreText = reviewScoreElement?.attr('aria-label')
    || cleanText(reviewScoreElement?.text() ?? null);
  const starLabel = firstAttr(card, ['[aria-label*="out of 5"]'], 'aria-label');
  const thumbnailImageUrl = firstAttr(card, [
    'img[data-testid="image"]',
    'img[data-testid*="thumbnail"]',
    'img',
  ], 'src');
  const [cityPart, ...countryParts] = state.destination.split(',').map((part) => part.trim());
  const discountPercentage = originalPrice && totalPrice && originalPrice > totalPrice
    ? Math.round((1 - totalPrice / originalPrice) * 100)
    : null;

  return {
    propertyId,
    hotelName,
    starRating: parseStarRating(starLabel),
    guestReviewScore: parseReviewScore(reviewScoreText),
    reviewCount: parseReviewCount(cardText),
    city: cityPart || null,
    country: countryParts.length > 0 ? countryParts.join(', ') : null,
    distanceFromCityCenter: cleanText(firstText(card, ['[data-testid="distance"]'])),
    totalPrice,
    pricePerNight,
    originalPrice,
    discountPercentage,
    currency: state.currency,
    freeCancellation: /free cancellation/i.test(cardText),
    propertyUrl,
    thumbnailImageUrl,
    sustainabilityBadge: /travel sustainable|sustainability/i.test(cardText),
    geniusDiscount: /genius/i.test(cardText),
    destination: state.destination,
    scrapedAt,
  };
}

function firstSelection(card: CheerioSelection, selectors: string[]): CheerioSelection | null {
  for (const selector of selectors) {
    const selection = card.find(selector).first();
    if (selection.length > 0) return selection;
  }
  return null;
}

function firstText(card: CheerioSelection, selectors: string[]): string | null {
  const selection = firstSelection(card, selectors);
  return selection ? cleanText(selection.text()) : null;
}

function firstAttr(card: CheerioSelection, selectors: string[], attribute: string): string | null {
  const selection = firstSelection(card, selectors);
  return cleanText(selection?.attr(attribute) ?? null);
}

function cleanText(value: string | null | undefined): string | null {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}
