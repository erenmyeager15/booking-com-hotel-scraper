import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import { PROPERTY_CARD_SELECTOR, hydratePropertyCards, reportedPropertyCount } from './property-cards.js';

test('modern nested card wrappers are selected once, older standalone containers still work', () => {
  const $ = load('<div data-testid="property-card"><div data-testid="property-card-container">A</div></div>'
    + '<div data-testid="property-card"><div data-testid="property-card-container">B</div></div>'
    + '<div data-testid="property-card-container">Older C</div>');
  assert.equal($(PROPERTY_CARD_SELECTOR).length, 3);
});

test('reported source inventory count is not guessed from unrelated card or price text', () => {
  assert.equal(reportedPropertyCount('London: 6,754 properties found'), 6754);
  assert.equal(reportedPropertyCount('0 properties are available'), null);
  assert.equal(reportedPropertyCount('London: 25 properties available'), 25);
  assert.equal(reportedPropertyCount('Price £502 for 2 nights'), null);
});

test('bounded browser hydration loads a 25-property batch without duplicate nested wrappers', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const card = (index: number) => `<div data-testid="property-card" style="height:150px"><div data-testid="property-card-container">Hotel ${index}</div></div>`;
    const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>'
      + Array.from({ length: 15 }, (_, index) => card(index)).join('')
      + '<script>addEventListener("scroll",()=>{document.documentElement.dataset.scrollEvents=String(Number(document.documentElement.dataset.scrollEvents||0)+1);'
      + 'if(!document.getElementById("loaded")){const extra=document.createElement("div");extra.id="loaded";extra.innerHTML='
      + JSON.stringify(Array.from({ length: 15 }, (_, index) => card(index + 15)).join(''))
      + ';document.body.append(extra);}});document.documentElement.dataset.listenerReady="true";</script></body></html>';
    // Navigate a fully intercepted document, as the collector does, without
    // network requests or a private browser session.
    await page.route('**/*', route => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('https://www.booking.com/offline-hydration-fixture');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.listenerReady), 'true', 'fixture lazy-loading listener must be installed');
    assert.equal(await page.locator(PROPERTY_CARD_SELECTOR).count(), 15);
    const loaded = await hydratePropertyCards(page, 25, 2_000);
    assert.equal(loaded, 30, JSON.stringify(await page.evaluate(() => ({
      y: window.scrollY, height: window.innerHeight, documentHeight: document.documentElement.scrollHeight,
      lastTop: document.querySelector('[data-testid="property-card"]:last-of-type')?.getBoundingClientRect().top,
      loaded: Boolean(document.getElementById('loaded')),
      listenerReady: document.documentElement.dataset.listenerReady, scrollEvents: document.documentElement.dataset.scrollEvents,
    }))));
    assert.equal(await page.locator(PROPERTY_CARD_SELECTOR).count(), 30);
  } finally { await browser.close(); }
});

test('bounded hydration stops on a stalled source and does not invent additional hotels', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent('<div data-testid="property-card">Only one real hotel</div>');
    const start = Date.now();
    assert.equal(await hydratePropertyCards(page, 25, 100), 1);
    assert.ok(Date.now() - start < 1_000);
  } finally { await browser.close(); }
});
