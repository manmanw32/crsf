import express from 'express';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';

const app = express();
app.use(express.json());

const REFERER_URL = 'https://artlist.io/voice-over';
const API_URL = 'https://artlist.io/api/auth/csrf';
const USER_DATA_DIR = './puppeteer_user_data';

// Ensure user data directory exists
await fs.mkdir(USER_DATA_DIR, { recursive: true }).catch(() => {});

function randomHex(len) {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function traceHeaders() {
  const trace = randomHex(32);
  const parent = randomHex(16);
  return {
    'sentry-trace': `${trace}-${parent}-0`,
    'traceparent': `00-0000000000000000${trace}-${parent}-01`,
    'x-datadog-trace-id': Math.floor(Math.random() * 1e15).toString(),
    'x-datadog-parent-id': Math.floor(Math.random() * 1e15).toString(),
  };
}

// Robust Chrome path detection
async function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
  ].filter(Boolean);

  for (const execPath of candidates) {
    try {
      await fs.access(execPath);
      console.log(`Chrome found at: ${execPath}`);
      return execPath;
    } catch (_) {}
  }

  // Final fallback: try to run `which google-chrome`
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    const { stdout } = await execAsync('which google-chrome || which google-chrome-stable || which chromium-browser', { timeout: 5000 });
    const path = stdout.trim();
    if (path) {
      console.log(`Chrome discovered via 'which': ${path}`);
      return path;
    }
  } catch (_) {}

  throw new Error('Chrome not found. Ensure google-chrome-stable is installed and at /usr/bin/google-chrome');
}

app.post('/get-csrf', async (req, res) => {
  let browser = null;
  try {
    const chromePath = await findChrome();

    console.log('Launching Puppeteer...');
    browser = await puppeteer.launch({
      headless: true,
      userDataDir: USER_DATA_DIR,
      executablePath: chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--mute-audio',
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-features=ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,SSDService',
      ],
      defaultViewport: null,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // Set realistic headers
    await page.setExtraHTTPHeaders({
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="141", "Not)A;Brand";v="8", "Chromium";v="141"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    });

    console.log('Navigating to Artlist...');
    await page.goto(REFERER_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForTimeout(8_000);

    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const cookieString = cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');

    const headers = {
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
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
      ...traceHeaders(),
    };

    console.log('Fetching CSRF token...');
    const resp = await page.evaluate(async (url, hdrs) => {
      try {
        const r = await fetch(url, {
          method: 'GET',
          headers: hdrs,
          credentials: 'include',
        });
        const txt = await r.text();
        return { ok: r.ok, status: r.status, body: txt };
      } catch (e) {
        return { ok: false, status: 0, body: e.message };
      }
    }, API_URL, headers);

    if (!resp.ok) {
      throw new Error(`CSRF request failed: ${resp.status} ${resp.body}`);
    }

    let csrfToken = null;
    try {
      const json = JSON.parse(resp.body);
      csrfToken = json.csrfToken ?? json.token ?? json.data?.csrfToken ?? null;
    } catch (e) {
      console.warn('Failed to parse CSRF JSON:', e.message);
    }

    if (!csrfToken) {
      throw new Error('CSRF token not found in response');
    }

    const cfClearance = cookies.find(c => c.name === 'cf_clearance')?.value ?? null;

    res.json({
      success: true,
      csrfToken,
      cookies: cookieString,
      cf_clearance: cfClearance,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('CSRF Error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.warn('Browser close error:', e.message);
      }
    }
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'POST /get-csrf to retrieve Artlist CSRF token',
    timestamp: new Date().toISOString(),
  });
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/`);
  console.log(`Endpoint: POST http://localhost:${PORT}/get-csrf`);
});
