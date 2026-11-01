import type { Page } from 'playwright';
import type { SearchState } from './types.js';
import { PROPERTY_LINK_SELECTOR } from './property-cards.js';
import { pageDiagnosticCounters } from './page-diagnostics.js';

export const searchEvidenceSelector = 'input[name="ss"], input[name="checkin"], input[name="checkout"], '
  + 'input[name="group_adults"], input[name="group_children"], input[name="no_rooms"], '
  + 'input[name="age"], '
  + '[data-testid="searchbox-dates-container"], [data-testid="occupancy-config"], '
  + '[data-testid="header-currency-picker-trigger"], '
  + '[role="checkbox"][aria-checked="true"][data-date], ' + PROPERTY_LINK_SELECTOR;
export interface SearchField { name: string; test: string; value: string; text: string }
export type SearchEvidence = { status: 'confirmed' | 'unknown' | 'mismatch'; reason: string | null };

interface HtmlSelection {
  readonly length: number;
  eq(index: number): HtmlSelection;
  attr(name: string): string | undefined;
  text(): string;
}
export function htmlSearchFields($: (selector: string) => HtmlSelection): SearchField[] {
  const selected = $(searchEvidenceSelector);
  return Array.from({ length: selected.length }, (_, index) => {
    const element = selected.eq(index);
    return { name: element.attr('name') ?? '', test: element.attr('data-testid') ?? '',
      value: element.attr('href') ?? element.attr('data-date') ?? element.attr('value') ?? '',
      text: `${element.text()} ${element.attr('aria-label') ?? ''} ${element.attr('title') ?? ''}`,
      ...(element.attr('data-date') ? { name: /check-in date/i.test(element.attr('aria-label') ?? '') ? 'selected_checkin'
        : /check-out date/i.test(element.attr('aria-label') ?? '') ? 'selected_checkout' : '' } : {}) };
  });
}

export async function browserSearchFields(page: Page): Promise<SearchField[]> {
  return page.locator(searchEvidenceSelector).evaluateAll(elements => elements.map(element => ({
    name: element.getAttribute('name') ?? '', test: element.getAttribute('data-testid') ?? '',
    value: element.getAttribute('href') ?? element.getAttribute('data-date') ?? ('value' in element ? String(element.value) : ''),
    text: `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`,
    ...(element.hasAttribute('data-date') ? { name: /check-in date/i.test(element.getAttribute('aria-label') ?? '') ? 'selected_checkin'
      : /check-out date/i.test(element.getAttribute('aria-label') ?? '') ? 'selected_checkout' : '' } : {}),
  })));
}

/** Structural diagnostics only: never persist page text, field values, links,
 * cookies or HTML. Empty controls are symptoms, not proof of a source denial. */
export async function browserSearchDiagnostic(page: Page) {
  const structure = await page.locator(searchEvidenceSelector).evaluateAll(elements => ({
    readyState: document.readyState,
    destinationControls: elements.filter(element => element.getAttribute('name') === 'ss').length,
    emptyDestinationControls: elements.filter(element => element.getAttribute('name') === 'ss'
      && !('value' in element && String(element.value).trim())).length,
    propertyLinks: elements.filter(element => element.getAttribute('data-testid') === 'title-link').length,
    dateControls: elements.filter(element => element.getAttribute('data-testid') === 'searchbox-dates-container').length,
    occupancyControls: elements.filter(element => element.getAttribute('data-testid') === 'occupancy-config').length,
    currencyControls: elements.filter(element => element.getAttribute('data-testid') === 'header-currency-picker-trigger').length,
  }));
  return { ...structure, ...pageDiagnosticCounters(page) };
}

/** URL parameters are requests, not proof that Booking applied them. Only explicit
 * rendered form values, selected calendar dates or rendered property-link stay
 * parameters can confirm it. Yearless labels alone cannot confirm a full date. */
