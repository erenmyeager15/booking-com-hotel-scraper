import test from 'node:test';
import assert from 'node:assert/strict';
import { Actor } from 'apify';
import { chromium } from 'playwright';
import { router, buildSearchUrl } from './routes.js';
import { emptyMonitor, prepareRateChange } from './monitor.js';
import type { HotelRecord, SearchState } from './types.js';
import { bookingCompletionStatus } from './completion.js';
import { browserSearchDiagnostic } from './search-evidence.js';
import { advanceRenderedResults } from './browser-continuation.js';
import { bookingNavigationOptions, waitForBookingDocument } from './navigation.js';

test('empty rendered search stops without hotel charges, retries or exposing page contents', async () => {
  const browser = await chromium.launch({ headless: true }), originalPush = Actor.pushData;
  let charges = 0, visits = 0;
  Actor.pushData = (async () => { charges++; throw new Error('No hotel may be billed'); }) as unknown as typeof Actor.pushData;
  try {
    const page = await browser.newPage(), state = stateFor('empty-search-diagnostic', 25);
    await page.route('**/*', route => {
      visits++;
      return route.fulfill({ contentType: 'text/html', body: '<title>private-page-title</title>'
        + '<input name="ss" value=""><input name="checkin" value="private-date">'
        + '<button data-testid="occupancy-config">private-guests</button>'
        + '<a href="https://private.example/secret">private-text</a>' });
    });
    const request = { url: buildSearchUrl(state), label: 'search', noRetry: false, userData: { state } };
    await page.goto(request.url);
    // Exercise the actual timeout branch without spending 18 seconds on a
    // fully intercepted page whose absence of cards is deterministic.
    page.waitForSelector = (async () => { throw new Error('fixture card wait expired'); }) as typeof page.waitForSelector;
    const warnings: unknown[] = [];
    await assert.rejects(async () => router({ page, request,
      log: { info: () => {}, debug: () => {}, warning: (_message: string, details: unknown) => warnings.push(details) },
      crawler: { addRequests: () => { throw new Error('No retry or next page permitted'); } },
    } as unknown as Parameters<typeof router>[0]), /PROPERTY_CARDS_NOT_RENDERED/);
    assert.equal(request.noRetry, true);
    assert.equal(charges, 0); assert.equal(visits, 1);
    assert.equal(state.coverage?.reason, 'source_search_not_rendered');
    assert.equal(bookingCompletionStatus([state], 1, false), 'partial');
    assert.equal(warnings.length, 1);
    const diagnostic = await browserSearchDiagnostic(page);
    assert.equal(diagnostic.emptyDestinationControls, 1);
    assert.equal(diagnostic.propertyLinks, 0);
    assert.equal(/private|London|2026-|2601889|booking\.com/.test(JSON.stringify(warnings)), false);
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

const stateFor = (name: string, maxResults: number): SearchState => ({
  destination: 'London, United Kingdom', requestNamespace: name,
  searchUrl: 'https://www.booking.com/searchresults.en-gb.html?ss=London%2C+Greater+London%2C+United+Kingdom&dest_id=-2601889&dest_type=city&checkin=2026-11-15&checkout=2026-11-17&group_adults=2&no_rooms=1&group_children=0&selected_currency=GBP&lang=en-gb',
  checkIn: '2026-11-15', checkOut: '2026-11-17', adults: 2, rooms: 1, childrenAges: [],
  propertyTypes: [], minReviewScore: 0, currency: 'GBP', language: 'en-gb',
  maxResults, collectedCount: 0, examinedCount: 0, seenIds: [], offset: 0, pageSize: 25,
  hasMore: true, maxPages: 4, coverage: { status: 'pending', successfulPages: 0, reason: null },
});

function fixtureHtml(offset: number, options: { destinationInput?: string; cardParameters?: Record<string, string>;
  datesLabel?: string; occupancyLabel?: string; currency?: string } = {}): string {
  const parameters = new URLSearchParams({ checkin: '2026-11-15', checkout: '2026-11-17',
    group_adults: '2', no_rooms: '1', group_children: '0', dest_id: '-2601889', dest_type: 'city', ...options.cardParameters });
  for (const [key, value] of [...parameters]) if (!value) parameters.delete(key);
  const card = (index: number) => '<div data-testid="property-card" style="height:150px"><div data-testid="property-card-container">'
    + `<a data-testid="title-link" href="https://www.booking.com/hotel/gb/offline-${index}.en-gb.html?${parameters.toString().replaceAll('&', '&amp;')}"><div data-testid="title">Offline hotel ${index}</div></a>`
    + `<span data-testid="price-and-discounted-price">£${219 + index}</span><span data-testid="price-for-x-nights">2 nights, 2 adults</span>`
    + '<span data-testid="taxes-and-charges">Includes taxes and charges</span></div></div>';
  return '<h1>London: 6,754 properties found</h1>' + (options.destinationInput ?? '<input name="ss" value="London">')
    + `<button data-testid="searchbox-dates-container">${options.datesLabel ?? 'Sun 15 Nov — Tue 17 Nov'}</button>`
    + `<button data-testid="occupancy-config" aria-label="Number of travellers and rooms. Currently selected: ${options.occupancyLabel ?? '2 adults · 0 children · 1 room'}"></button>`
    + `<button data-testid="header-currency-picker-trigger">${options.currency ?? 'GBP'}</button>`
    + Array.from({ length: 15 }, (_, index) => card(offset + index)).join('')
    + '<script>addEventListener("scroll",()=>{if(!document.getElementById("loaded")){const extra=document.createElement("div");extra.id="loaded";extra.innerHTML='
    + JSON.stringify(Array.from({ length: 15 }, (_, index) => card(offset + 15 + index)).join('')) + ';document.body.append(extra);}});</script>';
}

for (const wrongStay of [false, true]) {
  test(`deferred script stalls DOMContentLoaded: ${wrongStay ? 'wrong stay is rejected' : '25 verified hotels are saved without waiting for it'}`, async () => {
    const browser = await chromium.launch({ headless: true }), originalPush = Actor.pushData;
    const saved: HotelRecord[] = []; const events: string[] = [];
    let releaseScript!: () => void, visits = 0, scriptRequests = 0, domReady = false;
    const blockedScript = new Promise<void>(resolve => { releaseScript = resolve; });
    Actor.pushData = (async (record: HotelRecord, event: string) => {
      saved.push(record); events.push(event); return { chargedCount: 1, eventChargeLimitReached: false };
    }) as unknown as typeof Actor.pushData;
    try {
      const page = await browser.newPage(), state = stateFor(`deferred-script-${wrongStay}`, 25);
      page.on('domcontentloaded', () => { domReady = true; });
      await page.route('**/*', async route => {
        if (route.request().resourceType() === 'script') {
          scriptRequests++; await blockedScript;
          return route.fulfill({ contentType: 'text/javascript', body: '/* offline deferred script */' }).catch(() => {});
        }
        assert.equal(route.request().resourceType(), 'document'); visits++;
        return route.fulfill({ contentType: 'text/html', body:
          '<html><head><script defer src="https://www.booking.com/offline-deferred.js"></script></head><body>'
          + fixtureHtml(0, wrongStay ? { cardParameters: { checkin: '2027-01-01' } } : {}) + '</body></html>' });
      });
      const request = { url: buildSearchUrl(state), label: 'search', noRetry: false, userData: { state } };
      await page.goto(request.url, bookingNavigationOptions());
      await waitForBookingDocument(page);
      assert.equal(domReady, false, 'deferred script must still block DOMContentLoaded');
      const collect = async () => router({ page, request,
        log: { info: () => {}, warning: () => {}, debug: () => {} },
        crawler: { addRequests: () => { throw new Error('No retry or extra page allowed'); } },
      } as unknown as Parameters<typeof router>[0]);
      if (wrongStay) await assert.rejects(collect, /BOOKING_RENDERED_SEARCH_MISMATCH/);
      else await collect();
      assert.equal(saved.length, wrongStay ? 0 : 25);
      assert.equal(new Set(saved.map(row => row.propertyId)).size, saved.length);
      assert.ok(events.every(event => event === 'hotel-scraped'));
      assert.ok(saved.every(row => row.rateEvidence?.searchContextVerified && row.rateEvidence.currencyStatus === 'confirmed'));
      assert.equal(domReady, false); assert.equal(visits, 1); assert.equal(scriptRequests, 1);
    } finally { releaseScript(); Actor.pushData = originalPush; await browser.close(); }
  });
}

for (const scenario of [
  { mode: 'append', limit: 25 }, { mode: 'append', limit: 50 },
  { mode: 'replace', limit: 50 }, { mode: 'changed-stay', limit: 25 },
  { mode: 'denied', limit: 25 }, { mode: 'cap', limit: 25 }, { mode: 'stalled', limit: 25 },
  { mode: 'retained-http', limit: 25 },
  { mode: 'delayed-control', limit: 25 }, { mode: 'delayed-append', limit: 25 }, { mode: 'delayed-denied', limit: 25 },
  { mode: 'delayed-changed-stay', limit: 25 },
] as const) {
  test(`source-rendered continuation: ${scenario.mode}/${scenario.limit} uses one document and exact unique charges`, async () => {
    const browser = await chromium.launch({ headless: true }), originalPush = Actor.pushData;
    const saved: HotelRecord[] = []; let visits = 0;
    let afterFirstBatch = async () => {};
    Actor.pushData = (async (record: HotelRecord) => {
      saved.push(record); if (saved.length === 20) await afterFirstBatch();
      return { chargedCount: 1, eventChargeLimitReached: false };
    }) as unknown as typeof Actor.pushData;
    try {
      const page = await browser.newPage(), state = stateFor(`rendered-${scenario.mode}-${scenario.limit}`, scenario.limit);
      if (scenario.mode === 'cap') state.maxPages = 1;
      const retainedCount = scenario.mode === 'retained-http' ? 20 : 0;
      if (retainedCount) {
        state.collectedCount = retainedCount;
        state.seenIds = Array.from({ length: retainedCount }, (_, i) => `offline-${i}`);
        state.coverage!.successfulPages = 1;
      }
      const html = fixtureHtml(0).replace(/<script>[\s\S]*$/, '')
        + '<button id="more">Load more results</button><script>'
        + `const mode=${JSON.stringify(scenario.mode)};let batch=0;window.moreClicks=0;`
        + `const template=document.querySelector('[data-testid="property-card"]').cloneNode(true);`
        + `function card(index){const root=template.cloneNode(true);const link=root.querySelector('[data-testid="title-link"]');link.href=link.href.replace(/offline-\\d+/, 'offline-'+index);root.querySelector('[data-testid="title"]').textContent='Hotel '+index;return root;}`
        + `for(let i=15;i<20;i++)document.body.insertBefore(card(i),document.getElementById('more'));`
        + `if(mode.startsWith('delayed-'))document.getElementById('more').hidden=true;
          window.revealMore=()=>setTimeout(()=>{
            if(mode==='delayed-append'){for(let i=20;i<25;i++)document.body.insertBefore(card(i),document.getElementById('more'));return;}
            if(mode==='delayed-denied'){document.body.innerHTML='<h1>Access denied</h1>';return;}
            if(mode==='delayed-changed-stay'){document.querySelector('[data-testid="searchbox-dates-container"]').textContent='1 Jan 2027 — 2 Jan 2027';return;}
            document.getElementById('more').hidden=false;
          },300);
          document.getElementById('more').onclick=()=>{window.moreClicks++;batch++;
          if(mode==='stalled')return;
          if(mode==='denied'){document.body.innerHTML='<h1>Access denied</h1>';return;}
          if(mode==='changed-stay')document.querySelector('[data-testid="searchbox-dates-container"]').textContent='1 Jan 2027 — 2 Jan 2027';
          if(mode==='replace')document.querySelectorAll('[data-testid="property-card"]').forEach(card=>card.remove());
          for(let i=batch*20;i<(batch+1)*20;i++)document.body.insertBefore(card(i),document.getElementById('more'));
        };</script>`;
      await page.route('**/*', route => {
        assert.equal(route.request().resourceType(), 'document'); visits++;
        assert.equal(visits, 1, 'offset URL navigation would repeat the same source page');
        return route.fulfill({ contentType: 'text/html', body: html });
      });
      const request = { url: buildSearchUrl(state), label: 'search', noRetry: false, userData: { state } };
      await page.goto(request.url);
      if (scenario.mode.startsWith('delayed-')) afterFirstBatch = async () => {
        await page.evaluate(() => (window as unknown as { revealMore: () => void }).revealMore());
      };
      const collect = async () => router({ page, request,
        log: { info: () => {}, warning: () => {}, debug: () => {} },
        crawler: { addRequests: () => { throw new Error('Must retain the current browser page'); } },
      } as unknown as Parameters<typeof router>[0]);
      if (['changed-stay', 'delayed-changed-stay'].includes(scenario.mode)) await assert.rejects(collect, /BOOKING_RENDERED_SEARCH_MISMATCH/);
      else if (['denied', 'delayed-denied'].includes(scenario.mode)) await assert.rejects(collect, /BOOKING_BLOCKED_AFTER_CONTINUATION/);
      else await collect();
      const incomplete = ['changed-stay', 'denied', 'cap', 'stalled', 'delayed-denied', 'delayed-changed-stay'].includes(scenario.mode);
      assert.equal(saved.length, (incomplete ? 20 : scenario.limit) - retainedCount);
      assert.equal(new Set(saved.map(row => row.propertyId)).size, saved.length);
      assert.equal(state.collectedCount, saved.length + retainedCount); assert.equal(visits, 1);
      if (retainedCount) assert.ok(saved.every(row => !Array.from({ length: 20 }, (_, i) => `offline-${i}`).includes(row.propertyId)));
      assert.equal(await page.evaluate(() => (window as unknown as { moreClicks: number }).moreClicks),
        ['cap', 'delayed-append', 'delayed-denied', 'delayed-changed-stay'].includes(scenario.mode) ? 0 : scenario.limit === 50 ? 2 : 1);
      if (scenario.mode === 'cap') assert.equal(state.coverage?.reason, 'page_cap');
      if (scenario.mode === 'stalled') {
        assert.equal(state.coverage?.reason, 'rendered_continuation_stalled');
        assert.equal(bookingCompletionStatus([state], 0, false), 'partial');
        assert.equal(request.noRetry, true);
      }
      if (!incomplete) assert.equal(state.coverage?.reason, 'max_results');
    } finally { Actor.pushData = originalPush; await browser.close(); }
  });
}

test('rendered continuation cannot count duplicates, hidden controls or ambiguous buttons as progress', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
      fixtureHtml(0).replace(/<script>[\s\S]*$/, '') + '<button onclick="window.clicks=(window.clicks||0)+1">Load more results</button>' }));
    await page.goto(buildSearchUrl(stateFor('rendered-stall', 25)));
    // Allow Playwright to scroll this below-the-fold control and establish
    // click stability under parallel browser load; assert it was clicked once.
    // The shorter 200 ms budget could expire before the fixture click occurred.
    assert.equal(await advanceRenderedResults(page, 2_000), 'stalled');
    assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 1);
    await page.evaluate(() => { const button = document.querySelector('button[onclick]')!; button.setAttribute('hidden', ''); });
    assert.equal(await advanceRenderedResults(page, 200), 'absent');
    await page.evaluate(() => { const button = document.querySelector('button[onclick]')!; button.removeAttribute('hidden'); document.body.append(button.cloneNode(true)); });
    assert.equal(await advanceRenderedResults(page, 200), 'stalled');
    assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 1);
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button[onclick]');
      for (const button of Array.from(buttons).slice(1)) button.remove();
      buttons[0].setAttribute('disabled', '');
    });
    assert.equal(await advanceRenderedResults(page, 200), 'stalled');
    assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 1);
  } finally { await browser.close(); }
});

