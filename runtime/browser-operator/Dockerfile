# The worker connects to Steel's Chrome over CDP, so it needs NO local browser —
# playwright-core (no bundled Chromium) keeps the image small.
FROM node:20-slim
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build
CMD ["node", "dist/index.js"]
