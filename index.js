import express from 'express';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';

const app = express();
app.use(express.json());

const REFERER_URL = 'https://artlist.io/voice-over';
const API_URL = 'https://artlist.io/api/auth/csrf';
const USER_DATA_DIR = './puppeteer_user_data';
await fs.mkdir(USER_DATA_DIR, { recursive: true });

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

async function findChrome() {
  const candidates = [
    '/usr/bin/google-chrome',  // Correct path for google-chrome-stable
    process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/render/.cache/puppeteer/chrome/linux-*/chrome',
    '/usr/bin/chromium-browser',
  ];

  for (const execPath of candidates) {
    try {
      await fs.access(execPath);
      console.log('Chrome found:', execPath);
      return execPath;
    } catch (_) {}
  }
  throw new Error('Chrome not found. Verify Dockerfile installation and path.');
}

app.post('/get-csrf', async (req, res) => {
  let browser = null;
  try {
    const chromePath = await findChrome();

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
      ],
      defaultViewport: null,
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9,hi;q=0.8',
      'sec-ch-ua': '"Google Chrome";v="141", "Not)A;Brand";v="8", "Chromium";v="141"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    });

    console.log('Navigating...');
    await page.goto(REFERER_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForTimeout(8_000);

    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const cookieString = cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');

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
      ...traceHeaders(),
    };

    const resp = await page.evaluate(async (url, hdrs) => {
      const r = await fetch(url, { method: 'GET', headers: hdrs, credentials: 'include' });
      const txt = await r.text();
      return { ok: r.ok, status: r.status, body: txt };
    }, API_URL, headers);

    if (!resp.ok) throw new Error(`CSRF request failed ${resp.status}`);

    let csrfToken = null;
    try {
      const json = JSON.parse(resp.body);
      csrfToken = json.csrfToken ?? json.token ?? null;
    } catch (_) {}
    if (!csrfToken) throw new Error('CSRF token not found');

    res.json({
      success: true,
      csrfToken,
      cookies: cookieString,
      cf_clearance: cookies.find(c => c.name === 'cf_clearance')?.value ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', endpoint: 'POST /get-csrf' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
