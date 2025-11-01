import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

/* -------------------------------------------------------------
   CONFIG – Production Browserless endpoint (v2)
   ------------------------------------------------------------- */
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || 'YOUR_TOKEN_HERE';
const BROWSERLESS_URL   = `https://production-sfo.browserless.io/content?token=${BROWSERLESS_TOKEN}`;

const REFERER_URL = 'https://artlist.io/voice-over';
const CSRF_API    = 'https://artlist.io/api/auth/csrf';

/* -------------------------------------------------------------
   Helper – random trace headers
   ------------------------------------------------------------- */
function randomHex(len) {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
function traceHeaders() {
  const trace  = randomHex(32);
  const parent = randomHex(16);
  return {
    'sentry-trace': `${trace}-${parent}-0`,
    'traceparent': `00-0000000000000000${trace}-${parent}-01`,
    'x-datadog-trace-id': Math.floor(Math.random() * 1e15).toString(),
    'x-datadog-parent-id': Math.floor(Math.random() * 1e15).toString(),
  };
}

/* -------------------------------------------------------------
   POST /get-csrf
   ------------------------------------------------------------- */
app.post('/get-csrf', async (req, res) => {
  try {
    console.log('Launching Browserless (v2) session...');

    // ONLY ALLOWED FIELDS
    const payload = {
      url: REFERER_URL,
      gotoOptions: { waitUntil: 'networkidle2', timeout: 60000 },
      waitForTimeout: 8000,           // 8 seconds after network idle
      viewport: { width: 1280, height: 720 },
    };

    const blResp = await fetch(BROWSERLESS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!blResp.ok) {
      const txt = await blResp.text();
      throw new Error(`Browserless ${blResp.status}: ${txt}`);
    }

    const data = await blResp.json();

    // Browserless v2 returns cookies directly
    const cookies = data.cookies || [];
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const cookieString = cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');

    console.log(`Got ${cookies.length} cookies, calling CSRF API...`);

    // Call CSRF endpoint
    const csrfResp = await fetch(CSRF_API, {
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        priority: 'u=1, i',
        referer: REFERER_URL,
        'sec-ch-ua': '"Google Chrome";v="141", "Not)A;Brand";v="8", "Chromium";v="141"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        cookie: cookieHeader,
        ...traceHeaders(),
      },
    });

    const csrfText = await csrfResp.text();
    if (!csrfResp.ok) throw new Error(`CSRF API ${csrfResp.status}: ${csrfText}`);

    let csrfToken = null;
    try {
      const json = JSON.parse(csrfText);
      csrfToken = json.csrfToken ?? json.token ?? json.data?.csrfToken ?? null;
    } catch (_) {}

    if (!csrfToken) throw new Error('CSRF token not found');

    const cfClearance = cookies.find(c => c.name === 'cf_clearance')?.value ?? null;

    res.json({
      success: true,
      csrfToken,
      cookies: cookieString,
      cf_clearance: cfClearance,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------------------------------------------------
   Health check
   ------------------------------------------------------------- */
app.get('/', (req, res) => {
  res.json({ status: 'ok', endpoint: 'POST /get-csrf', docs: 'https://docs.browserless.io' });
});

/* -------------------------------------------------------------
   Start server
   ------------------------------------------------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
