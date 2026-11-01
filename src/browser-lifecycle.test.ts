import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPool, PlaywrightPlugin } from 'crawlee';
import { chromium } from 'playwright';
import type { LaunchContext } from 'crawlee';
import { bookingBrowserContext, bookingBrowserPool } from './browser-lifecycle.js';

test('real browser pool closes each page-owned context, reuses one browser, and allows retained session cookies on the next page', async () => {
  const pool = new BrowserPool({
    ...bookingBrowserPool, useFingerprints: false,
    // Simulate the cloud image's executable override. The real launch hook must
    // remove it or this test cannot launch any browser.
    browserPlugins: [new PlaywrightPlugin(chromium, { ...bookingBrowserContext,
      launchOptions: { headless: false, executablePath: '/unavailable-full-browser', channel: 'unavailable-channel',
        args: ['--enable-automation'] } })],
  });
  try {
    const first = await pool.newPage(), firstContext = first.context(), browser = firstContext.browser();
    assert(browser, 'isolated mode must expose a real Browser, not a persistent context wrapper');
    const cdp = await browser.newBrowserCDPSession();
    const command = await cdp.send('Browser.getBrowserCommandLine');
    assert.match(command.arguments[0], /headless_shell|headless-shell/i,
      'the executable must be the version-matched headless shell, not the image override');
    await cdp.detach();
    await first.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<title>Offline lifecycle</title>' }));
    await first.goto('https://www.booking.com/offline-lifecycle');
    await firstContext.addCookies([{ name: 'offline_session', value: 'fixture', domain: 'www.booking.com', path: '/' }]);
    const cookies = await firstContext.cookies();
    await first.evaluate(() => { (window as unknown as { retainedHeap: number[] }).retainedHeap = Array(100_000).fill(1); });
    assert.equal(browser.contexts().length, 1);
    await first.close();
    assert.equal(browser.contexts().length, 0, 'the old document/context must be released before another page opens');
    await assert.rejects(firstContext.cookies(), /closed/i);
    const second = await pool.newPage(), secondContext = second.context();
    assert.notEqual(secondContext, firstContext);
    assert.equal(secondContext.browser(), browser, 'one underlying browser is sufficient across sequential pages');
    await secondContext.addCookies(cookies);
    assert.equal((await secondContext.cookies('https://www.booking.com')).find(cookie => cookie.name === 'offline_session')?.value, 'fixture');
    await second.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<title>Next offline lifecycle</title>' }));
    await second.goto('https://www.booking.com/offline-lifecycle-next');
    assert.equal(await second.evaluate(() => 'retainedHeap' in window), false);
    await second.close();
    assert.equal(browser.contexts().length, 0);
  } finally { await pool.destroy(); }
});

test('headless-shell selection keeps the existing proxy, headers and browser security options', () => {
  const options = { executablePath: '/image/browser', channel: 'chrome', headless: false,
    proxy: { server: 'http://127.0.0.1:12345' },
    args: ['--no-sandbox', '--disable-dev-shm-usage'], extraHTTPHeaders: { 'Accept-Language': 'en-US' } };
  const context = { launchOptions: options } as unknown as LaunchContext;
  bookingBrowserPool.preLaunchHooks[0]('fixture', context);
  assert.deepEqual(options, { headless: true, proxy: { server: 'http://127.0.0.1:12345' },
    args: ['--no-sandbox', '--disable-dev-shm-usage'], extraHTTPHeaders: { 'Accept-Language': 'en-US' } });
});