for (const mode of ['recovered', 'persistent', 'blocked', 'used', 'unknown'] as const) {
  test(`context lost during card wait: ${mode} preserves the one-restoration budget and exact billing`, async () => {
    const browser = await chromium.launch({ headless: true }), originalPush = Actor.pushData;
    const saved: HotelRecord[] = []; let searches = 0, landings = 0;
    Actor.pushData = (async (record: HotelRecord) => { saved.push(record); return { chargedCount: 1, eventChargeLimitReached: false }; }) as unknown as typeof Actor.pushData;
    try {
      const page = await browser.newPage(), state = stateFor(`late-context-${mode}`, 25);
      const landing = mode === 'unknown' ? 'https://www.booking.com/account/login.html' : 'https://www.booking.com/index.en-us.html';
      await page.route('**/*', route => {
        assert.equal(route.request().resourceType(), 'document');
        if (new URL(route.request().url()).pathname.startsWith('/searchresults')) {
          searches++; assert(searches <= 2, 'at most one exact search restoration');
          return route.fulfill({ contentType: 'text/html', body: searches === 1 ? '<input name="ss" value="London">' : fixtureHtml(0) });
        }
        landings++; assert(landings <= 2);
        return route.fulfill({ contentType: 'text/html', body: mode === 'blocked' ? '<h1>Access denied</h1>'
          : '<input name="ss" value=""><button data-testid="searchbox-dates-container"></button>' });
      });
      const request = { url: buildSearchUrl(state), label: 'search', noRetry: false,
        userData: { state, bookingSearchShellRestoreAttempted: mode === 'used' } };
      await page.goto(request.url);
      // Model a persistent redirected navigation at the Page boundary rather
      // than using a 302: Playwright may follow a redirect outside this route
      // handler, which would invalidate an offline fixture.
      const originalGoto = page.goto.bind(page); const restoreTargets: string[] = [];
      page.goto = (async (url: string, options: unknown) => {
        if (url === request.url) {
          restoreTargets.push(url);
          if (mode === 'persistent') return originalGoto(landing, options as Parameters<typeof originalGoto>[1]);
        }
        return originalGoto(url, options as Parameters<typeof originalGoto>[1]);
      }) as typeof page.goto;
      const originalWait = page.waitForSelector.bind(page); let redirected = false;
      page.waitForSelector = (async (selector: string, options: unknown) => {
        if (!redirected && selector.includes('property-card')) {
          redirected = true; await page.goto(landing); throw new Error('fixture: context lost while waiting for cards');
        }
        return originalWait(selector, options as Parameters<typeof originalWait>[1]);
      }) as typeof page.waitForSelector;
      const collect = async () => router({ page, request, crawler: {},
        log: { info: () => {}, warning: () => {}, debug: () => {} },
      } as unknown as Parameters<typeof router>[0]);
      if (mode === 'recovered') await collect();
      else await assert.rejects(collect, mode === 'blocked' ? /BOOKING_BLOCKED_WHILE_WAITING/
        : mode === 'unknown' ? /PROPERTY_CARDS_NOT_RENDERED/ : /CONTEXT_LOST/);
      assert.equal(saved.length, mode === 'recovered' ? 25 : 0);
      assert.equal(new Set(saved.map(row => row.propertyId)).size, saved.length);
      assert.equal(searches, mode === 'recovered' ? 2 : 1);
      assert.deepEqual(restoreTargets, mode === 'recovered' || mode === 'persistent' ? [request.url] : []);
      if (mode === 'recovered') assert(saved.every(row => row.rateEvidence?.searchContextVerified));
      if (mode === 'used' || mode === 'persistent') assert.equal(request.noRetry, true);
    } finally { Actor.pushData = originalPush; await browser.close(); }
  });
}

