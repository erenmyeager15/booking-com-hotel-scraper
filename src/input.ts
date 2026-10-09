import type { ActorInput, NormalizedInput, ProxyConfigInput, SortBy } from './types.js';

// Datacenter proxy is the default because it is not billed per gigabyte. A measured
// London run cost $0.00540 on the datacenter pool versus $0.03336 on residential, where
// residential transfer alone was 90% of the bill. Residential fallback now requires
// an explicit opt-in and is limited to one search page.
const DEFAULT_PROXY_CONFIGURATION = {
  useApifyProxy: true,
};
const RESIDENTIAL_GROUPS = ['RESIDENTIAL'];
const DEFAULT_CHECK_IN_OFFSET_DAYS = 30;

const ALLOWED_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL',
  'MXN', 'SEK', 'NOK', 'DKK', 'NZD', 'KRW', 'SGD', 'MYR', 'THB', 'TRY',
]);
const ALLOWED_SORTS = new Set<SortBy>([
  'popularity', 'priceLowToHigh', 'reviewScore', 'distance',
]);
const ALLOWED_LANGUAGES = new Set([
  'en-us', 'en-gb', 'de', 'es', 'fr', 'it', 'nl', 'pt-br', 'pt-pt', 'ja',
  'zh-cn', 'zh-tw', 'ko', 'ar', 'hi', 'tr', 'pl', 'sv', 'da', 'no', 'fi',
]);

export function normalizeInput(input: ActorInput = {}, today = new Date()): NormalizedInput {
  const searchUrls = normalizeSearchUrls(input.searchUrls);
  // URL mode is intentionally exclusive. Apify's input UI applies the London
  // destination default even when a user pastes a URL; ignoring destinations when
  // searchUrls are present prevents an unexpected second, paid search.
  const destinations = searchUrls.length > 0 ? [] : [...new Set((Array.isArray(input.destinations) ? input.destinations : ['London, United Kingdom'])
    .map((destination) => cleanText(destination))
    .filter(Boolean))]
    .slice(0, 50);

  if (destinations.length === 0 && searchUrls.length === 0) {
    throw new Error('Provide at least one destination or Booking.com search URL.');
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
  const languageCandidate = cleanText(input.language || 'en-us').toLowerCase();
  const sortCandidate = cleanText(input.sortBy || 'popularity') as SortBy;
  const minPrice = normalizeOptionalNumber(input.minPrice, 'minPrice');
  const maxPrice = normalizeOptionalNumber(input.maxPrice, 'maxPrice');

  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    throw new Error('minPrice must be less than or equal to maxPrice.');
  }

  const scrapeDetails = input.scrapeDetails === true;
  const proxyConfiguration = normalizeProxyConfiguration(input.proxyConfiguration);
  if (
    scrapeDetails
    && proxyConfiguration.apifyProxyGroups?.some((group) => group.toUpperCase() === 'RESIDENTIAL')
  ) {
    throw new Error(
      'Detailed mode does not support Apify Residential proxy because its transfer cost is too high. '
      + 'Leave proxy groups empty to use the included datacenter proxy, or provide your own custom proxy URL.',
    );
  }

  const trackChanges = input.trackChanges === true;
  const monitorName = cleanText(input.monitorName);
  if (trackChanges && !/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/.test(monitorName)) {
    throw new Error('Set monitorName to 1-64 letters, numbers, spaces, underscores or hyphens when trackChanges is enabled.');
  }

  return {
    destinations,
    searchUrls,
    checkIn,
    checkOut,
    adults: clampInteger(input.adults, 2, 1, 30),
    rooms: clampInteger(input.rooms, 1, 1, 30),
    childrenAges: normalizeIntegerArray(input.childrenAges, 0, 17, 10, false),
    propertyTypes: Array.isArray(input.propertyTypes)
      ? input.propertyTypes.map((type) => cleanText(type)).filter(Boolean)
      : [],
    stars: normalizeIntegerArray(input.stars, 1, 5, 5, true),
    minReviewScore: clampNumber(input.minReviewScore, 0, 0, 10),
    minPrice,
    maxPrice,
    sortBy: ALLOWED_SORTS.has(sortCandidate) ? sortCandidate : 'popularity',
    // Defaults to the real yield of one Booking.com results page. A page costs the
    // same in proxy transfer whether 1 or 25 records are kept, so a default of 1 spent
    // a whole page to bill a single hotel and lost money on every run. Do not raise
    // this default past 25: a measured page renders 50 cards but only ~25 become valid
    // records, and requesting more triggers an offset=25 fetch that returns the same
    // cards and zero new records, so it costs a second page for nothing. See the
    // pagination limitation noted in ROADMAP.md.
    maxResults: clampInteger(input.maxResults, 25, 1, 500),
    currency: ALLOWED_CURRENCIES.has(currency) ? currency : 'USD',
    language: ALLOWED_LANGUAGES.has(languageCandidate) ? languageCandidate : 'en-us',
    scrapeDetails,
    maxImages: clampInteger(input.maxImages, 10, 1, 50),
    proxyConfiguration,
    allowResidentialFallback: input.allowResidentialFallback === true,
    maxPagesPerSearch: clampInteger(input.maxPagesPerSearch, 4, 1, 40),
    trackChanges,
    monitorName,
    priceChangeThresholdPercent: clampNumber(input.priceChangeThresholdPercent, 5, 0, 100),
    observationHistoryLimit: clampInteger(input.observationHistoryLimit, 10, 2, 30),
  };
}

