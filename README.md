# Booking.com Hotel Scraper - Prices, Reviews & Availability

Scrape Booking.com hotel and accommodation search results for travel research, price monitoring, lead generation, and competitor analysis. The actor searches one or more destinations for a date range, extracts clean property records, deduplicates by Booking.com property ID, and saves the results to an Apify Dataset. Export to JSON, CSV, Excel, or HTML, or pull via the Apify API — no login and no API key required.

Each clean hotel record is charged with the `hotel-scraped` pay-per-event event after it is saved. The actor skips incomplete cards that do not expose a property name and Booking.com hotel URL, so the dataset avoids empty placeholder rows.

## Features

- Multiple destinations in one run
- Check-in and check-out date search
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
| `propertyType` | Hotel, apartment, hostel, villa, resort, B&B, or guest house when exposed |
| `starRating` | Star rating when exposed |
| `guestReviewScore` | Guest review score from 0 to 10 |
| `reviewCount` | Number of reviews |
| `totalPrice` | Total stay price for the searched dates |
| `pricePerNight` | Calculated or exposed nightly price |
| `originalPrice` | Original price before discount when exposed |
| `discountPercentage` | Discount percentage when calculable |
| `currency` | Requested currency |
| `breakfastIncluded` | Breakfast signal from the card |
| `freeCancellation` | Free cancellation signal from the card |
| `roomsAvailable` | Rooms available when exposed |
| `amenities` | Amenities/facilities exposed on the card |
| `city` / `country` | Parsed from destination input |
| `distanceFromCityCenter` | Distance text from Booking.com |
| `address` | Address when exposed |
| `propertyUrl` | Clean direct Booking.com hotel URL |
| `thumbnailImageUrl` | Property thumbnail image URL |
| `latitude` / `longitude` | Coordinates when exposed |
| `sustainabilityBadge` | Sustainability badge signal |
| `geniusDiscount` | Genius discount signal |
| `scrapedAt` | ISO timestamp |

## Use Cases

1. Hotel price monitoring across cities and dates
2. Travel app and comparison-site data enrichment
3. Hospitality competitor research
4. Market research by review score, price, and destination
5. Accommodation lead generation for travel businesses

## How to Scrape Booking.com Hotels (Step by Step)

1. Click **Try for free** / **Run**.
2. Enter one or more `destinations` (e.g. `Paris, France`) and your `checkIn` / `checkOut` dates.
3. Set `adults`, `rooms`, `currency`, and `maxResults` (start small to test).
4. Optionally filter by `propertyTypes` and `minReviewScore`, then click **Run**.
5. When the run finishes, export results to JSON, CSV, Excel, or HTML, or pull them via the Apify API.

## Sample Output

```json
{
  "propertyId": "monsieur-george-amp-spa-champs-elysees",
  "hotelName": "Monsieur George Hotel & Spa - Champs-Elysees",
  "propertyType": null,
  "starRating": null,
  "guestReviewScore": 9,
  "reviewCount": 882,
  "reviewCategories": {
    "location": 8,
    "cleanliness": null,
    "comfort": null,
    "facilities": null
  },
  "city": "Paris",
  "country": "France",
  "distanceFromCityCenter": "4 km from downtown",
  "totalPrice": 1078,
  "pricePerNight": 539,
  "currency": "USD",
  "breakfastIncluded": false,
  "freeCancellation": false,
  "propertyUrl": "https://www.booking.com/hotel/fr/monsieur-george-amp-spa-champs-elysees.html",
  "thumbnailImageUrl": "https://cf.bstatic.com/xdata/images/hotel/square240/example.webp",
  "destination": "Paris, France",
  "scrapedAt": "2026-06-11T15:48:29.877Z"
}
```

## Input Example

```json
{
  "destinations": ["Paris, France"],
  "checkIn": "2026-07-01",
  "checkOut": "2026-07-03",
  "adults": 2,
  "rooms": 1,
  "propertyTypes": ["Hotels", "Apartments"],
  "minReviewScore": 7,
  "maxResults": 50,
  "currency": "USD",
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

## Pricing

| Event | Price |
| --- | --- |
| `hotel-scraped` | $0.003 per clean hotel record |
| 1,000 hotels | $3.00 |
| 10,000 hotels | $30.00 |

## Technical Details

- Runtime: Node.js 20 on `apify/actor-node-playwright-chrome:20`
- Scraping engine: Crawlee PlaywrightCrawler
- Proxy: Apify residential proxy recommended for cloud runs
- Retry policy: 3 retries with blocked-request retry handling
- Storage: Apify Dataset
- Charge model: `Actor.charge({ eventName: "hotel-scraped" })`

## Notes

- Booking.com can vary card fields by market, destination, availability, and experiment. Unavailable fields are returned as `null`.
- The default Apify table view focuses on populated search-result fields and hides optional columns that are often unavailable on Booking.com cards. Raw JSON still includes those fields.
- This actor collects search result card data, not every detail available on individual hotel detail pages.
- Data is for research and business intelligence, not booking, legal, or financial advice.
