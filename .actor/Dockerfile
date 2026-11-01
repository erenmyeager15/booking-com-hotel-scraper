FROM apify/actor-node-playwright-chrome:24-1.64.1-slim@sha256:6553a91859376e9557c28cd866959d32f20e3787e869e7765afa7ed36ebdafd9

# Refuse a stale base layer lacking the 21 October 2026 Node security release.
RUN node -e "const [a,b,c]=process.versions.node.split('.').map(Number); if(a!==24 || b<22 || (b===22 && c<1)) throw new Error('Patched Node 24.22.1 or later in the 24.x line required'); console.log('Verified Node',process.version)"

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm --quiet set progress=false \
 && timeout --signal=TERM --kill-after=5s 45s npm ci --include=dev --omit=optional --no-audit --no-fund \
 && echo "Installed dependencies"

COPY . ./

# The exact pinned base image already ran Playwright 1.64.1 install chromium,
# which supplies the matching headless shell. Do not invoke npx or a second
# browser download here. A missing/broken binary fails this bounded smoke check.
RUN timeout --signal=TERM --kill-after=5s 25s npm run build \
 && timeout --signal=TERM --kill-after=5s 25s node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch({ headless: true, timeout: 15000, args: ['--no-sandbox'] }); console.log('Verified Booking headless shell', browser.version()); await browser.close();"

# The base image permits a 30 GB old-space heap. Keep a bounded Node heap at
# runtime so garbage collection leaves room for the browser in a 1 GB Actor.
# This limits V8 old space, not total process or container memory. Compilation
# above retains its build-time memory; the existing header allowance is kept.
ENV NODE_OPTIONS="--max-old-space-size=256 --max-semi-space-size=16 --max-http-header-size=80000"

CMD ["node", "dist/main.js"]
