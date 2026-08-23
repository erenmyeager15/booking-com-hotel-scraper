import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichHotelRecord, parseRoomOption } from './details.js';
import type { HotelRecord } from './types.js';

test('parses room prices, occupancy, meal plans, cancellation, and scarce inventory', () => {
  const room = parseRoomOption({
    roomName: 'Deluxe King Room',
    bedType: '1 king bed',
    occupancyText: 'Max 3 guests',
    priceText: 'INR12,450',
    conditionsText: 'Breakfast included · Free cancellation before 6 PM',
    availabilityText: 'Only 2 rooms left',
    amenities: ['Air conditioning', 'Free WiFi', 'Air conditioning'],
  }, 'USD');

  assert.equal(room.roomName, 'Deluxe King Room');
  assert.equal(room.occupancy, 3);
  assert.equal(room.totalPrice, 12450);
  assert.equal(room.currency, 'INR');
  assert.equal(room.mealPlan, 'Breakfast included');
  assert.equal(room.freeCancellation, true);
  assert.equal(room.refundable, true);
  assert.equal(room.unitsLeft, 2);
  assert.deepEqual(room.amenities, ['Air conditioning', 'Free WiFi']);
});

test('prefers the requested currency pair over a trailing local-conversion label', () => {
  const room = parseRoomOption({
    roomName: 'Superior King Room',
    bedType: '1 king bed',
    occupancyText: '2 guests',
    priceText: '$539 · INR conversion available',
    conditionsText: 'Free cancellation',
    availabilityText: 'Available',
    amenities: [],
  }, 'USD');

  assert.equal(room.totalPrice, 539);
  assert.equal(room.currency, 'USD');
});

test('enriches a search card with property and room-level detail', () => {
  const base: HotelRecord = {
    propertyId: 'northstar',
    hotelName: 'Northstar',
    starRating: 4,
    guestReviewScore: 8.7,
    reviewCount: 100,
    city: 'London',
    country: 'United Kingdom',
    distanceFromCityCenter: '1 km',
    totalPrice: null,
    pricePerNight: null,
    originalPrice: null,
    discountPercentage: null,
    currency: 'GBP',
    freeCancellation: false,
    propertyUrl: 'https://www.booking.com/hotel/gb/northstar.html',
    thumbnailImageUrl: 'https://images.example/thumb.jpg',
    sustainabilityBadge: false,
    geniusDiscount: false,
    available: true,
    availabilityStatus: 'available',
    checkIn: '2026-09-10',
    checkOut: '2026-09-12',
    nights: 2,
    adults: 2,
    children: 0,
    rooms: 1,
    scrapeMode: 'fast',
    billingTier: 'fast',
    sourceUrl: 'https://www.booking.com/searchresults.html?ss=London',
    address: null,
    description: null,
    latitude: null,
    longitude: null,
    checkInTime: null,
    checkOutTime: null,
    facilities: [],
    imageUrls: [],
    roomOptions: [],
    surroundings: [],
    destination: 'London, United Kingdom',
    scrapedAt: '2026-08-23T00:00:00.000Z',
  };

  const enriched = enrichHotelRecord(base, {
    title: 'Northstar Hotel London',
    address: '1 Example Street, London',
    description: 'A central hotel.',
    latitude: '51.5074',
    longitude: '-0.1278',
    checkInTime: 'From 15:00',
    checkOutTime: 'Until 11:00',
    facilities: ['Free WiFi', 'Restaurant'],
    imageUrls: ['https://images.example/full.jpg'],
    surroundings: ['Central Station · 500 m'],
    roomRows: [{
      roomName: 'Double Room',
      bedType: '1 queen bed',
      occupancyText: '2 guests',
      priceText: 'GBP 240',
      conditionsText: 'Free cancellation · Breakfast included',
      availabilityText: '1 room left',
      amenities: ['Private bathroom'],
    }],
    bodyText: 'Rooms available for your dates',
  });

  assert.equal(enriched.scrapeMode, 'detailed');
  assert.equal(enriched.hotelName, 'Northstar Hotel London');
  assert.equal(enriched.totalPrice, 240);
  assert.equal(enriched.pricePerNight, 120);
  assert.equal(enriched.latitude, 51.5074);
  assert.equal(enriched.roomOptions.length, 1);
  assert.equal(enriched.roomOptions[0].occupancy, 2);
  assert.equal(enriched.freeCancellation, true);
  assert.deepEqual(enriched.imageUrls, [
    'https://images.example/thumb.jpg',
    'https://images.example/full.jpg',
  ]);
});
