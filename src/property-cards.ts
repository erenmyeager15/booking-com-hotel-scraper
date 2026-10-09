import type { Page } from 'playwright';

// Modern Booking nests a property-card-container inside each property-card.
// Keep the fallback for older markup without counting both wrappers.
export const PROPERTY_CARD_SELECTOR = '[data-testid="property-card"], '
  + '[data-testid="property-card-container"]:not([data-testid="property-card"] [data-testid="property-card-container"])';
export const PROPERTY_LINK_SELECTOR = '[data-testid="property-card"] a[data-testid="title-link"], '
  + '[data-testid="property-card-container"]:not([data-testid="property-card"] [data-testid="property-card-container"]) a[data-testid="title-link"]';

export function reportedPropertyCount(text: string): number | null {
  const match = text.match(/\b([\d,\s]+)\s+properties\s+(?:found|available)\b/i);
  if (!match) return null;
  const count = Number(match[1].replace(/[,\s]/g, ''));
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** Two bounded lazy-load attempts, not an unbounded whole-city scroll. */
export async function hydratePropertyCards(page: Page, target: number, timeoutMs = 8_000): Promise<number> {
  const cards = page.locator(PROPERTY_CARD_SELECTOR);
  const deadline = Date.now() + timeoutMs;
  let count = await cards.count();
  for (let round = 0; round < 2 && count > 0 && count < target; round++) {
    const remaining = () => Math.max(1, deadline - Date.now());
    if (remaining() <= 1) break;
    // Collecting cards needs a scroll, not Playwright's click/animation stability
    // checks. A bounded DOM scroll also works in headless/background documents.
    await cards.last().evaluate(element => element.scrollIntoView({ block: 'end', behavior: 'instant' }),
      undefined, { timeout: Math.min(1_500, remaining()) }).catch(() => null);
    // Headless/background renderers can defer a purely programmatic scroll
    // event. A real wheel input wakes that rendering path without synthesizing
    // site events, mutating inventory, or extending the hydration deadline.
    if (remaining() > 1) await page.mouse.wheel(0, 120).catch(() => null);
    await page.waitForFunction(({ selector, previous }) => document.querySelectorAll(selector).length > previous,
      { selector: PROPERTY_CARD_SELECTOR, previous: count },
      { timeout: Math.min(3_000, remaining()), polling: 100 }).catch(() => null);
    const nextCount = await cards.count();
    if (nextCount <= count) break;
    count = nextCount;
  }
  return count;
}
