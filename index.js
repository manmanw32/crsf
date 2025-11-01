import express from 'express';
import fetch from 'node-fetch';   // node-fetch v3+ (ESM)

const app = express();
app.use(express.json());

/* -------------------------------------------------------------
   CONFIG – put your Browserless token here (or use env var)
   ------------------------------------------------------------- */
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '2SSAwtJD82odF6zde50181b77f720b09476827ac6cc05f60b';
const BROWSERLESS_URL   = `https://chrome.browserless.io/content?token=${BROWSERLESS_TOKEN}`;

const REFERER_URL = 'https://artlist.io/voice-over';
const CSRF_API    = 'https://artlist.io/api/auth/csrf';

/* -------------------------------------------------------------
   Helper – random trace headers (keeps Artlist happy)
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
    console.log('Opening page via Browserless...');

    // 1. Load the page + wait
    const blResp = await fetch(BROWSERLESS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: REFERER_URL,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 60000 },
        waitFor: 8000,                     // same 8 s pause you had
        // realistic headers (helps bypass Cloudflare)
        headers: {
          'accept-language': 'en-US,en;q=0.9',
          'sec-ch-ua': '"Google Chrome";v="141", "Not)A;Brand";v="8", "Chromium";v="141"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        },
      }),
    });

    if (!blResp.ok) {
      const txt = await blResp.text();
      throw new Error(`Browserless error ${blResp.status}: ${txt}`);
    }

    const { cookies = [] } = await blResp.json();

    // Build cookie strings for the CSRF request
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const cookieString = cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');

    console.log('Fetched cookies, calling CSRF API...');

    // 2. Call the CSRF endpoint
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
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
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

    if (!csrfToken) throw new Error('CSRF token not found in response');

    const cfClearance = cookies.find(c => c.name === 'cf_clearance')?.value ?? null;

    res.json({
      success: true,
      csrfToken,
      cookies: cookieString,
      cf_clearance: cfClearance,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('CSRF error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/* -------------------------------------------------------------
   Health check
   ------------------------------------------------------------- */
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'POST /get-csrf → Artlist CSRF token (Browserless)',
    timestamp: new Date().toISOString(),
  });
});

/* -------------------------------------------------------------
   Start server
   ------------------------------------------------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT}`);
  console.log(`Health:   http://localhost:${PORT}/`);
  console.log(`Endpoint: POST http://localhost:${PORT}/get-csrf`);
});
