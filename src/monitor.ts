import { createHash } from 'node:crypto';
import type { HotelRecord, RateChange, RateObservation } from './types.js';

interface SavedRate { context: string; terms: string; evidence: string; observations: RateObservation[] }
export interface MonitorState { schemaVersion: 1; rates: Record<string, SavedRate> }
export const emptyMonitor = (): MonitorState => ({ schemaVersion: 1, rates: {} });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function contextOf(record: HotelRecord, market: string): string {
  const source = new URL(record.sourceUrl);
  // Do not include pagination or tracking parameters. Stay, occupancy, filters,
  // requested market and language define whether these observations are comparable.
  return digest([record.checkIn, record.checkOut, record.adults, record.rooms,
    record.childrenAges ?? [], record.currency, record.scrapeMode, market,
    source.searchParams.get('nflt'), source.searchParams.get('lang'),
    source.searchParams.get('ss') ?? source.searchParams.get('dest_id')]);
}

export function prepareRateChange(record: HotelRecord, state: MonitorState, options: {
  monitorName: string; market: string; threshold: number; historyLimit: number;
}): { record: HotelRecord; commit: () => void } {
  const identity = record.propertyUrl ? new URL(record.propertyUrl).pathname : record.propertyId;
  const context = contextOf(record, options.market), key = digest([identity, context]);
  const terms = digest([record.freeCancellation, record.geniusDiscount, record.roomOptions.map(r =>
    [r.roomName, r.occupancy, r.mealPlan, r.cancellationPolicy, r.refundable]).sort()]);
  const evidence = JSON.stringify([record.rateEvidence?.priceBasis, record.rateEvidence?.taxStatus,
    record.rateEvidence?.currencyStatus, record.rateEvidence?.observedCurrency]);
  const prior = state.rates[key], previous = prior?.observations.at(-1);
  let status: RateChange['status'] = 'baseline', reason: string | null = null;
  let change: number | null = null, percentage: number | null = null;
  if (options.market === 'unfixed') {
    status = 'not_comparable'; reason = 'proxy_market_not_fixed';
  } else if (!record.rateEvidence?.searchContextVerified || record.rateEvidence.comparisonWarnings.length) {
    status = 'not_comparable'; reason = record.rateEvidence?.comparisonWarnings.join(',') || 'missing_rate_evidence';
  } else if (prior && (prior.terms !== terms || prior.evidence !== evidence)) {
    status = 'not_comparable'; reason = prior.terms !== terms ? 'offer_terms_changed' : 'price_basis_changed';
  } else if (previous && record.totalPrice !== null && previous.totalPrice !== null && previous.totalPrice > 0) {
    change = Math.round((record.totalPrice - previous.totalPrice) * 100) / 100;
    percentage = Math.round(change / previous.totalPrice * 10000) / 100;
    status = change < 0 ? 'price_drop' : change > 0 ? 'price_increase' : 'unchanged';
  }
  const observations = [...(prior?.observations ?? []), {
    at: record.scrapedAt, totalPrice: record.totalPrice, pricePerNight: record.pricePerNight,
    availabilityStatus: record.availabilityStatus,
  }].slice(-options.historyLimit);
  return {
    record: { ...record, rateChange: {
      monitorName: options.monitorName, status, reason,
      previousObservedAt: previous?.at ?? null, previousTotalPrice: previous?.totalPrice ?? null,
      totalPriceChange: change, priceChangePercent: percentage,
      alert: percentage !== null && Math.abs(percentage) >= options.threshold && percentage !== 0,
      observations,
    } },
    commit: () => {
      state.rates[key] = { context, terms, evidence, observations };
      // At most 1,000 stay/property comparisons, evicting the oldest observations.
      const keys = Object.keys(state.rates);
      if (keys.length > 1000) {
        keys.sort((a, b) => (state.rates[a].observations.at(-1)?.at ?? '').localeCompare(state.rates[b].observations.at(-1)?.at ?? ''));
        keys.slice(0, keys.length - 1000).forEach(k => delete state.rates[k]);
      }
    },
  };
}

export function monitorStoreName(owner: string, actor: string, name: string): string {
  return `booking-rates-${digest([owner, actor, name]).slice(0, 32)}`;
}
