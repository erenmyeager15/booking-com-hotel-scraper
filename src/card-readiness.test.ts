import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page, type Browser } from 'playwright';
import { waitForBookingSearchCards, inspectBookingPage } from './routes.js';
import { attachPageDiagnostics, browserFailureDiagnostic } from './page-diagnostics.js';

type Scenario = 'late-cards' | 'parsed-empty' | 'never-cards' | 'denied' | 'changed-search';
async function stream(scenario: Scenario, check: (page: Page, visits: () => number, url: string) => Promise<void>) {
  let visits = 0;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const server = createServer((_request, response) => {
    visits++;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.write('<!doctype html><html><body><h1>Offline London search</h1><input name="ss" value="London">');
    if (scenario === 'parsed-empty') { response.end('</body></html>'); return; }
    if (scenario === 'late-cards') timers.push(setTimeout(() => response.write(
      Array.from({ length: 25 }, (_, i) => `<div data-testid="property-card" style="height:80px"><a data-testid="title-link" href="https://www.booking.com/hotel/gb/offline-${i}.html">Offline ${i}</a><span data-testid="price-and-discounted-price">US$150</span></div>`).join(''),
    ), 250));
    if (scenario === 'denied') timers.push(setTimeout(() => response.write('<h1>Access denied</h1>'), 150));
    // Keep the actual main HTTP body open: DOM remains loading. No external
    // site is contacted and the test controls whether cards ever arrive.
  });
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); attachPageDiagnostics(page);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stream`;
    await page.route('**/*', route => route.request().resourceType() === 'document'
      && route.request().url() === url ? route.continue() : route.abort());
    await page.goto(url, { waitUntil: 'commit', timeout: 2_000 });
    await check(page, () => visits, url);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await browser?.close(); server.closeAllConnections();
    await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('HTTP-200 streamed document can supply 25 cards after the first wait without navigation or a second request', async () => {
  await stream('late-cards', async (page, visits) => {
    await waitForBookingSearchCards(page, Date.now() + 2_000, 80);
    assert.equal(await page.locator('[data-testid="property-card"]').count(), 25);
    const diagnostic = await browserFailureDiagnostic(page);
    assert.equal(diagnostic.readyState, 'loading'); assert.equal(diagnostic.documentStatus, 200);
    assert.equal(diagnostic.documentInFlight, true); assert.equal(diagnostic.documentFinished, false);
    assert.equal(diagnostic.scriptFailures, 0); assert.equal(diagnostic.dataFailures, 0);
    assert.equal(visits(), 1);
  });
});

test('a parsed empty shell does not receive the extra loading allowance', async () => {
  await stream('parsed-empty', async (page, visits) => {
    await page.waitForLoadState('domcontentloaded');
    await assert.rejects(waitForBookingSearchCards(page, Date.now() + 2_000, 80), /Timeout/);
    assert.equal(await inspectBookingPage(page), 'normal'); assert.equal(visits(), 1);
  });
});

test('a streamed document that never supplies cards fails at the same-page deadline', async () => {
  await stream('never-cards', async (page, visits) => {
    await assert.rejects(waitForBookingSearchCards(page, Date.now() + 350, 80), /READINESS_DEADLINE/);
    assert.equal((await browserFailureDiagnostic(page)).propertyCards, 0); assert.equal(visits(), 1);
  });
});

test('source denial ends the same-page loading allowance without another request', async () => {
  await stream('denied', async (page, visits) => {
    await assert.rejects(waitForBookingSearchCards(page, Date.now() + 2_000, 80), /Timeout/);
    assert.equal(await inspectBookingPage(page), 'blocked'); assert.equal(visits(), 1);
  });
});

test('a changed search ends the loading allowance without resetting the deadline or navigating again', async () => {
  await stream('changed-search', async (page, visits, url) => {
    const waiting = waitForBookingSearchCards(page, Date.now() + 2_000, 80, () => page.url() === url);
    await page.waitForTimeout(150); await page.evaluate(() => history.replaceState({}, '', '?different-search'));
    await assert.rejects(waiting, /Timeout/); assert.equal(visits(), 1);
  });
});
