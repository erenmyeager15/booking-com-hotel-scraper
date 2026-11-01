import type { Page } from 'playwright';
import { PROPERTY_CARD_SELECTOR } from './property-cards.js';

export const CONTINUATION_BUTTON_NAME = /^(?:(?:load|show) more (?:results|properties)|next page)$/i;

/** Live Booking (verified 1 November 2026, London, headless shell):
 * searchresults.html ignores offset/rows and always serves the first 15-25
 * cards. After client hydration, the list appends 15-20 cards per FullSearch
 * request whenever its end re-enters the viewport; after roughly 100 cards a
 * "Load more results" button replaces that. A wheel at the maximum scroll
 * position fires no scroll event, so bring the last card into view first and
 * then wheel past it. This is an ordinary user scroll in the same document. */
async function nudgeListEnd(page: Page, remainingMs: number): Promise<void> {
  if (remainingMs <= 1) return;
  await page.locator(PROPERTY_CARD_SELECTOR).last()
    .evaluate(element => element.scrollIntoView({ block: 'end', behavior: 'instant' }),
      undefined, { timeout: Math.min(1_000, remainingMs) }).catch(() => null);
  await page.mouse.wheel(0, 400).catch(() => null);
}

/** Prefer the source's own in-document continuation to inventing another
 * offset. Never click ambiguous/hidden controls or treat duplicate cards as progress. */
export async function advanceRenderedResults(page: Page, timeoutMs = 8_000,
  stillValid: () => Promise<boolean> = async () => true): Promise<'absent' | 'advanced' | 'stalled'> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const remaining = () => Math.max(1, deadline - Date.now());
  const controls = page.getByRole('button', {
    name: CONTINUATION_BUTTON_NAME,
    exact: true,
  });
  const before = await page.locator(PROPERTY_CARD_SELECTOR).evaluateAll(elements => elements.map(root => {
    const href = root.querySelector('a[data-testid="title-link"], a[href*="/hotel/"]')?.getAttribute('href');
    try { return href ? new URL(href, location.href).pathname : root.getAttribute('data-property-id') ?? ''; }
    catch { return ''; }
  }).filter(Boolean));
  let visible = [];
  // Hydration can finish several seconds after the first server-rendered
  // cards. Keep the current document, scroll its list end into view, and wait
  // for appended identities or a footer control within this bounded budget.
  while (true) {
    if (!await stillValid()) return 'stalled';
    visible = [];
    for (let i = 0; i < await controls.count(); i++) {
      const control = controls.nth(i);
      if (await control.isVisible()) visible.push(control);
    }
    const newCards = await page.locator(PROPERTY_CARD_SELECTOR).evaluateAll((elements, previous) => elements.some(root => {
      const href = root.querySelector('a[data-testid="title-link"], a[href*="/hotel/"]')?.getAttribute('href');
      let id = ''; try { id = href ? new URL(href, location.href).pathname : root.getAttribute('data-property-id') ?? ''; }
      catch { return false; } return !!id && !previous.includes(id);
    }), before);
    if (newCards) return 'advanced';
    if (visible.length) break;
    if (Date.now() >= deadline) return 'absent';
    await nudgeListEnd(page, deadline - Date.now());
    if (Date.now() >= deadline) continue;
    await page.waitForTimeout(Math.min(700, remaining()));
  }
  if (visible.length !== 1 || Date.now() >= deadline) return 'stalled';
  // Each call performs at most one genuine user-interface continuation. Do not
  // issue another click or invent a request if the source fails to advance.
  try {
    const control = visible[0];
    try {
      await control.click({ timeout: Math.min(1500, remaining()) });
    } catch (error) {
      // Live Booking overlays can intercept the pointer at the list footer.
      // Activate the same single, visible, enabled control once instead.
      if (!await control.isEnabled().catch(() => false)) throw error;
      await control.evaluate(element => (element as HTMLElement).click(), undefined, { timeout: Math.min(1_000, remaining()) });
    }
    await page.waitForFunction(({ selector, previous }) => Array.from(document.querySelectorAll(selector)).some(root => {
      const href = root.querySelector('a[data-testid="title-link"], a[href*="/hotel/"]')?.getAttribute('href');
      let id = '';
      try { id = href ? new URL(href, location.href).pathname : root.getAttribute('data-property-id') ?? ''; }
      catch { return false; }
      return !!id && !previous.includes(id);
    }), { selector: PROPERTY_CARD_SELECTOR, previous: before }, { timeout: remaining(), polling: 100 });
    return 'advanced';
  } catch { return 'stalled'; }
}

/** Fixed structural counts only: never retain button labels, page contents,
 * link targets or source tokens when diagnosing a pagination boundary. */
export async function renderedContinuationDiagnostic(page: Page): Promise<Record<string, number>> {
  const controls = page.getByRole('button', { name: CONTINUATION_BUTTON_NAME, exact: true });
  const matched = await controls.count(); let visible = 0, enabled = 0;
  for (let i = 0; i < matched; i++) {
    const control = controls.nth(i);
    if (await control.isVisible()) { visible++; if (await control.isEnabled()) enabled++; }
  }
  return { matchingControls: matched, visibleControls: visible, enabledVisibleControls: enabled,
    cards: await page.locator(PROPERTY_CARD_SELECTOR).count() };
}
