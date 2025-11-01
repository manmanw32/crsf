# ---- Base image -------------------------------------------------
FROM node:20-slim

# ---- Chrome dependencies (official list) -------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# ---- Install Google Chrome (stable) -------------------------------
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] \
      http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# ---- Verify binary location ---------------------------------------
RUN google-chrome --version && which google-chrome

# ---- Create a tiny helper that puppeteer can call -----------------
RUN echo '#!/bin/sh\nexec google-chrome "$@"' > /usr/local/bin/chrome \
 && chmod +x /usr/local/bin/chrome

# ---- App ---------------------------------------------------------
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

COPY . .

EXPOSE 10000
CMD ["node", "index.js"]
