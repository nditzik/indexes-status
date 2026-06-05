// Cloudflare Worker — minimal CORS proxy for the indexes-status dashboard.
//
// Purpose: corsproxy.io went paywall (returns 403 with "Upgrade at...").
// This worker replaces it for free (Cloudflare Workers free tier =
// 100K requests/day, more than enough for a refresh every 60s).
//
// Deployment: see DEPLOY-WORKER.md in this repo.
//
// Whitelist keeps this from being abused as a generic open proxy —
// only the two endpoints the dashboard actually calls are allowed.
const ALLOWED_HOSTS = new Set([
    'query1.finance.yahoo.com',
    'query2.finance.yahoo.com',
    'stooq.com',
]);

const ALLOWED_ORIGINS = [
    'https://nditzik.github.io',
    'http://localhost',
    'http://127.0.0.1',
];

function corsHeaders(origin) {
    const allow = ALLOWED_ORIGINS.find(o => origin && origin.startsWith(o)) || '*';
    return {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
    };
}

export default {
    async fetch(request) {
        const origin = request.headers.get('Origin') || '';
        const cors = corsHeaders(origin);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }
        if (request.method !== 'GET') {
            return new Response('Method not allowed', { status: 405, headers: cors });
        }

        const reqUrl = new URL(request.url);
        const target = reqUrl.searchParams.get('url');
        if (!target) {
            return new Response('Missing ?url= parameter', { status: 400, headers: cors });
        }

        let targetUrl;
        try {
            targetUrl = new URL(target);
        } catch (_) {
            return new Response('Invalid url', { status: 400, headers: cors });
        }

        if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
            return new Response(`Host not allowed: ${targetUrl.hostname}`, { status: 403, headers: cors });
        }

        try {
            const upstream = await fetch(targetUrl.toString(), {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; indexes-status-dashboard/1.0)',
                    'Accept': 'application/json, text/csv, text/plain, */*',
                },
                cf: { cacheTtl: 30, cacheEverything: true },
            });

            const headers = new Headers(cors);
            const ct = upstream.headers.get('Content-Type');
            if (ct) headers.set('Content-Type', ct);
            headers.set('Cache-Control', 'public, max-age=30');

            return new Response(upstream.body, {
                status: upstream.status,
                statusText: upstream.statusText,
                headers,
            });
        } catch (err) {
            return new Response('Upstream fetch failed: ' + (err && err.message), {
                status: 502,
                headers: cors,
            });
        }
    },
};
