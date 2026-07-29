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
- Direct Apify cloud runs now fail immediately with a clear proxy error instead of waiting through Booking.com's robot-verification page.
- Booking.com's current `#challenge-container` response is detected explicitly.
- Request retries and session rotations are bounded to one each, navigation waits are shorter, and tiny runs request fewer rows.
- Successful and unsuccessful runs write a machine-readable `OUTPUT` summary.
- Treat `$4.00 / 1,000` as a controlled live experiment, not a proven sustainable price.
- Track paying users, results, success rate, cost per 1,000 results, revenue, profit, and margin for 24-72 hours.
- Keep the price only if measured cost per 1,000 stays below `$4.00` with an adequate safety margin.
- Roll back the price or pause promotion if measured cost remains above revenue.
- Do not run extra paid smoke tests unless a warning, user report, or unexpected success-rate drop requires one.

## Phase 3: Cost-first architecture

- **Status**: Planned if the live build remains unprofitable.
- Reduce memory, retries, session rotations, pagination depth, waits, and unnecessary Residential proxy usage.
- Benchmark cost separately for search-only and hotel-detail modes.
- Investigate Booking.com internal API or GraphQL requests as an HTTP-first path, retaining Playwright only as a fallback where technically and legally appropriate.
- Add premium detail scraping only after each mode has measured cost and a defensible event price.
