import { createPlaywrightRouter, Dataset } from 'crawlee';
import { Actor } from 'apify';
import type { Page, Locator } from 'playwright';
import type { HotelRecord, SearchState } from './types.js';
import { PROPERTY_TYPE_HT_IDS } from './types.js';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, request, crawler, log }) => {
  const state = request.userData.state as SearchState;

  if (!state.hasMore) {
    log.info(`No more pages for "${state.destination}" - hasMore=false`);
    return;
  }

  log.info(`Page offset=${state.offset} for "${state.destination}" (${state.collectedCount}/${state.maxResults})`);

  await randomDelay(page, 1500, 3000);

  await handleCookieConsent(page);
  await handleCurrencyDropdown(page, state.currency, log);

  try {
    await page.waitForSelector('[data-testid="property-card"]', { timeout: 30000 });
  } catch {
    log.warning(`No property cards at offset ${state.offset} for "${state.destination}" - stopping`);
    state.hasMore = false;
    return;
  }

  await randomDelay(page, 1000, 2000);

  const cards = page.locator('[data-testid="property-card"]');
  const cardCount = await cards.count();
  log.info(`Found ${cardCount} cards`);

  if (cardCount === 0) {
    state.hasMore = false;
    return;
  }

  let newOnPage = 0;

  for (let i = 0; i < cardCount; i++) {
    if (state.collectedCount >= state.maxResults) {
      log.info(`Reached maxResults ${state.maxResults}`);
      state.hasMore = false;
      return;
    }

    const card = cards.nth(i);
    const record = await extractProperty(card, state);

    if (
      record &&
      record.propertyId &&
      !state.seenIds.includes(record.propertyId) &&
      (state.minReviewScore === 0 ||
        (record.guestReviewScore !== null && record.guestReviewScore >= state.minReviewScore))
    ) {
      state.seenIds.push(record.propertyId);
      await Dataset.pushData(record);
      await chargeHotelEvent(log);
      state.collectedCount++;
      newOnPage++;
      log.info(`[${state.collectedCount}/${state.maxResults}] ${record.hotelName}`);

      if (state.collectedCount >= state.maxResults) {
        log.info(`Reached maxResults ${state.maxResults}`);
        state.hasMore = false;
        return;
      }
    }
  }

  if (state.collectedCount >= state.maxResults) {
    state.hasMore = false;
    return;
  }

  if (newOnPage === 0) {
    log.info('No new properties on this page - likely end of results');
    state.hasMore = false;
    return;
  }

  state.offset += state.pageSize;
  const nextUrl = buildSearchUrl(state);

  log.info(`Enqueuing offset ${state.offset}`);
  await randomDelay(page, 1500, 3000);

  await crawler.addRequests([{ url: nextUrl, userData: { state }, label: 'search' }]);

  await randomDelay(page, 1000, 2000);
});

export function buildSearchUrl(state: SearchState): string {
  const base = 'https://www.booking.com/searchresults.html';
  const params = new URLSearchParams();

  params.set('ss', state.destination);
  params.set('checkin', state.checkIn);
  params.set('checkout', state.checkOut);
  params.set('group_adults', String(state.adults));
  params.set('no_rooms', String(state.rooms));
  params.set('offset', String(state.offset));
  params.set('rows', String(state.pageSize));
  params.set('selected_currency', state.currency);

  if (state.propertyTypes.length > 0) {
    const filters = state.propertyTypes
      .map((t) => PROPERTY_TYPE_HT_IDS[t])
      .filter(Boolean);
    if (filters.length > 0) {
      params.set('nflt', filters.join(';'));
    }
  }

  return `${base}?${params.toString()}`;
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

async function handleCurrencyDropdown(page: Page, currency: string, log: any): Promise<void> {
  if (currency.toUpperCase() === 'USD') return;
  try {
    const trigger = page.locator(
      '[data-testid="currency-selector-trigger"], [data-testid="currency-select"], button[data-testid*="currency"]'
    ).first();
    const visible = await trigger.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) return;

    await trigger.click();
    await page.waitForTimeout(600);

    const option = page.locator(
      `[data-testid*="currency-option"]:has-text("${currency}"), a:has-text("${currency}")`
    ).first();
    const optionVisible = await option.isVisible({ timeout: 2000 }).catch(() => false);
    if (!optionVisible) return;

    await option.click();
    await page.waitForTimeout(1500);
    await page.waitForLoadState('networkidle');
    log.info(`Currency -> ${currency}`);
  } catch {
    log.debug('Currency selector not available');
  }
}