export function assessSearchEvidence(fields: SearchField[], state: SearchState): SearchEvidence {
  const mismatch = (reason: string): SearchEvidence => ({ status: 'mismatch', reason });
  const values = (name: string) => fields.filter(f => f.name === name).map(f => f.value.trim());
  for (const [name, expected] of [['checkin', state.checkIn], ['checkout', state.checkOut],
    ['selected_checkin', state.checkIn], ['selected_checkout', state.checkOut],
    ['group_adults', String(state.adults)], ['no_rooms', String(state.rooms)],
    ['group_children', String((state.childrenAges ?? []).length)]] as const) {
    if (values(name).some(value => value !== expected)) return mismatch(`rendered_${name}_mismatch`);
  }
  if (values('ss').some(value => !value)) return mismatch('rendered_destination_empty');
  const childAges = (state.childrenAges ?? []).map(String);
  if (values('age').length && values('age').join(',') !== childAges.join(',')) {
    return mismatch('rendered_child_ages_mismatch');
  }

  const expectedUrl = state.searchUrl ? new URL(state.searchUrl) : null;
  const expectedDestination = expectedUrl?.searchParams.get('ss') ?? state.destination;
  for (const destination of values('ss')) {
    if (contradictsDestination(destination, expectedDestination)) return mismatch('rendered_destination_mismatch');
  }

  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  let fullDateLabelConfirmed = false;
  for (const field of fields.filter(f => f.test === 'searchbox-dates-container')) {
    const dates = [...field.text.matchAll(/(\d{1,2})\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s*(20\d{2}))?/gi)];
    // Text plus accessible labels may repeat the same two dates. Validate every
    // pair; only an explicitly year-bearing pair can confirm full dates.
    if (dates.length < 2 || dates.length % 2 !== 0) continue;
    for (const [i, date] of dates.entries()) {
      const expected = [state.checkIn, state.checkOut][i % 2];
      const [, day, month, year] = date;
      if (Number(day) !== Number(expected.slice(8,10)) || months.indexOf(month.slice(0,3).toLowerCase()) + 1 !== Number(expected.slice(5,7))
        || (year !== undefined && year !== expected.slice(0,4))) return mismatch('rendered_date_label_mismatch');
    }
    if (dates.some((date,i) => i % 2 === 0 && date[3] === state.checkIn.slice(0,4)
      && dates[i+1][3] === state.checkOut.slice(0,4))) fullDateLabelConfirmed = true;
  }
  let occupancyConfirmed = false;
  for (const field of fields.filter(f => f.test === 'occupancy-config')) {
    const match = field.text.match(/(\d+)\s*adults?\s*[·,]\s*(\d+)\s*(?:children|child)\s*[·,]\s*(\d+)\s*rooms?/i);
    if (match && (Number(match[1]) !== state.adults || Number(match[2]) !== (state.childrenAges ?? []).length || Number(match[3]) !== state.rooms)) {
      return mismatch('rendered_occupancy_mismatch');
    }
    if (match) occupancyConfirmed = true;
  }
  for (const field of fields.filter(f => f.test === 'header-currency-picker-trigger')) {
    const observed = field.text.match(/\b([A-Z]{3})\b/)?.[1];
    if (observed && observed !== state.currency) return mismatch('rendered_currency_mismatch');
  }
  const expectedId = expectedUrl?.searchParams.get('dest_id');
  const expectedType = expectedUrl?.searchParams.get('dest_type');
  const cardLinks = fields.filter(f => f.test === 'title-link');
  let cardDatesConfirmed = cardLinks.length > 0;
  let cardDestinationConfirmed = !!expectedId && cardLinks.length > 0;
  for (const field of cardLinks) {
    let link: URL;
    try { link = new URL(field.value, 'https://www.booking.com'); }
    catch { cardDatesConfirmed = false; cardDestinationConfirmed = false; continue; }
    if (link.protocol !== 'https:' || !['www.booking.com', 'booking.com'].includes(link.hostname)
      || link.username || link.password || !link.pathname.startsWith('/hotel/')) {
      cardDatesConfirmed = false; cardDestinationConfirmed = false; continue;
    }
    for (const [name, expected] of [['checkin', state.checkIn], ['checkout', state.checkOut],
      ['group_adults', String(state.adults)], ['no_rooms', String(state.rooms)],
      ['group_children', String((state.childrenAges ?? []).length)]] as const) {
      const observed = link.searchParams.get(name);
      if (observed !== null && observed !== expected) return mismatch(`rendered_card_${name}_mismatch`);
      if (observed === null) cardDatesConfirmed = false;
    }
    if (link.searchParams.getAll('age').join(',') !== (state.childrenAges ?? []).join(',')) {
      if (link.searchParams.has('age')) return mismatch('rendered_card_child_ages_mismatch');
      cardDatesConfirmed = false;
    }
    if (expectedId && link.searchParams.get('dest_id') && link.searchParams.get('dest_id') !== expectedId) {
      return mismatch('rendered_card_destination_mismatch');
    }
    if (expectedType && link.searchParams.has('dest_type') && link.searchParams.get('dest_type') !== expectedType) {
      return mismatch('rendered_card_destination_type_mismatch');
    }
    if (link.searchParams.has('ss') && contradictsDestination(link.searchParams.get('ss')!, expectedDestination)) {
      return mismatch('rendered_card_destination_mismatch');
    }
    const cardCurrency = link.searchParams.get('selected_currency');
    if (cardCurrency && cardCurrency.toUpperCase() !== state.currency) return mismatch('rendered_card_currency_mismatch');
    if (!expectedId || link.searchParams.get('dest_id') !== expectedId
      || (expectedType && link.searchParams.get('dest_type') !== expectedType)) cardDestinationConfirmed = false;
  }
  const destinations = values('ss');
  const exactDestination = !!expectedDestination && destinations.length > 0
    && destinations.every(value => sourceDestinationMatches(value, expectedDestination));
  // Booking shortens a resolved city label to "London". Its source-rendered
  // links must also match the requested destination ID; the short label alone
  // cannot verify a country or region.
  const shortDestination = !!expectedDestination && cardDestinationConfirmed && destinations.length > 0
    && destinations.every(value => value.toLowerCase() === expectedDestination.split(',')[0].trim().toLowerCase());
  const destinationConfirmed = exactDestination || shortDestination;
  const datesConfirmed = ['checkin','checkout'].every(name => values(name).length > 0)
    || ['selected_checkin','selected_checkout'].every(name => values(name).length > 0)
    || cardDatesConfirmed || fullDateLabelConfirmed;
  const formGuestsConfirmed = ['group_adults','no_rooms','group_children'].every(name => values(name).length > 0);
  const guestsConfirmed = cardDatesConfirmed || ((formGuestsConfirmed || occupancyConfirmed)
    && (!childAges.length || values('age').join(',') === childAges.join(',')));
  if (!destinationConfirmed || !datesConfirmed || !guestsConfirmed) return { status: 'unknown', reason: 'rendered_search_not_confirmed' };
  return { status: 'confirmed', reason: null };
}

