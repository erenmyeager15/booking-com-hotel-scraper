import type { ActorInput, NormalizedInput, ProxyConfigInput } from './types.js';

// Datacenter proxy is the default because it is not billed per gigabyte. A measured
// London run cost $0.00540 on the datacenter pool versus $0.03336 on residential, where
// residential transfer alone was 90% of the bill. Residential is kept as an automatic
// fallback tier for when Booking.com challenges the datacenter pool.
const DEFAULT_PROXY_CONFIGURATION = {
  useApifyProxy: true,
};
const RESIDENTIAL_GROUPS = ['RESIDENTIAL'];
const DEFAULT_CHECK_IN_OFFSET_DAYS = 30;

const ALLOWED_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL',
  'MXN', 'SEK', 'NOK', 'DKK', 'NZD', 'KRW', 'SGD', 'MYR', 'THB', 'TRY',
]);

export function normalizeInput(input: ActorInput = {}, today = new Date()): NormalizedInput {
  const destinations = [...new Set((Array.isArray(input.destinations) ? input.destinations : [])
    .map((destination) => cleanText(destination))
    .filter(Boolean))]
    .slice(0, 50);

  if (destinations.length === 0) {
    throw new Error('At least one destination is required. Provide a "destinations" array.');
  }

  const checkIn = cleanText(input.checkIn)
    ? validateDateInput(input.checkIn, 'checkIn')
    : addDays(localDateString(today), DEFAULT_CHECK_IN_OFFSET_DAYS);
  const checkOut = cleanText(input.checkOut)
    ? validateDateInput(input.checkOut, 'checkOut')
    : addDays(checkIn, 1);

  if (checkIn >= checkOut) {
    throw new Error('checkOut must be after checkIn.');
  }

  if (checkIn <= localDateString(today)) {
    throw new Error('checkIn must be a future date.');
  }

  const currency = cleanText(input.currency || 'USD').toUpperCase();

  return {
    destinations,
    checkIn,
    checkOut,
    adults: clampInteger(input.adults, 2, 1, 30),
    rooms: clampInteger(input.rooms, 1, 1, 30),
    propertyTypes: Array.isArray(input.propertyTypes)
      ? input.propertyTypes.map((type) => cleanText(type)).filter(Boolean)
      : [],
    minReviewScore: clampNumber(input.minReviewScore, 0, 0, 10),
    // Defaults to the real yield of one Booking.com results page. A page costs the
    // same in proxy transfer whether 1 or 25 records are kept, so a default of 1 spent
    // a whole page to bill a single hotel and lost money on every run. Do not raise
    // this default past 25: a measured page renders 50 cards but only ~25 become valid
    // records, and requesting more triggers an offset=25 fetch that returns the same
    // cards and zero new records, so it costs a second page for nothing. See the
    // pagination limitation noted in ROADMAP.md.
    maxResults: clampInteger(input.maxResults, 25, 1, 500),
    currency: ALLOWED_CURRENCIES.has(currency) ? currency : 'USD',
    proxyConfiguration: normalizeProxyConfiguration(input.proxyConfiguration),
  };
}

export function normalizeProxyConfiguration(value: unknown): ProxyConfigInput {
  if (value === undefined || value === null) {
    return { useApifyProxy: DEFAULT_PROXY_CONFIGURATION.useApifyProxy };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('proxyConfiguration must be a proxy configuration object.');
  }

  const raw = value as ProxyConfigInput;
  const proxyUrls = cleanStringArray(raw.proxyUrls);
  const groups = cleanStringArray(raw.apifyProxyGroups);

  if (proxyUrls.length > 0) {
    if (raw.useApifyProxy === true || (raw.useApifyProxy !== false && groups.length > 0)) {
      throw new Error('proxyConfiguration cannot combine custom proxyUrls with Apify Proxy settings.');
    }
    return { useApifyProxy: false, proxyUrls };
  }

  if (raw.useApifyProxy === false) return { useApifyProxy: false };

  const country = cleanText(raw.apifyProxyCountry).toUpperCase();
  return {
    useApifyProxy: true,
    // No groups means "let the tier logic choose", which starts on the cheaper
    // datacenter pool. An explicit group list is always honoured as-is.
    ...(groups.length > 0 ? { apifyProxyGroups: groups } : {}),
    ...(country ? { apifyProxyCountry: country } : {}),
  };
}

export interface ProxyTier {
  label: string;
  options: ReturnType<typeof toProxyConfigurationOptions>;
}

/**
 * Builds the proxy tiers to try in order. When the caller did not pin a specific
 * Apify proxy group, this returns the cheap datacenter pool first and residential
 * as a fallback, so a datacenter block degrades into a costlier run instead of a
 * failed one. Custom proxy URLs and explicit group choices are never overridden.
 */
export function buildProxyTiers(value: ProxyConfigInput): ProxyTier[] {
  if (value.proxyUrls?.length) {
    return [{ label: 'custom proxy URLs', options: toProxyConfigurationOptions(value) }];
  }
  if (value.useApifyProxy === false) {
    return [{ label: 'no proxy', options: toProxyConfigurationOptions(value) }];
  }
  if (value.apifyProxyGroups?.length) {
    return [{
      label: `requested proxy groups (${value.apifyProxyGroups.join(', ')})`,
      options: toProxyConfigurationOptions(value),
    }];
  }

  return [
    {
      label: 'datacenter proxy',
      options: toProxyConfigurationOptions(value),
    },
    {
      label: 'residential proxy fallback',
      options: toProxyConfigurationOptions({ ...value, apifyProxyGroups: [...RESIDENTIAL_GROUPS] }),
    },
  ];
}

export function requiresCloudProxy(value: ProxyConfigInput, isCloudRun: boolean): boolean {
  return isCloudRun
    && value.useApifyProxy === false
    && !value.proxyUrls?.length;
}

export function toProxyConfigurationOptions(value: ProxyConfigInput) {
  if (value.proxyUrls?.length) return { proxyUrls: [...value.proxyUrls] };
  if (value.useApifyProxy === false) return { useApifyProxy: false };
  return {
    useApifyProxy: true,
    // Omitting groups lets Apify serve its datacenter pool, which carries no
    // per-gigabyte transfer charge.
    ...(value.apifyProxyGroups?.length ? { groups: [...value.apifyProxyGroups] } : {}),
    ...(value.apifyProxyCountry ? { countryCode: value.apifyProxyCountry } : {}),
  };
}

function validateDateInput(value: unknown, fieldName: string): string {
  const date = cleanText(value);
  if (!date) throw new Error(`${fieldName} is required (YYYY-MM-DD).`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${fieldName} must be in YYYY-MM-DD format.`);
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);
  const [year, month, day] = date.split('-').map(Number);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} is not a valid date.`);
  }

  return date;
}

function clampInteger(value: unknown, defaultValue: number, minimum: number, maximum: number): number {
  return Math.trunc(clampNumber(value, defaultValue, minimum, maximum));
}

function clampNumber(value: unknown, defaultValue: number, minimum: number, maximum: number): number {
  const numericValue = Number(value ?? defaultValue);
  const safeValue = Number.isFinite(numericValue) ? numericValue : defaultValue;
  return Math.min(Math.max(safeValue, minimum), maximum);
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item)).filter(Boolean))];
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function localDateString(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
