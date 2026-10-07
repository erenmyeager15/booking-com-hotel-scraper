import { Actor } from 'apify';
import type { HotelRecord } from './types.js';
import { emptyMonitor, prepareRateChange, monitorStoreName, type MonitorState } from './monitor.js';
import type { NormalizedInput } from './types.js';

type PushResult = Awaited<ReturnType<typeof Actor.pushData>>;
let saveRecord = (record: HotelRecord, event: string): Promise<PushResult> => Actor.pushData(record, event);
let finish = async () => {};
let savedHotelCount = 0;
export const monitoringCounts = { baseline: 0, compared: 0, notComparable: 0, alerts: 0, historyWriteFailures: 0, storeId: null as string | null };

export async function initializeMonitoring(input: NormalizedInput): Promise<void> {
  if (!input.trackChanges) return;
  const env = Actor.getEnv();
  if (!env.userId || !env.actorId) throw new Error('Persistent rate monitoring needs an Apify run with an identified owner and Actor.');
  const store = await Actor.openKeyValueStore(monitorStoreName(env.userId, env.actorId, input.monitorName));
  const loaded = await store.getValue<MonitorState>('RATES');
  if (loaded && (loaded.schemaVersion !== 1 || typeof loaded.rates !== 'object' || !loaded.rates || Array.isArray(loaded.rates)
    || Object.values(loaded.rates).some(rate => !rate || !Array.isArray(rate.observations) || !rate.observations.length))) {
    throw new Error('Incompatible saved monitor data; use a new monitorName.');
  }
  const state = loaded ?? emptyMonitor();
  monitoringCounts.storeId = store.id;
  let serial: Promise<unknown> = Promise.resolve();
  let writes = 0;
  saveRecord = (record, event) => {
    const operation = serial.then(async () => {
      const prepared = prepareRateChange(record, state, { monitorName: input.monitorName,
        market: input.proxyConfiguration.apifyProxyCountry ?? 'unfixed',
        threshold: input.priceChangeThresholdPercent, historyLimit: input.observationHistoryLimit });
      const pushed = await Actor.pushData(prepared.record, event);
      if (pushed.chargedCount > 0 || !pushed.eventChargeLimitReached) {
        prepared.commit(); writes++;
        const change = prepared.record.rateChange!;
        if (change.status === 'baseline') monitoringCounts.baseline++;
        else if (change.status === 'not_comparable') monitoringCounts.notComparable++;
        else monitoringCounts.compared++;
        if (change.alert) monitoringCounts.alerts++;
        // A history-write failure must not retry an already saved/billed hotel.
        // Keep collecting and retry the history write once at normal run completion.
        if (writes % 25 === 0) await store.setValue('RATES', state).catch(() => {
          monitoringCounts.historyWriteFailures++;
          console.warn('Rate history checkpoint could not be saved; retrying at run completion.');
        });
      }
      return pushed;
    });
    serial = operation.catch(() => null);
    return operation;
  };
  finish = async () => { await serial; if (writes) await store.setValue('RATES', state); };
}

export const pushHotelRecord = async (record: HotelRecord, event: string) => {
  const result = await saveRecord(record, event);
  if (result.chargedCount > 0 || !result.eventChargeLimitReached) savedHotelCount++;
  return result;
};
export const getSavedHotelCount = () => savedHotelCount;
export const finishMonitoring = () => finish();
