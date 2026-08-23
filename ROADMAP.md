# Booking.com Hotel Scraper Roadmap

## Phase 5: URL mode, real pagination, and detailed property data (2026-08-23)

- Added Booking.com search-URL mode that preserves website filters, dates, occupancy,
  currency, language, and ordering.
- Replaced offset-only pagination with Booking.com's real next-page link when exposed;
  the resolved current URL is now the bounded fallback, so destination IDs and search
  context are retained.
- Added destination filters for children ages, stars, price range, sort order, and
  language.
- Added optional detailed mode for room types, bed configuration, occupancy, room
  prices, meal plans, cancellation/refundability, units left, property facilities,
  photos, address, coordinates, description, check-in/out times, and surroundings.
- Fast mode keeps the HTTP-first path. Detailed mode intentionally uses property-page
  browser requests and charges only after the enriched record is saved.
- Verification now passes with **23/23 tests**, TypeScript compilation, and valid
  input, dataset, and output schemas.

Live one-result detailed proofs now supersede that pending note:

- Build **1.0.37**, residential run `EU3TPSihyAtA2uVnH`: succeeded, 68.9s,
  1 enriched hotel, 18 room options, 0 failures, 8.94 MB residential transfer. The
  residential proxy component alone was about $0.0715 at the documented $8/GB rate.
- Build **1.0.38**, datacenter-first run `kvSRvjY88YtoZXo9l`: succeeded, 53.1s,
  1 enriched hotel, 18 room options, 0 failures, zero residential transfer, about
  $0.00393 after usage settled. The lower value visible immediately after the run
  was provisional and must not be used for pricing.
- Build **1.0.40**, datacenter run `h3KfctiLe24VLtX2k`: succeeded in about 55s with
  1 enriched hotel, 27 room options, 0 failed requests, and zero residential
  transfer. Settled platform usage is about **$0.00390**. This proof exposed a
  room-currency label mismatch; the parser now prefers the requested currency's
  symbol-and-number pair, with a regression test covering the observed layout.
- Final code and documentation are deployed as Apify build **1.0.42**
  (`nfOehi8aZy3XBnSdL`) and pushed to GitHub as commit **234521f**. No additional
  paid run had been started after the deterministic currency-parser fix at that point.
- Build **1.0.42**, datacenter run `JkSN5ORejRLfnApwT`: succeeded in 51.2s with
  1 enriched hotel, 27 room options, 0 failed requests, zero residential transfer,
  correct USD labels, and about **$0.004** settled platform usage. Memory averaged
  542.5 MB and peaked at 740.2 MB, confirming that the Playwright path should retain
  its 1,024 MB allocation rather than risk a 512 MB container.
- The margin-safe event design is deployed as build **1.0.43**
  (`CKAA2grtF6bo4xLYs`) and implemented in Git commit **6b21b1f**. The cloud build
  succeeded, but its two new pricing events remain inactive until the Console change
  is explicitly saved.

The product design keeps fast rows at **$0.002** and proposes a competitive
**$0.005 detailed row**, plus a **$0.002 one-time detailed-mode setup event**. The
setup charge covers the browser/session startup that dominates one-result runs while
keeping bulk pricing effectively at $5/1,000. At one result, creator revenue after
Apify's 20% share is $0.0056 against about $0.004 settled usage; the measured margin
is therefore about 29%. Detailed mode stays on datacenter proxy (or a user-supplied
custom proxy), because the residential proof would require an uncompetitive result
price. Explicit Apify Residential input is rejected for detailed mode; fast mode
retains its bounded residential fallback. The code safely skips new events until they
become active.

The proposed `detailed-hotel-scraped` and `detailed-run-started` events are **not yet
active in live monetization**. Live Actor pricing remains `hotel-scraped` at **$0.002**
plus the **$0.00005** Actor start event. Do not claim the $5 tier is published until
the Console change is saved. The public Store title, short description, and detailed
example also remain pending publication; the verified public title is still
`Booking.com Hotel Scraper - $2/1k, Prices & Availability`.

## Phase 4: Repriced to $2.00 / 1,000 (2026-08-13)

The owner changed the Console price from **$0.004 to $0.002 per `hotel-scraped`**
(`$2.00 / 1,000`), verified live via API at `2026-08-13T07:04:12Z`. The
`apify-actor-start` event stays at the Apify default **$0.00005** and platform usage is
**not** passed to users. `.actor/actor.json` was updated to the same figures so a later
`apify push` cannot revert the Console edit.

Against the measured datacenter cost of **$0.00013 per property**, this is a **92%
margin**, about **$0.00147 profit per result**, and break-even at roughly **2 results
per run**. The earlier warning that sub-$2 pricing was loss-making applied to the
residential proxy path and no longer holds.

Positioning rationale: $2.00 is the category's mainstream anchor, matching the
long-established `voyager/fast-booking-scraper` and `unfenced-group` at $1.99, while
undercutting `agenscrape` at $3, `noraview` at $5, and `juryless_lens` at $7. The $1.50
bracket was deliberately avoided because `solidcode` (87 users) and `makework36` (37
users) already compete there and it costs another 25% of revenue for little perceived
gain. Note that demand in this category does not track price: `noraview` charges $5 and
has 257 users, so price is a weak lever and $1.50 is kept in reserve as a future
promotional move rather than spent now.