test('a late URL change cannot save otherwise matching priced cards from a different search', async () => {
  const browser = await chromium.launch({ headless: true }), originalPush = Actor.pushData;
  let charged = 0;
  Actor.pushData = (async () => { charged++; throw new Error('Wrong search must not be billed'); }) as unknown as typeof Actor.pushData;
  try {
    const page = await browser.newPage(), state = stateFor('late-wrong-url', 25);
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixtureHtml(0) }));
    const request = { url: buildSearchUrl(state), label: 'search', noRetry: false, userData: { state } };
    await page.goto(request.url);
    const originalWait = page.waitForSelector.bind(page); let changed = false;
    page.waitForSelector = (async (selector: string, options: unknown) => {
      if (!changed && selector.includes('property-card')) {
        changed = true; const url = new URL(request.url); url.searchParams.set('group_adults', '3'); await page.goto(url.toString());
      }
      return originalWait(selector, options as Parameters<typeof originalWait>[1]);
    }) as typeof page.waitForSelector;
    await assert.rejects(async () => router({ page, request, crawler: {}, log: { info: () => {}, warning: () => {}, debug: () => {} } } as unknown as Parameters<typeof router>[0]), /BOOKING_SEARCH_CONTEXT_MISMATCH/);
    assert.equal(charged, 0); assert.equal(request.noRetry, true);
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

