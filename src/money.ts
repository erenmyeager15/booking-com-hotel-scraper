const CURRENCY_PATTERN = String.raw`(?:(?:US|C|A|NZ)?\$|USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|BRL|MXN|SEK|NOK|DKK|NZD|KRW|SGD|MYR|THB|TRY|€|£|¥|₹|Rs\.?)`;

export function parseMoney(text: string | null): number | null {
  if (!text) return null;
  const normalized = text.replace(/[\u00a0\u202f]/g, ' ').trim();
  const number = String.raw`([0-9][0-9,.]*(?: [0-9]{3}(?:[,.][0-9]{1,2})?)*)`;
  const match = normalized.match(new RegExp(`${CURRENCY_PATTERN}\\s*${number}`, 'i'))
    ?? normalized.match(new RegExp(`${number}\\s*${CURRENCY_PATTERN}`, 'i'));
  if (!match) return null;
  let digits = match[1].replace(/\s/g, '').replace(/[,.]+$/, '');
  const lastDot = digits.lastIndexOf('.'), lastComma = digits.lastIndexOf(',');
  const last = Math.max(lastDot, lastComma);
  if (last >= 0) {
    const suffix = digits.length - last - 1;
    // Booking usually displays whole numbers. A 1-2 digit suffix is decimal;
    // a three-digit group is a thousands separator in either locale.
    if (suffix === 1 || suffix === 2) digits = digits.slice(0, last).replace(/[,.]/g, '') + '.' + digits.slice(last + 1);
    else digits = digits.replace(/[,.]/g, '');
  }
  const value = Number(digits);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function observedCurrency(text: string, requested: string): { currency: string | null; status: 'confirmed' | 'ambiguous' | 'mismatch' | 'unknown' } {
  const code = text.match(/\b(USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|BRL|MXN|SEK|NOK|DKK|NZD|KRW|SGD|MYR|THB|TRY)\b/i)?.[1].toUpperCase();
  const symbol = code ?? (/US\$/.test(text) ? 'USD' : /NZ\$/.test(text) ? 'NZD' : /C\$/.test(text) ? 'CAD' : /A\$/.test(text) ? 'AUD'
    : /€/.test(text) ? 'EUR' : /£/.test(text) ? 'GBP' : /₹|\bRs\.?/.test(text) ? 'INR' : null);
  if (symbol) return { currency: symbol, status: symbol === requested ? 'confirmed' : 'mismatch' };
  if (/\$|¥/.test(text)) return { currency: null, status: 'ambiguous' };
  return { currency: null, status: 'unknown' };
}