async function extractProperty(card: Locator, state: SearchState): Promise<HotelRecord | null> {
  try {
    const link = card.locator('a[data-testid="title-link"], a[href*="/hotel/"]').first();
    const href = await link.getAttribute('href').catch(() => null);
    const propertyUrl = normalizeBookingUrl(href);

    const propertyId =
      (await safeAttr(card, 'data-property-id')) ||
      extractIdFromHref(href);

    const hotelName = cleanText(await safeText(card.locator('[data-testid="title"]').first()));
    if (!hotelName || !propertyUrl) return null;

    const cardText = cleanText(await safeText(card)) ?? '';

    const totalText =
      (await safeText(card.locator('[data-testid="price-and-discounted-price"]').first())) ||
      (await safeText(card.locator('[data-testid="price-for-x-nights"]').first()));
    const totalPrice = parseMoney(totalText);

    const perNightText = await safeText(
      card.locator('[data-testid="price-per-night"], [data-testid*="per-night"]').first()
    );
    let pricePerNight = parseMoney(perNightText);

    const nights = countNights(state.checkIn, state.checkOut);
    if ((!pricePerNight || pricePerNight < 20) && totalPrice) {
      pricePerNight = Math.round((totalPrice / nights) * 100) / 100;
    }

    const originalText =
      (await safeText(card.locator('[data-testid="price-for-x-nights"] [data-testid*="original"]').first())) ||
      (await safeText(card.locator('[data-testid*="strikethrough"], [data-testid*="original-price"]').first()));
    let originalPrice = parseMoney(originalText);

    // Booking's rate-information block spells out "Original price US$X. Current price US$Y."
    // which is the most reliable source for the pre-discount total when shown.
    const rateInfo = cleanText(await safeText(card.locator('[data-testid="availability-rate-information"]').first()));
    if (!originalPrice && rateInfo) {
      const origMatch = rateInfo.match(/Original price[^0-9]*([0-9][0-9,]*)/i);
      if (origMatch) originalPrice = parseMoney(origMatch[0]);
    }

    let discountPercentage: number | null = null;
    if (originalPrice && totalPrice && originalPrice > totalPrice) {
      discountPercentage = Math.round((1 - totalPrice / originalPrice) * 100);
    }

    const scoreEl = card.locator('[data-testid="review-score"]').first();
    const reviewScoreText =
      (await safeAttr(scoreEl, 'aria-label')) ||
      (await safeText(scoreEl)) ||
      (await safeText(card.locator('[data-testid="review-score-link"]').first()));
    const guestReviewScore = parseReviewScore(reviewScoreText);

    const reviewCount = parseReviewCount(cardText);

    const starRating = await extractStarRating(card);

    const distanceRaw = await safeText(card.locator('[data-testid="distance"]'));
    const distanceFromCityCenter = cleanText(distanceRaw);

    const thumbSrc = await safeAttr(
      card.locator('img[data-testid="image"], img[data-testid*="thumbnail"]'),
      'src'
    ) || await safeAttr(card.locator('img').first(), 'src');
    const thumbnailImageUrl = thumbSrc || null;

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
      destination: state.destination,
      scrapedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function chargeHotelEvent(log: { warning(message: string): void }): Promise<void> {
  if (!Actor.isAtHome()) {
    log.warning('Skipping PPE charge outside Apify platform.');
    return;
  }

  try {
    await Actor.charge({ eventName: 'hotel-scraped' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warning(`PPE charge failed - continuing: ${message}`);
  }
}

async function extractStarRating(card: Locator): Promise<number | null> {
  // Booking exposes the official property class as an aria-label like "5 out of 5"
  // on a span inside the card (review scores use "out of 10", so this is unambiguous).
  const labelEl = card.locator('[aria-label*="out of 5"]').first();
  const label = await safeAttr(labelEl, 'aria-label');
  return parseStarRating(label);
}

function extractIdFromHref(href: string | null): string | null {
  if (!href) return null;
  const m = href.match(/\/hotel\/(?:[^/]+\/)?([^.?&/]+)/);
  return m?.[1] ?? null;
}

function parseMoney(text: string | null): number | null {
  const normalized = cleanText(text);
  if (!normalized) return null;

  const currencyPattern = String.raw`(?:US\$|USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|BRL|MXN|SEK|NOK|DKK|NZD|KRW|SGD|MYR|THB|TRY|\u20ac|\u00a3|\u00a5|\u20b9|Rs\.?)`;
  const before = new RegExp(`${currencyPattern}\\s*([0-9][0-9,.]*)`, 'i');
  const after = new RegExp(`([0-9][0-9,.]*)\\s*${currencyPattern}`, 'i');
  const match = normalized.match(before) ?? normalized.match(after);
  if (!match) return null;

  const parsed = Number.parseFloat(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseReviewScore(text: string | null): number | null {
  const normalized = cleanText(text)?.replace(/,/g, '.');
  if (!normalized) return null;

  const scored = normalized.match(/Scored\s*([0-9](?:\.[0-9])?|10(?:\.0)?)/i);
  const generic = normalized.match(/\b([0-9](?:\.[0-9])?|10(?:\.0)?)\b/);
  const parsed = Number.parseFloat((scored ?? generic)?.[1] ?? '');

  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : null;
}

function parseReviewCount(text: string | null): number | null {
  const normalized = cleanText(text);
  if (!normalized) return null;

  const match = normalized.match(/([0-9][0-9,]*)\s+reviews?/i);
  if (!match) return null;

  const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStarRating(text: string | null): number | null {
  const normalized = cleanText(text);
  if (!normalized) return null;

  const match = normalized.match(/([0-9](?:\.[0-9])?)\s*(?:out of\s*)?(?:star|stars|5)/i);
  const parsed = Number.parseFloat(match?.[1] ?? '');
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? parsed : null;
}

function countNights(checkIn: string, checkOut: string): number {
  const start = Date.parse(checkIn);
  const end = Date.parse(checkOut);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;
  return Math.max(1, Math.round((end - start) / 86400000));
}

function normalizeBookingUrl(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, 'https://www.booking.com');
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

async function safeText(loc: Locator): Promise<string | null> {
  return loc.textContent({ timeout: 1000 }).catch(() => null);
}

async function safeAttr(loc: Locator, attr: string): Promise<string | null> {
  return loc.getAttribute(attr, { timeout: 1000 }).catch(() => null);
}

async function randomDelay(_page: Page, min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}
