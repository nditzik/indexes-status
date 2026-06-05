# Deploy the Cloudflare Worker proxy (5 minutes)

The dashboard's live ticker fetches Yahoo Finance via a CORS proxy. The
old service (`corsproxy.io`) became paid-only in mid-2026. This guide
sets up your own free worker.

**Free tier limits:** 100,000 requests/day. The dashboard polls every
60 seconds → ~1,440 requests/day per open tab. You're nowhere near the
limit.

## One-time setup

1. **Sign in to Cloudflare**
   - Go to https://dash.cloudflare.com/sign-up
   - Sign up with the same email you use for GitHub (any email works).
   - Verify the email.

2. **Open Workers**
   - In the left sidebar click **Workers & Pages**.
   - Click **Create application** → **Create Worker**.
   - Name it `indexes-status-proxy` (must match the URL in
     [v2/overview-prod.js](v2/overview-prod.js) — see "If you pick a
     different name" below).
   - Click **Deploy**. Cloudflare will create a dummy "Hello world"
     worker. That's fine — we replace it next.

3. **Replace the worker code**
   - On the worker's page click **Edit code** (top right).
   - Open [cloudflare-worker.js](cloudflare-worker.js) from this repo
     and copy its full contents.
   - In the Cloudflare editor select all (Ctrl+A), delete, and paste.
   - Click **Save and deploy** (top right).

4. **Verify**
   - The worker URL is shown at the top of the page — looks like
     `https://indexes-status-proxy.<your-account>.workers.dev`.
   - Open it in a new tab with a test query:
     ```
     https://indexes-status-proxy.<your-account>.workers.dev/?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv8%2Ffinance%2Fchart%2FSPY%3Finterval%3D1d%26range%3D2d
     ```
   - You should see a JSON blob starting with `{"chart":{"result":...`.

5. **If your worker's URL is different**
   - The dashboard expects `https://indexes-status-proxy.nditzik.workers.dev/?url=`.
   - If Cloudflare gave you something else (different account name, or
     you picked a different worker name), open
     [v2/overview-prod.js](v2/overview-prod.js) and update the
     `PROXY_BASE` constant near the top to your actual worker URL +
     `/?url=`.
   - Commit and push.

That's it. Reload the dashboard — the SPY/QQQ/DIA/IWM ticker should
populate within a second or two.

## What the worker does

- Accepts `GET ?url=<encoded-target-url>`.
- Whitelists only Yahoo Finance and Stooq (you can add more in
  `ALLOWED_HOSTS` if needed).
- Forwards the request, adds CORS headers, returns the response.
- Caches each upstream response for 30 seconds at Cloudflare's edge
  to avoid hammering Yahoo when multiple tabs are open.

## Troubleshooting

- **Ticker still blank after deploy** → open the browser console (F12)
  and look at the failed request URL. If it points to the right worker
  domain and you see a CORS error, check that you saved + deployed the
  worker code (the "Hello world" default doesn't set CORS headers).
- **502 from worker** → Yahoo is rate-limiting that Cloudflare datacenter.
  Wait a minute and reload; the cache will usually clear.
- **Want to remove the worker** → Dashboard → Workers & Pages → click
  the worker → Settings → Delete.
