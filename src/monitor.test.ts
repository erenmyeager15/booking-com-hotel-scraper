import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMonitor, prepareRateChange, monitorStoreName } from './monitor.js';
import { addRateEvidence } from './rate-evidence.js';
import { parseMoney } from './money.js';
import { normalizeInput, resolveSearchContext } from './input.js';
import { hasSearchContext, extractPropertyFromSnapshot, buildSearchUrl } from './routes.js';
import type { HotelRecord, SearchState } from './types.js';
import { SearchStateRegistry } from './search-state.js';

const today = new Date('2026-10-07T10:00:00Z');
const search: SearchState = { destination: 'London', checkIn: '2026-11-07', checkOut: '2026-11-09',
  adults: 2, rooms: 1, childrenAges: [5], propertyTypes: [], minReviewScore: 0, maxResults: 25,
  currency: 'GBP', language: 'en-us', collectedCount: 0, examinedCount: 0, seenIds: [], offset: 0,
  pageSize: 25, hasMore: true };
const options = { monitorName: 'london-test', market: 'GB', threshold: 5, historyLimit: 3 };
test('serialized search and detail requests retain one live progress state', () => {
  const registry = new SearchStateRegistry();
  const initial = registry.restore({ ...search, requestNamespace: '0:0', coverage: { status: 'pending', successfulPages: 0, reason: null } });
  const staleDetailCopy = JSON.parse(JSON.stringify(initial)) as SearchState;
  const loadedSearch = registry.restore(JSON.parse(JSON.stringify(initial)) as SearchState);
  loadedSearch.collectedCount = 25;
  loadedSearch.offset = 25;
  loadedSearch.coverage!.successfulPages = 1;
  loadedSearch.coverage!.status = 'limited';
  loadedSearch.coverage!.reason = 'max_results';
  assert.equal(initial.collectedCount, 25);
  assert.equal(registry.restore(staleDetailCopy).coverage?.status, 'limited');
  assert.equal(registry.restore(staleDetailCopy).offset, 25);
});

test('progress stays isolated across duplicate destinations and proxy attempts', () => {
  const registry = new SearchStateRegistry();
  const first = registry.restore({ ...search, requestNamespace: '0:0' });
  first.collectedCount = 10;
  assert.equal(registry.restore({ ...search, requestNamespace: '0:1' }).collectedCount, 0);
  assert.equal(registry.restore({ ...search, requestNamespace: '1:0' }).collectedCount, 0);
});

function hotel(price = 200, overrides: Partial<HotelRecord> = {}): HotelRecord {
  const record = extractPropertyFromSnapshot({href: '/hotel/gb/example.html', propertyId: '1', hotelName: 'Example',
    cardText: 'Includes taxes and fees. Free cancellation', totalText: `GBP ${price}`, perNightText: null,
    originalText: null, rateInfo: null, reviewScoreAria: null, reviewScoreText: null, reviewScoreLinkText: null,
    starLabel: null, distanceText: null, thumbnailSrc: null}, search, '2026-10-07T10:00:00Z')!;
  return { ...addRateEvidence(record, search, `GBP ${price}`, null, 'Includes taxes and fees. Free cancellation', true), ...overrides };
}

test('rate baseline advances only after the record has been saved', () => {
  const state = emptyMonitor(), first = prepareRateChange(hotel(), state, options);
  assert.equal(first.record.rateChange?.status, 'baseline');
  assert.deepEqual(state.rates, {});
  first.commit();
  const next = prepareRateChange(hotel(180, {scrapedAt: '2026-10-08T10:00:00Z'}), state, options);
  assert.equal(next.record.rateChange?.status, 'price_drop');
  assert.equal(next.record.rateChange?.priceChangePercent, -10);
  assert.equal(next.record.rateChange?.alert, true);
  assert.equal(next.record.rateChange?.previousTotalPrice, 200);
});

test('changed stay, child ages, currency, filters or market starts a separate baseline', () => {
  const state = emptyMonitor(); prepareRateChange(hotel(), state, options).commit();
  for (const record of [hotel(150,{checkIn:'2026-11-08'}),hotel(150,{childrenAges:[6]}),
    hotel(150,{sourceUrl:buildSearchUrl({...search,stars:[5]})}),hotel(150,{currency:'USD'})]) {
    assert.equal(prepareRateChange(record,state,options).record.rateChange?.status,'baseline');
  }
  assert.equal(prepareRateChange(hotel(150),state,{...options,market:'US'}).record.rateChange?.status,'baseline');
});

test('different offer terms and unknown evidence never manufacture price alerts', () => {
  const state=emptyMonitor(); prepareRateChange(hotel(),state,options).commit();
  const different=prepareRateChange(hotel(100,{freeCancellation:false}),state,options).record.rateChange!;
  assert.equal(different.status,'not_comparable'); assert.equal(different.alert,false);
  const unknown=addRateEvidence(hotel(100),search,'$100',null,'price only',true);
  const unsafe=prepareRateChange(unknown,state,options).record.rateChange!;
  assert.equal(unsafe.status,'not_comparable'); assert.equal(unsafe.totalPriceChange,null);
  assert.equal(unsafe.alert,false);
  assert.equal(prepareRateChange(hotel(),state,{...options,market:'unfixed'}).record.rateChange?.reason,'proxy_market_not_fixed');
});

