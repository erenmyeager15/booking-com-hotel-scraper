import type { HotelRecord, SearchState } from './types.js';
import { observedCurrency } from './money.js';

export function addRateEvidence(record: HotelRecord, state: SearchState, totalText: string | null, nightlyText: string | null, cardText: string, verified: boolean, dedicatedTaxText?: string | null): HotelRecord {
  const currency = observedCurrency(totalText ?? nightlyText ?? '', state.currency);
  const evidenceText = (dedicatedTaxText || cardText).replace(/\s+/g, ' ').trim();
  const taxText = evidenceText.match(/.{0,40}\b(?:tax(?:es)?|fees|charges)\b.{0,100}/i)?.[0]?.trim().slice(0,200) ?? null;
  const included = /\b(?:includes?|including|inclusive of|incl\.)\s+(?:all\s+)?tax(?:es)?\b|\btax(?:es)?(?:\s+(?:and|&)\s+(?:fees|charges))?\s+(?:are\s+)?included\b/i.test(evidenceText);
  const excluded = /\b(?:excluding|excludes?|not including)\s+(?:all\s+)?tax(?:es)?\b|(?:\bplus|\+)\s*(?:[A-Z$€£₹\d,. ]+\s+)?(?:taxes|fees|charges)\b|\btax(?:es)?(?:\s+(?:and|&)\s+(?:fees|charges))?\s+(?:are\s+)?(?:not included|excluded)\b/i.test(evidenceText);
  const taxStatus = included && excluded ? 'mixed' : included ? 'included' : excluded ? 'excluded' : 'unknown';
  const comparisonWarnings: string[] = [];
  if (!verified) comparisonWarnings.push('search_context_not_verified');
  if (currency.status !== 'confirmed') comparisonWarnings.push(`currency_${currency.status}`);
  if (taxStatus === 'unknown' || taxStatus === 'mixed') comparisonWarnings.push(`tax_basis_${taxStatus}`);
  if (record.totalPrice === null) comparisonWarnings.push('stay_total_unavailable');
  return { ...record, childrenAges: [...(state.childrenAges ?? [])], rateEvidence: {
    priceBasis: record.totalPrice !== null ? 'displayed_stay_total' : record.pricePerNight !== null ? 'displayed_nightly_rate' : 'unpriced',
    requestedCurrency: state.currency, observedCurrency: currency.currency, currencyStatus: currency.status,
    taxStatus, taxText, observedTotalText: totalText?.trim().slice(0, 200) ?? null,
    observedNightlyText: nightlyText?.trim().slice(0, 200) ?? null, searchContextVerified: verified,
    comparisonWarnings, comparisonScope: 'hotel_search_offer',
  } };
}