export function normalizeSearchUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const urls: string[] = [];
  for (const rawValue of value) {
    const rawUrl = cleanText(rawValue);
    if (!rawUrl) continue;

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid Booking.com search URL: ${rawUrl}`);
    }

    const hostname = url.hostname.toLowerCase();
    if (!(hostname === 'booking.com' || hostname.endsWith('.booking.com'))) {
      throw new Error(`searchUrls only accepts Booking.com URLs: ${rawUrl}`);
    }
    // Booking's public search links include localized filenames such as
    // searchresults.en-gb.html, not only searchresults.html. Keep the exact
    // search route and preserve its stay, destination identity and filters.
    if (!/^\/searchresults(?:\.(?:[a-z]{2,3}(?:-[a-z]{2})?\.)?html)?\/?$/i.test(url.pathname)) {
      throw new Error(`Use a Booking.com search-results URL, not a property or homepage URL: ${rawUrl}`);
    }

    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS Booking.com search URL without embedded credentials.');
    url.hash = '';
    urls.push(url.toString());
  }

  return [...new Set(urls)].slice(0, 50);
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
 * Apify proxy group, this returns the cheap datacenter pool. Residential is added
 * only with explicit consent to the costlier fallback. Pinned groups are preserved.
 */
export function buildProxyTiers(value: ProxyConfigInput, allowResidentialFallback = false): ProxyTier[] {
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

  const tiers: ProxyTier[] = [
    {
      label: 'datacenter proxy',
      options: toProxyConfigurationOptions(value),
    },
  ];
  if (allowResidentialFallback) {
    tiers.push({
      label: 'residential proxy fallback',
      options: toProxyConfigurationOptions({ ...value, apifyProxyGroups: [...RESIDENTIAL_GROUPS] }),
    });
  }
  return tiers;
}

export function requiresCloudProxy(value: ProxyConfigInput, isCloudRun: boolean): boolean {
  return isCloudRun
    && value.useApifyProxy === false
    && !value.proxyUrls?.length;
}

/** Fill omitted URL context, but reject expired or contradictory dates before paid navigation. */
export function resolveSearchContext(searchUrl: string, input: NormalizedInput, today = new Date()) {
  const url = new URL(searchUrl);
  const checkIn = url.searchParams.has('checkin') ? validateDateInput(url.searchParams.get('checkin'), 'URL checkin') : input.checkIn;
  const checkOut = url.searchParams.has('checkout') ? validateDateInput(url.searchParams.get('checkout'), 'URL checkout') : url.searchParams.has('checkin') ? addDays(checkIn, 1) : input.checkOut;
  if (checkIn <= localDateString(today)) throw new Error('The search URL checkin is expired. Update its dates or omit dates to use future defaults.');
  if (checkOut <= checkIn) throw new Error('The search URL checkout must be after checkin.');
  url.searchParams.set('checkin', checkIn); url.searchParams.set('checkout', checkOut);
  const adults = url.searchParams.has('group_adults') ? strictInteger(url.searchParams.get('group_adults'), 'URL group_adults', 1, 30) : input.adults;
  const rooms = url.searchParams.has('no_rooms') ? strictInteger(url.searchParams.get('no_rooms'), 'URL no_rooms', 1, 30) : input.rooms;
  const hasChildren = url.searchParams.has('group_children') || url.searchParams.has('age');
  const ages = hasChildren ? url.searchParams.getAll('age').map(age => strictInteger(age, 'URL age', 0, 17)) : input.childrenAges;
  if (ages.length > 10 || (url.searchParams.has('group_children') && strictInteger(url.searchParams.get('group_children'), 'URL group_children', 0, 10) !== ages.length)) {
    throw new Error('Provide one age parameter for each child in the search URL.');
  }
  const currency = (url.searchParams.get('selected_currency') ?? input.currency).toUpperCase();
  if (!ALLOWED_CURRENCIES.has(currency)) throw new Error('Unsupported selected_currency in Booking.com search URL.');
  const language = (url.searchParams.get('lang') ?? input.language).toLowerCase();
  if (!ALLOWED_LANGUAGES.has(language)) throw new Error('Unsupported lang in Booking.com search URL.');
  url.searchParams.set('group_adults', String(adults)); url.searchParams.set('no_rooms', String(rooms));
  url.searchParams.set('group_children', String(ages.length)); url.searchParams.delete('age');
  ages.forEach(age => url.searchParams.append('age', String(age)));
  url.searchParams.set('selected_currency', currency); url.searchParams.set('lang', language);
  return { searchUrl: url.toString(), checkIn, checkOut, adults, rooms, childrenAges: ages, currency, language };
}

function strictInteger(value: unknown, name: string, min: number, max: number): number {
  if (value === '' || value === null || !/^\d+$/.test(String(value))) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  const n = Number(value); if (n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return n;
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

function normalizeOptionalNumber(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null || cleanText(value) === '') return null;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
  }
  return numericValue;
}

function normalizeIntegerArray(
  value: unknown,
  minimum: number,
  maximum: number,
  maxItems: number,
  unique: boolean,
): number[] {
  if (!Array.isArray(value)) return [];
  const values = value.map(Number)
    .filter((item) => Number.isInteger(item) && item >= minimum && item <= maximum);
  return (unique ? [...new Set(values)] : values).slice(0, maxItems);
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
