import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInput,
  normalizeProxyConfiguration,
  requiresCloudProxy,
  toProxyConfigurationOptions,
} from './input.js';
import {
  buildSearchUrl,
  classifyBookingDocument,
  countNights,
  decidePageProgress,
  extractIdFromHref,
  extractPropertyFromSnapshot,
  normalizeBookingUrl,
  parseMoney,
  parseReviewCount,
  parseReviewScore,
  parseStarRating,
} from './routes.js';
import type { SearchState } from './types.js';

const fixedToday = new Date(2026, 6, 1);

test('normalizes Booking.com input and clamps limits', () => {
  const input = normalizeInput({
    destinations: [' London, United Kingdom ', 'London, United Kingdom', ''],
    checkIn: '2026-08-15',
    checkOut: '2026-08-16',
    adults: 99,
    rooms: 0,
    minReviewScore: 99,
    maxResults: 999,
    currency: 'inr',
  }, fixedToday);

  assert.deepEqual(input.destinations, ['London, United Kingdom']);
  assert.equal(input.adults, 30);
  assert.equal(input.rooms, 1);
  assert.equal(input.minReviewScore, 10);
  assert.equal(input.maxResults, 500);
  assert.equal(input.currency, 'INR');
  assert.deepEqual(input.proxyConfiguration, {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
  });
});

test('defaults maxResults to one full results page so a run never pays a whole page fetch for a single row', () => {
  const input = normalizeInput({
    destinations: ['London, United Kingdom'],
    checkIn: '2026-08-15',
    checkOut: '2026-08-16',
  }, fixedToday);

  assert.equal(input.maxResults, 25);
});

test('still honours an explicit low maxResults', () => {
  const input = normalizeInput({
    destinations: ['London, United Kingdom'],
    checkIn: '2026-08-15',
    checkOut: '2026-08-16',
    maxResults: 1,
  }, fixedToday);

  assert.equal(input.maxResults, 1);
});

test('uses durable dynamic dates when date input is omitted', () => {
  const input = normalizeInput({ destinations: ['London'] }, fixedToday);
  assert.equal(input.checkIn, '2026-07-31');
  assert.equal(input.checkOut, '2026-08-01');
});

test('rejects missing destinations, stale dates, invalid dates, and reversed ranges', () => {
  assert.throws(() => normalizeInput({ destinations: [] }, fixedToday), /destination/);
  assert.throws(() => normalizeInput({
    destinations: ['London'],
    checkIn: '2026-07-01',
    checkOut: '2026-07-02',
  }, fixedToday), /future/);
  assert.throws(() => normalizeInput({
    destinations: ['London'],
    checkIn: '2026-02-31',
    checkOut: '2026-03-01',
  }, fixedToday), /valid date/);
  assert.throws(() => normalizeInput({
    destinations: ['London'],
    checkIn: '2026-08-16',
    checkOut: '2026-08-15',
  }, fixedToday), /after checkIn/);
});

test('preserves direct, custom, and country-specific proxy intent', () => {
  assert.deepEqual(normalizeProxyConfiguration({ useApifyProxy: false }), {
    useApifyProxy: false,
  });
  assert.deepEqual(
    normalizeProxyConfiguration({
      useApifyProxy: false,
      apifyProxyGroups: ['RESIDENTIAL'],
      proxyUrls: [' http://proxy.example:8000 '],
    }),
    { useApifyProxy: false, proxyUrls: ['http://proxy.example:8000'] },
  );
  assert.deepEqual(
    toProxyConfigurationOptions(normalizeProxyConfiguration({
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'gb',
    })),
    { useApifyProxy: true, groups: ['RESIDENTIAL'], countryCode: 'GB' },
  );
  assert.throws(
    () => normalizeProxyConfiguration({
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      proxyUrls: ['http://proxy.example:8000'],
    }),
    /cannot combine/,
  );
  assert.equal(requiresCloudProxy({ useApifyProxy: false }, true), true);
  assert.equal(requiresCloudProxy({ useApifyProxy: false }, false), false);
  assert.equal(requiresCloudProxy({
    useApifyProxy: false,
    proxyUrls: ['http://proxy.example:8000'],
  }, true), false);
});

test('classifies Booking.com block and genuine no-result pages', () => {
  assert.equal(classifyBookingDocument('Security check', 'Verify you are human'), 'blocked');
  assert.equal(
    classifyBookingDocument(
      'Booking.com',
      'In order to continue, we need to verify that you are not a robot.',
    ),
    'blocked',
  );
  assert.equal(classifyBookingDocument('Booking.com', '', true), 'blocked');
  assert.equal(classifyBookingDocument('Booking.com', 'No properties found for these dates'), 'no-results');
  assert.equal(classifyBookingDocument('Hotels in London', '125 properties found'), 'normal');
});

