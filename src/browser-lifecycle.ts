import type { LaunchContext } from 'crawlee';

/** Page-owned contexts release their document heap when a queued page closes.
 * Crawlee still persists cookies through the existing Session configuration;
 * this changes resource lifetime, not retry or source-access policy. */
export const bookingBrowserContext = { useIncognitoPages: true } as const;

/** Remove the image's full-browser override at the final launch boundary so
 * Playwright selects its version-matched headless shell, as in local tests.
 * A missing shell fails launch instead of selecting an untested fallback. */
function useBundledHeadlessBrowser(_pageId: string, context: LaunchContext): void {
  if (!context.launchOptions) throw new Error('BOOKING_BROWSER_LAUNCH_OPTIONS_MISSING');
  context.launchOptions.headless = true;
  delete context.launchOptions.executablePath;
  delete context.launchOptions.channel;
}

export const bookingBrowserPool = {
  maxOpenPagesPerBrowser: 1,
  preLaunchHooks: [useBundledHeadlessBrowser],
};
