# Booking.com Scraper: Rooms, Prices & Availability

Scrape Booking.com hotels and accommodation by destination or by pasting a search-results URL with filters already applied. Export clean hotel records to JSON, CSV, Excel, XML, or HTML, or read them through the Apify API.

Choose **fast mode** for efficient search-result collection. Turn on **detailed mode** when you need room-level prices and availability, occupancy, bed types, meal plans, cancellation policies, facilities, photos, descriptions, addresses, coordinates, check-in/out times, and nearby places.

No Booking.com login or API key is required.

## Why use this Actor?

- Search by destination or paste a real Booking.com search URL
- Preserve the website filters and ordering from pasted URLs
- Choose fast search-card data or detailed property and room data
- Search with children ages, star ratings, price range, property type, review score, currency, language, and sorting
- Follow Booking.com's real next-page links for reliable pagination
- Deduplicate properties and stop exactly at `maxResults`
- Use datacenter proxy first; fast mode has a bounded residential fallback
- Pay only for clean records saved to the dataset
- Stop safely at the user's maximum run cost

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
- 40 pages have been examined for one source
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

The detailed events are new. Apify applies its standard 14-day notice period before new paid events take effect; during that transition, the Actor safely skips an undefined setup event and detailed rows use the existing fast-result event.

For a first detailed test, use one destination and `maxResults: 1`. For bulk collection, use fast mode and a full page such as 25 results. Set a maximum run cost in Apify when you want a hard ceiling on fast mode's automatic residential fallback.

## Reliability and cost control

- Direct Apify cloud traffic is rejected early because Booking.com commonly presents a verification challenge.
- With the default proxy input, fast mode tries the lower-cost datacenter pool first and automatically retries with residential only when the first tier produces no usable data.
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