test('retries malformed cards, continues filtered pages, and bounds pagination', () => {
  assert.equal(decidePageProgress({
    cardCount: 25, extractedCount: 0, newCount: 0, duplicateCount: 0,
    filteredCount: 0, offset: 0, pageSize: 25,
  }), 'retry');
  assert.equal(decidePageProgress({
    cardCount: 25, extractedCount: 25, newCount: 0, duplicateCount: 0,
    filteredCount: 25, offset: 0, pageSize: 25,
  }), 'next');
  assert.equal(decidePageProgress({
    cardCount: 25, extractedCount: 25, newCount: 0, duplicateCount: 25,
    filteredCount: 0, offset: 25, pageSize: 25,
  }), 'stop');
  assert.equal(decidePageProgress({
    cardCount: 25, extractedCount: 25, newCount: 25, duplicateCount: 0,
    filteredCount: 0, offset: 975, pageSize: 25,
  }), 'stop');
});

test('builds Booking.com search URLs with property filters', () => {
  const state: SearchState = {
    destination: 'London, United Kingdom',
    checkIn: '2026-08-15',
    checkOut: '2026-08-16',
    adults: 2,
    rooms: 1,
    propertyTypes: ['Hotels', 'Apartments', 'Unknown'],
    minReviewScore: 0,
    maxResults: 1,
    currency: 'USD',
    collectedCount: 0,
    examinedCount: 0,
    seenIds: [],
    offset: 25,
    pageSize: 25,
    hasMore: true,
  };

  const url = new URL(buildSearchUrl(state));
  assert.equal(url.hostname, 'www.booking.com');
  assert.equal(url.searchParams.get('ss'), 'London, United Kingdom');
  assert.equal(url.searchParams.get('checkin'), '2026-08-15');
  assert.equal(url.searchParams.get('checkout'), '2026-08-16');
  assert.equal(url.searchParams.get('group_adults'), '2');
  assert.equal(url.searchParams.get('selected_currency'), 'USD');
  assert.equal(url.searchParams.get('nflt'), 'ht_id=201;ht_id=203');
});

test('parses Booking.com card values', () => {
  assert.equal(parseMoney('Original price US$1,234. Current price US$987'), 1234);
  assert.equal(parseMoney('987 USD'), 987);
  assert.equal(parseMoney('Rs. 9,999'), 9999);
  assert.equal(parseReviewScore('Scored 8.7 out of 10'), 8.7);
  assert.equal(parseReviewScore('8,1'), 8.1);
  assert.equal(parseReviewCount('1,234 reviews'), 1234);
  assert.equal(parseStarRating('4 out of 5 stars'), 4);
  assert.equal(countNights('2026-08-15', '2026-08-18'), 3);
  assert.equal(extractIdFromHref('/hotel/gb/royal-national.html?aid=1'), 'royal-national');
  assert.equal(
    normalizeBookingUrl('/hotel/gb/royal-national.html?aid=1#map'),
    'https://www.booking.com/hotel/gb/royal-national.html',
  );
});

test('builds a hotel record from one browser card snapshot', () => {
  const state: SearchState = {
    destination: 'New Delhi, India',
    checkIn: '2026-09-10',
    checkOut: '2026-09-12',
    adults: 2,
    rooms: 1,
    propertyTypes: [],
    minReviewScore: 0,
    maxResults: 5,
    currency: 'INR',
    collectedCount: 0,
    examinedCount: 0,
    seenIds: [],
    offset: 0,
    pageSize: 25,
    hasMore: true,
  };

  const record = extractPropertyFromSnapshot({
    href: '/hotel/in/example-stay.html?aid=123',
    propertyId: '12345',
    hotelName: ' Example Stay ',
    cardText: 'Example Stay 1,234 reviews Free cancellation Genius',
    totalText: 'INR 4,000',
    perNightText: null,
    originalText: 'INR 5,000',
    rateInfo: null,
    reviewScoreAria: 'Scored 8.7 out of 10',
    reviewScoreText: null,
    reviewScoreLinkText: null,
    starLabel: '4 out of 5 stars',
    distanceText: '1.2 km from downtown',
    thumbnailSrc: 'https://images.example/hotel.jpg',
  }, state, '2026-08-09T00:00:00.000Z');

  assert.ok(record);
  assert.equal(record.propertyId, '12345');
  assert.equal(record.hotelName, 'Example Stay');
  assert.equal(record.totalPrice, 4000);
  assert.equal(record.pricePerNight, 2000);
  assert.equal(record.originalPrice, 5000);
  assert.equal(record.discountPercentage, 20);
  assert.equal(record.guestReviewScore, 8.7);
  assert.equal(record.reviewCount, 1234);
  assert.equal(record.starRating, 4);
  assert.equal(record.freeCancellation, true);
  assert.equal(record.geniusDiscount, true);
  assert.equal(record.propertyUrl, 'https://www.booking.com/hotel/in/example-stay.html');
});
