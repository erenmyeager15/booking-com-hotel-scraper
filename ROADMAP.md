# Booking.com Hotel Scraper Roadmap

## ✅ Phase 1: Profitability Optimization (Completed)
- **Status**: Deployed
- **Goal**: Make the scraper highly profitable at a competitive price point.
- **Actions Taken**:
  - Reduced memory footprint to 512MB.
  - Aggressively blocked all non-essential assets (Images, CSS, Fonts, Media) to reduce bandwidth and CPU usage.
  - Removed all hardcoded arbitrary delays (Wait times cut from up to 3s down to 100-300ms).
  - Switched exclusively to Pay-per-event pricing model.
  - Validated AWS WAF challenge bypass using the optimized Playwright engine.
- **Outcome**: The event price is now `$0.004` per hotel scraped, while the backend platform costs were reduced to an estimated `~$1.00-$1.50` per 1K results.

## 📈 Phase 2: Monitoring & Verification (Current)
- **Status**: In Progress
- **Goal**: Verify real-world profitability and stability.
- **Actions**:
  - Monitor the Apify Insights tab for the next 7-14 days.
  - Track "Cost per 1,000 runs" to ensure the compute optimizations hold true for production traffic.
  - Verify that the `$0.004` price point attracts more volume and generates positive margins.
  - Monitor the "Issues" tab for any new AWS WAF variations or layout changes on Booking.com.

## 🚀 Phase 3: Growth & Feature Expansion (Future)
- **Status**: Planned
- **Goal**: Increase revenue per user by offering premium data fields.
- **Potential Features**:
  - **Premium Detail Scraping**: Add an option to scrape "Rooms & Surroundings" data (similar to Voyager). This would require navigating to the hotel detail page, which is more expensive, but can be charged as a separate premium PPE event (e.g., `$0.008` for standard, `$0.012` for deep scraping).
  - **GraphQL/Internal API Discovery**: Investigate if Booking.com's mobile API or internal GraphQL endpoints can be scraped directly to completely bypass the AWS WAF JS-challenge, dropping costs to near-zero.
  - **Dynamic Rate Limiting**: Implement smarter auto-scaling based on Apify's CPU signals.
