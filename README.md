# Booking.com Scraper: Hotel Rates, Rooms & Change Tracking

Scrape Booking.com hotels and accommodation by destination or by pasting a search-results URL with filters already applied. Export clean hotel records to JSON, CSV, Excel, XML, or HTML, or read them through the Apify API.

Choose **fast mode** for efficient search-result collection. Turn on **detailed mode** when you need room-level prices and availability, occupancy, bed types, meal plans, cancellation policies, facilities, photos, descriptions, addresses, coordinates, check-in/out times, and nearby places.

No Booking.com login or API key is required.

For recurring rate checks, enable `trackChanges` and use a stable `monitorName`, explicit stay dates and a fixed proxy country. Each saved row can include previous prices, percentage changes, alert flags and a bounded observation history. `rateEvidence` explains the displayed price basis, currency and tax signals, and `rateChange.reason` explains why a comparison was skipped.

## Why use this Actor?

- Search by destination or paste a real Booking.com search URL
- Preserve the website filters and ordering from pasted URLs
- Choose fast search-card data or detailed property and room data
- Search with children ages, star ratings, price range, property type, review score, currency, language, and sorting
- Load Booking's initial lazy-rendered batch and follow next-page links, with bounded pagination and explicit coverage limits
- Deduplicate properties and stop exactly at `maxResults`
- Use datacenter proxy first; optional Residential fallback is off by default and limited to one search page
- Bill hotel result events only for clean records saved; start/setup events are separate
- Stop hotel result charging at the user's maximum charge (not a hard platform-cost ceiling)

## Fast mode vs. detailed mode

| Capability | Fast mode | Detailed mode |
| --- | --- | --- |
| Hotel name, URL, property ID | Yes | Yes |
| Total and nightly stay price | Yes, from search card | Yes, with room-page fallback |
| Stars, guest score, review count | Yes | Yes |
| Original price and discount | When shown | When shown |
| Free-cancellation and Genius signals | Yes | Yes |
| Room types and bed configuration | No | Yes, when shown |
| Room occupancy and units left | No | Yes, when shown |
| Meal and cancellation policies | No | Yes, when shown |
| Room-level price and availability | No | Yes, when dates are available |
| Address, coordinates, description | No | Yes, when shown |
| Facilities and image gallery | Thumbnail only | Yes |
| Check-in/out times and surroundings | No | Yes, when shown |
| Speed | Fastest | Slower: one property-page visit per result |

Detailed mode is optional. Keep `scrapeDetails: false` for large listing searches, then enable it for the smaller set of properties where room and property depth matters.

## Input modes

### 1. Search by destination

Enter one or more destinations and configure the stay and filters in the Actor input.

```json
{
  "destinations": ["London, United Kingdom"],
  "adults": 2,
  "rooms": 1,
  "childrenAges": [7],
  "stars": [4, 5],
  "minReviewScore": 8,
  "minPrice": 100,
  "maxPrice": 500,
  "sortBy": "priceLowToHigh",
  "maxResults": 25,
  "currency": "GBP",
  "language": "en-gb",
  "scrapeDetails": false,
  "proxyConfiguration": {
    "useApifyProxy": true
  }
}
```

Dates are optional. When omitted, the Actor uses a one-night stay beginning 30 days after the run date. This keeps saved tasks and schedules from becoming stale.

### 2. Search by Booking.com URL

Apply filters on Booking.com, copy the complete search-results URL, and paste it into `searchUrls`.

```json
{
  "searchUrls": [
    "https://www.booking.com/searchresults.html?ss=Paris%2C+France&checkin=2026-10-10&checkout=2026-10-12&group_adults=2&no_rooms=1&nflt=class%3D5%3Bht_id%3D201&order=price"
  ],
  "maxResults": 50,
  "scrapeDetails": true,
  "maxImages": 10,
  "proxyConfiguration": {
    "useApifyProxy": true
  }
}
```

URL mode preserves the Booking.com URL's destination, dates, occupancy, currency, language, filters, and ordering while changing only pagination controls. When `searchUrls` is supplied, it takes priority over `destinations`; this prevents the input form's default London destination from starting an unintended extra search.

Missing dates and guest parameters are filled from the normalized input. Explicit expired dates, reversed dates, invalid currency or incomplete child ages are rejected before browsing, with a readable `OUTPUT` error. Explicit dates are never silently changed to another stay. An empty API input uses London and future date defaults; an explicitly empty destination list still needs a valid URL or destination.

## Repeat a rate watch

Set these options alongside your usual destination or saved search URL:

```json
{
  "destinations": ["London, United Kingdom"],
  "checkIn": "2026-11-15",
  "checkOut": "2026-11-17",
  "adults": 2,
  "rooms": 1,
  "currency": "GBP",
  "maxResults": 25,
  "trackChanges": true,
  "monitorName": "london-november-stay",
  "priceChangeThresholdPercent": 5,
  "observationHistoryLimit": 10,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyCountry": "US" }
}
```

Keep the same name, stay dates, guest ages, market, currency and filters on repeats. The first comparable observation is a baseline. Later rows report `unchanged`, `price_drop` or `price_increase`; moves reaching your threshold have `alert: true`. Send those fields to your own integration if you want notifications. The Actor does not send messages.