for (const mode of ['continue','repeat','cap'] as const) {
  test(`stalled 15-card browser batch: ${mode} is bounded and never skips or rebills source rows`, async () => {
    const browser=await chromium.launch({headless:true}),originalPush=Actor.pushData;
    const saved:HotelRecord[]=[],events:string[]=[],offsets:number[]=[];
    Actor.pushData=(async (record:HotelRecord,event:string)=>{saved.push(record);events.push(event);return {chargedCount:1,eventChargeLimitReached:false};}) as unknown as typeof Actor.pushData;
    try {
      const page=await browser.newPage(),state=stateFor(`offline-stall-${mode}`,25);
      if(mode==='cap')state.maxPages=1;
      await page.route('**/*',route=>{
        if(route.request().resourceType()!=='document')return route.abort();
        const offset=Number(new URL(route.request().url()).searchParams.get('offset')??0);offsets.push(offset);
        assert(offsets.length<=2,'at most two source pages');
        return route.fulfill({contentType:'text/html',body:fixtureHtml(mode==='repeat'?0:offset).replace(/<script>[\s\S]*$/,'')});
      });
      const pending=[{url:buildSearchUrl(state),userData:{state}}];
      while(pending.length){const request=pending.shift()!;await page.goto(request.url);
        await router({page,request:{...request,label:'search'},log:{info:()=>{},debug:()=>{},warning:()=>{}},
          crawler:{addRequests:async (requests:typeof pending)=>{pending.push(...requests);}},
        } as unknown as Parameters<typeof router>[0]);
      }
      assert.equal(saved.length,mode==='continue'?25:15);
      assert.equal(new Set(saved.map(row=>row.propertyId)).size,saved.length);
      assert.equal(events.length,saved.length);
      assert.deepEqual(offsets,mode==='cap'?[0]:[0,15]);
      assert.equal(state.coverage?.reason,mode==='continue'?'max_results':mode==='repeat'?'repeated_page':'page_cap');
      assert.equal(bookingCompletionStatus([state],0,false),mode==='continue'?'succeeded':'partial');
    } finally {Actor.pushData=originalPush;await browser.close();}
  });
}