/** Only a unique, explicit currency from the selected page control is evidence.
 * Neither requested URL parameters nor an unqualified dollar sign establish it. */
export function pageCurrencyEvidence(fields: SearchField[]): string | null {
  const supported = /\b(?:USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|BRL|MXN|SEK|NOK|DKK|NZD|KRW|SGD|MYR|THB|TRY)\b/g;
  const codes = new Set<string>();
  for (const field of fields.filter(f => f.test === 'header-currency-picker-trigger')) {
    for (const code of field.text.match(supported) ?? []) codes.add(code);
    for (const [pattern, code] of [[/\b(?:US|United States) dollars?\b/i,'USD'],[/\bCanadian dollars?\b/i,'CAD'],
      [/\bAustralian dollars?\b/i,'AUD'],[/\bNew Zealand dollars?\b/i,'NZD'],[/\bpounds? sterling\b/i,'GBP'],
      [/\bJapanese yen\b/i,'JPY'],[/\bChinese yuan\b/i,'CNY'],[/\bIndian rupees?\b/i,'INR']] as const) {
      if (pattern.test(field.text)) codes.add(code);
    }
  }
  return codes.size === 1 ? [...codes][0] : null;
}

function sourceDestinationMatches(observed: string, expected: string): boolean {
  if (observed.trim().toLowerCase() === expected.trim().toLowerCase()) return true;
  const parts=(s:string)=>s.toLowerCase().split(',').map(x=>x.trim().replace(/\s+/g,' '));
  if (!/^[\p{L}\p{M}\p{N}\s,.'’()\-]+$/u.test(observed+expected)) return false;
  const a=parts(observed),b=parts(expected);
  // Preserve every requested region; do not resolve an incomplete "London".
  return b.length>=2 && a.length>=b.length && a[0]===b[0] && a.at(-1)===b.at(-1)
    && b.slice(1,-1).every(part=>a.slice(1,-1).includes(part));
}

/** Plain, structured location labels can contradict a requested city/region.
 * Encoded strings or free-form search sentences are not resolved by guessing.
 * A shortened matching city remains unknown unless independent source IDs match. */
function contradictsDestination(observed: string, expected: string): boolean {
  const parts = (label: string) => label.split(',').map(part => part.trim().toLowerCase().replace(/\s+/g, ' '));
  const plain = (label: string) => /^[\p{L}\p{M}\p{N}\s,.'’()\-]+$/u.test(label);
  if (!plain(observed) || !plain(expected)) return false;
  const actual = parts(observed), requested = parts(expected);
  if (actual.some(part => !part) || requested.some(part => !part)) return false;
  if (actual[0] !== requested[0]) return true;
  if (actual.length === 1 || requested.length === 1) return false;
  const aliases: Record<string, string> = {
    uk: 'united kingdom', gb: 'united kingdom', gbr: 'united kingdom', 'great britain': 'united kingdom',
    us: 'united states', usa: 'united states', 'united states of america': 'united states',
    uae: 'united arab emirates',
  };
  const region = (value: string) => aliases[value] ?? value;
  return region(actual.at(-1)!) !== region(requested.at(-1)!);
}