Choose a proxy country your account actually supports. The example uses US, which is independent of the London destination or GBP display currency. Datacenter access does not include every country; the Actor checks the proxy tunnel before browser setup and does not silently select another market. Removing the proxy country permits ordinary collection, but disables comparable rate alerts.

Unknown or ambiguous currency, missing tax context, a changed observed offer, an unverified search context or an unspecified proxy market produces `not_comparable` and no price alert. A dollar sign alone is ambiguous even when USD was requested. Displayed hotel offers can still change room type or conditions the search card does not reveal; this is a hotel-offer comparison, not a guarantee of identical room products or final checkout totals. Missing hotels are not treated as sold out.

Search URL parameters alone are not proof that Booking applied your stay. The Actor also checks exposed form values, selected calendar dates, and stay/guest parameters on rendered property links. Explicit date, guest, currency or location contradictions are rejected before saving results; a context-free or unverified empty page is not reported as genuine no availability. Yearless labels alone never confirm a stay. A read-only, hidden or incomplete search form does not block ordinary collection of priced hotel cards, and the Actor does not edit it or select another city. These rows retain `rateEvidence.searchContextVerified: false`; tracking reports `not_comparable` with no price alert. For comparable repeats, prefer a complete search URL generated by Booking with its destination identity, plus matching source-rendered stay evidence.

Booking may redirect a saved search to an undated city landing page or a search shell. These pages are not stay or availability evidence. The Actor permits one return to the exact original search URL, preserving its dates, guests and filters; a persistent redirect fails without saving or charging results from the redirected page. Valid hotels saved earlier in the run are retained and are not charged again. The same restoration allowance is retained across crawler retries; check `OUTPUT.status` and `searchCoverage` for an interrupted, partial search.

Booking can expose fewer static cards than the requested page size before lazy-loading the rest. The fast collector makes one bounded continuation from the number of cards actually received. If Booking repeats or ignores that continuation, prior IDs are retained and the browser fallback cannot bill them again.

History is private to the run account, Actor and monitor name, bounded to 1,000 property/stay contexts and 2–30 observations per context. Use non-overlapping scheduled runs; simultaneous runs sharing one monitor are not supported. Changing dates creates a different baseline. Future defaults change the stay each day, so use explicit dates for a meaningful repeat comparison.

`OUTPUT` reports search coverage (`complete`, `empty`, `limited` or `failed`), successful page counts, limitation reasons and monitoring counters. Repeated pages, result caps and page caps do not establish complete coverage. Summary and rate evidence use the existing hotel result events; no new paid monitoring event is introduced.

## Input reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `destinations` | string[] | London | Destinations for destination mode, up to 50 |
| `searchUrls` | string[] | `[]` | Booking.com search-results URLs, up to 50 |
| `checkIn` | string | run date + 30 days | Future date in `YYYY-MM-DD` |
| `checkOut` | string | one night later | Date after check-in |
| `adults` | integer | `2` | Adults per search |
| `rooms` | integer | `1` | Number of rooms |
| `childrenAges` | integer[] | `[]` | One age from 0–17 for each child |
| `propertyTypes` | string[] | `[]` | Hotels, Apartments, Hostels, Villas, Resorts, B&Bs, or Guest houses |
| `stars` | integer[] | `[]` | Star categories from 1–5 |
| `minReviewScore` | number | `0` | Exact post-filter threshold from 0–10 |
| `minPrice` / `maxPrice` | number | empty | Total stay-price range in selected currency |
| `sortBy` | string | `popularity` | Popularity, lowest price, review score, or distance |
| `maxResults` | integer | `25` | Maximum properties per destination or URL, up to 500 |
| `currency` | string | `USD` | Display currency for destination mode |
| `language` | string | `en-us` | Booking.com content language |
| `scrapeDetails` | boolean | `false` | Visit property pages for detailed property and room data |
| `maxImages` | integer | `10` | Images per property in detailed mode, from 1–50 |
| `proxyConfiguration` | object | Apify Proxy | Apify or custom proxy settings |
| `allowResidentialFallback` | boolean | `false` | Fast-mode opt-in fallback, one search page; higher transfer costs can exceed revenue |
| `maxPagesPerSearch` | integer | `4` | Page limit per search, from 1–40; not a coverage guarantee |
| `trackChanges` | boolean | `false` | Save and compare bounded observations of displayed hotel offers |
| `monitorName` | string | empty | Required with tracking; reuse the same 1–64-character name for repeats |
| `priceChangeThresholdPercent` | number | `5` | Alert flag threshold, from 0–100%; never alerts on unchanged or non-comparable prices |
| `observationHistoryLimit` | integer | `10` | Retained observations per hotel/stay context, from 2–30 |

## Output data

Every result includes search context so prices can be interpreted correctly:

