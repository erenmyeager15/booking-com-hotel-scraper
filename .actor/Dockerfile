FROM apify/actor-node-playwright-chrome:20

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm --quiet set progress=false \
 && npm ci --include=dev --omit=optional \
 && echo "Installed dependencies"

COPY . ./

RUN npm run build

CMD ["node", "dist/main.js"]
