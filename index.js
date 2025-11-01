import express from 'express';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';

const app = express();
app.use(express.json());

// Config
const REFERER_URL = 'https://artlist.io/voice-over';
const API_URL = 'https://artlist.io/api/auth/csrf';
const USER_DATA_DIR = './puppeteer_user_data'; // Persistent across deploys

// Ensure dir exists
await fs.mkdir(USER_DATA_DIR, { recursive: true });

// Helper: Generate Sentry/Trace headers (optional, but keeps request realistic)
function generateTraceHeaders() {
  const traceId = Array(16).fill().map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
  const parentId = Array(8).fill().map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
  return {
    'sentry-trace': `${traceId}-${parentId}-0`,
    'traceparent': `00-0000000000000000${traceId}-${parentId}-01`,
    'x-datadog-trace-id': Math.floor(Math.random() * 1000000000000000).toString(),
    'x-datadog-parent-id': Math.floor(Math.random() * 1000000000000000).toString(),
  };
}

app.post('/get-csrf', async (req, res) => {
  let browser;
  try {
    console.log('Launching Puppeteer...');
    browser = await puppeteer.launch({
      headless: true,
      userDataDir: USER_DATA_DIR,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--disable-dev-shm-usage',
      ],
      defaultViewport: null,
    });

    const page = await browser.newPage();

    // Set realistic headers
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    });

    console.log('Navigating to trigger Cloudflare...');
    await page.goto(REFERER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(7000); // Let CF resolve

    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const cookieString = cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');

    const traceHeaders = generateTraceHeaders();

    const headers = {
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json',
      'priority': 'u=1, i',
      'referer': REFERER_URL,
      'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
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
      return { status: res.status, body: text, ok: res.ok };
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
      throw new Error('CSRF token not found in response');
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
    });
  } finally {
    if (browser) await browser.close();
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'alive', endpoint: 'POST /get-csrf' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CSRF API running on port ${PORT}`);
});