- `propertyId`, `hotelName`, `propertyUrl`, and `sourceUrl`
- `destination`, `city`, `country`, and distance from city center
- `starRating`, `guestReviewScore`, and `reviewCount`
- `totalPrice`, `pricePerNight`, `originalPrice`, `discountPercentage`, and `currency`
- `available`, `availabilityStatus`, and `freeCancellation`
- `checkIn`, `checkOut`, `nights`, `adults`, `children`, and `rooms`
- `thumbnailImageUrl`, `sustainabilityBadge`, and `geniusDiscount`
- `scrapeMode`, `billingTier`, and `scrapedAt`

Detailed mode can additionally populate:

- `address`, `latitude`, `longitude`, and `description`
- `checkInTime` and `checkOutTime`
- `facilities`, `imageUrls`, and `surroundings`
- `roomOptions`

Each `roomOptions` item can contain:

```json
{
  "roomName": "Deluxe King Room",
  "bedType": "1 king bed",
  "occupancy": 2,
  "totalPrice": 320,
  "currency": "USD",
  "mealPlan": "Breakfast included",
  "cancellationPolicy": "Free cancellation before 6 PM",
  "freeCancellation": true,
  "refundable": true,
  "available": true,
  "unitsLeft": 2,
  "amenities": ["Air conditioning", "Private bathroom", "Free WiFi"]
}
```

Booking.com varies fields by property, market, dates, device layout, and experiment. Missing scalar fields are returned as `null`; missing collections are returned as empty arrays rather than invented values.

## Pagination

The Actor first uses Booking.com's actual **Next page** URL. This preserves destination IDs, filters, experiments, and other search context that can be lost when an offset is constructed from scratch. If a next link is not exposed, the Actor falls back to the current resolved URL with a bounded offset.

Pagination stops when any of these is true:

- `maxResults` is reached
- Booking.com has no next page
- a page contains only already-seen properties
- `maxPagesPerSearch` pages have been examined (default 4, maximum 40)
- the user's maximum run cost is reached

## Pricing

This Actor uses Pay Per Event pricing.

| Event | Price |
| --- | ---: |
| Actor start | $0.00005 per GB, minimum one event |
| Fast hotel record | $0.002 ($2 / 1,000) |
| Detailed hotel record | $0.005 ($5 / 1,000) |
| Detailed mode setup | $0.002 once per detailed run |

Fast mode costs **$2.00 per 1,000 saved hotel records**. Detailed mode costs **$5.00 per 1,000**, plus a **$0.002 one-time setup charge per run**, because it starts a browser session and opens one extra property page per hotel. The setup charge protects small-run reliability without inflating bulk per-result pricing. Every row reports its `billingTier`.

Platform runtime and the default proxy are included in these event prices and are not added separately to the user's bill. Detailed mode uses the datacenter pool (or a user-supplied custom proxy), keeping its price predictable and competitive.

The code also supports Apify pricing transitions: if the detailed events are not yet active, it skips an undefined setup event and detailed rows use the existing fast-result event. The prices shown above are the intended active event prices; consult the Actor pricing tab for your run.

For a first detailed test, use one destination and `maxResults: 1`. For bulk collection, use fast mode and a full page such as 25 results. Apify's maximum charge stops result billing, but it does not guarantee a ceiling on platform costs when requests fail before producing results. Residential transfer is costly, so automatic fallback requires `allowResidentialFallback: true` and stops after one search page. This can reduce coverage; it is reported in `OUTPUT`.

## Reliability and cost control

- Startup has a 60-second overall limit with shorter stage limits and named diagnostics for SDK initialization, input, proxy and history setup. A stalled stage ends the process as a failure, not an empty success. It does not automatically restart uncertain billing operations or continue with a different proxy. An accepted start/setup charge can still apply; no fixed all-in cost is guaranteed.
- Direct Apify cloud traffic is rejected early because Booking.com commonly presents a verification challenge.
- Unavailable proxy countries and proxy authentication errors fail early with guidance, rather than ten repeated HTTP attempts followed by an unnecessary browser fallback.
- With the default proxy input, fast mode stays on the lower-cost datacenter pool. A one-page Residential retry requires `allowResidentialFallback: true` and happens only if the first tier produces no usable data.
- Detailed mode stays on datacenter proxy to keep its fixed $5/1,000 price sustainable. Apify Residential is rejected for detailed runs; custom proxy URLs remain supported.
- Explicit Apify proxy groups and custom proxy URLs are always respected.
- Blocked sessions are retired and retried with bounded limits.
- Clean records are stored only when the corresponding result charge is accepted.
- The `OUTPUT` key-value-store record reports status, mode, result count, failed requests, source count, empty searches, and whether the spending limit stopped the run.

## API example

Run the Actor with the Apify API, then read the default dataset:

```bash
curl "https://api.apify.com/v2/acts/fascinating_lentil~booking-com-hotel-scraper/runs?token=YOUR_TOKEN" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"destinations":["London, United Kingdom"],"maxResults":1,"scrapeDetails":true}'
```

The same Actor can be connected to Make, Zapier, Google Sheets, webhooks, scheduled tasks, and other Apify integrations.

## Responsible use

This Actor collects publicly available accommodation information. Use it only where you have a lawful purpose and comply with Booking.com's terms, robots.txt, applicable privacy rules, and local regulations. Do not use the Actor to misuse personal data or interfere with the source service.
