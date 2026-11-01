import type { Page, Request } from 'playwright';
import { searchRedirectDiagnostic } from './navigation.js';
import { PROPERTY_CARD_SELECTOR } from './property-cards.js';

interface Counters {
  scriptFailures: number; dataFailures: number; pageErrors: number;
  httpClientErrors: number; httpServerErrors: number; documentStatus: number | null;
  documentInFlight: boolean; documentFinished: boolean;
  pendingScripts: number; pendingDataRequests: number;
}
const counters = new WeakMap<Page, Counters>();
const empty = (): Counters => ({ scriptFailures: 0, dataFailures: 0, pageErrors: 0,
  httpClientErrors: 0, httpServerErrors: 0, documentStatus: null,
  documentInFlight: false, documentFinished: false, pendingScripts: 0, pendingDataRequests: 0 });

/** Count page failures without retaining URLs, headers, payloads or error text.
 * Installing twice on a reused page must not double-count events. */
export function attachPageDiagnostics(page: Page): void {
  if (counters.has(page)) return;
  const result = empty(); counters.set(page, result);
  const increment = (key: 'scriptFailures' | 'dataFailures' | 'pageErrors' | 'httpClientErrors' | 'httpServerErrors' | 'pendingScripts' | 'pendingDataRequests') => {
    result[key] = Math.min(1000, result[key] + 1);
  };
  const scripts = new WeakSet<Request>(), data = new WeakSet<Request>();
  let mainDocument: Request | undefined;
  const settled = (request: Request, failed: boolean) => {
    if (scripts.delete(request)) result.pendingScripts = Math.max(0, result.pendingScripts - 1);
    if (data.delete(request)) result.pendingDataRequests = Math.max(0, result.pendingDataRequests - 1);
    if (request === mainDocument) { result.documentInFlight = false; result.documentFinished = !failed; }
  };
  page.on('request', request => {
    if (request.resourceType() === 'script' && !scripts.has(request)) { scripts.add(request); increment('pendingScripts'); }
    if (['xhr', 'fetch'].includes(request.resourceType()) && !data.has(request)) { data.add(request); increment('pendingDataRequests'); }
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      mainDocument = request; result.documentStatus = null; result.documentInFlight = true; result.documentFinished = false;
    }
  });
  page.on('requestfinished', request => settled(request, false));
  page.on('requestfailed', request => {
    settled(request, true);
    if (request.resourceType() === 'script') increment('scriptFailures');
    if (['xhr', 'fetch'].includes(request.resourceType())) increment('dataFailures');
  });
  page.on('pageerror', () => increment('pageErrors'));
  page.on('response', response => {
    const status = response.status();
    if (status >= 400 && status < 500) increment('httpClientErrors');
    if (status >= 500) increment('httpServerErrors');
    const request = response.request();
    if (request.isNavigationRequest() && response.frame() === page.mainFrame()) {
      mainDocument = request; result.documentStatus = status; result.documentInFlight = true; result.documentFinished = false;
    }
  });
}

export function pageDiagnosticCounters(page: Page): Counters {
  return { ...(counters.get(page) ?? empty()) };
}

/** Capture navigation failures before page teardown, with a bounded wait if the
 * renderer is hung. No HTML, field values, links, cookies or raw error text. */
export async function browserFailureDiagnostic(page: Page | undefined, timeoutMs = 1_000) {
  const counts = page ? pageDiagnosticCounters(page) : empty();
  const route = searchRedirectDiagnostic(page?.url() ?? '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const structure = page && !page.isClosed() ? await Promise.race([
      page.evaluate(selector => ({
        readyState: document.readyState,
        hasBody: Boolean(document.body),
        propertyCards: Math.min(1_000, document.querySelectorAll(selector).length),
      }), PROPERTY_CARD_SELECTOR).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]) : null;
    return { ...counts, ...route, documentReceived: counts.documentStatus !== null,
      structureAvailable: structure !== null, ...(structure ?? {}) };
  } finally { if (timer) clearTimeout(timer); }
}
