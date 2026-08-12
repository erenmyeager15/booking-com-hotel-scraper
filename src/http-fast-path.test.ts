import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractPropertyFromHtml } from './http-fast-path.js';
import type { SearchState } from './types.js';

function state(overrides: Partial<SearchState> = {}): SearchState {
  return {
    destination: 'London, United Kingdom',
    checkIn: '2026-09-10',
    checkOut: '2026-09-12',
    adults: 2,
    rooms: 1,
    propertyTypes: [],
    minReviewScore: 0,
    maxResults: 25,
    currency: 'GBP',
    collectedCount: 0,
    examinedCount: 0,
    seenIds: [],
    offset: 0,
    pageSize: 25,
    hasMore: true,
    ...overrides,
  };
}

test('extracts a complete Booking property card without a browser', () => {
  const $ = cheerio.load(`
    <article data-testid="property-card" data-property-id="12345">
      <a data-testid="title-link" href="/hotel/gb/northstar.html?aid=1">
        <span data-testid="title">Northstar Hotel</span>
      </a>
      <span aria-label="4 out of 5 stars"></span>
      <div data-testid="review-score" aria-label="Scored 8.7 out of 10">8.7</div>
      <span>1,234 reviews</span>
      <span data-testid="distance">1.2 km from centre</span>
      <span data-testid="price-and-discounted-price">GBP 240</span>
      <span data-testid="original-price">GBP 300</span>
      <span>Free cancellation</span>
      <span>Genius discount</span>
      <img data-testid="image" src="https://images.example/hotel.jpg">
    </article>
  `);

  const record = extractPropertyFromHtml(
    $('[data-testid="property-card"]').first(),
    state(),
    '2026-08-09T00:00:00.000Z',
  );

  assert.ok(record);
  assert.equal(record.propertyId, '12345');
  assert.equal(record.hotelName, 'Northstar Hotel');
  assert.equal(record.starRating, 4);
  assert.equal(record.guestReviewScore, 8.7);
  assert.equal(record.reviewCount, 1234);
  assert.equal(record.totalPrice, 240);
  assert.equal(record.pricePerNight, 120);
  assert.equal(record.originalPrice, 300);
  assert.equal(record.discountPercentage, 20);
  assert.equal(record.freeCancellation, true);
  assert.equal(record.geniusDiscount, true);
  assert.equal(record.city, 'London');
  assert.equal(record.country, 'United Kingdom');
  assert.equal(record.propertyUrl, 'https://www.booking.com/hotel/gb/northstar.html');
});

test('rejects incomplete server-rendered cards so the browser can handle them', () => {
  const $ = cheerio.load(`
    <article data-testid="property-card" data-property-id="12345">
      <span data-testid="title">Missing URL Hotel</span>
    </article>
  `);

  assert.equal(
    extractPropertyFromHtml($('[data-testid="property-card"]').first(), state()),
    null,
  );
});