test('browser collector uses explicit page currency and accessible price/tax labels, not requested USD alone',async()=>{
  const browser=await chromium.launch({headless:true}),originalPush=Actor.pushData,saved:HotelRecord[]=[];
  Actor.pushData=(async(record:HotelRecord)=>{saved.push(record);return {chargedCount:1,eventChargeLimitReached:false};}) as unknown as typeof Actor.pushData;
  try {
    const page=await browser.newPage(),state=stateFor('offline-price-labels',1);state.currency='USD';state.searchUrl=state.searchUrl!.replace('selected_currency=GBP','selected_currency=USD');
    const html=fixtureHtml(0,{currency:'USD'}).replaceAll('£','$').replaceAll('>Includes taxes and charges</span>',' aria-label="Includes taxes and charges"></span>');
    await page.route('**/*',route=>route.request().resourceType()==='document'?route.fulfill({contentType:'text/html',body:html}):route.abort());
    const request={url:buildSearchUrl(state),label:'search',userData:{state}};await page.goto(request.url);
    await router({page,request,log:{info:()=>{},debug:()=>{},warning:()=>{}},crawler:{}} as unknown as Parameters<typeof router>[0]);
    assert.equal(saved.length,1);assert.equal(saved[0].rateEvidence?.currencyStatus,'confirmed');
    assert.equal(saved[0].rateEvidence?.observedPageCurrency,'USD');assert.equal(saved[0].rateEvidence?.currencyEvidenceSource,'page_currency_control');
    assert.equal(saved[0].rateEvidence?.taxStatus,'included');
  } finally {Actor.pushData=originalPush;await browser.close();}
});