The Store title now surfaces the price as
`Booking.com Hotel Scraper - $2/1k, Prices & Availability` (56 chars), the same tactic
used on Blinkit and JioMart. `seoTitle` deliberately omits the price so search metadata
cannot go stale after a future change. The near-zero start fee is now advertised in the
README as a differentiator, since several competitors charge $0.01 to $0.10 per run.

## Phase 3: Measured run economics (2026-08-12)

Two paid verification runs on build **1.0.32/1.0.33**, London, 2 adults, 1 room,
replaced every earlier cost estimate with measured figures.

**Residential run `TsoLfY5QQiAWN6W7l`** - SUCCEEDED, 42.2s, 25 records:
total **$0.03336**, of which `PROXY_RESIDENTIAL_TRANSFER` was **$0.03006 (90%)** on
**3.85 MB**, compute **$0.00234 (7%)**, everything else 3%. Cost per property
**$0.001335**.

**Datacenter run `655ETFxqPKfEPFtW4`** - SUCCEEDED, 71.2s, 25 records, proxy group
`BUYPROXIES94952`: total **$0.00540** with **zero** residential bytes. Cost per
property **$0.000216**, a **6.2x** improvement and an **84%** cheaper run. Booking.com
served this datacenter pool without blocking. Cost is now dominated by **compute
($0.00396, 73%)** rather than proxy. Single sample; repeat before relying on it.

Margins at measured datacenter cost, net of Apify's 20% commission: **93%** at $4/1k,
**87%** at $2/1k, **82%** at $1.50/1k, **73%** at $1/1k. At residential cost, $1.50/1k
is **loss-making** at -11%. These figures used the probe's $0.000216 per property; the
shipped datacenter default later measured **$0.00013**, which lifts the $2/1k margin to
**92%**.

### Datacenter-first proxy with residential fallback (shipped)

The default proxy configuration no longer pins `RESIDENTIAL`. When no group is
requested, the run tries Apify's datacenter pool first and only retries on residential
if the cheap tier collected nothing, so a datacenter block costs money instead of
costing the user their results. Explicit group choices and custom `proxyUrls` are never
overridden, and a requested country carries onto both tiers. Each tier gets fresh
per-destination state and its own crawler, and `resetNoResultDestinations()` prevents a
blocked first tier from being misreported as a genuinely empty search. Destination
search charges happen once, before the tier loop, so a retry cannot double-charge.

### Historical issues found before Phase 5

- **Offset-only pagination did not advance (code path replaced in Phase 5).** With `maxResults: 50` the browser logged
  `Found 50 cards` at `offset=0`, kept 25 valid records, then fetched `offset=25`,
  logged `Found 50 cards` again, and produced **zero** new records. Booking.com
  returned the same card set, so the second page fetch was pure waste. On residential
  that nearly doubles run cost for no extra rows. `maxResults` is therefore capped at a
  practical **~25 per destination** even though the schema allowed 500. Phase 5 now
  follows the real next-page URL; a live multi-page proof is still required.
- **Only about half of the cards become records.** Pages render 50 cards but yield ~25
  valid rows, so ad or placeholder cards are being counted in `Found N cards`.
- **The cheerio fast path never succeeds in production.** It finished in 1-2.5s with no
  usable cards on both residential and datacenter, so every run pays for the Playwright
  fallback. Fixing it would cut both proxy bytes and the compute that now dominates cost.
- Memory is still **1024 MB**. Now that compute is 73% of a datacenter run, dropping to
  512 MB is worth testing, but only after the browser fallback stops being the norm.

## Phase 1: Playwright optimization and pricing

- **Status**: Published; profitability not yet verified.
- Heavy browser assets (`image`, `media`, `font`, and `stylesheet`) are blocked.
- The live pay-per-event price was `$0.004` per hotel scraped (`$4.00 / 1,000`).
  Superseded on 2026-08-13; see Phase 4.
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
  Superseded on 2026-08-13: the price is now `$2.00 / 1,000` and cost per property is
  measured at `$0.00013`, so profitability is no longer unproven.
- Track paying users, results, success rate, cost per 1,000 results, revenue, profit, and margin for 24-72 hours.
- Keep the price only if measured cost per 1,000 stays well below it. Measured cost is
  now `$0.13 / 1,000` on datacenter proxy against `$2.00 / 1,000` of revenue.
- Roll back the price or pause promotion if measured cost remains above revenue.
- Do not run extra paid smoke tests unless a warning, user report, or unexpected success-rate drop requires one.

### 2026-08-02 pricing and architecture review

- Superseded on 2026-08-13 by the $0.002/hotel price in Phase 4.
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
- Detailed scraping shipped as an opt-in mode in Phase 5 at the existing record price;
  benchmark it separately and revisit pricing if live cost threatens margin.
