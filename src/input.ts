import type { ActorInput, NormalizedInput } from './types.js';

const DEFAULT_PROXY_CONFIGURATION = {
  useApifyProxy: true,
  apifyProxyGroups: ['RESIDENTIAL'],
};

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

  const checkIn = validateDateInput(input.checkIn, 'checkIn');
  const checkOut = validateDateInput(input.checkOut, 'checkOut');

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
    maxResults: clampInteger(input.maxResults, 1, 1, 500),
    currency: ALLOWED_CURRENCIES.has(currency) ? currency : 'USD',
    proxyConfiguration: input.proxyConfiguration ?? DEFAULT_PROXY_CONFIGURATION,
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

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function localDateString(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
