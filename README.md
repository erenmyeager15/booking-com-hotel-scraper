# Booking.com Hotel Scraper - Prices, Reviews & Availability

Scrape Booking.com hotel and accommodation search results for travel market research, price monitoring, and competitor analysis. The actor searches one or more destinations for a date range, extracts clean property records, deduplicates by Booking.com property ID, and saves the results to an Apify Dataset. Export to JSON, CSV, Excel, or HTML, or pull via the Apify API. No login and no API key required.

For the first run, start small: one destination, `maxResults: 1`, and the recommended residential proxy enabled. Dates are optional; when omitted, the Actor searches a one-night stay beginning 30 days after the run date.

Each clean hotel record is saved through the `hotel-scraped` pay-per-event flow, so output is only kept when the result event charge is accepted. The actor skips incomplete cards that do not expose a property name and Booking.com hotel URL, so the dataset avoids empty placeholder rows.

## Features

- Multiple destinations in one run
- Explicit or automatically generated future check-in and check-out dates
- Adults, rooms, currency, review score, and property type inputs
- Pagination up to 500 properties per destination
- Residential proxy support for Apify cloud runs
- Random delays, session pool, and retry handling
- Null fallbacks for fields that Booking.com does not expose on every search card

## Data Extracted

| Field | Description |
| --- | --- |
| `propertyId` | Booking.com hotel slug or property ID |
| `hotelName` | Property name |
| `destination` | Destination used for the search |
| `starRating` | Star rating when exposed |
| `guestReviewScore` | Guest review score from 0 to 10 |
| `reviewCount` | Number of reviews |
| `totalPrice` | Total stay price for the searched dates |
| `pricePerNight` | Calculated or exposed nightly price |
| `originalPrice` | Original price before discount when exposed |
| `discountPercentage` | Discount percentage when calculable |
| `currency` | Requested currency |
| `freeCancellation` | Free cancellation signal from the card |
| `city` / `country` | Parsed from destination input |
| `distanceFromCityCenter` | Distance text from Booking.com |
| `propertyUrl` | Clean direct Booking.com hotel URL |
| `thumbnailImageUrl` | Property thumbnail image URL |
| `sustainabilityBadge` | Sustainability badge signal |
| `geniusDiscount` | Genius discount signal |
| `scrapedAt` | ISO timestamp |

## Use Cases

1. Hotel price monitoring across cities and dates
2. Travel app and comparison-site data enrichment
3. Hospitality competitor research
4. Market research by review score, price, and destination
5. Accommodation data collection for travel market research

## Pricing and cost control

This Actor uses Apify Pay Per Event pricing. The live Store configuration charges a small Actor start event and then charges hotel rows only when clean records are saved to the dataset.

| Event | Price | When charged |
| --- | ---: | --- |
| `apify-actor-start` | $0.00005 per GB | When the run starts, minimum one event |
| `hotel-scraped` | $0.008 | For each clean hotel record saved |

The current live pricing does not expose a separate per-destination search event. Hotel records are saved through the `hotel-scraped` event, and the run stops when the user's maximum cost limit is reached.

Cost-control tips:

- Start with one destination.
- Use a one-night future date range for your first test.
- Use `maxResults: 1` for the first test run.
- Leave `minReviewScore` at 0 for the broadest first test; add 7 or higher after output looks right.
- Keep residential proxy enabled for reliability.
- Increase destinations and result limits only after a small run returns the expected data.
- Runtime memory is capped at 2 GB to keep runs predictable.

