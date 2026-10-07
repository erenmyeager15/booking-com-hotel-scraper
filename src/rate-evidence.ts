import type { HotelRecord, SearchState } from './types.js';
import { observedCurrency } from './money.js';

export function addRateEvidence(record: HotelRecord, state: SearchState, totalText: string | null, nightlyText: string | null, cardText: string, verified: boolean): HotelRecord {
  const currency = observedCurrency(totalText ?? nightlyText ?? '', state.currency);
  const taxText = cardText.match(/(?:includes?|excluding|excludes?|plus|\+|taxes?)[^.!?]{0,100}(?:taxes|fees|charges)[^.!?]{0,60}/i)?.[0]?.trim() ?? null;
  const included = /(?:includes?|including|inclusive of)\s+(?:all\s+)?taxes|taxes(?:\s+and\s+(?:fees|charges))?\s+included/i.test(cardText);
  const excluded = /(?:excluding|excludes?|not including|plus|\+)\s+(?:[A-Z$€£₹\d,. ]+\s+)?(?:taxes|fees|charges)|taxes(?:\s+and\s+(?:fees|charges))?\s+(?:not included|excluded)/i.test(cardText);
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
