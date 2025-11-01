import express from 'express';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const app = express();
app.use(express.json());

// === CONFIG ===
const REFERER_URL = 'https://artlist.io/voice-over';
const API_URL = 'https://artlist.io/api/auth/csrf';
const USER_DATA_DIR = './puppeteer_user_data'; // Persistent storage
const PUPPETEER_CACHE = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';

// Ensure dirs
await fs.mkdir(USER_DATA_DIR, { recursive: true });

// === DYNAMIC HEADERS ===
function generateTraceHeaders() {
  const traceId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const parentId = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return {
    'sentry-trace': `${traceId}-${parentId}-0`,
    'traceparent': `00-0000000000000000${traceId}-${parentId}-01`,
    'x-datadog-trace-id': Math.floor(Math.random() * 1e15).toString(),
    'x-datadog-parent-id': Math.floor(Math.random() * 1e15).toString(),
  };
}

// === MAIN ENDPOINT ===
app.post('/get-csrf', async (req, res) => {
  let browser = null;
  try {
    console.log('Launching Puppeteer...');

    // Find Chrome executable (installed by `npx puppeteer browsers install chrome`)
    const chromePath = await findChrome();
    if (!chromePath) {
      throw new Error('Chrome not found. Build must run: npx puppeteer browsers install chrome');
    }

    browser = await puppeteer.launch({
      headless: true,
      userDataDir: USER_DATA_DIR,
      executablePath: chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-g |
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-component-extensions-with-background-pages',
        '--disable-background-networking',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--disable-features=TranslateUI',
        '--disable-component-update',
      ],
      defaultViewport: null,
      timeout: 60000,
    });

    const page = await browser.newPage();

    // Set realistic headers
    await page.setExtraHTTPHeaders({
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9,hi;q=0.8',
      'sec-ch-ua': '"Google Chrome";v="141", "Not)A;Brand";v="8", "Chromium";v="141"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    });

    console.log('Navigating to trigger Cloudflare...');
    await page.goto(REFERER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(8000); // Let CF challenge resolve

    // Capture cookies
    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const cookieString = cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');

    const traceHeaders = generateTraceHeaders();

    const headers = {
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9,hi;q=0.8',
      'content-type': 'application/json',
      'priority': 'u=1, i',
      'referer': REFERER_URL,
      'sec-ch-ua': '"Google Chrome";v="141", "Not)A;Brand";v="8", "Chromium";v="141"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'cookie': cookieHeader,
      ...traceHeaders,
    };

    console.log('Fetching CSRF token...');
    const response = await page.evaluate(async (apiUrl, headers) => {
      const res = await fetch(apiUrl, {
        method: 'GET',
        headers: headers,
        credentials: 'include',
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, body: text };
    }, API_URL, headers);

    if (!response.ok) {
      throw new Error(`CSRF request failed: ${response.status} ${response.body}`);
    }

    let csrfToken = null;
    try {
      const json = JSON.parse(response.body);
      csrfToken = json.csrfToken || json.token || null;
    } catch (e) {
      console.warn('CSRF response not JSON:', response.body);
    }

    if (!csrfToken) {
      throw new Error('CSRF token not found');
    }

    res.json({
      success: true,
      csrfToken,
      cookies: cookieString,
      cookieCount: cookies.length,
      cf_clearance: cookies.find(c => c.name === 'cf_clearance')?.value || null,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
  }
});

// === HEALTH CHECK ===
app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    endpoint: 'POST /get-csrf',
    docs: 'Send POST to get fresh CSRF + cookies',
  });
});

// === FIND CHROME (Critical for Render) ===
async function findChrome() {
  const candidates = [
    // Render cache
    '/opt/render/.cache/puppeteer/chrome/linux-*/chrome',
    // Default Puppeteer install
    path.join(PUPPETEER_CACHE, 'chrome', 'linux-*', 'chrome'),
    // Fallback
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  for (const pattern of candidates) {
    try {
      const files = await fs.glob(pattern);
      if (files.length > 0) {
        const stat = await fs.stat(files[0]);
        if (stat.isFile()) {
          console.log('Chrome found:', files[0]);
          return files[0];
        }
      }
    } catch (e) {}
  }

  // Manual search in cache
  try {
    const cacheDir = path.dirname(candidates[1]);
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('chrome-linux')) {
        const chromePath = path.join(cacheDir, entry.name, 'chrome');
        const stat = await fs.stat(chromePath);
        if (stat.isFile()) {
          console.log('Chrome found in cache:', chromePath);
          return chromePath;
        }
      }
    }
  } catch (e) {}

  return null;
}

// === START SERVER ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CSRF API running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}`);
  console.log(`Get CSRF: POST http://localhost:${PORT}/get-csrf`);
});