test('unresolved destination with read-only or hidden controls still collects 25 priced rows without form edits or false alerts', async () => {
  const browser = await chromium.launch({ headless: true });
  const originalPush = Actor.pushData;
  try {
    const page = await browser.newPage();
    let visits = 0;
    const options = { destinationInput: '<input name="ss" value="London" readonly aria-label="Search in your own words">'
      + '<input name="ss" value="London" hidden><button type="submit">Search</button>',
      cardParameters: { dest_id: '', dest_type: '' } };
    await page.route('**/*', route => {
      if (route.request().resourceType() !== 'document') return route.abort();
      visits++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml(0, options) });
    });
    const state = { ...stateFor('offline-readonly-collector', 25), searchUrl: undefined };
    const requestedUrl = buildSearchUrl(state);
    await page.goto(requestedUrl);
    await page.evaluate(() => {
      document.documentElement.dataset.formEdits = '0';
      for (const event of ['input', 'change', 'submit']) document.addEventListener(event, () => {
        document.documentElement.dataset.formEdits = String(Number(document.documentElement.dataset.formEdits) + 1);
      });
    });
    const saved: HotelRecord[] = [], events: string[] = [];
    Actor.pushData = (async (record: HotelRecord, event: string) => {
      saved.push(record); events.push(event); return { chargedCount: 1, eventChargeLimitReached: false };
    }) as unknown as typeof Actor.pushData;
    await router({ page, request: { url: requestedUrl, label: 'search', userData: { state } },
      log: { info: () => {}, debug: () => {}, warning: () => {} },
      crawler: { addRequests: async () => { throw new Error('No extra navigation is allowed'); } },
    } as unknown as Parameters<typeof router>[0]);
    assert.equal(saved.length, 25);
    assert.equal(new Set(saved.map(row => row.propertyId)).size, 25);
    assert.equal(events.length, 25);
    assert.ok(events.every(event => event === 'hotel-scraped'));
    assert.ok(saved.every(row => row.totalPrice !== null && row.totalPrice > 0
      && row.rateEvidence?.searchContextVerified === false
      && row.rateEvidence.comparisonWarnings.includes('search_context_not_verified')));
    assert.equal(visits, 1);
    assert.equal(state.searchUrl, undefined);
    assert.equal(page.url(), requestedUrl);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.formEdits), '0');
    const history = emptyMonitor(), monitor = { monitorName: 'offline-readonly', market: 'US', threshold: 5, historyLimit: 3 };
    for (const record of saved) {
      const first = prepareRateChange(record, history, monitor); first.commit();
      const repeat = prepareRateChange({ ...record, totalPrice: record.totalPrice! / 2,
        scrapedAt: '2026-10-10T12:00:00Z' }, history, monitor).record.rateChange!;
      assert.equal(repeat.status, 'not_comparable');
      assert.equal(repeat.alert, false);
      assert.equal(repeat.priceChangePercent, null);
      assert.equal(repeat.observations.length, 2);
    }
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