## Input

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `destinations` | array | yes | `["London, United Kingdom"]` | One or more destinations to search. Use one destination for tests. |
| `checkIn` | string | no | 30 days after run | Optional future check-in date in YYYY-MM-DD format. |
| `checkOut` | string | no | one night after check-in | Optional future check-out date in YYYY-MM-DD format. Must be after check-in. |
| `adults` | integer | no | `2` | Number of adults per room. |
| `rooms` | integer | no | `1` | Number of rooms to search for. |
| `propertyTypes` | array | no | `[]` | Optional property type filters. Leave empty for all accommodation types. |
| `minReviewScore` | number | no | `0` | Optional guest review score threshold. |
| `maxResults` | integer | no | `1` | Maximum properties per destination. Use 1 for the first test; up to 500. |
| `currency` | string | no | `USD` | Display currency for prices. |
| `proxyConfiguration` | object | no | Residential | Apify proxy settings. Residential proxy is recommended. |

## Input Example

```json
{
  "destinations": ["London, United Kingdom"],
  "adults": 2,
  "rooms": 1,
  "minReviewScore": 0,
  "maxResults": 1,
  "currency": "USD",
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

To search specific dates, add `checkIn` and `checkOut` in `YYYY-MM-DD` format. Otherwise the dynamic one-night default remains future-safe for saved tasks and automated QA.

## How to Scrape Booking.com Hotels (Step by Step)

1. Click **Try for free** / **Run**.
2. Enter one destination. Optionally provide future `checkIn` / `checkOut` dates.
3. Set `adults`, `rooms`, `currency`, and `maxResults: 1` for the first run.
4. Optionally filter by `propertyTypes` and `minReviewScore`, then click **Run**.
5. When the run finishes, export results to JSON, CSV, Excel, or HTML, or pull them via the Apify API.

## Output dataset

The default **Hotel Records** dataset view is designed for quick export to CSV, Excel, JSON, or API workflows. It shows the most useful booking research fields first: destination, hotel name, stars, guest score, review count, total price, nightly price, currency, city/country, distance from city center, cancellation signal, property URL, property ID, and scraped timestamp. Original price, discount percentage, thumbnail, sustainability, and Genius signals remain available in full JSON when Booking.com exposes them.

```json
{
  "propertyId": "royal-national",
  "hotelName": "Royal National Hotel",
  "starRating": 3,
  "guestReviewScore": 7.9,
  "reviewCount": 19601,
  "city": "London",
  "country": "United Kingdom",
  "distanceFromCityCenter": "1.8 km from downtown",
  "totalPrice": 261,
  "pricePerNight": 261,
  "originalPrice": 290,
  "discountPercentage": 10,
  "currency": "USD",
  "freeCancellation": false,
  "propertyUrl": "https://www.booking.com/hotel/gb/royal-national.html",
  "thumbnailImageUrl": "https://cf.bstatic.com/xdata/images/hotel/square240/example.webp",
  "sustainabilityBadge": false,
  "geniusDiscount": false,
  "destination": "London, United Kingdom",
  "scrapedAt": "2026-06-21T12:43:43.000Z"
}
```

## Technical Details

- Runtime: Node.js 20 on `apify/actor-node-playwright-chrome:20`
- Scraping engine: Crawlee PlaywrightCrawler
- Proxy: Apify residential proxy recommended for cloud runs
- Retry policy: 3 retries with blocked-request retry handling
- Browser safety: up to 3 concurrent pages, 30 requests per minute, and 40 candidate pages per destination
- Storage: Apify Dataset
- Charge model: `Actor.pushData(record, "hotel-scraped")` per saved hotel

## Notes

- Booking.com can vary card fields by market, destination, availability, and experiment. Unavailable fields are returned as `null`.
- The default Apify table view focuses on populated search-result fields. Full JSON includes the complete runtime record shown above.
- This actor collects search result card data, not every detail available on individual hotel detail pages.
- Data is for research and business intelligence, not booking, legal, or financial advice.

## Responsible Use

This Actor is intended for lawful collection of publicly available information only. Users are responsible for ensuring their use complies with the source website's terms, robots.txt, applicable privacy laws, including India's DPDP Act, and all local regulations.

Do not use this Actor to collect, store, sell, or misuse personal data without a lawful basis. The Actor author is not responsible for misuse by end users.