test('history is bounded and unchanged prices do not alert even at zero threshold', () => {
  const state=emptyMonitor();
  for(let i=0;i<8;i++)prepareRateChange(hotel(200,{scrapedAt:`2026-10-0${i+1}T10:00:00Z`}),state,options).commit();
  const next=prepareRateChange(hotel(),state,{...options,threshold:0}).record.rateChange!;
  assert.equal(next.observations.length,3); assert.equal(next.status,'unchanged'); assert.equal(next.alert,false);
});

test('monitor store names isolate account, Actor and monitor without exposing names', () => {
  assert.notEqual(monitorStoreName('a','booking','same'),monitorStoreName('b','booking','same'));
  assert.notEqual(monitorStoreName('a','booking','same'),monitorStoreName('a','other','same'));
  assert.notEqual(monitorStoreName('a','booking','same'),monitorStoreName('a','booking','different'));
});

test('currency and tax evidence flag actual conflicts rather than guessing all-in prices', () => {
  const mismatch=addRateEvidence(hotel(),search,'US$200',null,'Excludes taxes and fees',true);
  assert.equal(mismatch.rateEvidence?.currencyStatus,'mismatch');
  assert.equal(mismatch.rateEvidence?.observedCurrency,'USD');
  assert.equal(mismatch.rateEvidence?.taxStatus,'excluded');
  const mixed=addRateEvidence(hotel(),search,'£200',null,'Includes taxes and fees. Plus taxes and charges',true);
  assert.equal(mixed.rateEvidence?.taxStatus,'mixed');
});

test('money parser preserves decimals and thousands across common Booking locales', () => {
  for(const [text,amount] of [['EUR 1.234,56',1234.56],['€1 234,56',1234.56],['GBP 1,234.56',1234.56],
    ['JPY 1,234',1234],['INR 1,23,456',123456],['US$280 for 2 nights',280]] as const)assert.equal(parseMoney(text),amount);
});

test('dedicated tax labels preserve evidence without inventing an inclusive total', () => {
  for (const label of ['Incl. taxes and charges', 'Taxes & charges are included', 'Includes all taxes']) {
    const record = addRateEvidence(hotel(), search, 'GBP 200', null, 'unrelated card text', true, label);
    assert.equal(record.rateEvidence?.taxStatus, 'included');
    assert.ok(record.rateEvidence?.taxText?.includes('tax') || record.rateEvidence?.taxText?.includes('Tax'));
  }
  for (const label of ['Taxes & charges are not included', 'Excludes all taxes', '+ GBP 20 taxes and charges', '+£40 taxes and charges']) {
    assert.equal(addRateEvidence(hotel(), search, 'GBP 200', null, '', true, label).rateEvidence?.taxStatus, 'excluded');
  }
  assert.equal(addRateEvidence(hotel(), search, 'GBP 200', null, '', true, 'Taxes and charges').rateEvidence?.taxStatus, 'unknown');
  assert.equal(addRateEvidence(hotel(), search, 'GBP 200', null, 'Includes taxes and fees', true, 'Tax treatment unavailable').rateEvidence?.taxStatus, 'unknown');
});

test('empty API input has usable defaults while deliberate empty destinations fail', () => {
  assert.deepEqual(normalizeInput({},today).destinations,['London, United Kingdom']);
  assert.throws(()=>normalizeInput({destinations:[]},today),/destination/);
  assert.equal(normalizeInput({},today).allowResidentialFallback,false);
});

test('saved search URL dates, guests and currency resolve before navigation', () => {
  const input=normalizeInput({},today);
  const resolved=resolveSearchContext('https://www.booking.com/searchresults.html?ss=London',input,today);
  assert.equal(resolved.checkIn,input.checkIn); assert.equal(resolved.currency,'USD');
  assert.equal(new URL(resolved.searchUrl).searchParams.get('checkin'),input.checkIn);
  assert.throws(()=>resolveSearchContext('https://www.booking.com/searchresults.html?ss=London&checkin=2026-09-01',input,today),/expired/);
  assert.throws(()=>resolveSearchContext('https://www.booking.com/searchresults.html?ss=London&checkin=2026-11-01&checkout=2026-10-31',input,today),/after/);
  assert.throws(()=>resolveSearchContext('https://www.booking.com/searchresults.html?ss=London&group_children=2&age=5',input,today),/one age/);
});

test('loaded search must preserve dates, occupancy and currency to establish context', () => {
  const url=buildSearchUrl(search); assert.equal(hasSearchContext(url,search),true);
  for(const [key,value]of [['checkin','2026-11-08'],['group_adults','3'],['selected_currency','USD']]){
    const changed=new URL(url);changed.searchParams.set(key,value);assert.equal(hasSearchContext(changed.toString(),search),false);
  }
});
