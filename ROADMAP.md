# Booking.com Hotel Scraper Roadmap

## Phase 1: Playwright optimization and pricing

- **Status**: Published; profitability not yet verified.
- Heavy browser assets (`image`, `media`, `font`, and `stylesheet`) are blocked.
- The live pay-per-event price is `$0.004` per hotel scraped (`$4.00 / 1,000`).
- The default and minimum memory were reduced to `1024 MB`, with `2048 MB` still available for larger batches. Browser concurrency is capped at one page to keep the 1 GB default stable.
- Residential proxy use remains in the documented/default example path.
- The previous estimate of `$1.00-$1.50 / 1,000` backend cost is unverified and must not be used as a profitability claim. The last observed Apify estimate before this release was `$28.86 / 1,000 results`.

## Phase 2: Live cost verification

- **Status**: Reliability hardening implemented on 2026-07-29; live economics still under observation.
- Live API verification on **2026-08-02** found build **1.0.29**, a **1024 MB**
  default, **28 succeeded / 3 failed / 0 timed out** public runs over the prior
  30 days, and 2 active users in both the 7-day and 30-day windows. This is a
  **90.3%** 30-day success rate and supersedes the older 76% snapshot.
- Direct Apify cloud runs now fail immediately with a clear proxy error instead of waiting through Booking.com's robot-verification page.
- Booking.com's current `#challenge-container` response is detected explicitly.
- Transient challenge shells get a short resolution window so valid Residential sessions are not retired before hotel cards render.
- Request retries and session rotations are bounded to two each, while explicit challenge detection prevents long blocked-page waits.
- Successful and unsuccessful runs write a machine-readable `OUTPUT` summary.
- Treat `$4.00 / 1,000` as a controlled live experiment, not a proven sustainable price.
- Track paying users, results, success rate, cost per 1,000 results, revenue, profit, and margin for 24-72 hours.
- Keep the price only if measured cost per 1,000 stays below `$4.00` with an adequate safety margin.
- Roll back the price or pause promotion if measured cost remains above revenue.
- Do not run extra paid smoke tests unless a warning, user report, or unexpected success-rate drop requires one.

### 2026-08-02 pricing and architecture review

- Keep the current **$0.004/hotel + $0.00005/start** configuration while the
  active-listing observation window is running. The price is near current Store
  competitors, but profitable paid-run economics are not yet proven.
- Do **not** enable pay-per-event plus platform usage as the default response to
  uncertain margin. Apify documents that pass-through as a temporary pricing-test
  tool that reduces transparency and negatively affects Actor quality score.
- Do **not** block browser scripts without a controlled proof. The current reliable
  path sometimes needs Booking.com's challenge scripts to resolve before property
  cards appear; copying another Actor's HTTP-only claim is not evidence that this
  implementation can safely disable them.
- The Chromium site-isolation flags and fixed waits remain review candidates, but
  neither should be changed during the current observation window without a
  reproducible failure or a controlled before/after cost measurement.
- Next evidence required: paid-run revenue, platform cost, result count, duration,
  and failure reason for at least three post-1.0.29 runs. Do not infer sustainable
  margin from a single owner smoke test.

## Phase 3: Cost-first architecture

- **Status**: Isolated feasibility work only; no production rewrite approved.
- Reduce memory, retries, session rotations, pagination depth, waits, and unnecessary Residential proxy usage.
- Benchmark cost separately for search-only and hotel-detail modes.
- Investigate Booking.com internal API or GraphQL requests as an HTTP-first path, retaining Playwright only as a fallback where technically and legally appropriate.
- Any HTTP-first path must be independently verified against current responses,
  source terms, output parity, block behavior, and cost. Do not copy a competitor's
  undocumented endpoint or treat the phrase "unprotected GraphQL API" as permission
  or a stable contract.
- Add premium detail scraping only after each mode has measured cost and a defensible event price.
