import type { Page } from 'playwright';
import type { HotelRecord, RoomOption } from './types.js';

export interface RoomSnapshot {
  roomName: string | null;
  bedType: string | null;
  occupancyText: string | null;
  priceText: string | null;
  conditionsText: string | null;
  availabilityText: string | null;
  amenities: string[];
}

export interface BookingDetailSnapshot {
  title: string | null;
  address: string | null;
  description: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  facilities: string[];
  imageUrls: string[];
  surroundings: string[];
  roomRows: RoomSnapshot[];
  bodyText: string;
}

/**
 * Reads the public property page in one browser round trip. Booking.com ships
 * several layouts at once, so each field deliberately has both current
 * data-testid selectors and long-lived legacy selectors.
 */
export async function extractBookingDetails(
  page: Page,
  maxImages: number,
): Promise<BookingDetailSnapshot> {
  return page.evaluate((imageLimit) => {
    const clean = (value: string | null | undefined): string | null => {
      const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
      return normalized || null;
    };
    const firstText = (selectors: string[]): string | null => {
      for (const selector of selectors) {
        const value = clean(document.querySelector(selector)?.textContent);
        if (value) return value;
      }
      return null;
    };
    const uniqueTexts = (selectors: string[], limit = 200): string[] => {
      const values: string[] = [];
      for (const selector of selectors) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          const value = clean(element.textContent);
          if (value && !values.includes(value)) values.push(value);
          if (values.length >= limit) return values;
        }
      }
      return values;
    };
    const bodyText = clean(document.body?.innerText) ?? '';
    const html = document.documentElement?.innerHTML ?? '';

    let structuredData: Record<string, unknown> | null = null;
    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        const parsed: unknown = JSON.parse(script.textContent ?? 'null');
        const rootItems: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        const candidates: unknown[] = [];
        for (const item of rootItems) {
          if (item && typeof item === 'object') {
            candidates.push(item);
            const graph = (item as Record<string, unknown>)['@graph'];
            if (Array.isArray(graph)) candidates.push(...graph);
          }
        }
        const match = candidates.find((item) => {
          if (!item || typeof item !== 'object') return false;
          const type = (item as Record<string, unknown>)['@type'];
          const types = Array.isArray(type) ? type : [type];
          return types.some((value) => /hotel|lodging|resort|apartment/i.test(String(value ?? '')));
        });
        if (match && typeof match === 'object') {
          structuredData = match as Record<string, unknown>;
          break;
        }
      } catch {
        // Ignore malformed or unrelated structured-data blocks.
      }
    }

    const schemaString = (value: unknown): string | null =>
      typeof value === 'string' ? clean(value) : null;
    const schemaObject = (value: unknown): Record<string, unknown> | null =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    const addressObject = schemaObject(structuredData?.address);
    const countryObject = schemaObject(addressObject?.addressCountry);
    const structuredAddressParts = [
        schemaString(addressObject?.streetAddress),
        schemaString(addressObject?.addressLocality),
        schemaString(addressObject?.addressRegion),
        schemaString(addressObject?.postalCode),
        schemaString(addressObject?.addressCountry) ?? schemaString(countryObject?.name),
      ].filter((value): value is string => Boolean(value)).join(', ');
    const structuredAddress = schemaString(structuredData?.address)
      ?? (structuredAddressParts || null);
    const geoObject = schemaObject(structuredData?.geo);

    let latitude: string | number | null = null;
    let longitude: string | number | null = null;
    const latLng = document.querySelector('[data-atlas-latlng]')?.getAttribute('data-atlas-latlng')
      ?? document.querySelector('[data-latlng]')?.getAttribute('data-latlng');
    const latLngMatch = latLng?.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/);
    if (latLngMatch) {
      latitude = latLngMatch[1];
      longitude = latLngMatch[2];
    } else if (geoObject?.latitude !== undefined && geoObject?.longitude !== undefined) {
      latitude = String(geoObject.latitude);
      longitude = String(geoObject.longitude);
    } else {
      const jsonCoordinates = html.match(
        /["']latitude["']\s*:\s*["']?(-?\d+(?:\.\d+)?)["']?[\s\S]{0,240}?["']longitude["']\s*:\s*["']?(-?\d+(?:\.\d+)?)/i,
      ) ?? html.match(
        /["']longitude["']\s*:\s*["']?(-?\d+(?:\.\d+)?)["']?[\s\S]{0,240}?["']latitude["']\s*:\s*["']?(-?\d+(?:\.\d+)?)/i,
      );
      if (jsonCoordinates) {
        const longitudeFirst = /longitude/i.test(jsonCoordinates[0].slice(0, 30));
        latitude = longitudeFirst ? jsonCoordinates[2] : jsonCoordinates[1];
        longitude = longitudeFirst ? jsonCoordinates[1] : jsonCoordinates[2];
      }
    }

    const images: string[] = [];
    const imageElements = document.querySelectorAll([
      '[data-testid="property-gallery-preview"] img',
      '[data-testid="gallery-image"] img',
      '#photo_wrapper img',
      'img[src*="bstatic.com/xdata/images/hotel"]',
    ].join(','));
    for (const image of Array.from(imageElements)) {
      const source = image.getAttribute('src')
        ?? image.getAttribute('data-highres')
        ?? image.getAttribute('data-src');
      if (source && !images.includes(source)) images.push(source);
      if (images.length >= imageLimit) break;
    }
    const structuredImages = structuredData?.image;
    const imageCandidates = Array.isArray(structuredImages) ? structuredImages : [structuredImages];
    for (const candidate of imageCandidates) {
      const source = schemaString(candidate)
        ?? schemaString(schemaObject(candidate)?.url)
        ?? schemaString(schemaObject(candidate)?.contentUrl);
      if (source && !images.includes(source)) images.push(source);
      if (images.length >= imageLimit) break;
    }

    const rowElements = Array.from(new Set(Array.from(document.querySelectorAll([
      '#hprt-table tr[data-block-id]',
      '#hprt-table tbody tr',
      '[data-testid="availability-row"]',
      '[data-testid="room-row"]',
    ].join(',')))));
    const roomRows: RoomSnapshot[] = [];
    let previousRoomName: string | null = null;
    let previousBedType: string | null = null;

    for (const row of rowElements) {
      const rowFirstText = (selectors: string[]): string | null => {
        for (const selector of selectors) {
          const value = clean(row.querySelector(selector)?.textContent);
          if (value) return value;
        }
        return null;
      };
      const rowFirstAttribute = (selectors: string[], attribute: string): string | null => {
        for (const selector of selectors) {
          const value = clean(row.querySelector(selector)?.getAttribute(attribute));
          if (value) return value;
        }
        return null;
      };

      const roomName: string | null = rowFirstText([
        '.hprt-roomtype-link',
        '.hprt-roomtype-icon-link',
        '[data-testid="room-name"]',
        '[data-testid="roomtype-name"]',
        '[data-room-name]',
      ]) ?? rowFirstAttribute(['[data-room-name]'], 'data-room-name') ?? previousRoomName;
      const bedType: string | null = rowFirstText([
        '.hprt-roomtype-bed',
        '.bed-types',
        '[data-testid="bed-type"]',
        '[data-testid*="bed-config"]',
      ]) ?? previousBedType;
      const occupancyText = rowFirstAttribute([
        '.hprt-occupancy [title]',
        '[data-testid*="occupancy"] [title]',
      ], 'title') ?? rowFirstAttribute([
        '.hprt-occupancy img',
        '.hprt-occupancy [aria-label]',
        '[data-testid*="occupancy"] [aria-label]',
      ], 'aria-label') ?? rowFirstAttribute([
        '.hprt-occupancy img',
        '[data-testid*="occupancy"] img',
      ], 'alt') ?? rowFirstText(['.hprt-occupancy', '[data-testid*="occupancy"]']);
      const priceText = rowFirstText([
        '.hprt-price-price',
        '.hprt-table-cell-price',
        '[data-testid="price-for-x-nights"]',
        '[data-testid="price-and-discounted-price"]',
        '[data-testid*="price"]',
      ]);
      const conditionsText = rowFirstText([
        '.hprt-table-cell-conditions',
        '.hprt-conditions',
        '[data-testid*="cancellation"]',
        '[data-testid*="policy"]',
      ]);
      const availabilityText = rowFirstText([
        '.hprt-table-cell-availability',
        '.hprt-nos-select',
        '[data-testid*="availability"]',
      ]) ?? clean(row.textContent);
      const amenities = Array.from(row.querySelectorAll([
        '.hprt-facilities-facility',
        '[data-testid*="facility"]',
        'li',
      ].join(',')))
        .map((element) => clean(element.textContent))
        .filter((value): value is string => Boolean(value));

      if (!roomName && !priceText) continue;
      previousRoomName = roomName;
      previousBedType = bedType;
      roomRows.push({
        roomName,
        bedType,
        occupancyText,
        priceText,
        conditionsText,
        availabilityText,
        amenities: [...new Set(amenities)].slice(0, 50),
      });
    }

    const checkInText = firstText([
      '[data-testid="checkin-time"]',
      '#checkin_policy .description',
      '.hp_checkinout:first-child .description',
      '[data-testid="policy-checkin"]',
    ]) ?? bodyText.match(/Check-in\s+(?:From\s+)?(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i)?.[1] ?? null;
    const checkOutText = firstText([
      '[data-testid="checkout-time"]',
      '#checkout_policy .description',
      '.hp_checkinout:last-child .description',
      '[data-testid="policy-checkout"]',
    ]) ?? bodyText.match(/Check-out\s+(?:Until\s+)?(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i)?.[1] ?? null;

    return {
      title: schemaString(structuredData?.name)
        ?? firstText(['#hp_hotel_name', 'h2.pp-header__title', 'h1[data-testid="title"]', 'h1']),
      address: structuredAddress ?? firstText([
        '[data-testid="address"]',
        '[data-testid="PropertyHeaderAddressDesktop-wrapper"]',
        '.hp_address_subtitle',
        '#showMap2 span',
      ]),
      description: firstText([
        '[data-testid="property-description"]',
        '#property_description_content',
        '#summary p',
        '.hp-description',
      ]) ?? schemaString(structuredData?.description),
      latitude,
      longitude,
      checkInTime: clean(checkInText),
      checkOutTime: clean(checkOutText),
      facilities: uniqueTexts([
        '[data-testid="property-most-popular-facilities-wrapper"] li',
        '[data-testid="facility-group-container"] li',
        '#hotelFacilities li',
        '#facilities_block .facilityGroup li',
      ]),
      imageUrls: images,
      surroundings: uniqueTexts([
        '[data-testid="property-surroundings"] li',
        '[data-testid*="surrounding"] li',
        '[data-testid*="nearby"] li',
        '[data-testid="property-location-score"]',
        '#hotel_surroundings li',
        '#location_score_tooltip',
        '.hp_nearby_places_container li',
        '.hp_location_block__section_container li',
      ], 100),
      roomRows,
      bodyText: bodyText.slice(0, 20000),
    };
  }, Math.max(1, Math.min(maxImages, 50)));
}

export function enrichHotelRecord(
  record: HotelRecord,
  snapshot: BookingDetailSnapshot,
  maxImages = 50,
): HotelRecord {
  const requestedOccupancy = record.adults + record.children;
  const roomOptions = snapshot.roomRows.map((room) => {
    const parsed = parseRoomOption(room, record.currency);
    return parsed.occupancy === null && requestedOccupancy > 0
      ? { ...parsed, occupancy: requestedOccupancy }
      : parsed;
  });
  const pageSaysSoldOut = /sold out|no availability|not available for (?:your|these) dates/i
    .test(snapshot.bodyText);
  const availableRooms = roomOptions.filter((room) => room.available);
  const available = availableRooms.length > 0
    ? true
    : pageSaysSoldOut
      ? false
      : record.available;
  const availabilityStatus = available === true
    ? 'available'
    : available === false
      ? 'sold_out'
      : 'unknown';
  const roomPrices = availableRooms
    .map((room) => room.totalPrice)
    .filter((price): price is number => price !== null);
  const detailPrice = roomPrices.length > 0 ? Math.min(...roomPrices) : null;
  const imageUrls = [...new Set([
    ...(record.thumbnailImageUrl ? [record.thumbnailImageUrl] : []),
    ...snapshot.imageUrls,
  ])].slice(0, Math.max(1, maxImages));

  return {
    ...record,
    hotelName: plausiblePropertyTitle(snapshot.title) ?? record.hotelName,
    totalPrice: record.totalPrice ?? detailPrice,
    pricePerNight: record.pricePerNight
      ?? (detailPrice === null ? null : Number((detailPrice / Math.max(record.nights, 1)).toFixed(2))),
    freeCancellation: record.freeCancellation
      || roomOptions.some((room) => room.freeCancellation),
    available,
    availabilityStatus,
    scrapeMode: 'detailed',
    address: normalizeAddress(snapshot.address),
    description: cleanText(snapshot.description),
    latitude: parseCoordinate(snapshot.latitude, -90, 90),
    longitude: parseCoordinate(snapshot.longitude, -180, 180),
    checkInTime: cleanText(snapshot.checkInTime),
    checkOutTime: cleanText(snapshot.checkOutTime),
    facilities: uniqueStrings(snapshot.facilities),
    imageUrls,
    roomOptions,
    surroundings: uniqueStrings(snapshot.surroundings),
  };
}

export function parseRoomOption(
  snapshot: RoomSnapshot,
  fallbackCurrency: string | null,
): RoomOption {
  const conditions = cleanPolicyText(snapshot.conditionsText);
  const availability = cleanText(snapshot.availabilityText);
  const combined = `${conditions ?? ''} ${availability ?? ''}`.trim();
  const soldOut = /sold out|not available|unavailable/i.test(combined);
  const price = parseMoneyAndCurrency(snapshot.priceText, fallbackCurrency);
  const freeCancellation = /free cancellation/i.test(combined);
  const refundable = /non[- ]?refundable/i.test(combined)
    ? false
    : /free cancellation|refundable/i.test(combined)
      ? true
      : null;
  const occupancyMatch = cleanText(snapshot.occupancyText)?.match(/(?:max(?:imum)?\s*)?(\d+)\s*(?:persons?|people|guests?|adults?)?/i);
  const unitsMatch = combined.match(/(?:only\s*)?(\d+)\s+(?:room|unit)s?\s+left/i);
  const mealPlan = parseMealPlan(combined);

  return {
    roomName: cleanText(snapshot.roomName),
    bedType: cleanText(snapshot.bedType),
    occupancy: occupancyMatch ? Number.parseInt(occupancyMatch[1], 10) : null,
    totalPrice: price.amount,
    currency: price.currency,
    mealPlan: cleanText(mealPlan),
    cancellationPolicy: conditions,
    freeCancellation,
    refundable,
    available: !soldOut && (price.amount !== null || !/sold out|unavailable/i.test(combined)),
    unitsLeft: unitsMatch ? Number.parseInt(unitsMatch[1], 10) : null,
    amenities: uniqueStrings(snapshot.amenities).filter((value) => !(
      /breakfast|cancellation|non[- ]?refundable|prepayment|pay online|policyModal/i.test(value)
    )),
  };
}

function parseMoneyAndCurrency(
  text: string | null,
  fallbackCurrency: string | null,
): { amount: number | null; currency: string | null } {
  const normalized = cleanText(text);
  if (!normalized) return { amount: null, currency: fallbackCurrency };

  const currencyAliases: Record<string, string> = {
    '$': 'USD', 'US$': 'USD', 'CA$': 'CAD', 'AU$': 'AUD', 'NZ$': 'NZD', 'S$': 'SGD',
    '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', RS: 'INR', 'RS.': 'INR',
  };
  const preferredCurrency = fallbackCurrency?.toUpperCase() ?? null;
  const preferredTokens: Record<string, string> = {
    USD: String.raw`(?:US\$|USD|\$)`,
    CAD: String.raw`(?:CA\$|CAD|\$)`,
    AUD: String.raw`(?:AU\$|AUD|\$)`,
    NZD: String.raw`(?:NZ\$|NZD|\$)`,
    SGD: String.raw`(?:S\$|SGD|\$)`,
    EUR: String.raw`(?:EUR|€)`,
    GBP: String.raw`(?:GBP|£)`,
    JPY: String.raw`(?:JPY|¥)`,
    INR: String.raw`(?:INR|₹|Rs\.?)`,
  };
  const amountPattern = String.raw`([0-9][0-9,.]*)`;
  const parseAmount = (value: string): number | null => {
    const parsed = Number.parseFloat(value.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  };

  // Booking sometimes appends the account's local-conversion label to a price that
  // is visibly rendered in the requested currency. Prefer the requested currency's
  // symbol-and-number pair, so "$539 … INR conversion available" cannot become
  // 539 INR merely because INR is the only three-letter code in the cell text.
  const preferredToken = preferredCurrency ? preferredTokens[preferredCurrency] : undefined;
  if (preferredCurrency && preferredToken) {
    const before = normalized.match(new RegExp(`${preferredToken}\\s*${amountPattern}`, 'i'));
    if (before) return { amount: parseAmount(before[1]), currency: preferredCurrency };
    const after = normalized.match(new RegExp(`${amountPattern}\\s*${preferredToken}`, 'i'));
    if (after) return { amount: parseAmount(after[1]), currency: preferredCurrency };
  }

  const currencyToken = String.raw`(US\$|CA\$|AU\$|NZ\$|S\$|USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|BRL|MXN|SEK|NOK|DKK|NZD|KRW|SGD|MYR|THB|TRY|€|£|¥|₹|Rs\.?|\$)`;
  const before = normalized.match(new RegExp(`${currencyToken}\\s*${amountPattern}`, 'i'));
  if (before) {
    const rawCurrency = before[1].toUpperCase();
    return {
      amount: parseAmount(before[2]),
      currency: currencyAliases[rawCurrency] ?? rawCurrency,
    };
  }

  const after = normalized.match(new RegExp(`${amountPattern}\\s*${currencyToken}`, 'i'));
  if (after) {
    const rawCurrency = after[2].toUpperCase();
    return {
      amount: parseAmount(after[1]),
      currency: currencyAliases[rawCurrency] ?? rawCurrency,
    };
  }

  const bareAmount = normalized.match(/\b([0-9][0-9,.]*)\b/);
  return {
    amount: bareAmount ? parseAmount(bareAmount[1]) : null,
    currency: preferredCurrency,
  };
}

function parseCoordinate(value: string | number | null, minimum: number, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function parseMealPlan(value: string): string | null {
  if (/breakfast included/i.test(value)) return 'Breakfast included';
  const paidBreakfast = value.match(/(?:good\s+)?breakfast\s*((?:US\$|USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|€|£|¥|₹|Rs\.?)\s*[0-9][0-9,.]*)/i);
  if (paidBreakfast) return `Breakfast available for ${paidBreakfast[1]}`;
  if (/no meals? included/i.test(value)) return 'No meals included';
  if (/all[- ]inclusive/i.test(value)) return 'All-inclusive';
  if (/full board/i.test(value)) return 'Full board';
  if (/half board/i.test(value)) return 'Half board';
  return null;
}

function cleanPolicyText(value: string | null): string | null {
  const cleaned = cleanText(value)?.split(/#policyModal_|\.bui-modal__close/i)[0].trim();
  return cleaned || null;
}

function plausiblePropertyTitle(value: string | null): string | null {
  const title = cleanText(value);
  if (!title || title.length > 180 || /\.cls-|benefits available|sustainability certification/i.test(title)) {
    return null;
  }
  return title;
}

function normalizeAddress(value: string | null): string | null {
  const address = cleanText(value);
  if (!address) return null;

  const parts = address.split(',').map((part) => part.trim()).filter(Boolean);
  const firstPart = parts[0]?.toLowerCase();
  if (firstPart) {
    const repeatedAt = parts.findIndex((part, index) => index > 0 && part.toLowerCase() === firstPart);
    if (repeatedAt > 0) return parts.slice(0, repeatedAt).join(', ');
  }
  return address;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => cleanText(value)).filter((value): value is string => Boolean(value)))];
}

function cleanText(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized || null;
}