test('actual browser collector rejects rendered date, guest, location and currency contradictions before saving or billing', async () => {
  const browser = await chromium.launch({ headless: true });
  const originalPush = Actor.pushData;
  let saved = 0;
  Actor.pushData = (async () => { saved++; return { chargedCount: 1, eventChargeLimitReached: false }; }) as unknown as typeof Actor.pushData;
  try {
    const cases: Parameters<typeof fixtureHtml>[1][] = [
      { datesLabel: 'Sun 15 November 2027 — Tue 17 November 2027' },
      { occupancyLabel: '3 adults · 0 children · 1 room' },
      { destinationInput: '<input name="ss" value="Paris, France" readonly>' },
      { destinationInput: '<input name="ss" value="London, Canada" readonly>' },
      { currency: 'USD' },
      { cardParameters: { checkin: '2027-11-15' } },
      { cardParameters: { dest_id: '-2140479' } },
      { cardParameters: { dest_type: 'airport' } },
    ];
    for (const [index, options] of cases.entries()) {
      const page = await browser.newPage();
      await page.route('**/*', route => route.request().resourceType() === 'document'
        ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml(0, options) }) : route.abort());
      const state = stateFor(`offline-mismatched-collector-${index}`, 25);
      const request = { url: buildSearchUrl(state), label: 'search', userData: { state }, noRetry: false };
      await page.goto(request.url);
      await assert.rejects(async () => await router({ page, request,
        log: { info: () => {}, debug: () => {}, warning: () => {} }, crawler: {},
      } as unknown as Parameters<typeof router>[0]), /BOOKING_RENDERED_SEARCH_MISMATCH/, JSON.stringify(options));
      assert.equal(request.noRetry, true);
      assert.equal(state.collectedCount, 0);
      await page.close();
    }
    assert.equal(saved, 0);
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

test('actual browser collector restores the observed city redirect once and saves 25 verified priced hotels', async () => {
  const browser = await chromium.launch({ headless: true }), originalPush = Actor.pushData;
  const saved: HotelRecord[] = [], events: string[] = [];
  try {
    const page = await browser.newPage(), state = stateFor('offline-city-redirect', 25);
    const request = { url: buildSearchUrl(state), label: 'search', userData: { state, bookingSearchShellRestoreAttempted: false }, noRetry: false };
    let searchVisits = 0, cityVisits = 0;
    await page.route('**/*', route => {
      if (route.request().resourceType() !== 'document') return route.abort();
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/city/')) {
        cityVisits++;
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>London city information</h1>' });
      }
      assert.equal(route.request().url(), request.url, 'restoration must keep the exact approved stay and filters');
      assert.equal(++searchVisits, 1, 'only one search restoration is permitted');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml(0) });
    });
    Actor.pushData = (async (record: HotelRecord, event: string) => {
      saved.push(record); events.push(event); return { chargedCount: 1, eventChargeLimitReached: false };
    }) as unknown as typeof Actor.pushData;
    // Start at the already-observed landing state. Its captured request does
    // not establish whether Booking used a server or client-side redirect.
    await page.goto('https://www.booking.com/city/gb/london.en-gb.html');
    assert.equal(page.url(), 'https://www.booking.com/city/gb/london.en-gb.html');
    await router({ page, request, log: { info: () => {}, debug: () => {}, warning: () => {} },
      crawler: { addRequests: async () => { throw Error('No extra search may be queued'); } },
    } as unknown as Parameters<typeof router>[0]);
    assert.equal(searchVisits, 1); assert.equal(cityVisits, 1);
    assert.equal(request.userData.bookingSearchShellRestoreAttempted, true);
    assert.equal(page.url(), request.url);
    assert.equal(saved.length, 25); assert.equal(new Set(saved.map(row => row.propertyId)).size, 25);
    assert.deepEqual(events, Array(25).fill('hotel-scraped'));
    assert.ok(saved.every(row => row.rateEvidence?.searchContextVerified === true
      && row.rateEvidence.taxStatus === 'included' && row.totalPrice !== null && row.totalPrice > 0));
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

test('actual browser collector never saves or bills a persistent city redirect and does not restore again on retry', async () => {
  const browser = await chromium.launch({ headless: true }), originalPush = Actor.pushData;
  let restorations = 0, cityVisits = 0, billed = 0;
  Actor.pushData = (async () => { billed++; return { chargedCount: 1, eventChargeLimitReached: false }; }) as unknown as typeof Actor.pushData;
  try {
    const page = await browser.newPage(), state = stateFor('offline-persistent-city', 25);
    const request = { url: buildSearchUrl(state), label: 'search', userData: { state }, noRetry: false };
    await page.route('**/*', route => {
      if (route.request().resourceType() !== 'document') return route.abort();
      if (new URL(route.request().url()).pathname.startsWith('/city/')) {
        cityVisits++;
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>London city information</h1>' });
      }
      throw Error('The persistent-landing transport never fetches another source');
    });
    await page.goto('https://www.booking.com/city/gb/london.en-gb.html');
    // Model the recorded final URL with an intercepted real document, without
    // letting a fixture's HTTP redirect chain reach the external website.
    const navigate = page.goto.bind(page);
    page.goto = async (url, options) => {
      assert.equal(url, request.url, 'attempt only the original search, not an invented destination');
      assert.equal(++restorations, 1, 'persistent redirect must stop, not loop');
      return navigate('https://www.booking.com/city/gb/london.en-gb.html', options);
    };
    const collect = async () => await router({ page, request, log: { info: () => {}, debug: () => {}, warning: () => {} }, crawler: {},
    } as unknown as Parameters<typeof router>[0]);
    await assert.rejects(collect(), /BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE/);
    assert.equal(request.noRetry, true);
    await assert.rejects(collect(), /BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE/);
    assert.equal(restorations, 1); assert.equal(cityVisits, 2);
    assert.equal(billed, 0); assert.equal(state.collectedCount, 0);
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

test('a failed browser restoration preserves 20 prior HTTP hotels and diagnoses the current route, not stale loadedUrl', async () => {
  const browser = await chromium.launch({ headless: true }), originalPush = Actor.pushData;
  let restorations = 0, newCharges = 0;
  const warnings: Array<{ message: string; details: unknown }> = [];
  Actor.pushData = (async () => { newCharges++; return { chargedCount: 1, eventChargeLimitReached: false }; }) as unknown as typeof Actor.pushData;
  try {
    const page = await browser.newPage(), state = stateFor('offline-partial-city-failure', 25);
    state.collectedCount = 20;
    state.examinedCount = 20;
    state.seenIds = Array.from({ length: 20 }, (_, index) => `http-${index}`);
    state.coverage!.successfulPages = 1;
    const before = structuredClone(state);
    const request = { url: buildSearchUrl(state), loadedUrl: buildSearchUrl(state), label: 'search', userData: { state }, noRetry: false };
    const landing = 'https://www.booking.com/city/gb/london.en-gb.html?label=private-tracking';
    await page.route('**/*', route => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml(20) }) : route.abort());
    await page.goto(landing);
    const navigate = page.goto.bind(page);
    page.goto = async (url, options) => {
      assert.equal(url, request.url);
      assert.equal(++restorations, 1);
      return navigate(landing, options);
    };
    const collect = async () => await router({ page, request,
      log: { info: () => {}, debug: () => {}, warning: (message: string, details: unknown) => { warnings.push({ message, details }); } },
      crawler: {},
    } as unknown as Parameters<typeof router>[0]);
    await assert.rejects(collect(), /BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE/);
    await assert.rejects(collect(), /BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE/);
    assert.equal(request.noRetry, true);
    assert.equal(restorations, 1);
    assert.equal(newCharges, 0, 'never save or bill redirected cards or previously saved HTTP rows');
    assert.deepEqual(state, before, 'retain all prior counts, IDs and coverage without inventing completion');
    assert.equal(request.loadedUrl, request.url, 'persisted initial URL is not the current page after restoration');
    assert.equal(warnings.length, 2);
    for (const { details } of warnings) {
      assert.deepEqual(details, { routeKind: 'city_landing',
        missingFields: ['ss', 'dest_id', 'checkin', 'checkout', 'group_adults', 'no_rooms', 'group_children', 'age', 'selected_currency'],
        restorationAttempted: true, retainedHotels: 20 });
      assert.equal(/private-tracking|london|2026-11|2601889|booking\.com/i.test(JSON.stringify(details)), false);
    }
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

for (const limit of [25, 50]) {
  test(`actual browser collector saves exactly ${limit} unique, verified rows across lazy-loaded batches`, async () => {
    const browser = await chromium.launch({ headless: true });
    const saved: HotelRecord[] = [];
    const chargedEvents: string[] = [];
    const originalPush = Actor.pushData;
    Actor.pushData = (async (record: HotelRecord, event: string) => {
      saved.push(record); chargedEvents.push(event);
      return { chargedCount: 1, eventChargeLimitReached: false };
    }) as unknown as typeof Actor.pushData;
    try {
      const page = await browser.newPage();
      await page.route('**/*', route => {
        if (route.request().resourceType() !== 'document') return route.abort();
        const offset = Number(new URL(route.request().url()).searchParams.get('offset') ?? '0');
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml(offset) });
      });
      const state = stateFor(`offline-collector-${limit}`, limit);
      const pending: Array<{ url: string; userData: { state: SearchState } }> = [{ url: buildSearchUrl(state), userData: { state } }];
      let visits = 0;
      while (pending.length) {
        const request = pending.shift()!;
        await page.goto(request.url);
        visits++;
        assert.ok(visits <= 2, 'bounded test must not issue extra requests');
        await router({ page, request: { ...request, label: 'search' },
          log: { info: () => {}, debug: () => {}, warning: () => {} },
          crawler: { addRequests: async (requests: typeof pending) => { pending.push(...requests); } },
        } as unknown as Parameters<typeof router>[0]);
      }
      assert.equal(saved.length, limit);
      assert.equal(new Set(saved.map(record => record.propertyId)).size, limit);
      assert.equal(state.collectedCount, limit);
      assert.equal(state.coverage?.reason, 'max_results');
      assert.equal(visits, limit === 25 ? 1 : 2);
      assert.ok(chargedEvents.every(event => event === 'hotel-scraped'));
      assert.ok(saved.every(record => record.rateEvidence?.searchContextVerified === true
        && record.rateEvidence.taxStatus === 'included' && record.rateEvidence.currencyStatus === 'confirmed'
        && record.checkIn === '2026-11-15' && record.checkOut === '2026-11-17'
        && record.totalPrice !== null && record.totalPrice > 0));
    } finally { Actor.pushData = originalPush; await browser.close(); }
  });
}
