/* ═══════════════════════════════════════════════════════════════════════
   OVERVIEW V2 · data loading + computation + rendering
   Depends on: regime.js (window.Regime)
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ─── Constants ────────────────────────────────────────────────────────

const DATA_BASE = 'data';

// CORS proxy chain for live market data (Yahoo Finance).
// Public CORS proxies churn (corsproxy.io went paywall mid-2026), so
// we try each backend in order. The first that returns parseable JSON
// wins. Adding a self-hosted Cloudflare Worker URL to the front of
// the chain takes precedence — see DEPLOY-WORKER.md.
// See README §audit-fix-8.
const PROXY_CHAIN = [
    {
        // Jina reader — returns upstream body in a Markdown envelope
        // ("Title:...\nURL Source:...\nMarkdown Content:\n{json}").
        name: 'jina',
        build: url => 'https://r.jina.ai/' + url,
        parse: text => {
            const i = text.indexOf('{');
            if (i < 0) throw new Error('no JSON in jina response');
            return JSON.parse(text.slice(i));
        },
    },
    {
        // allorigins.win — JSON wrapper with .contents holding the
        // upstream body as a string. Adequate fallback when jina is
        // rate-limited.
        name: 'allorigins',
        build: url => 'https://api.allorigins.win/get?url=' + encodeURIComponent(url),
        parse: text => {
            const wrapper = JSON.parse(text);
            if (!wrapper || typeof wrapper.contents !== 'string') {
                throw new Error('allorigins: malformed envelope');
            }
            return JSON.parse(wrapper.contents);
        },
    },
];

// Back-compat — kept for any legacy callers reading the constant.
const PROXY_BASE = 'https://r.jina.ai/';

async function proxyFetchJSON(targetUrl) {
    const errors = [];
    for (const proxy of PROXY_CHAIN) {
        try {
            const r = await fetch(proxy.build(targetUrl), { cache: 'no-store' });
            if (!r.ok) {
                errors.push(`${proxy.name}: HTTP ${r.status}`);
                continue;
            }
            const text = await r.text();
            return proxy.parse(text);
        } catch (err) {
            errors.push(`${proxy.name}: ${err && err.message}`);
        }
    }
    throw new Error('all proxies failed: ' + errors.join(' | '));
}
// Load up to a year of CSVs so the EQ500 cumulative index has a fixed
// baseline (anchored to the earliest available trading day). Other
// downstream calcs still slice within (`last25` for distribution
// days, `ago5` for 5-day deltas), so loading more files doesn't change
// their math — it just lets the equal-weighted index compound from a
// stable starting point instead of a 30-day rolling window.
const HISTORY_DAYS = 365;

// Sector buckets (codes from sectors.json — adjust if names differ)
const CYCLICAL  = ['IT', 'CD', 'FIN', 'IND', 'MAT', 'EN', 'COMM'];
const DEFENSIVE = ['HC', 'CS', 'UTIL', 'REIT'];

// Category color tokens (CSS vars — must match styles.css / shared.css)
const CAT_COLOR = {
    breadth:   'var(--cat-breadth)',
    momentum:  'var(--cat-momentum)',
    risk:      'var(--cat-risk)',
    flow:      'var(--cat-flow)',
    sector:    'var(--cat-sector)',
    macro:     'var(--cat-macro)',
    historical:'var(--cat-historical)',
    action:    'var(--cat-action)'
};

const RSI_GROUP_FOR = {
    'New Above 20':'oversold','Below 30':'oversold','New Below 30':'oversold','New Above 30':'oversold',
    'Below 50':'weak','New Below 50':'weak','New Above 50':'strong','Above 50':'strong',
    'Above 70':'overbought','New Above 70':'overbought','Above 80':'overbought','New Above 80':'overbought'
};

// ─── Helpers ──────────────────────────────────────────────────────────

function num(v) {
    if (v == null) return null;
    const s = String(v).trim().replace('%','').replace('+','').replace(/,/g,'');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function parseCSVLine(line) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQ = !inQ; continue; }
        if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    out.push(cur);
    return out;
}

function parseCSV(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.length);
    if (!lines.length) return [];
    const headers = parseCSVLine(lines[0]);
    return lines.slice(1).map(line => {
        const vals = parseCSVLine(line);
        const obj = {};
        headers.forEach((h, i) => obj[h] = vals[i] != null ? vals[i] : '');
        return obj;
    });
}

function parseDateFromFilename(name) {
    const m = name.match(/(\d{2})-(\d{2})-(\d{4})/);
    return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

// Normalize a stock row to a typed object
function normRow(r) {
    const sym = String(r.Symbol || '').trim();
    const latest = num(r.Latest);
    return {
        sym,
        name: String(r.Name || '').replace(/^"|"$/g, ''),
        latest,
        chg:   num(r['%Change']),
        ma20:  num(r['20D MA']),
        ma50:  num(r['50D MA']),
        ma150: num(r['150D MA']),
        ma200: num(r['200D MA']),
        rsiRank: String(r['RSI Rank'] || '').trim(),
        w52:   num(r['52W %/High']),
        rvol:  num(r['20D RelVol']),
        // Extended Barchart view (added 2026-06-11). Older history files
        // lack these columns — num() returns null and downstream metrics
        // simply skip them, so the old format keeps parsing cleanly.
        volume:   num(r['Volume']),
        rsiNum:   num(r['14D Rel Str']),
        wtdAlpha: num(r['Wtd Alpha']),
    };
}

const isMacroSym = s => s.startsWith('$');
const isStockRow = s => s && s.length && !isMacroSym(s);

// ─── Data Loading ─────────────────────────────────────────────────────

async function fetchText(url) {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return r.text();
}
async function fetchJSON(url) {
    return JSON.parse(await fetchText(url));
}

async function loadData() {
    const [sectors, index] = await Promise.all([
        fetchJSON(`${DATA_BASE}/sectors.json`).catch(() => ({ tickers: {}, codes: {} })),
        fetchJSON(`${DATA_BASE}/index.json`)
    ]);

    // Today
    const todayText = await fetchText(`${DATA_BASE}/data.txt`);
    const today = parseCSV(todayText);

    // History — last N CSVs (parallel)
    const recentFiles = index.slice(-HISTORY_DAYS);
    const historyTexts = await Promise.all(
        recentFiles.map(f => fetchText(`${DATA_BASE}/${f}`).catch(() => null))
    );
    const history = recentFiles
        .map((f, i) => ({
            date: parseDateFromFilename(f),
            file: f,
            rows: historyTexts[i] ? parseCSV(historyTexts[i]) : null
        }))
        .filter(h => h.rows && h.date)
        .sort((a, b) => a.date.localeCompare(b.date));

    // Options flow + SPX backfill in parallel — neither blocks the other,
    // and the backfill is cached per trading day in localStorage so most
    // page loads skip the network fetch entirely. Historical (multi-year)
    // SPX+RSP files load alongside; they're optional — the rest of the
    // dashboard still renders cleanly if the fetch fails.
    const [flowHistory, spxBackfill] = await Promise.all([
        loadFlowHistory(history, 22),
        loadSpxBackfill(),
        // Fire and forget — Historical.load() caches internally; we don't
        // need its result inside loadData(). The render function will
        // await it again (cheap — same cached promise).
        window.Historical ? window.Historical.load() : Promise.resolve(),
    ]);

    return { sectors, index, today, history, flowHistory, spxBackfill };
}

// ─── SPX backfill from Yahoo Finance ─────────────────────────────────
//
// The CSV exports from Barchart only started carrying the $SPX row on
// 23/04/2026, so the first 22 days of our history have no cap-weighted
// reference. Without a fix the SPX-rebased index would silently start
// a month late, hiding its baseline mismatch with EQ500.
//
// We pull SPX (^GSPC) daily closes from Yahoo's chart endpoint on
// first load each day, derive %Change between consecutive sessions,
// and cache the result in localStorage so subsequent page loads don't
// refetch. Yahoo's v8 chart endpoint is the rare free historical source
// that still works without an API key (Stooq's CSV endpoint now
// requires one). Browser CORS is handled by corsproxy.io — the same
// proxy fetchLiveIndices already uses.
async function loadSpxBackfill() {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = 'spxBackfill_' + today;
    try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) return JSON.parse(cached);
    } catch (_) { /* cache miss / parse error — fall through to network */ }

    // 365 days back from today is comfortably more than HISTORY_DAYS,
    // so the backfill always covers the full CSV history window.
    const now = Math.floor(Date.now() / 1000);
    const oneYearAgo = now - 365 * 24 * 60 * 60;
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/^GSPC?period1=${oneYearAgo}&period2=${now}&interval=1d`;
    try {
        const json = await proxyFetchJSON(yahooUrl);
        const result = json && json.chart && json.chart.result && json.chart.result[0];
        if (!result || !result.timestamp || !result.indicators
                || !result.indicators.quote || !result.indicators.quote[0]) {
            return {};
        }
        const timestamps = result.timestamp;
        const closes = result.indicators.quote[0].close;

        // Build a sorted [date, close] list, then derive day-over-day
        // %Change between consecutive trading days.
        const series = [];
        for (let i = 0; i < timestamps.length; i++) {
            const c = closes[i];
            if (c == null || !Number.isFinite(c)) continue;
            const d = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
            series.push({ date: d, close: c });
        }
        series.sort((a, b) => a.date.localeCompare(b.date));

        const pctChanges = {};
        for (let i = 1; i < series.length; i++) {
            const prev = series[i - 1].close;
            const curr = series[i].close;
            if (prev > 0) {
                pctChanges[series[i].date] = (curr - prev) / prev * 100;
            }
        }
        try { localStorage.setItem(cacheKey, JSON.stringify(pctChanges)); }
        catch (_) { /* quota / disabled — ignore */ }
        return pctChanges;
    } catch (err) {
        console.warn('SPX backfill fetch failed:', err);
        return {};
    }
}

async function loadFlowHistory(history, daysBack) {
    // Build candidate filenames from the LAST `daysBack` history dates
    const candidates = history.slice(-daysBack).map(h => {
        const [y, m, dd] = h.date.split('-');
        return { date: h.date, file: `spx-options-flow-${m}-${dd}-${y}.csv` };
    });
    // Fetch all in parallel — null on miss
    const texts = await Promise.all(candidates.map(c =>
        fetchText(`${DATA_BASE}/${c.file}`).catch(() => null)
    ));
    return candidates
        .map((c, i) => ({ date: c.date, file: c.file, rows: texts[i] ? parseCSV(texts[i]) : null }))
        .filter(d => d.rows && d.rows.length > 0);
}

// ─── Per-day metric extraction ─────────────────────────────────────────

function extractDayMetrics(rows, sectorsMap) {
    // Find macros
    const macro = {};
    // If RSP is in the watchlist (Invesco S&P 500 Equal Weight ETF), grab
    // its %Change for direct use as the equal-weight benchmark below.
    // Cleaner than approximating with a simple stock-mean: RSP reflects
    // quarterly-rebalanced ETF weights + dividends + split adjustments,
    // exactly matching what the user sees in real quote feeds. Falls
    // back to the computed mean when RSP isn't present in the CSV.
    let rspChange = null;
    for (const r of rows) {
        const s = String(r.Symbol || '').trim();
        if (s === '$VIX') { macro.vix = num(r.Latest); macro.vixChgPct = num(r['%Change']); }
        else if (s === '$DXY') { macro.dxy = num(r.Latest); macro.dxyChgPct = num(r['%Change']); }
        else if (s === '$TNX') { macro.tnx = num(r.Latest); macro.tnxChgPct = num(r['%Change']); }
        else if (s === '$SPX') {
            macro.spx = {
                price:  num(r.Latest),
                chgPct: num(r['%Change']),
                ma20:   num(r['20D MA']),
                ma50:   num(r['50D MA']),
                ma150:  num(r['150D MA']),
                ma200:  num(r['200D MA']),
                high52: num(r['52W %/High']),
                // Numeric 14D RSI of the index itself — available since
                // the extended Barchart view (2026-06-11). null before.
                rsi:    num(r['14D Rel Str']),
            };
        }
        else if (s === 'RSP') {
            rspChange = num(r['%Change']);
        }
    }

    // Stocks — exclude RSP itself (it's an ETF, not a constituent) so it
    // doesn't bias breadth metrics or get double-counted in avgChange.
    const stocks = rows
        .filter(r => {
            const sym = String(r.Symbol || '').trim();
            return isStockRow(sym) && sym !== 'RSP';
        })
        .map(normRow)
        .filter(s => s.latest !== null && s.latest > 0);

    const total = stocks.length;
    if (!total) return null;

    const above = key => stocks.filter(s => s[key] && s.latest > s[key]).length;
    const a20  = above('ma20');
    const a50  = above('ma50');
    const a150 = above('ma150');
    const a200 = above('ma200');
    const golden = stocks.filter(s => s.ma50 && s.ma200 && s.ma50 > s.ma200).length;

    const newHighs = stocks.filter(s => s.w52 !== null && s.w52 >= -5).length;
    const newLows  = stocks.filter(s => s.w52 !== null && s.w52 <= -30).length;

    const rsiCount = group => stocks.filter(s => RSI_GROUP_FOR[s.rsiRank] === group).length;
    const oversold    = rsiCount('oversold');
    const overbought  = rsiCount('overbought');
    const strong      = rsiCount('strong');
    const rsiAbove50  = strong + overbought;

    // Thrust: stocks with "New Above 30" OR "New Above 50" (newly crossed)
    const rsiThrust = stocks.filter(s =>
        s.rsiRank === 'New Above 30' || s.rsiRank === 'New Above 50'
    ).length;

    // ── Extended-view metrics (Volume / numeric RSI / Wtd Alpha) ──
    // All null-safe: history files before 2026-06-11 lack these columns,
    // so the metrics come out null and the UI rows simply hide.
    //
    // Up/Down volume — total volume in advancing vs declining stocks.
    // The classic institutional-pressure read: a 9:1 down-volume day is
    // real panic; a 9:1 up-volume day after a correction is a thrust.
    let upVol = 0, downVol = 0, volCounted = 0;
    for (const s of stocks) {
        if (s.volume == null || s.chg == null) continue;
        if (s.chg > 0) upVol += s.volume;
        else if (s.chg < 0) downVol += s.volume;
        volCounted++;
    }
    const udVolRatio = (volCounted >= 100 && downVol > 0)
        ? upVol / downVol
        : null;

    // Numeric RSI distribution — precise oversold/overbought counts and
    // the cross-sectional median (the categorical RSI Rank only gives
    // coarse buckets).
    const rsiVals = stocks.map(s => s.rsiNum).filter(v => v != null && Number.isFinite(v));
    let medianRsi = null, oversoldNum = null, overboughtNum = null;
    if (rsiVals.length >= 100) {
        const sortedRsi = rsiVals.slice().sort((a, b) => a - b);
        const mid = Math.floor(sortedRsi.length / 2);
        medianRsi = sortedRsi.length % 2 ? sortedRsi[mid] : (sortedRsi[mid - 1] + sortedRsi[mid]) / 2;
        oversoldNum = rsiVals.filter(v => v < 30).length;
        overboughtNum = rsiVals.filter(v => v > 70).length;
    }

    // Exclude split-related anomalies: a stock that splits 10-for-1 shows
    // up with %Change ≈ -90% in the watchlist (Barchart reports raw price
    // change, not split-adjusted). This is NOT a real decline — RSP and
    // other equal-weight ETFs adjust for splits automatically, so to match
    // their behavior we drop anything with |%Change| > 50%. Observed on
    // 2026-05-29 with GS and LLY both around -90%, which dragged the raw
    // avgChange from +0.06% (real) to -0.30% (broken) and flipped the
    // 22/05 spread chip from above its threshold to below.
    const SPLIT_THRESHOLD = 50;
    const chgs = stocks.map(s => s.chg).filter(v =>
        v !== null && v !== 0 && Math.abs(v) < SPLIT_THRESHOLD);
    // avgChange — if RSP is in the watchlist, use its exact %Change as the
    // equal-weight benchmark (matches what real quote feeds show; accounts
    // for quarterly rebalance drift + dividends + corporate actions that
    // simple stock-mean misses). Falls back to the computed mean when RSP
    // isn't present. The drift can be 0.1-0.3% on tech-led rally days,
    // which was enough to flip the 22/05 KNN spread signal from ✓ to ✗.
    const computedMean = chgs.length ? chgs.reduce((a,b) => a+b, 0) / chgs.length : null;
    const avgChange = (rspChange != null && Number.isFinite(rspChange)
                       && Math.abs(rspChange) < SPLIT_THRESHOLD)
                      ? rspChange
                      : computedMean;
    const advancing = chgs.filter(v => v > 0).length;
    const declining = chgs.filter(v => v < 0).length;

    const pct = (n, t) => t ? +(n / t * 100).toFixed(1) : 0;
    const pctMa200 = pct(a200, total);
    const pctMa50  = pct(a50, total);
    const pctMa20  = pct(a20, total);
    const pctGolden = pct(golden, total);
    const healthScore = Math.round(
        pct(a200, total) * 0.30 +
        pct(golden, total) * 0.25 +
        pct(rsiAbove50, total) * 0.25 +
        pct(a20, total) * 0.20
    );

    // Sector aggregation (today snapshot)
    const sectorTickers = (sectorsMap && sectorsMap.tickers) || {};
    const bySector = {};
    for (const s of stocks) {
        const sec = sectorTickers[s.sym];
        if (!sec) continue;
        if (!bySector[sec]) bySector[sec] = { total: 0, above200: 0, chgs: [], rvols: [], alphas: [] };
        const b = bySector[sec];
        b.total++;
        if (s.ma200 && s.latest > s.ma200) b.above200++;
        if (s.chg !== null) b.chgs.push(s.chg);
        if (s.rvol !== null) b.rvols.push(s.rvol);
        if (s.wtdAlpha != null) b.alphas.push(s.wtdAlpha);
    }
    const sectors = Object.entries(bySector).map(([code, d]) => ({
        code,
        total:    d.total,
        pct200:   d.total ? (d.above200 / d.total * 100) : 0,
        avgChg:   d.chgs.length ? d.chgs.reduce((a,b) => a+b, 0) / d.chgs.length : 0,
        avgRvol:  d.rvols.length ? d.rvols.reduce((a,b) => a+b, 0) / d.rvols.length : 0,
        // Long-term relative-strength tilt — average Wtd Alpha of the
        // sector's constituents. null when the column isn't available.
        avgAlpha: d.alphas.length ? d.alphas.reduce((a,b) => a+b, 0) / d.alphas.length : null,
    }));

    return {
        macro,
        total, a20, a50, a150, a200, golden,
        newHighs, newLows,
        oversold, overbought, strong, rsiAbove50, rsiThrust,
        avgChange, advancing, declining,
        pctMa200, pctMa50, pctMa20, pctGolden,
        healthScore,
        sectors,
        // Extended-view metrics (null on pre-2026-06-11 history)
        udVolRatio, upVol, downVol,
        medianRsi, oversoldNum, overboughtNum,
    };
}

// ─── Scoring ──────────────────────────────────────────────────────────

// Tech score with FULL coverage = 90 points distributed across 7 inputs.
// The "coverage" field tells callers how much of that ideal was actually
// available — so the UI can warn when a score is computed from partial
// data. See README §audit-fix-2.
const _TECH_FULL_MAX = 90;
function scoreTech(spx, vixChgPct) {
    const r = scoreTechFull(spx, vixChgPct);
    return r ? r.value : null;
}
function scoreTechFull(spx, vixChgPct) {
    if (!spx || spx.price == null) return null;
    let parts = 0, max = 0;
    const missing = [];
    const p = spx.price;
    if (spx.ma20)  { parts += p > spx.ma20  ? 15 : 5; max += 15; } else missing.push('MA20');
    if (spx.ma50)  { parts += p > spx.ma50  ? 20 : 5; max += 20; } else missing.push('MA50');
    if (spx.ma200) { parts += p > spx.ma200 ? 25 : 3; max += 25; } else missing.push('MA200');
    if (spx.ma20 && spx.ma50 && spx.ma200) {
        if (spx.ma20 > spx.ma50 && spx.ma50 > spx.ma200) parts += 15;
        else if (spx.ma20 < spx.ma50 && spx.ma50 < spx.ma200) parts += 0;
        else if (spx.ma20 > spx.ma50) parts += 10;
        else parts += 5;
        max += 15;
    } else {
        missing.push('סדר MA');
    }
    if (spx.high52 != null) {
        const d = Math.abs(spx.high52);
        parts += d <= 5 ? 10 : d <= 10 ? 7 : d <= 20 ? 4 : 1;
        max += 10;
    } else missing.push('52W high');
    if (spx.chgPct != null) {
        const c = spx.chgPct;
        parts += c >  1.0 ? 15
               : c >  0.5 ? 12
               : c >= -0.5 ? 9
               : c >= -1.0 ? 5
               : c >= -1.5 ? 2
               : 0;
        max += 15;
    } else missing.push('שינוי יומי');
    if (vixChgPct != null && Number.isFinite(vixChgPct)) {
        parts += vixChgPct <= -10 ? 10
               : vixChgPct <=   0 ? 8
               : vixChgPct <=  10 ? 5
               : vixChgPct <=  25 ? 2
               : 0;
        max += 10;
    } else missing.push('VIX יומי');
    if (max === 0) return null;
    return {
        value: Math.max(0, Math.min(100, Math.round(parts / max * 100))),
        coverage: max / _TECH_FULL_MAX,
        max, parts, missing,
    };
}

const _BREADTH_FULL_MAX = 65;
function scoreBreadth(metrics) {
    const r = scoreBreadthFull(metrics);
    return r ? r.value : null;
}
function scoreBreadthFull(metrics) {
    const p200 = metrics.pctMa200 || 0;
    let parts = 0, max = 0;
    const missing = [];
    // MA200 (25) — always computed; no "missing" path
    parts += p200 >= 65 ? 25 : p200 >= 50 ? 18 : p200 >= 40 ? 10 : 3;
    max += 25;
    // Health (15)
    parts += metrics.healthScore >= 70 ? 15 : metrics.healthScore >= 55 ? 10 : metrics.healthScore >= 40 ? 5 : 1;
    max += 15;
    // NH/NL ratio (10)
    const nhnl = metrics.newLows === 0 && metrics.newHighs > 0 ? 99
               : metrics.newLows > 0 ? metrics.newHighs / metrics.newLows : 0;
    parts += nhnl === 99 || nhnl >= 1.5 ? 10 : nhnl >= 1.0 ? 7 : nhnl >= 0.7 ? 3 : 0;
    max += 10;
    // Avg change (5)
    if (metrics.avgChange != null) {
        parts += metrics.avgChange > 0.5 ? 5 : metrics.avgChange >= -0.5 ? 3 : 0;
        max += 5;
    } else missing.push('שינוי ממוצע');
    // RSI distribution (10)
    if (metrics.total) {
        const rsi50pct = metrics.rsiAbove50 / metrics.total * 100;
        parts += rsi50pct >= 65 ? 10 : rsi50pct >= 50 ? 7 : rsi50pct >= 40 ? 4 : 1;
        max += 10;
    } else missing.push('התפלגות RSI');
    if (max === 0) return null;
    return {
        value: Math.max(0, Math.min(100, Math.round(parts / max * 100))),
        coverage: max / _BREADTH_FULL_MAX,
        max, parts, missing,
    };
}

// ─── Flow Analytics (z-score + EMA based) ──────────────────────────
//
// Recalibrated 2026-05-22 after data audit revealed absolute thresholds
// (pcPremium > 1.15 etc.) were never firing on real SPX flow data.
//
// Pipeline per flow metric:
//   1. Compute raw value per day across full flow history
//   2. EMA-smooth the noisy ones (alpha per metric)
//   3. Compute baseline (mean + stddev) over rolling 22d
//   4. Compute z-score for today's raw value vs baseline
//   5. Map z-scores → flow score (0-100) and chip triggers

function median(arr) {
    if (!arr || !arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function meanOf(arr) {
    const f = arr.filter(v => v != null && Number.isFinite(v));
    return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
}

function stddevOf(arr) {
    const f = arr.filter(v => v != null && Number.isFinite(v));
    if (f.length < 2) return null;
    const m = f.reduce((a, b) => a + b, 0) / f.length;
    const variance = f.reduce((s, v) => s + (v - m) * (v - m), 0) / f.length;
    return Math.sqrt(variance);
}

function baseline(values) {
    const m = meanOf(values);
    const s = stddevOf(values);
    const n = values.filter(v => v != null && Number.isFinite(v)).length;
    if (m == null || s == null || s === 0 || n < 5) return null;
    return { mean: m, stddev: s, n };
}

function zscore(value, base) {
    if (value == null || !base) return null;
    return (value - base.mean) / base.stddev;
}

// EMA over an ordered series (oldest first). Returns array same length.
function emaSeries(values, alpha) {
    const out = [];
    let prev = null;
    for (const v of values) {
        if (v == null || !Number.isFinite(v)) { out.push(prev); continue; }
        prev = (prev == null) ? v : alpha * v + (1 - alpha) * prev;
        out.push(prev);
    }
    return out;
}

// Per-day flow metric extraction (one day's worth of flow rows)
// Extended 2026-05-22:
//   - Side (ask/bid/mid) per Call/Put for aggressive direction
//   - Code aggregation (Floor / Electronic / CBOE / ISO Sweep) — venue & quality
//   - ToOpen breakdown (BuyToOpen / SellToOpen) — conviction signal
function computeFlowDay(rows) {
    if (!rows || !rows.length) return null;
    let callTr = 0, putTr = 0, callP = 0, putP = 0, bigTrades = 0;
    let callAsk = 0, callBid = 0, callMid = 0;
    let putAsk = 0, putBid = 0, putMid = 0;
    let callAskP = 0, callBidP = 0, callMidP = 0;
    let putAskP = 0, putBidP = 0, putMidP = 0;
    // NEW · DTE × premium tracking (for premium-weighted average DTE per quadrant)
    let callAskDteWP = 0, callBidDteWP = 0, callMidDteWP = 0;
    let putAskDteWP  = 0, putBidDteWP  = 0, putMidDteWP  = 0;
    let callDteWP = 0, putDteWP = 0;   // overall per type
    // NEW · DTE bucket tracking (premium per bucket per Call/Put)
    const DTE_BUCKETS = ['0-7d', '8-30d', '31-90d', '91-180d', '180+d'];
    const bucketFor = dte => {
        if (dte <= 7)   return '0-7d';
        if (dte <= 30)  return '8-30d';
        if (dte <= 90)  return '31-90d';
        if (dte <= 180) return '91-180d';
        return '180+d';
    };
    const callDtePremByBucket = { '0-7d': 0, '8-30d': 0, '31-90d': 0, '91-180d': 0, '180+d': 0 };
    const putDtePremByBucket  = { '0-7d': 0, '8-30d': 0, '31-90d': 0, '91-180d': 0, '180+d': 0 };
    const ivsCall = [], ivsPut = [];

    // NEW · code tracking
    const codeRaw = {};        // raw per-code counts
    const codeRawP = {};       // raw per-code premium

    // NEW · ToOpen tracking
    let callBuyOpen = 0, callSellOpen = 0, callOpenGeneric = 0;
    let putBuyOpen  = 0, putSellOpen  = 0, putOpenGeneric  = 0;
    let callBuyOpenP = 0, callSellOpenP = 0;
    let putBuyOpenP  = 0, putSellOpenP  = 0;

    for (const r of rows) {
        const t = String(r.Type || '').trim().toLowerCase();
        const prem = num(r.Premium) || 0;
        const side = String(r.Side || '').trim().toLowerCase();
        const ivStr = String(r.IV || '').replace('%', '').trim();
        const iv = parseFloat(ivStr);
        const code = String(r.Code || '').trim().toUpperCase();
        const opening = String(r['*'] || '').trim();
        const dteVal = parseInt(r.DTE, 10);
        const hasDte = Number.isFinite(dteVal);
        const dtePrem = hasDte ? dteVal * prem : 0;

        if (t === 'call') {
            callTr++; callP += prem;
            if (hasDte) {
                callDteWP += dtePrem;
                callDtePremByBucket[bucketFor(dteVal)] += prem;
            }
            if (side === 'ask') { callAsk++; callAskP += prem; if (hasDte) callAskDteWP += dtePrem; }
            else if (side === 'bid') { callBid++; callBidP += prem; if (hasDte) callBidDteWP += dtePrem; }
            else if (side === 'mid') { callMid++; callMidP += prem; if (hasDte) callMidDteWP += dtePrem; }
            if (Number.isFinite(iv) && iv > 0) ivsCall.push(iv);
            // ToOpen — conviction breakdown
            if (opening === 'BuyToOpen')  { callBuyOpen++;  callBuyOpenP  += prem; }
            else if (opening === 'SellToOpen') { callSellOpen++; callSellOpenP += prem; }
            else if (opening === 'ToOpen') callOpenGeneric++;
        } else if (t === 'put') {
            putTr++; putP += prem;
            if (hasDte) {
                putDteWP += dtePrem;
                putDtePremByBucket[bucketFor(dteVal)] += prem;
            }
            if (side === 'ask') { putAsk++; putAskP += prem; if (hasDte) putAskDteWP += dtePrem; }
            else if (side === 'bid') { putBid++; putBidP += prem; if (hasDte) putBidDteWP += dtePrem; }
            else if (side === 'mid') { putMid++; putMidP += prem; if (hasDte) putMidDteWP += dtePrem; }
            if (Number.isFinite(iv) && iv > 0) ivsPut.push(iv);
            if (opening === 'BuyToOpen')  { putBuyOpen++;  putBuyOpenP  += prem; }
            else if (opening === 'SellToOpen') { putSellOpen++; putSellOpenP += prem; }
            else if (opening === 'ToOpen') putOpenGeneric++;
        }
        if (prem >= 5_000_000) bigTrades++;

        // Code aggregation
        if (code) {
            codeRaw[code]  = (codeRaw[code]  || 0) + 1;
            codeRawP[code] = (codeRawP[code] || 0) + prem;
        }
    }

    // Aggregate codes into groups (per CBOE/MIAX conventions confirmed with user)
    //   floor      = MFSL + SLFT     · רצפה — מוסדי
    //   electronic = MLET + AUTO     · אלקטרוני — שוק רחב
    //   iso        = ISOI            · ISO Sweep — conviction אגרסיבי
    //   cbmo       = CBMO            · CBOE Market — קוד דומיננטי על SPX
    //   other      = הכל אחר
    const codeGroups = { floor: {trades:0,premium:0}, electronic:{trades:0,premium:0},
                         iso:{trades:0,premium:0}, cbmo:{trades:0,premium:0}, other:{trades:0,premium:0} };
    const groupOf = c => {
        if (c === 'ISOI') return 'iso';
        if (c === 'CBMO') return 'cbmo';
        if (c === 'MFSL' || c === 'SLFT') return 'floor';
        if (c === 'MLET' || c === 'AUTO') return 'electronic';
        return 'other';
    };
    for (const [c, count] of Object.entries(codeRaw)) {
        const g = groupOf(c);
        codeGroups[g].trades  += count;
        codeGroups[g].premium += codeRawP[c];
    }

    const totP = callP + putP;
    const totTr = callTr + putTr;
    if (totTr === 0) return null;

    const ivCallMed = median(ivsCall);
    const ivPutMed  = median(ivsPut);

    // Directional metrics — by trade count AND by premium
    // Trade-count %: democratic (each trade counts equally)
    // Premium %:     money-weighted (a $50M trade weighs more than 10 × $1M trades)
    const callDirTr  = callAsk + callBid;
    const putDirTr   = putAsk + putBid;
    const callDirP   = callAskP + callBidP;
    const putDirP    = putAskP + putBidP;
    const callAskPct      = callDirTr ? callAsk  / callDirTr * 100 : null;
    const putAskPct       = putDirTr  ? putAsk   / putDirTr  * 100 : null;
    const callAskPremPct  = callDirP  ? callAskP / callDirP  * 100 : null;
    const putAskPremPct   = putDirP   ? putAskP  / putDirP   * 100 : null;

    return {
        n_trades: rows.length,
        callTr, putTr, totTr,
        callP, putP, totP,
        pc_trades:        callTr > 0 ? putTr / callTr : null,
        pc_premium:       callP  > 0 ? putP  / callP  : null,
        call_premium_pct: totP   > 0 ? callP / totP * 100 : null,
        put_premium_pct:  totP   > 0 ? putP  / totP * 100 : null,
        net_premium_pct:  totP   > 0 ? (callP - putP) / totP * 100 : null,
        iv_call_med:      ivCallMed,
        iv_put_med:       ivPutMed,
        iv_skew:          (ivCallMed != null && ivPutMed != null) ? ivPutMed - ivCallMed : null,
        big_trades:       bigTrades,
        // NEW · Side breakdown
        callAsk, callBid, callMid,
        putAsk,  putBid,  putMid,
        callAskP, callBidP, callMidP,
        putAskP,  putBidP,  putMidP,
        callAskPct,            // % of directional call trades that hit ASK
        putAskPct,             // % of directional put trades that hit ASK
        callAskPremPct,        // % of directional call PREMIUM that hit ASK (money-weighted)
        putAskPremPct,         // % of directional put PREMIUM that hit ASK
        // NEW · DTE (premium-weighted average days-to-expiry) per quadrant
        callAvgDte:    callP    > 0 ? Math.round(callDteWP    / callP)    : null,
        putAvgDte:     putP     > 0 ? Math.round(putDteWP     / putP)     : null,
        callAskDte:    callAskP > 0 ? Math.round(callAskDteWP / callAskP) : null,
        callBidDte:    callBidP > 0 ? Math.round(callBidDteWP / callBidP) : null,
        callMidDte:    callMidP > 0 ? Math.round(callMidDteWP / callMidP) : null,
        putAskDte:     putAskP  > 0 ? Math.round(putAskDteWP  / putAskP)  : null,
        putBidDte:     putBidP  > 0 ? Math.round(putBidDteWP  / putBidP)  : null,
        putMidDte:     putMidP  > 0 ? Math.round(putMidDteWP  / putMidP)  : null,
        // NEW · DTE bucket distribution (premium per bucket)
        callDtePremByBucket,
        putDtePremByBucket,
        dteBuckets: DTE_BUCKETS,
        // NEW · code groups
        codeGroups,            // { floor, electronic, iso, cbmo, other } each { trades, premium }
        codeRaw,               // for debugging
        // NEW · ToOpen breakdown
        opens: {
            callBuy: callBuyOpen,   callBuyP: callBuyOpenP,
            callSell: callSellOpen, callSellP: callSellOpenP,
            putBuy: putBuyOpen,     putBuyP: putBuyOpenP,
            putSell: putSellOpen,   putSellP: putSellOpenP,
            callGeneric: callOpenGeneric,
            putGeneric: putOpenGeneric,
            // Net conviction summary
            bullish:  callBuyOpen + putSellOpen,    // buy calls + write puts
            bearish:  callSellOpen + putBuyOpen,    // write calls + buy puts
            total:    callBuyOpen + callSellOpen + putBuyOpen + putSellOpen + callOpenGeneric + putOpenGeneric,
        }
    };
}

// EMA smoothing alphas per metric (based on data audit noise CVs)
const FLOW_EMA_ALPHA = {
    pc_premium:       0.25,   // CV 52% — heavy smoothing
    pc_trades:        0.35,
    net_premium_pct:  0.30,
    call_premium_pct: 0.45,
    iv_call_med:      0.50,   // already stable
    iv_put_med:       0.50,
    iv_skew:          0.45,
};

// Builds the full analytics object for the flow layer.
// Returns: { score, today, ema, z, baselines, days, debug }
function computeFlowAnalytics(flowHistory) {
    if (!flowHistory || flowHistory.length === 0) {
        return { score: null, today: null, ema: null, z: null, baselines: null, days: [], debug: [] };
    }

    // 1. Per-day raw metrics (oldest first)
    const days = flowHistory.map(d => ({
        date: d.date,
        raw: computeFlowDay(d.rows)
    })).filter(d => d.raw);

    if (days.length === 0) {
        return { score: null, today: null, ema: null, z: null, baselines: null, days: [], debug: [] };
    }

    // 2. EMA series per metric (across history)
    const emaByMetric = {};
    for (const [k, alpha] of Object.entries(FLOW_EMA_ALPHA)) {
        const series = days.map(d => d.raw[k]);
        emaByMetric[k] = emaSeries(series, alpha);
    }
    // Attach today's EMA values
    const todayIdx = days.length - 1;
    const ema = {};
    for (const k of Object.keys(FLOW_EMA_ALPHA)) {
        ema[k] = emaByMetric[k][todayIdx];
    }

    // 3. Baselines from history EXCLUDING today (so today is fresh)
    //    Use raw values, not EMA, so z-score reflects today's actual reading
    //    against past actual readings.
    const histOnly = days.slice(0, todayIdx);
    const baselines = {};
    const metricsToBaseline = [
        'pc_premium', 'pc_trades', 'call_premium_pct', 'net_premium_pct',
        'iv_skew', 'iv_put_med', 'iv_call_med', 'big_trades', 'totP'
    ];
    for (const k of metricsToBaseline) {
        baselines[k] = baseline(histOnly.map(d => d.raw[k]));
    }

    // 4. Z-scores for today's raw values
    const today = days[todayIdx].raw;
    const z = {};
    for (const k of metricsToBaseline) {
        z[k] = zscore(today[k], baselines[k]);
    }

    // 5. Absolute Flow score (0-100) — replaced the z-score baseline
    //    approach 2026-05-24 after the rolling baseline kept making
    //    objectively bullish days (76% call premium, 0.32 P/C) read
    //    as "neutral 51" while less-bullish days (59% calls, 0.69 P/C)
    //    scored 13 — purely because they were "below the baseline of
    //    the past 22 mostly-bullish days." That's a relative metric
    //    wearing absolute clothing. This formula scores each day on
    //    its OWN flow, no history baseline involved.
    //
    //    Three components, all centered at 50% = neutral:
    //      A = call premium % of total                (±50 weight)
    //      B = call_ask / (call_ask + call_bid) %     (±25, bullish aggression)
    //      C = put_ask  / (put_ask  + put_bid)  %     (±25, bearish aggression — subtracted)
    //    IV skew omitted on purpose — SPX has a structurally positive
    //    skew (institutional hedging premium on OTM puts) that's noise
    //    rather than signal in an absolute frame.
    // Component A — share of DIRECTIONAL premium that's calls.
    // CRITICAL revision 2026-06-03: previous A used overall premium
    // (calls / total) which lumped Mid trades in with Ask/Bid. On
    // block-heavy days (e.g. 2026-06-03 with $8.09B in call Mid = 95%
    // of call premium), this inflated A to ~65% and produced a "67
    // neutral-bullish" reading while the actual directional flow had
    // puts outpacing calls 5:1. The whole purpose of the score is to
    // surface what aggressive buyers are doing — Mid (dealer blocks /
    // RFQ / spread legs) doesn't reflect directional intent.
    function directionalCallPct(r) {
        const dCall = (r.callAskP || 0) + (r.callBidP || 0);
        const dPut  = (r.putAskP  || 0) + (r.putBidP  || 0);
        const tot = dCall + dPut;
        if (tot <= 0) return null;
        return (dCall / tot) * 100;
    }

    // Mid dominance — fraction of premium that's in Mid trades. Used
    // both as a warning indicator and as a fallback signal (when Mid
    // dominates, the directional read is reliable but small-sample).
    function midDominance(r) {
        const mid = (r.callMidP || 0) + (r.putMidP || 0);
        const tot = (r.callP || 0) + (r.putP || 0);
        if (tot <= 0) return 0;
        return (mid / tot) * 100;
    }

    function scoreFromMetrics(r) {
        if (!r) return null;
        let s = 50;
        // A — directional P/C balance (Mid excluded). Was overall premium
        // until 2026-06-03; see directionalCallPct comment for the why.
        const aDirectional = directionalCallPct(r);
        if (aDirectional != null) {
            s += (aDirectional - 50) * 1.0;
        }
        // B — aggressive call buying share (ask% of directional call premium)
        if (r.callAskPremPct != null && Number.isFinite(r.callAskPremPct)) {
            s += (r.callAskPremPct - 50) * 0.5;
        }
        // C — aggressive put buying share (subtracted)
        if (r.putAskPremPct != null && Number.isFinite(r.putAskPremPct)) {
            s -= (r.putAskPremPct - 50) * 0.5;
        }
        return Math.max(0, Math.min(100, Math.round(s)));
    }

    // Old "absolute" formula — kept for display alongside the directional
    // score so the user can see both reads. Uses the overall premium %.
    function scoreFromMetricsAbsolute(r) {
        if (!r) return null;
        let s = 50;
        if (r.call_premium_pct != null && Number.isFinite(r.call_premium_pct)) {
            s += (r.call_premium_pct - 50) * 1.0;
        }
        if (r.callAskPremPct != null && Number.isFinite(r.callAskPremPct)) {
            s += (r.callAskPremPct - 50) * 0.5;
        }
        if (r.putAskPremPct != null && Number.isFinite(r.putAskPremPct)) {
            s -= (r.putAskPremPct - 50) * 0.5;
        }
        return Math.max(0, Math.min(100, Math.round(s)));
    }

    const score = scoreFromMetrics(today);
    const scoreAbsolute = scoreFromMetricsAbsolute(today);
    const midPct = midDominance(today);

    // 5b. Each historical day's score is computed from its OWN flow
    //     metrics — no shared baseline, no z-scores. days[i].score is
    //     therefore reproducible from days[i].raw alone. Each day also
    //     gets the absolute score + mid dominance for display.
    for (let i = 0; i < days.length; i++) {
        days[i].score = scoreFromMetrics(days[i].raw);
        days[i].scoreAbsolute = scoreFromMetricsAbsolute(days[i].raw);
        days[i].midPct = midDominance(days[i].raw);
    }

    // 6. Debug log for chip decisions
    const debug = [];
    const debugThreshold = (id, raw, baseValue, zValue, threshold, fired, reason) => {
        debug.push({ id, raw, ema: ema[id] || null, baseline: baseValue,
                     z: zValue, threshold, fired, reason });
    };

    debugThreshold('pc_premium',  today.pc_premium,  baselines.pc_premium,
                   z.pc_premium,  1.5,
                   z.pc_premium != null && z.pc_premium > 1.5,
                   z.pc_premium != null
                     ? `z=${z.pc_premium.toFixed(2)} ${z.pc_premium > 1.5 ? '> +1.5 → ELEVATED HEDGING fires' : '≤ +1.5 → not fired'}`
                     : 'no baseline (need ≥5 history days)');

    debugThreshold('call_premium_pct', today.call_premium_pct, baselines.call_premium_pct,
                   z.call_premium_pct, 1.0,
                   z.call_premium_pct != null && z.call_premium_pct > 1.0,
                   z.call_premium_pct != null
                     ? `z=${z.call_premium_pct.toFixed(2)} ${z.call_premium_pct > 1.0 ? '> +1.0 → CALL DOMINANT (info)' : 'neutral'}`
                     : 'no baseline');

    debugThreshold('iv_skew', today.iv_skew, baselines.iv_skew,
                   z.iv_skew, 1.0,
                   z.iv_skew != null && z.iv_skew > 1.0,
                   z.iv_skew != null
                     ? `z=${z.iv_skew.toFixed(2)} ${z.iv_skew > 1.0 ? '> +1.0 → SKEW ELEVATED' : 'normal'}`
                     : 'no baseline');

    // Flow coverage — primarily reflects Mid-dominance (not "missing
    // inputs" but "directional vs non-directional"). High Mid means the
    // score reflects a smaller and noisier directional pool.
    // See README §audit-fix-2 / §audit-fix-6.
    let flowCoverage = null;
    if (today) {
        const totalP = (today.callP || 0) + (today.putP || 0);
        const midP   = (today.callMidP || 0) + (today.putMidP || 0);
        const dirP   = totalP - midP;
        const missing = [];
        if (midPct >= 70) missing.push(`Mid דומיננטי (${Math.round(midPct)}%)`);
        else if (midPct >= 50) missing.push(`Mid גבוה (${Math.round(midPct)}%)`);
        // Directional coverage = how much of total premium is actually
        // directional. 1.0 = no Mid; 0.5 = half is dealer blocks; lower
        // = the score reflects a small slice of the day's premium.
        flowCoverage = {
            coverage: totalP > 0 ? dirP / totalP : 0,
            midPct,
            directionalP: dirP,
            totalP,
            missing,
        };
    }
    return { score, scoreAbsolute, midPct, today, ema, z, baselines, days, debug, coverage: flowCoverage };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Backwards-compat shim — old call sites expect scoreFlow(rows) → {score, pcPremium, ...}
// Now delegated to computeFlowAnalytics for a single day (no z-score, baseline=null)
function scoreFlowSingle(rows) {
    const today = computeFlowDay(rows);
    if (!today) return { score: null };
    // Fallback: simple percentile-free scoring when we have only one day
    // This is intentionally weak — caller should use computeFlowAnalytics instead.
    return { score: null, today };
}

function combineScores(tech, flow, breadth) {
    const w = { t: 0.40, f: 0.35, b: 0.25 };
    let num = 0, den = 0;
    if (tech    !== null) { num += w.t * tech;    den += w.t; }
    if (flow    !== null) { num += w.f * flow;    den += w.f; }
    if (breadth !== null) { num += w.b * breadth; den += w.b; }
    if (den === 0) return null;
    return Math.max(0, Math.min(100, Math.round(num / den)));
}

// ─── Top-level metric assembly ─────────────────────────────────────────

function computeMetrics(data) {
    const { sectors: sectorsMap, today, history, flowHistory, spxBackfill } = data;
    // Backfill map is {yyyy-mm-dd: dailyPctChange}. Empty object when the
    // Stooq fetch failed — the SPX rebase loop falls back silently.
    const spxFill = spxBackfill || {};

    const todayM = extractDayMetrics(today, sectorsMap);
    if (!todayM) throw new Error('No stocks parsed from today\'s data.');

    // History deltas
    const hist = history.map(h => ({ date: h.date, m: extractDayMetrics(h.rows, sectorsMap) }))
                        .filter(h => h.m);
    const todayIdx = hist.length - 1;          // history includes today as last (if data.txt == latest CSV)

    // ── Cash-index daily-change correction ──
    // Barchart's pre-computed %Change for the cash-index rows ($SPX,
    // $TNX) intermittently arrives as 0.00% when the export predates the
    // official index settle — the PRICE is correct, only the % cell is a
    // stale zero (ETFs settle immediately, cash indices lag). So when the
    // field is missing or ~0, derive the change from price-vs-previous-
    // close. Verified-good days (Barchart already populated the field)
    // are left untouched. Identical logic lives in send_report.py so the
    // email stays in parity.
    const INDEX_CHG_EPS = 0.005;
    const fixSpxChg = (cur, prevPrice) => {
        if (!cur || cur.price == null || prevPrice == null || prevPrice <= 0) return;
        if (cur.chgPct == null || !Number.isFinite(cur.chgPct) || Math.abs(cur.chgPct) < INDEX_CHG_EPS) {
            cur.chgPct = (cur.price / prevPrice - 1) * 100;
        }
    };
    const fixTnxChg = (m, pm) => {
        if (!m || !pm || !m.macro || !pm.macro) return;
        if (m.macro.tnx != null && pm.macro.tnx != null && pm.macro.tnx > 0
            && (m.macro.tnxChgPct == null || !Number.isFinite(m.macro.tnxChgPct)
                || Math.abs(m.macro.tnxChgPct) < INDEX_CHG_EPS)) {
            m.macro.tnxChgPct = (m.macro.tnx / pm.macro.tnx - 1) * 100;
        }
    };
    for (let i = 1; i < hist.length; i++) {
        const m = hist[i].m, pm = hist[i - 1].m;
        if (m && m.macro && pm && pm.macro) {
            fixSpxChg(m.macro.spx, pm.macro.spx ? pm.macro.spx.price : null);
            fixTnxChg(m, pm);
        }
    }
    // todayM is parsed separately from hist; correct it from the prior
    // history day (hist[last] == today, so its predecessor is [last-1]).
    if (hist.length >= 2 && todayM.macro) {
        const prevM = hist[hist.length - 2].m;
        if (prevM && prevM.macro) {
            fixSpxChg(todayM.macro.spx, prevM.macro.spx ? prevM.macro.spx.price : null);
            fixTnxChg(todayM, prevM);
        }
    }

    const ago5 = hist[Math.max(0, todayIdx - 5)];
    const breadth5dDelta = ago5 ? (todayM.pctMa200 - ago5.m.pctMa200) : 0;
    const vix5dDelta = ago5 && ago5.m.macro.vix != null && todayM.macro.vix != null
                       ? todayM.macro.vix - ago5.m.macro.vix : 0;
    // Daily %Change for VIX/DXY/10Y comes straight from the CSV's
    // %Change column (same source as SPX's chgPct). The strip renders
    // these with the instrument's raw direction: up = green ▲, down =
    // red ▼ — no inversion for "headwind to equities", so the visual
    // matches the chart of the instrument itself.
    const vix1dPct = todayM.macro.vixChgPct;
    const dxy1dPct = todayM.macro.dxyChgPct;
    const tnx1dPct = todayM.macro.tnxChgPct;

    // ── Equal-weighted index (EQ500) ──
    // Synthetic level built by compounding every day's avgChange from
    // the CSV history. Starts at 100 on the first available day so the
    // number is a direct "how much has the AVERAGE stock moved since
    // we started tracking" — the cap-weighted SPX hides this entirely.
    // todayM.avgChange is the most recent daily %Change (matches the
    // last entry of hist when data.txt = latest CSV, which it normally
    // is). The compounding loop walks all of hist (including today),
    // so eqLevel ends up reflecting the post-today value.
    let eqLevel = 100;
    let spxLevel = 100;
    for (const h of hist) {
        if (h.m && h.m.avgChange != null && Number.isFinite(h.m.avgChange)) {
            eqLevel *= (1 + h.m.avgChange / 100);
        }
        // Parallel SPX rebase. Source priority:
        //   1. CSV's $SPX row %Change (available from 23/04/2026 onward).
        //   2. Stooq backfill for the same trading day (covers the
        //      pre-23/04 gap when Barchart wasn't carrying $SPX yet).
        // Same baseline (100 on hist[0]), same compounding rule — so the
        // EQ500 vs SPX levels are directly comparable as cumulative-
        // return numbers anchored to the very first trading day we have.
        let spxChg = h.m && h.m.macro && h.m.macro.spx
                     ? h.m.macro.spx.chgPct : null;
        if ((spxChg == null || !Number.isFinite(spxChg))
                && h.date && spxFill[h.date] != null) {
            spxChg = spxFill[h.date];
        }
        if (spxChg != null && Number.isFinite(spxChg)) {
            spxLevel *= (1 + spxChg / 100);
        }
    }
    const eqIndex = {
        level: eqLevel,
        dailyChgPct: todayM.avgChange,
        date: hist.length ? hist[hist.length - 1].date : null,
    };
    const spxRebased = {
        level: spxLevel,
        dailyChgPct: todayM.macro && todayM.macro.spx
                     ? todayM.macro.spx.chgPct : null,
        date: hist.length ? hist[hist.length - 1].date : null,
    };

    // "Selling-pressure days" — honest about its limits. The first pass
    // at this rule used -0.3% on SPX and over-counted: it flagged days
    // where the cap-weighted index closed -0.41%, -0.49%, -0.38% — the
    // kind of noise the user correctly described as "I didn't see any
    // real selling days". Tightened to -0.5% which yields ~2 days in
    // the current window, matching real moves like 05/15 (-1.24%) and
    // 05/19 (-0.67%) and excluding sub-half-percent flutters.
    //
    //   Primary rule: $SPX %Change < -0.5% on the day.
    //   Fallback:    avgChange of the 500 stocks < -0.7% (used only when
    //                the CSV's $SPX row is missing — pre-23/04 days).
    //
    // sellDaysRecent10 captures FRESHNESS — a cluster in the last 10
    // sessions reads very differently from the same count spread out
    // across the full 25-day window.
    const last25 = hist.slice(-25);
    const last10 = hist.slice(-10);
    const isSellingDay = (h) => {
        const spx = h.m && h.m.macro && h.m.macro.spx
                    ? h.m.macro.spx.chgPct : null;
        if (spx != null && Number.isFinite(spx)) return spx < -0.5;
        return h.m && h.m.avgChange != null && h.m.avgChange < -0.7;
    };
    const distributionDays = last25.filter(isSellingDay).length;
    const sellDaysRecent10 = last10.filter(isSellingDay).length;
    // Tight cluster — 2+ selling days inside the last 3 trading sessions
    // is a strong "wave just hit" signal even if the broader 25d count
    // is still low.
    const last3 = hist.slice(-3);
    const sellDaysRecent3 = last3.filter(isSellingDay).length;

    // Days since last "new low" appeared
    let daysSinceNewLow = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].m.newLows === 0) daysSinceNewLow++;
        else break;
    }

    // Scores — FALLBACK path (phase-3.0 stage 2/3). data/daily_state.json,
    // built by the single Python source, is authoritative and overlays
    // these in init() when present. This JS computation only survives as a
    // resilience fallback for when daily_state is missing/stale, so after
    // a Python-only formula change (phase 3.1+) it may lag the source —
    // that's expected and covered by the informational parity note.
    // Still captures coverage/missing-input breakdown for the warnings.
    const techFull = scoreTechFull(todayM.macro.spx, vix1dPct);
    const techScore = techFull ? techFull.value : null;
    const breadthFull = scoreBreadthFull(todayM);
    const breadthScore = breadthFull ? breadthFull.value : null;
    const flowAnalytics = computeFlowAnalytics(flowHistory);
    const flowScore = flowAnalytics.score;
    const combined = combineScores(techScore, flowScore, breadthScore);

    // Sector leadership composition (top 3 by avg change today)
    const sectorsRanked = [...todayM.sectors].sort((a, b) => b.avgChg - a.avgChg);
    const top3 = sectorsRanked.slice(0, 3);
    const bot3 = sectorsRanked.slice(-3).reverse();
    const cyclicalInTop3  = top3.filter(s => CYCLICAL.includes(s.code)).length;
    const defensiveInTop3 = top3.filter(s => DEFENSIVE.includes(s.code)).length;
    const cyclicalLeadership  = top3.length ? cyclicalInTop3 / top3.length : 0;
    const defensiveLeadership = top3.length ? defensiveInTop3 / top3.length : 0;

    // Yesterday's classifier inputs — used both for thrust detection
    // and for the narrative's "which criterion just crossed today" line.
    // Declared at the wider scope so the metrics object can carry it
    // through to renderNarrative.
    let previousPhase = null;
    let previousMetrics = null;
    let yesterdayScores = null;   // {tech, flow, breadth, combined, raw}
    if (hist.length >= 2) {
        const yest = hist[hist.length - 2];
        const yestAgo5 = hist[Math.max(0, hist.length - 7)];
        const yestBreadth5d = yestAgo5 ? (yest.m.pctMa200 - yestAgo5.m.pctMa200) : 0;
        const yestDist = hist.slice(-26, -1)
            .filter(h => h.m.avgChange != null && h.m.avgChange < -0.2).length;
        const yestVixChg = yest.m.macro && yest.m.macro.vixChgPct;
        const yestTech = scoreTech(yest.m.macro.spx, yestVixChg);
        const yestBreadth = scoreBreadth(yest.m);
        // Yesterday's Flow Score + raw — pulled from the per-day analytics
        // array. The raw row is used by the interpretation sentence to
        // explain WHY the Flow Score moved (callShare swing etc).
        let yestFlow = null;
        let yestFlowRaw = null;
        if (flowAnalytics && flowAnalytics.days && flowAnalytics.days.length >= 2) {
            const fy = flowAnalytics.days[flowAnalytics.days.length - 2];
            if (fy && Number.isFinite(fy.score)) yestFlow = fy.score;
            if (fy && fy.raw) yestFlowRaw = fy.raw;
        }
        const yestCombined = combineScores(yestTech, yestFlow, yestBreadth);
        const yestM = {
            combined: yestCombined != null ? yestCombined : 50,
            breadth5dDelta: yestBreadth5d,
            vix: yest.m.macro.vix || 0,
            distributionDays: yestDist,
            nhMinusNl: yest.m.newHighs - yest.m.newLows,
            rsiThrust: yest.m.rsiThrust,
            pctMa200: yest.m.pctMa200,
            previousPhase: null
        };
        const yestResult = Regime.classifyPhase(yestM);
        previousPhase = yestResult.phase.id;
        previousMetrics = yestM;
        yesterdayScores = {
            tech: yestTech, flow: yestFlow, breadth: yestBreadth,
            combined: yestCombined, raw: yest, flowRaw: yestFlowRaw,
        };
    }

    // Composed metrics for regime + chips
    const metrics = {
        // Today scores
        techScore, flowScore, breadthScore, combined,
        // Coverage report — populated by scoreTechFull / scoreBreadthFull
        // and computeFlowAnalytics. Each is { coverage: 0..1, missing: [...] }.
        // UI uses these to surface a ⚠ chip when coverage < 1.
        techCoverage: techFull ? { coverage: techFull.coverage, missing: techFull.missing } : null,
        breadthCoverage: breadthFull ? { coverage: breadthFull.coverage, missing: breadthFull.missing } : null,
        flowCoverage: flowAnalytics.coverage || null,

        // Yesterday's score breakdown — drives the adaptive interpretation
        // line under the MCC combined score ("נחתך מ-X ל-Y בשל ..."). See
        // README §section-2-interpretation.
        yesterdayScores,

        // Breadth
        pctMa200: todayM.pctMa200,
        pctMa50:  todayM.pctMa50,
        pctMa20:  todayM.pctMa20,
        pctGolden: todayM.pctGolden,
        healthScore: todayM.healthScore,
        avgChange: todayM.avgChange,
        nhCount: todayM.newHighs,
        nlCount: todayM.newLows,
        newHighs: todayM.newHighs,
        newLows: todayM.newLows,
        nhMinusNl: todayM.newHighs - todayM.newLows,
        nhNlRatio: todayM.newLows === 0 && todayM.newHighs > 0 ? 99 : (todayM.newLows ? todayM.newHighs / todayM.newLows : 0),
        oversold: todayM.oversold,
        overboughtCount: todayM.overbought,
        rsiThrust: todayM.rsiThrust,
        advancing: todayM.advancing,
        declining: todayM.declining,

        // Extended-view metrics (null on pre-2026-06-11 data)
        udVolRatio: todayM.udVolRatio,
        upVol: todayM.upVol,
        downVol: todayM.downVol,
        medianRsi: todayM.medianRsi,
        oversoldNum: todayM.oversoldNum,
        overboughtNum: todayM.overboughtNum,

        // Macro
        vix: todayM.macro.vix || 0,
        dxy: todayM.macro.dxy || 0,
        tnx: todayM.macro.tnx || 0,
        spx: todayM.macro.spx,

        // Trends
        breadth5dDelta,
        vix5dDelta,
        vix1dPct,
        dxy1dPct,
        tnx1dPct,
        eqIndex,
        spxRebased,
        distributionDays,
        sellDaysRecent10,
        sellDaysRecent3,
        daysSinceNewLow,

        // Risk-Off detection — if ANY of these fire, the structural
        // scores are likely to under-react to a real risk event, so the
        // UI must show a banner to keep the user honest about what
        // happened today.
        riskOff: (function () {
            const reasons = [];
            const spxChg = todayM.macro.spx ? todayM.macro.spx.chgPct : null;
            if (spxChg != null && spxChg <= -1.5) reasons.push({ type: 'spx_crash', value: spxChg, text: `המדד ירד ${Math.abs(spxChg).toFixed(2)}% ביום אחד — ירידה חדה` });
            if (vix1dPct != null && vix1dPct >= 25) reasons.push({ type: 'vix_spike', value: vix1dPct, text: `מדד הפחד קפץ ${vix1dPct.toFixed(0)}% ביום אחד` });
            if (distributionDays >= 4) reasons.push({ type: 'dist_count', value: distributionDays, text: `${distributionDays} ימי מכירה רחבה בחודש האחרון (הסף: 4) — לחץ מוסדי מצטבר` });
            if (sellDaysRecent3 >= 2) reasons.push({ type: 'dist_cluster', value: sellDaysRecent3, text: `${sellDaysRecent3} ימי מכירה בתוך 3 ימי המסחר האחרונים — קיבוץ הדוק` });
            // Acute = a same-day event (crash / fear spike). Without one,
            // the banner is only a BACKGROUND warning (accumulated selling
            // days) — and must not call a strong green close "יום מסוכן".
            const acute = reasons.some(r => r.type === 'spx_crash' || r.type === 'vix_spike');
            // The actual selling days (date + SPX move) — shown as a
            // chip line inside the banner so the count is verifiable.
            const sellingDays = last25.filter(isSellingDay).map(h => ({
                date: h.date,
                chg: h.m && h.m.macro && h.m.macro.spx && h.m.macro.spx.chgPct != null
                     ? h.m.macro.spx.chgPct
                     : (h.m ? h.m.avgChange : null),
            }));
            return { active: reasons.length > 0, reasons, sellingDays, acute, lastDayChg: spxChg };
        })(),

        // Flow — backwards-compat top-level (raw values)
        pcPremium:  flowAnalytics.today ? flowAnalytics.today.pc_premium  : null,
        pcTrades:   flowAnalytics.today ? flowAnalytics.today.pc_trades   : null,
        netPremium: flowAnalytics.today ? flowAnalytics.today.callP - flowAnalytics.today.putP : null,

        // Flow — full analytics sub-object (for new chip access patterns)
        // Access pattern: m.flow.raw.pc_premium, m.flow.z.pc_premium, m.flow.ema.pc_premium
        flow: flowAnalytics.today ? {
            raw:       flowAnalytics.today,
            ema:       flowAnalytics.ema,
            z:         flowAnalytics.z,
            baselines: flowAnalytics.baselines,
            score:     flowAnalytics.score,
        } : null,

        // Sectors
        sectors: sectorsRanked,
        top3, bot3,
        cyclicalLeadership, defensiveLeadership,

        // Context
        previousPhase,
        previousMetrics,         // yesterday's classifier inputs (or null
                                 // if hist < 2 days), used by narrative
                                 // to identify which threshold crossed today
        dataDate: hist.length ? hist[hist.length - 1].date : null,
        sessionCount: hist.length,
        // Date the regime entered current phase (computed in renderMCC)
    };

    return { todayM, hist, metrics, flowAnalytics };
}

// ─── Compute days-in-current-phase ─────────────────────────────────────

function computeDaysInPhase(hist, sectorsMap, currentPhaseId) {
    // Walk history backwards classifying each day. Stop when phase changes.
    if (!hist.length) return { days: 0, entered: null };
    let count = 0;
    let entered = null;
    let prevPhaseForLoop = null;
    for (let i = hist.length - 1; i >= 0; i--) {
        const m = hist[i].m;
        const ago5 = hist[Math.max(0, i - 5)].m;
        const breadth5d = m.pctMa200 - ago5.pctMa200;
        const last25 = hist.slice(Math.max(0, i - 24), i + 1)
            .filter(h => h.m.avgChange != null && h.m.avgChange < -0.2).length;
        const t = scoreTech(m.macro.spx, m.macro && m.macro.vixChgPct);
        const b = scoreBreadth(m);
        const c = combineScores(t, null, b);
        const dayMetrics = {
            combined: c != null ? c : 50,
            breadth5dDelta: breadth5d,
            vix: m.macro.vix || 0,
            distributionDays: last25,
            nhMinusNl: m.newHighs - m.newLows,
            rsiThrust: m.rsiThrust,
            pctMa200: m.pctMa200,
            previousPhase: prevPhaseForLoop
        };
        const result = Regime.classifyPhase(dayMetrics);
        if (result.phase.id !== currentPhaseId) {
            entered = hist[i + 1] ? hist[i + 1].date : hist[i].date;
            break;
        }
        count++;
        prevPhaseForLoop = result.phase.id;
        if (i === 0) entered = hist[0].date;
    }
    return { days: count, entered };
}

// ─── Rendering ────────────────────────────────────────────────────────

// IDs in this prod build are prefixed with 'ov2_' to avoid clashing
// with the existing dashboard's IDs (mcc, mccScore, kpiP200, etc.).
const ID_PREFIX = 'ov2_';
const $ = id => document.getElementById(ID_PREFIX + id);

function fmt(v, digits) {
    if (v == null || !Number.isFinite(v)) return '—';
    return (+v).toFixed(digits == null ? 2 : digits);
}
function fmtPct(v, digits) {
    if (v == null || !Number.isFinite(v)) return '—';
    const sign = v > 0 ? '+' : '';
    return sign + (+v).toFixed(digits == null ? 2 : digits) + '%';
}
function fmtSigned(v, digits) {
    if (v == null || !Number.isFinite(v)) return '—';
    const sign = v > 0 ? '+' : '';
    return sign + (+v).toFixed(digits == null ? 2 : digits);
}
function fmtDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}
function deltaClass(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted'; }
function deltaArrow(v) { return v > 0 ? '▲' : v < 0 ? '▼' : '─'; }

function sectorHmClass(chg) {
    if (chg <= -1)   return 'ov2-hm-bg-strong-neg';
    if (chg <= -0.3) return 'ov2-hm-bg-neg';
    if (chg <= -0.1) return 'ov2-hm-bg-weak-neg';
    if (chg <=  0.1) return 'ov2-hm-bg-neutral';
    if (chg <=  0.3) return 'ov2-hm-bg-weak-pos';
    if (chg <=  1)   return 'ov2-hm-bg-pos';
    return 'ov2-hm-bg-strong-pos';
}

// Selling-pressure card (redesign) — exactly three fixed lines, all
// text built in Python (daily_state.riskOff); the JS only renders them
// and draws the 25-dot evidence bar. Falls back to the live-JS riskOff
// (reasons list) only if daily_state is missing/stale.
function renderRiskOffBanner(metrics) {
    const wrap = $('riskOff');
    if (!wrap) return;
    const ro = metrics.riskOff;
    const p = metrics._pressure;   // Python-built card, when present
    const active = (p && p.active) || (ro && ro.active);
    if (!active) { wrap.style.display = 'none'; return; }
    const acute = !!((p && p.acute) || (ro && ro.acute));

    // Whole card goes red on an acute (risk) day; slate otherwise.
    wrap.classList.toggle('ov2-risk-off--acute', acute);
    const iconEl = $('riskOffIcon');
    if (iconEl) iconEl.textContent = acute ? '🚨' : '⚠️';

    // Line 1 — state. From Python; fallback to the first live reason.
    const stateEl = $('riskOffTitle');
    if (stateEl) {
        stateEl.textContent = (p && p.stateLine)
            || (acute ? 'יום סיכון בשוק' : 'לחץ מכירות מוסדי מצטבר');
    }
    // Line 2 — evidence sentence + the 25-dot bar.
    const evEl = $('riskOffEvidence');
    if (evEl) {
        evEl.textContent = (p && p.evidenceLine)
            || (ro && ro.reasons && ro.reasons[0] ? ro.reasons[0].text : '');
    }
    renderPressureDots(metrics);
    // Line 3 — action (includes its own exit condition).
    const actionEl = $('riskOffAction');
    if (actionEl) {
        const txt = (p && p.actionLine)
            || (acute ? 'לא קונים היום — חזרה לפעילות רק אחרי יום מסחר יציב'
                      : 'לא להוסיף חשיפה חדשה · המתנה לירידת הלחץ');
        actionEl.innerHTML = `<b>המשמעות:</b> ${txt}`;
    }
    wrap.style.display = '';
}

// The 25-dot evidence bar: chronological LEFT→RIGHT (LTR) inside the RTL
// card. Gray = normal session, red = selling day. A tooltip on the red
// dots carries the date + drop% — the full date list lives only here.
function renderPressureDots(metrics) {
    const bar = $('riskOffDots');
    if (!bar) return;
    const map = metrics._pressure && metrics._pressure.sellDaysMap;
    if (!Array.isArray(map) || !map.length) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    bar.innerHTML = map.map(d => {
        const sell = !!d.isSell;
        const cls = sell ? 'ov2-pdot ov2-pdot--sell' : 'ov2-pdot';
        if (sell) {
            const dd = d.date ? fmtDate(d.date) : '';
            const chg = (d.chgPct != null) ? ` ${d.chgPct.toFixed(2)}%` : '';
            return `<span class="${cls}" title="${dd}${chg}"></span>`;
        }
        return `<span class="${cls}"></span>`;
    }).join('');
}

// Live reconciliation — called by fetchLiveIndices with SPY's live
// %change. The banner BOX stays neutral (user preference); only this
// strip carries traffic colors, with the quote's date+time so the
// reader knows exactly how fresh "right now" is.
function updateRiskOffLive(spyPct, dataTs) {
    const wrap = $('riskOff');
    const liveEl = $('riskOffLive');
    if (!wrap || !liveEl || wrap.style.display === 'none') return;
    if (spyPct == null || !Number.isFinite(spyPct)) return;
    // Always show the live line while the banner is active — hiding it
    // in the "quiet zone" made it look like the feature vanished.
    liveEl.style.display = '';
    const pctStr = `${spyPct >= 0 ? '+' : ''}${spyPct.toFixed(1)}%`;
    // Timestamp of the live quote (ticker fetchedAt; falls back to now)
    const ts = (dataTs instanceof Date && !isNaN(dataTs)) ? dataTs : new Date();
    const p2 = n => String(n).padStart(2, '0');
    const tsStr = `${p2(ts.getDate())}/${p2(ts.getMonth() + 1)}/${ts.getFullYear()} ${p2(ts.getHours())}:${p2(ts.getMinutes())}`;
    liveEl.classList.remove('ov2-live-pos', 'ov2-live-neg');
    if (spyPct >= 1) {
        liveEl.classList.add('ov2-live-pos');
        liveEl.textContent = `המסחר נכון לעכשיו (${tsStr}): חיובי ${pctStr} — ייתכן שהלחץ נרגע. הבאנר יתעדכן עם נתוני הסגירה.`;
    } else if (spyPct <= -0.3) {
        liveEl.classList.add('ov2-live-neg');
        liveEl.textContent = `המסחר נכון לעכשיו (${tsStr}): הירידה נמשכת ${pctStr}.`;
    } else {
        liveEl.textContent = `המסחר נכון לעכשיו (${tsStr}): יציב ${pctStr} — אין שינוי מהותי בינתיים.`;
    }
}

function renderStrip(m, phase) {
    // Skip cleanly when the strip's anchor element isn't on the page —
    // index-v3.html drops the strip entirely, so calling textContent on
    // a missing element would throw and abort the rest of init().
    if (!$('stateScore')) return;
    const combined = m.combined;
    let scoreLabel, scoreClass;
    if (combined == null) {
        scoreLabel = '—'; scoreClass = 'muted';
    } else if (combined >= 75) {
        scoreLabel = 'מצוין'; scoreClass = 'pos';
    } else if (combined >= 60) {
        scoreLabel = 'בריא'; scoreClass = 'pos';
    } else if (combined >= 45) {
        scoreLabel = 'זהיר'; scoreClass = 'warn';
    } else if (combined >= 30) {
        scoreLabel = 'מוחלש'; scoreClass = 'neg';
    } else {
        scoreLabel = 'שלילי'; scoreClass = 'neg';
    }
    $('stateDot').className = `ov2-state-dot ov2-${scoreClass}`;
    $('stateName').textContent = scoreLabel;
    $('stateScore').textContent = combined != null ? combined : '—';

    // SPX removed from header strip — already covered by live SPY ticker above.
    // (SPX historical close from data file was less useful than live SPY.)

    $('idxVixVal').textContent = m.vix ? m.vix.toFixed(2) : '—';
    // All three macro tiles show daily %Change with the instrument's
    // raw direction: ▲ + green when the value rose, ▼ + red when it
    // fell. No "good/bad for equities" inversion — the user wants the
    // arrow to reflect the chart, not the market interpretation.
    $('idxVixChg').textContent = m.vix1dPct != null ? `${deltaArrow(m.vix1dPct)} ${fmtPct(m.vix1dPct, 2)}` : '—';
    $('idxVixChg').className = 'ov2-idx-chg ' + 'ov2-' + deltaClass(m.vix1dPct);

    $('idxDxyVal').textContent = m.dxy ? m.dxy.toFixed(2) : '—';
    $('idxDxyChg').textContent = m.dxy1dPct != null ? `${deltaArrow(m.dxy1dPct)} ${fmtPct(m.dxy1dPct, 2)}` : '—';
    $('idxDxyChg').className = 'ov2-idx-chg ' + 'ov2-' + deltaClass(m.dxy1dPct);

    $('idxTnxVal').textContent = m.tnx ? m.tnx.toFixed(2) : '—';
    $('idxTnxChg').textContent = m.tnx1dPct != null ? `${deltaArrow(m.tnx1dPct)} ${fmtPct(m.tnx1dPct, 2)}` : '—';
    $('idxTnxChg').className = 'ov2-idx-chg ' + 'ov2-' + deltaClass(m.tnx1dPct);

    $('dataDate').textContent = fmtDate(m.dataDate);
}

// ─── Macro Trail — multi-year SPX vs EQ500 + spread ───────────────────
//
// Builds two charts and a three-stat row from the Historical module's
// spliced series (Barchart through 2026-04-24, daily CSV from 25/04
// forward). Anchored to 100 at the earliest date both series have.
//
// Defensive throughout — if Historical hasn't loaded, or Chart.js is
// missing, the panel hides itself silently. Never poisons the rest of
// the dashboard.
let _macroTrailMain = null;

async function renderMacroTrail(hist) {
    const panel = $('macroTrail');
    if (!panel) return;
    if (!window.Historical || typeof Chart === 'undefined') {
        panel.style.display = 'none';
        return;
    }
    try {
        const built = await window.Historical.buildSplicedSeries(hist);
        const { spxLevels, eqLevels, spread, anchorDate } = built;
        if (!spxLevels.length || !eqLevels.length) {
            panel.style.display = 'none';
            return;
        }

        // Header stats
        const lastSpx = spxLevels[spxLevels.length - 1].level;
        const lastEq  = eqLevels[eqLevels.length - 1].level;
        const spxRet = lastSpx - 100;
        const eqRet  = lastEq - 100;
        const gap    = lastEq - lastSpx;
        const fmtRet = (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

        const subEl = $('macroTrailSub');
        if (subEl) {
            const [y, m, d] = (anchorDate || '').split('-');
            const start = y ? `${d}/${m}/${y}` : '—';
            const last = spxLevels[spxLevels.length - 1].date;
            const [ly, lm, ld] = (last || '').split('-');
            const end = ly ? `${ld}/${lm}/${ly}` : '—';
            subEl.textContent = `מ-${start} עד ${end} · ${spxLevels.length} ימי מסחר`;
        }
        const setStat = (id, val, asClass) => {
            const el = $(id);
            if (!el) return;
            el.textContent = fmtRet(val);
            el.className = 'ov2-macro-trail-stat-val ' +
                (asClass ? (val > 0 ? 'ov2-pos' : val < 0 ? 'ov2-neg' : '') : '');
        };
        setStat('macroTrailSpxRet', spxRet, true);
        setStat('macroTrailEqRet',  eqRet, true);
        setStat('macroTrailSpread', gap, true);

        // ── Main chart: two levels, time-axis ──
        if (_macroTrailMain) { _macroTrailMain.destroy(); _macroTrailMain = null; }
        const mainCanvas = $('macroTrailChart');
        if (mainCanvas) {
            _macroTrailMain = new Chart(mainCanvas, {
                type: 'line',
                data: {
                    labels: spxLevels.map(r => r.date),
                    datasets: [
                        {
                            label: 'SPX (משוקלל)',
                            data: spxLevels.map(r => r.level),
                            borderColor: '#2563EB',
                            backgroundColor: 'rgba(37, 99, 235, 0.06)',
                            borderWidth: 1.6,
                            pointRadius: 0,
                            fill: false,
                            tension: 0.1,
                        },
                        {
                            label: 'EQ500 (שוויוני)',
                            data: eqLevels.map(r => r.level),
                            borderColor: '#059669',
                            backgroundColor: 'rgba(5, 150, 105, 0.06)',
                            borderWidth: 1.6,
                            pointRadius: 0,
                            fill: false,
                            tension: 0.1,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} (${(ctx.parsed.y - 100 >= 0 ? '+' : '')}${(ctx.parsed.y - 100).toFixed(2)}%)`,
                            },
                        },
                    },
                    scales: {
                        x: {
                            ticks: { autoSkip: true, maxTicksLimit: 8, font: { size: 10 } },
                            grid:  { display: false },
                        },
                        y: {
                            ticks: { font: { size: 10 }, callback: (v) => v.toFixed(0) },
                            grid:  { color: 'rgba(0,0,0,0.05)' },
                        },
                    },
                },
            });
        }

        // Spread chart removed 2026-05-24 — 10 years of daily bars produced
        // a dense red/green smear with no readable signal. Per-day spread
        // data is still computed by Historical.buildSplicedSeries and used
        // internally by patterns.js (KNN feature #4 = 5-day cumulative
        // spread), so the underlying signal isn't lost — just the visual.
        // Advance/decline ratio in the daily watchlist CSVs is a cleaner
        // representation if a chart is wanted here later.

        // Expose for console debugging.
        if (window.__V2) window.__V2.macroTrail = built;
    } catch (err) {
        console.warn('renderMacroTrail failed:', err);
        panel.style.display = 'none';
    }
}

// ─── Flow vs Price panel — options sentiment timeline vs SPX ─────────
//
// Plots two aligned series across the last ~22 trading days:
//   - Flow score (0-100): per-day options-flow score from
//     computeFlowAnalytics. 50 is the neutral midline; above 60 is
//     "calls dominant / bullish lean", below 40 is "puts dominant /
//     hedging lean".
//   - SPX cumulative %: starts at 0 on the first flow-history day and
//     compounds forward using daily $SPX %Change.
//
// Two scalars in the header:
//   - Pearson correlation between the two series — answers "did flow
//     and price move together over this window?"
//   - Today's divergence — flow score's deviation from 50 on the same
//     day SPX moved. When they disagree (flow defensive but SPX up,
//     or flow bullish but SPX down), the eye should catch it.
let _fvpChart = null;
function renderFlowVsPrice(metrics, flowAnalytics, hist) {
    const panel = $('flowVsPrice');
    if (!panel) return;
    if (typeof Chart === 'undefined' || !flowAnalytics || !flowAnalytics.days
            || flowAnalytics.days.length === 0) {
        panel.style.display = 'none';
        return;
    }
    try {
        // Build a date → SPX %change map from the dashboard's daily hist.
        // The flow-history dates are a subset (or superset) of hist;
        // we align on dates that appear in both.
        const spxByDate = Object.create(null);
        for (const h of hist) {
            const c = h && h.m && h.m.macro && h.m.macro.spx
                      ? h.m.macro.spx.chgPct : null;
            if (Number.isFinite(c)) spxByDate[h.date] = c;
        }

        const flowDays = flowAnalytics.days.filter(d => d && d.date && d.score != null);
        if (flowDays.length < 3) {
            panel.style.display = 'none';
            return;
        }

        // Build aligned arrays: dates, flow scores, SPX cumulative %.
        // Cumulative SPX starts at 0 on the first flow day with a $SPX
        // reading we know about; days where SPX is missing get a null
        // (chart treats it as a gap, levels carry over implicitly).
        const labels = [];
        const flowScores = [];
        const spxCum = [];
        let cumLvl = 100;
        for (const d of flowDays) {
            labels.push(d.date);
            flowScores.push(d.score);
            const c = spxByDate[d.date];
            if (Number.isFinite(c)) cumLvl *= (1 + c / 100);
            spxCum.push((cumLvl - 100));
        }

        // Pearson correlation (defensive — needs paired data only)
        const paired = [];
        for (let i = 0; i < flowScores.length; i++) {
            if (Number.isFinite(flowScores[i]) && Number.isFinite(spxCum[i])) {
                paired.push([flowScores[i], spxCum[i]]);
            }
        }
        let corr = null;
        if (paired.length >= 4) {
            const meanF = paired.reduce((s, p) => s + p[0], 0) / paired.length;
            const meanS = paired.reduce((s, p) => s + p[1], 0) / paired.length;
            let num = 0, dF = 0, dS = 0;
            for (const [f, s] of paired) {
                num += (f - meanF) * (s - meanS);
                dF  += (f - meanF) ** 2;
                dS  += (s - meanS) ** 2;
            }
            if (dF > 0 && dS > 0) corr = num / Math.sqrt(dF * dS);
        }

        // Header stats — correlation + today's divergence.
        const corrEl = $('fvpCorr');
        if (corrEl) {
            if (corr == null) { corrEl.textContent = '—'; corrEl.className = 'ov2-fvp-stat-val'; }
            else {
                const sign = corr >= 0 ? '+' : '';
                corrEl.textContent = sign + corr.toFixed(2);
                corrEl.className = 'ov2-fvp-stat-val ' + (corr > 0.4 ? 'ov2-pos' : corr < -0.4 ? 'ov2-neg' : '');
            }
        }
        // Today's divergence: flow lean (score - 50) vs SPX daily %change.
        // Flag DIVERGENCE when they have opposite signs and at least one
        // is meaningful (|score-50| >= 5 or |spx| >= 0.3%).
        const lastFlow = flowScores[flowScores.length - 1];
        const lastSpxChg = metrics.spx ? metrics.spx.chgPct : null;
        const divEl = $('fvpDiv');
        if (divEl) {
            if (lastFlow == null || lastSpxChg == null) {
                divEl.textContent = '—';
                divEl.className = 'ov2-fvp-stat-val';
            } else {
                const flowLean = lastFlow - 50;
                const meaningful = Math.abs(flowLean) >= 5 || Math.abs(lastSpxChg) >= 0.3;
                const diverged = (flowLean > 0 && lastSpxChg < 0) || (flowLean < 0 && lastSpxChg > 0);
                if (meaningful && diverged) {
                    divEl.textContent = 'כן';
                    divEl.className = 'ov2-fvp-stat-val ov2-neg';
                } else {
                    divEl.textContent = 'לא';
                    divEl.className = 'ov2-fvp-stat-val ov2-pos';
                }
            }
        }

        // Dominant-motif DTE — classify each day in the window as bullish
        // (score >= 60), bearish (score <= 40), or neutral, then take the
        // larger non-neutral cohort and compute its ASK-SIDE premium-
        // weighted average DTE on the matching side: callAskDte+callAskP
        // for bullish, putAskDte+putAskP for bearish.
        //
        // Ask-side only on purpose — those are the aggressive BUYERS (paying
        // ask, willing to chase the offer), which is the cleanest read of
        // directional conviction. Mid prints are passive, bid prints are
        // sellers (or covered-call writers), and including them muddies the
        // "what are the bulls actually paying for?" signal.
        //
        // Short-DTE ask-side bullish flow (≤14d) signals tactical gamma
        // plays around events; long-DTE (60d+) signals genuine multi-
        // quarter conviction. Same score, very different stories.
        const dteEl = $('fvpDte');
        if (dteEl) {
            const bull = flowDays.filter(d => d.score >= 60);
            const bear = flowDays.filter(d => d.score <= 40);
            const dominant = bull.length === 0 && bear.length === 0
                ? null
                : bull.length >= bear.length ? 'bull' : 'bear';
            let dteVal = null, dteN = 0;
            if (dominant) {
                const set = dominant === 'bull' ? bull : bear;
                let wSum = 0, pSum = 0;
                for (const d of set) {
                    const raw = d.raw || {};
                    const dte  = dominant === 'bull' ? raw.callAskDte : raw.putAskDte;
                    const prem = dominant === 'bull' ? raw.callAskP   : raw.putAskP;
                    if (dte != null && Number.isFinite(dte)
                            && prem != null && prem > 0) {
                        wSum += dte * prem;
                        pSum += prem;
                        dteN++;
                    }
                }
                if (pSum > 0) dteVal = wSum / pSum;
            }
            if (dteVal == null) {
                dteEl.textContent = '—';
                dteEl.className = 'ov2-fvp-stat-val';
            } else {
                const bucket = dteVal <= 14 ? 'טווח קצר'
                              : dteVal <= 60 ? 'טווח בינוני'
                              : dteVal <= 180 ? 'טווח ארוך'
                              : 'טווח ארוך מאוד';
                const side = dominant === 'bull' ? 'שורי' : 'דובי';
                dteEl.textContent = `${Math.round(dteVal)}d · ${bucket} (${side}, n=${dteN})`;
                dteEl.className = 'ov2-fvp-stat-val ' + (dominant === 'bull' ? 'ov2-pos' : 'ov2-neg');
            }
        }

        // Sub-line — window context
        const subEl = $('fvpSub');
        if (subEl) {
            const first = labels[0], last = labels[labels.length - 1];
            const [fy, fm, fd] = (first || '').split('-');
            const [ly, lm, ld] = (last || '').split('-');
            const firstFmt = fy ? `${fd}/${fm}/${fy}` : '—';
            const lastFmt = ly ? `${ld}/${lm}/${ly}` : '—';
            subEl.textContent = `${firstFmt} → ${lastFmt} · ${labels.length} ימי מסחר`;
        }

        // ── Chart with dual y-axis ──
        if (_fvpChart) { _fvpChart.destroy(); _fvpChart = null; }
        const canvas = $('fvpChart');
        if (canvas) {
            // Reference line at score = 50 — the bullish/bearish divider.
            // Implemented as a flat phantom dataset (no plugin required).
            // Excluded from the legend via Chart.js' filter callback below.
            const neutralLine = labels.map(() => 50);
            _fvpChart = new Chart(canvas, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        {
                            label: 'ציון Flow אבסולוטי (0-100)',
                            data: flowScores,
                            yAxisID: 'yFlow',
                            borderColor: '#7C3AED',
                            backgroundColor: 'rgba(124, 58, 237, 0.08)',
                            borderWidth: 2,
                            pointRadius: 2,
                            pointBackgroundColor: '#7C3AED',
                            fill: false,
                            tension: 0.2,
                        },
                        {
                            label: 'SPX מצטבר (%)',
                            data: spxCum,
                            yAxisID: 'ySpx',
                            borderColor: '#059669',
                            backgroundColor: 'rgba(5, 150, 105, 0.06)',
                            borderWidth: 2,
                            pointRadius: 2,
                            pointBackgroundColor: '#059669',
                            fill: false,
                            tension: 0.2,
                        },
                        {
                            label: 'גבול 50 (ניטרלי)',
                            data: neutralLine,
                            yAxisID: 'yFlow',
                            borderColor: 'rgba(124, 58, 237, 0.55)',
                            borderWidth: 1.5,
                            borderDash: [6, 5],
                            pointRadius: 0,
                            pointHoverRadius: 0,
                            fill: false,
                            tension: 0,
                            // Don't react to tooltip / hover — pure reference line
                            hoverBorderWidth: 1.5,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
                        tooltip: {
                            // Skip the neutral-50 reference dataset — it's always 50 by
                            // construction, so showing it in the tooltip adds noise.
                            filter: (ctx) => ctx.dataset.label !== 'גבול 50 (ניטרלי)',
                            callbacks: {
                                label: (ctx) => {
                                    if (ctx.dataset.yAxisID === 'yFlow') {
                                        return `ציון Flow אבסולוטי: ${ctx.parsed.y.toFixed(1)}`;
                                    }
                                    const sign = ctx.parsed.y >= 0 ? '+' : '';
                                    return `SPX מצטבר: ${sign}${ctx.parsed.y.toFixed(2)}%`;
                                },
                            },
                        },
                    },
                    scales: {
                        x: {
                            ticks: { autoSkip: true, maxTicksLimit: 7, font: { size: 10 } },
                            grid:  { display: false },
                        },
                        yFlow: {
                            type: 'linear',
                            position: 'right',
                            min: 0, max: 100,
                            ticks: { font: { size: 10 }, color: '#7C3AED', callback: (v) => v },
                            grid:  { color: 'rgba(124, 58, 237, 0.06)' },
                            title: { display: true, text: 'ציון Flow אבסולוטי', color: '#7C3AED', font: { size: 11 } },
                        },
                        ySpx: {
                            type: 'linear',
                            position: 'left',
                            ticks: { font: { size: 10 }, color: '#059669', callback: (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%' },
                            grid:  { display: false },
                            title: { display: true, text: 'SPX מצטבר', color: '#059669', font: { size: 11 } },
                        },
                    },
                },
            });
        }

        // Verdict sentence — combines correlation + today's reading
        // into one plain-Hebrew takeaway.
        const verdictEl = $('fvpVerdict');
        if (verdictEl) {
            const lastFlowVal = flowScores[flowScores.length - 1];
            const lastSpxCum = spxCum[spxCum.length - 1];
            const sign = lastSpxCum >= 0 ? '+' : '';
            let phrase, stateClass = '';
            if (corr != null && corr > 0.5) {
                phrase = `האופציות והמחיר נעים יחד (קורלציה +${corr.toFixed(2)}). ציון Flow אבסולוטי נוכחי: ${lastFlowVal.toFixed(0)}, SPX מצטבר בחלון: ${sign}${lastSpxCum.toFixed(2)}%.`;
                stateClass = corr > 0.7 ? 'ov2-pos' : '';
            } else if (corr != null && corr < -0.3) {
                phrase = `סטייה היסטורית — האופציות נעות הפוך למחיר (קורלציה ${corr.toFixed(2)}). זה דפוס שמופיע כשהשוק מתעלם משינוי בסנטימנט.`;
                stateClass = 'ov2-neg';
            } else if (lastFlowVal >= 65 && lastSpxCum > 0) {
                phrase = `אופציות אופטימיות (ציון ${lastFlowVal.toFixed(0)}) + מחיר עולה — אישור מגמה.`;
                stateClass = 'ov2-pos';
            } else if (lastFlowVal <= 35 && lastSpxCum < 0) {
                phrase = `אופציות הגנתיות (ציון ${lastFlowVal.toFixed(0)}) + מחיר יורד — אישור חולשה.`;
                stateClass = 'ov2-neg';
            } else if (lastFlowVal >= 65 && lastSpxCum < 0) {
                phrase = `סנטימנט אופטימי באופציות (${lastFlowVal.toFixed(0)}) למרות מחיר יורד — סימן אפשרי לסיום ירידה.`;
                stateClass = 'ov2-pos';
            } else if (lastFlowVal <= 35 && lastSpxCum > 0) {
                phrase = `סנטימנט הגנתי באופציות (${lastFlowVal.toFixed(0)}) למרות מחיר עולה — אזהרה אפשרית.`;
                stateClass = 'ov2-neg';
            } else {
                phrase = `מצב מאוזן — ציון Flow אבסולוטי ${lastFlowVal.toFixed(0)} (קרוב לניטרלי 50), SPX מצטבר ${sign}${lastSpxCum.toFixed(2)}%.`;
            }
            verdictEl.textContent = phrase;
            verdictEl.className = 'ov2-fvp-verdict ' + stateClass;
        }

        if (window.__V2) window.__V2.flowVsPrice = { labels, flowScores, spxCum, corr };
    } catch (err) {
        console.warn('renderFlowVsPrice failed:', err);
        panel.style.display = 'none';
    }
}

// ─── Early-warning signals (sub-panel inside Historical Echo) ──────────
//
// Reads the Patterns.analyze() output's earlyWarning block and renders
// the TWO signals with the largest separation between bullish and
// non-bullish historical outcomes. Each signal is shown as a card
// with: the diagnostic rule in plain Hebrew, the average values that
// generated the rule, and the Cohen's d effect size.
//
// Designed to read like an actionable checklist for the next 5 days,
// not as a forecast. We're explicit about sample sizes.
function renderEarlyWarning(analysis, hist) {
    const panel = $('echoEarlyWarning');
    if (!panel) return;
    if (!analysis || !analysis.earlyWarning) {
        panel.style.display = 'none';
        return;
    }
    const ew = analysis.earlyWarning;
    if (!ew.signals || ew.signals.length === 0
            || ew.counts.bullish < 2 || ew.counts.notBullish < 2) {
        panel.style.display = 'none';
        return;
    }

    const subEl = $('echoEwSub');
    if (subEl) {
        const flatNote = ew.counts.flat > 0
            ? ` (${ew.counts.bearish} שלילי + ${ew.counts.flat} שטוח)`
            : '';
        subEl.textContent =
            `מתוך ${ew.counts.total} ימים דומים: ${ew.counts.bullish} חיוביים (+20d ≥ +1%), ` +
            `${ew.counts.notBullish} אחרים${flatNote}. בדיקה מול 5 ימי המסחר האחרונים:`;
    }

    // Compute the current value for each signal feature, looking at
    // the LAST 5 trading days of the spliced series (the same window
    // the early-warning rules describe — "in the days after a pattern
    // fires"). This treats the last 5 days as if a pattern fired 5
    // sessions ago, which gives the user a live "are we trending toward
    // bullish continuation or toward the warning bucket?" read on each
    // page load.
    function currentValueFor(feature, hist) {
        if (!hist || hist.length < 6) return null;
        const last = hist.length - 1;
        const from = Math.max(0, last - 5);

        // Build cumulative SPX / EQ over the window from hist's %changes.
        let spxCum = 1, eqCum = 1;
        let minSpx = 1, maxSpx = 1, runningSpx = 1, maxDailyMag = 0;
        // Track VIX through the window so the live tracker can answer
        // both signals: "VIX %change over 5 days" and "max VIX in the
        // window." Falls back to null if the daily CSV doesn't have a
        // $VIX row for any of the 5 most recent days.
        let vixStart = null, vixEnd = null, vixMax = -Infinity;
        for (let i = from + 1; i <= last; i++) {
            const sp = hist[i] && hist[i].m && hist[i].m.macro && hist[i].m.macro.spx
                       && hist[i].m.macro.spx.chgPct != null
                       ? hist[i].m.macro.spx.chgPct : 0;
            const eq = hist[i] && hist[i].m && hist[i].m.avgChange != null
                       ? hist[i].m.avgChange : 0;
            spxCum *= (1 + sp / 100);
            eqCum  *= (1 + eq / 100);
            runningSpx = spxCum;
            if (runningSpx < minSpx) minSpx = runningSpx;
            if (runningSpx > maxSpx) maxSpx = runningSpx;
            if (Math.abs(sp) > maxDailyMag) maxDailyMag = Math.abs(sp);
            const vix = hist[i] && hist[i].m && hist[i].m.macro
                        ? hist[i].m.macro.vix : null;
            if (Number.isFinite(vix)) {
                if (vixStart == null) vixStart = vix;
                vixEnd = vix;
                if (vix > vixMax) vixMax = vix;
            }
        }
        // VIX-baseline anchor — what was VIX at the start of the window?
        const vixAnchor = hist[from] && hist[from].m && hist[from].m.macro
                          && Number.isFinite(hist[from].m.macro.vix)
                          ? hist[from].m.macro.vix : vixStart;
        const spxRet = (spxCum - 1) * 100;
        const eqRet  = (eqCum  - 1) * 100;
        const spreadVal = eqRet - spxRet;
        const dd = (minSpx - 1) * 100;
        const hi = (maxSpx - 1) * 100;
        const vixEarlyPct = (vixAnchor && vixAnchor > 0 && vixEnd != null)
                            ? (vixEnd / vixAnchor - 1) * 100 : null;
        const vixEarlyMax = vixMax > -Infinity ? vixMax : null;

        switch (feature) {
            case 'spxRetEarly':   return spxRet;
            case 'eqRetEarly':    return eqRet;
            case 'spreadEarly':   return spreadVal;
            case 'earlyDrawdown': return dd;
            case 'earlyHigh':     return hi;
            case 'maxDailyMag':   return maxDailyMag;
            case 'vixEarlyPct':   return vixEarlyPct;
            case 'vixEarlyMax':   return vixEarlyMax;
            default: return null;
        }
    }

    // Render the top 3 signals. Each card includes a "live tracking"
    // row showing where today's 5-day reading sits relative to the
    // threshold derived from historical separation.
    const signalsEl = $('echoEwSignals');
    if (!signalsEl) return;
    signalsEl.innerHTML = '';
    // Reliable signals first (passed |d| + sample-size bars); unreliable
    // ones can still appear in the top-3 but get a "רמז בלבד" badge and
    // never count toward the bull/bear vote summary.
    const ranked = ew.signals.slice().sort((a, b) =>
        ((b.reliable !== false) - (a.reliable !== false)) || (b.absD - a.absD));
    const top = ranked.slice(0, 3);
    let bullVotes = 0, bearVotes = 0, totalVotes = 0;
    for (const sig of top) {
        const card = document.createElement('div');
        const isReliable = sig.reliable !== false;
        const strong = sig.absD >= 0.7;
        card.className = 'ov2-echo-ew-signal' + (strong && isReliable ? ' ov2-strong' : '');

        const sign = sig.threshold >= 0 ? '+' : '';
        const thStr = `${sign}${sig.threshold.toFixed(2)}%`;
        let rule;
        if (sig.interpret === 'bull_above') {
            rule = `אם ${sig.label.replace(/^./, c => c.toLowerCase())} ≥ <strong>${thStr}</strong> → ${sig.tipBull} (תרחיש חיובי). אם נמוך מזה → ${sig.tipBear} (אזהרה).`;
        } else {
            rule = `אם ${sig.label.replace(/^./, c => c.toLowerCase())} ≤ <strong>${thStr}</strong> → ${sig.tipBull} (תרחיש חיובי). אם גבוה מזה → ${sig.tipBear} (אזהרה).`;
        }
        const signCD = sig.cohensD >= 0 ? '+' : '';

        // Live tracking
        const currentVal = currentValueFor(sig.feature, hist);
        let liveBlock = '';
        if (currentVal != null) {
            // Only reliable signals vote — hints don't move the verdict.
            if (isReliable) totalVotes++;
            const valSign = currentVal >= 0 ? '+' : '';
            const valStr = `${valSign}${currentVal.toFixed(2)}%`;
            let leaning, leaningClass;
            if (sig.interpret === 'bull_above') {
                if (currentVal >= sig.threshold) { leaning = 'נוטה חיובי'; leaningClass = 'pos'; if (isReliable) bullVotes++; }
                else                              { leaning = 'נוטה אזהרה'; leaningClass = 'neg'; if (isReliable) bearVotes++; }
            } else {
                if (currentVal <= sig.threshold) { leaning = 'נוטה חיובי'; leaningClass = 'pos'; if (isReliable) bullVotes++; }
                else                              { leaning = 'נוטה אזהרה'; leaningClass = 'neg'; if (isReliable) bearVotes++; }
            }
            liveBlock = `
                <div class="ov2-echo-ew-signal-live">
                    <span class="ov2-echo-ew-signal-live-label">ב-5 הימים האחרונים:</span>
                    <span class="ov2-echo-ew-signal-live-val">${valStr}</span>
                    <span class="ov2-echo-ew-signal-live-status ov2-${leaningClass}">${leaning}</span>
                </div>
            `;
        }

        const hintBadge = isReliable ? ''
            : '<span style="background:#fef3c7; color:#92400e; border:1px solid #fcd34d; border-radius:4px; padding:1px 6px; font-size:10px; font-weight:700; margin-right:6px;">רמז בלבד — מדגם קטן</span>';
        card.innerHTML = `
            <div class="ov2-echo-ew-signal-head">${sig.label}${hintBadge}</div>
            <div class="ov2-echo-ew-signal-rule">${rule}</div>
            ${liveBlock}
            <div class="ov2-echo-ew-signal-stats">
                חיוביים (n=${sig.bullN}): ${sig.bullMean >= 0 ? '+' : ''}${sig.bullMean.toFixed(2)}% ·
                אחרים (n=${sig.bearN}): ${sig.bearMean >= 0 ? '+' : ''}${sig.bearMean.toFixed(2)}% ·
                Cohen d: ${signCD}${sig.cohensD.toFixed(2)} ${isReliable ? (strong ? '— מובהקת' : '— בינונית') : '— לא מספיק נתונים להסקה'}
            </div>
        `;
        signalsEl.appendChild(card);
    }

    // Aggregate verdict — count how many signals lean each direction.
    // Append a small summary line above the caveat.
    const verdictEl = $('echoEwVerdict');
    if (verdictEl) {
        if (totalVotes === 0) {
            verdictEl.textContent = '';
            verdictEl.className = 'ov2-echo-ew-verdict';
        } else if (bullVotes === totalVotes) {
            verdictEl.textContent = `סיכום מעקב: ${bullVotes}/${totalVotes} סימנים נוטים לתרחיש החיובי.`;
            verdictEl.className = 'ov2-echo-ew-verdict ov2-pos';
        } else if (bearVotes === totalVotes) {
            verdictEl.textContent = `סיכום מעקב: ${bearVotes}/${totalVotes} סימנים נוטים לאזהרה.`;
            verdictEl.className = 'ov2-echo-ew-verdict ov2-neg';
        } else {
            verdictEl.textContent = `סיכום מעקב: ${bullVotes} סימנים חיוביים, ${bearVotes} אזהרה — מצב מעורב.`;
            verdictEl.className = 'ov2-echo-ew-verdict';
        }
    }
}

// ─── Enrich Daily Narrative with the "בעבר" history line ──────────────
//
// Reads the same Patterns.analyze() output the Echo panel renders,
// distills it to a single Hebrew sentence, and drops it into the
// 5th layer of the narrative panel (id ov2_narrativeHistory). The
// narrative.js module itself stays sync + pure — this enrichment is
// done in the render layer because it needs the async Historical
// loader to settle.
//
// Verdict logic mirrors the Echo panel's but in a more conversational
// single-sentence form so it reads naturally as part of the daily
// briefing.
function enrichNarrativeWithHistory(analysis) {
    const el = $('narrativeHistory');
    if (!el) return;
    if (!analysis || !analysis.matches || !analysis.matches.length) {
        el.textContent = 'אין מספיק התאמות בעבר.';
        return;
    }
    const o20 = analysis.outcomes && analysis.outcomes[20];
    if (!o20 || !o20.samples) {
        el.textContent = `${analysis.matches.length} ימים דומים בעבר — אין מספיק נתוני המשך לחישוב.`;
        return;
    }
    const med = o20.median;
    const hit = o20.hitRate;
    const N = o20.samples;
    const pos = Math.round(hit * N);
    let text;
    if (med > 1.0 && hit >= 0.6) {
        text = `${N} ימים דומים בעבר → השוק עלה ב-${pos} מתוך ${N} מהמקרים תוך 20 ימים, חציון +${med.toFixed(2)}%.`;
    } else if (med < -1.0 && hit <= 0.4) {
        text = `${N} ימים דומים בעבר → השוק ירד ב-${N - pos} מתוך ${N} מהמקרים תוך 20 ימים, חציון ${med.toFixed(2)}%.`;
    } else {
        const sign = med >= 0 ? '+' : '';
        text = `${N} ימים דומים בעבר → תוצאה מעורבת: ${pos} מתוך ${N} חיוביים, חציון ${sign}${med.toFixed(2)}% תוך 20 ימים.`;
    }
    el.textContent = text;
}

// ─── Historical Echo — pattern matching panel ─────────────────────────
//
// Consumes Patterns.analyze() output and turns it into a 3-card
// horizon view + match-chip list + Hebrew verdict sentence + paths
// chart that overlays the 20-day trajectories of all matched days.
// Defensive — if the historical loader or Patterns module is missing,
// or the sample is too thin to be useful, the panel hides itself
// silently.
//
// The Hebrew verdict reads the median across horizons + hit rate to
// produce one of a handful of summary phrases:
//   - "נטייה היסטורית חיובית" (median > +1% AND hit > 60%)
//   - "נטייה היסטורית שלילית" (median < -1% AND hit < 40%)
//   - "תוצאה מעורבת" (everything else)
let _echoPathsChart = null;
async function renderHistoricalEcho(hist) {
    const panel = $('echo');
    if (!panel) return;
    if (!window.Historical || !window.Patterns) {
        panel.style.display = 'none';
        enrichNarrativeWithHistory(null);
        return;
    }
    try {
        const spliced = await window.Historical.buildSplicedSeries(hist);
        if (!spliced || !spliced.spx.length) {
            panel.style.display = 'none';
            enrichNarrativeWithHistory(null);
            return;
        }
        const analysis = window.Patterns.analyze(spliced, { k: 10 });
        if (analysis.error || !analysis.matches.length) {
            panel.style.display = 'none';
            enrichNarrativeWithHistory(null);
            return;
        }

        // Match quality — gates everything downstream. When the KNN
        // can't find enough close neighbors, the outcomes/verdict/scenario
        // cards are derived from polluted data and must be hidden so we
        // don't lend the model false confidence.
        const _MATCH_GOOD_THRESHOLD = 1.0;
        const _MIN_GOOD_FOR_TRUSTED = 7;
        const _goodCount = analysis.matches.filter(m => m.distance != null && m.distance <= _MATCH_GOOD_THRESHOLD).length;
        const _insufficient = _goodCount < _MIN_GOOD_FOR_TRUSTED;

        // Sub-line — context about the sample
        const subEl = $('echoSub');
        if (subEl) {
            if (_insufficient) {
                subEl.innerHTML =
                    `<span style="color:#b91c1c; font-weight:700;">⛔ רק ${_goodCount}/10 התאמות במרחק ≤ ${_MATCH_GOOD_THRESHOLD}</span> — ` +
                    `המצב היום נדיר היסטורית, המודל לא יכול להציע אינדיקציה היסטורית. נכון ל-${fmtDate(analysis.asOfDate)}.`;
            } else {
                // Year spread — all-pre-2020 matches read very differently
                // from a mix that includes the current market structure.
                const yrs = analysis.matches.map(m => (m.date || '').slice(0, 4)).filter(Boolean);
                const yrRange = yrs.length
                    ? ` טווח שנים: ${yrs.reduce((a, b) => a < b ? a : b)}-${yrs.reduce((a, b) => a > b ? a : b)}.`
                    : '';
                subEl.textContent =
                    `${analysis.matches.length} ימים דומים מתוך ${analysis.sampleSize} ימי מסחר ב-10 השנים האחרונות.` +
                    yrRange +
                    ` נכון ל-${fmtDate(analysis.asOfDate)}.`;
            }
        }

        // Verdict — Hebrew summary sentence with state-aware coloring.
        // Anchored to 20d (the most "what's the trend" horizon) but
        // weighted by the hit rate so we don't overstate weak signals.
        const o20 = analysis.outcomes[20];
        const verdictEl = $('echoVerdict');
        if (_insufficient && verdictEl) {
            verdictEl.textContent = 'המודל ההיסטורי לא יכול לעזור היום — להישען על Tech, Flow ו-Breadth.';
            verdictEl.className = 'ov2-echo-verdict ov2-neg';
        } else if (verdictEl && o20 && o20.samples) {
            const med = o20.median;
            const hit = o20.hitRate;
            const vN = o20.samples;
            const vPos = Math.round(hit * vN);
            let phrase, stateClass;
            if (med > 1.0 && hit >= 0.6) {
                phrase = `נטייה היסטורית חיובית: ב-${vPos} מתוך ${vN} מקרים דומים, השוק עלה תוך 20 ימים (חציון +${med.toFixed(2)}%).`;
                stateClass = 'ov2-pos';
            } else if (med < -1.0 && hit <= 0.4) {
                phrase = `נטייה היסטורית שלילית: ב-${vN - vPos} מתוך ${vN} מקרים דומים, השוק ירד תוך 20 ימים (חציון ${med.toFixed(2)}%).`;
                stateClass = 'ov2-neg';
            } else {
                phrase = `תוצאה מעורבת: חציון תשואת 20 ימים ${med >= 0 ? '+' : ''}${med.toFixed(2)}%, ${vPos} מתוך ${vN} מקרים חיוביים. הטווח רחב — אין נטייה ברורה.`;
                stateClass = '';
            }
            verdictEl.textContent = phrase;
            verdictEl.className = 'ov2-echo-verdict ' + stateClass;
        }

        // 3-card horizon grid: 5d / 10d / 20d
        // Hidden when matches are insufficient — the medians and hit
        // rates were derived from polluted data and would mislead.
        const horizonsEl = $('echoHorizons');
        if (horizonsEl && _insufficient) {
            horizonsEl.style.display = 'none';
        } else if (horizonsEl) {
            horizonsEl.style.display = '';
            horizonsEl.innerHTML = '';
            for (const W of [5, 10, 20]) {
                const o = analysis.outcomes[W];
                const card = document.createElement('div');
                card.className = 'ov2-echo-horizon';
                if (!o || !o.samples) {
                    card.innerHTML = `
                        <div class="ov2-echo-horizon-label">${W} ימים</div>
                        <div class="ov2-echo-horizon-median ov2-muted">—</div>
                        <div class="ov2-echo-horizon-meta">אין מספיק מקרים</div>
                    `;
                } else {
                    const medClass = o.median > 0 ? 'ov2-pos' : o.median < 0 ? 'ov2-neg' : 'ov2-muted';
                    const sign = o.median >= 0 ? '+' : '';
                    card.innerHTML = `
                        <div class="ov2-echo-horizon-label">${W} ימים</div>
                        <div class="ov2-echo-horizon-median ${medClass}">${sign}${o.median.toFixed(2)}%</div>
                        <div class="ov2-echo-horizon-meta">חציון · ${Math.round(o.hitRate * o.samples)} מתוך ${o.samples} חיוביים</div>
                        <div class="ov2-echo-horizon-range">טווח: ${o.q25.toFixed(1)}% עד ${o.q75.toFixed(1)}%</div>
                    `;
                }
                horizonsEl.appendChild(card);
            }
        }

        // ── Scenario summary — plain-Hebrew digest of the analogs ──
        //
        // Goal: a reader who didn't scroll up should understand, in three
        // short blocks, what 10 historical analogs imply for the next 20
        // trading days. The text is auto-generated from the snapshot data,
        // so it stays in sync whenever the KNN refresh runs.
        //
        // Three blocks:
        //   1. Endpoint envelope (median, range, hit rate at 20d)
        //   2. Intraperiod path nuance (worst close DURING the window —
        //      almost always deeper than the endpoint return, important
        //      so the reader doesn't panic at a 2% dip mid-window)
        //   3. Regime caveat (KNN can't see macro shocks, only the
        //      9 features it samples)
        const scenarioEl = $('echoScenario');
        if (scenarioEl && _insufficient) {
            scenarioEl.style.display = 'none';
        } else if (scenarioEl) {
            const o20 = analysis.outcomes && analysis.outcomes[20];
            const paths = (analysis.paths && analysis.paths.paths) || [];
            if (!o20 || !o20.samples || paths.length === 0) {
                scenarioEl.style.display = 'none';
            } else {
                // Compute intraperiod drawdowns: for each path, find the
                // lowest cumulative return at any day >= 1 (day 0 = anchor).
                const intraDDs = [];
                for (const p of paths) {
                    let low = 0;
                    for (const pt of p.points) {
                        if (pt.day === 0) continue;
                        if (pt.ret < low) low = pt.ret;
                    }
                    intraDDs.push(low);
                }
                const ddSorted = intraDDs.slice().sort((a, b) => a - b);
                const ddWorst = ddSorted[0];   // most negative
                const ddMedian = ddSorted[Math.floor(ddSorted.length / 2)];
                const deepCount = intraDDs.filter(d => d <= -2).length;

                // Endpoint envelope strings
                const medSign = o20.median >= 0 ? '+' : '';
                const maxSign = o20.max >= 0 ? '+' : '';
                const minSign = o20.min >= 0 ? '+' : '';
                const hitPct = Math.round(o20.hitRate * 100);
                const N = o20.samples;

                // Overall lean for the headline color
                const leanClass = o20.median >= 1 ? 'ov2-pos'
                                : o20.median <= -1 ? 'ov2-neg'
                                : '';

                scenarioEl.style.display = '';
                scenarioEl.className = 'ov2-echo-scenario ' + leanClass;
                scenarioEl.innerHTML = `
                    <div class="ov2-echo-scenario-title">תרחיש בסיס — מה צופה ההיסטוריה ל-20 הימים הבאים</div>
                    <div class="ov2-echo-scenario-blocks">
                        <div class="ov2-echo-scenario-block">
                            <div class="ov2-echo-scenario-block-head">סוף 20 ימים</div>
                            <div class="ov2-echo-scenario-block-body">
                                ב-${N} מקרים היסטוריים דומים, התשואה ביום ה-20 נעה
                                בין <strong>${minSign}${o20.min.toFixed(2)}%</strong>
                                ל-<strong>${maxSign}${o20.max.toFixed(2)}%</strong>.
                                חציון <strong>${medSign}${o20.median.toFixed(2)}%</strong>.
                                <strong>${Math.round(o20.hitRate * N)} מתוך ${N}</strong> מקרים נסגרו בחיובי.
                            </div>
                        </div>
                        <div class="ov2-echo-scenario-block">
                            <div class="ov2-echo-scenario-block-head">בתוך 20 הימים (נפילות זמניות)</div>
                            <div class="ov2-echo-scenario-block-body">
                                גם בתרחיש "בריא" יש דיפים זמניים. בחלון הנוכחי:
                                הנפילה הזמנית הכי עמוקה הייתה
                                <strong>${ddWorst.toFixed(2)}%</strong>,
                                חציון <strong>${ddMedian.toFixed(2)}%</strong>.
                                ב-${deepCount} מתוך ${N} מקרים נראה דיף של 2%+ באמצע התקופה
                                ⇐ דיף כזה בימים הקרובים <em>לא</em> שובר את התבנית.
                            </div>
                        </div>
                        <div class="ov2-echo-scenario-block">
                            <div class="ov2-echo-scenario-block-head">תנאי תקפות</div>
                            <div class="ov2-echo-scenario-block-body">
                                הניתוח מניח שהמאקרו יישאר במשטר דומה (ריבית, גיאופוליטיקה, נזילות).
                                אירוע חריג — הפתעת ריבית, מלחמה רחבה, משבר אשראי —
                                מבטל את ה-baseline. ההיסטוריה אינה ביטוח, היא <strong>התפלגות מותנית</strong>:
                                "אם הרצף נשמר, היסטורית קיבלנו את הטווח הזה".
                            </div>
                        </div>
                    </div>
                `;
            }
        }

        // Match-chip list — only show matches that pass the quality
        // threshold (distance <= 1.0). The KNN always returns K=10
        // neighbors but if the bottom of the list is far away those
        // aren't real matches. When < 7 good matches exist, the panel
        // displays an insufficient-quality message instead.
        const MATCH_GOOD_THRESHOLD = 1.0;
        const MIN_GOOD_FOR_TRUSTED = 7;
        const goodMatches = analysis.matches.filter(m => m.distance != null && m.distance <= MATCH_GOOD_THRESHOLD);
        const matchesEl = $('echoMatches');
        if (matchesEl) {
            matchesEl.innerHTML = '';
            if (goodMatches.length < MIN_GOOD_FOR_TRUSTED) {
                const msg = document.createElement('span');
                msg.className = 'ov2-echo-insufficient';
                msg.innerHTML = `⛔ <b>רק ${goodMatches.length}/10 התאמות במרחק ≤ ${MATCH_GOOD_THRESHOLD}</b> — לא מצאתי ימים דומים מספיק. המצב הנוכחי נדיר היסטורית. ההתאמות הרחוקות לא מוצגות.`;
                matchesEl.appendChild(msg);
            }
            for (const m of goodMatches) {
                const chip = document.createElement('span');
                chip.className = 'ov2-echo-match-chip';
                chip.textContent = fmtDate(m.date);
                chip.title = `מרחק נורמלי: ${m.distance.toFixed(2)} (נמוך = דומה יותר)`;
                matchesEl.appendChild(chip);
            }
        }

        // Paths chart — overlay each match's 20-day trajectory plus the
        // median path on top. Thin colored lines for individual paths
        // (faded so the median stands out); bold black for the median.
        if (_echoPathsChart) { _echoPathsChart.destroy(); _echoPathsChart = null; }
        const pathsCanvas = $('echoPathsChart');
        if (pathsCanvas && analysis.paths && analysis.paths.paths.length) {
            const horizon = analysis.paths.horizon;
            const labels = [];
            for (let d = 0; d <= horizon; d++) labels.push('+' + d);

            // Color each path by terminal return (green if ended positive,
            // red if negative) — at a glance the eye sees the win/loss
            // mix without needing to read the legend.
            const datasets = analysis.paths.paths.map((p, i) => {
                const term = p.points[p.points.length - 1];
                const positive = term && term.ret >= 0;
                const data = labels.map((_, d) => {
                    const pt = p.points.find(pt => pt.day === d);
                    return pt ? pt.ret : null;
                });
                return {
                    label: p.matchDate,
                    data,
                    borderColor: positive ? 'rgba(5, 150, 105, 0.35)' : 'rgba(220, 38, 38, 0.35)',
                    backgroundColor: 'transparent',
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false,
                    tension: 0.15,
                    order: 2,
                };
            });
            // Median path — black, bold, drawn on top.
            datasets.push({
                label: 'חציון',
                data: labels.map((_, d) => {
                    const pt = analysis.paths.median.find(pt => pt.day === d);
                    return pt ? pt.ret : null;
                }),
                borderColor: '#111827',
                backgroundColor: 'rgba(17, 24, 39, 0.04)',
                borderWidth: 2.4,
                pointRadius: 0,
                fill: false,
                tension: 0.15,
                order: 1,
            });
            _echoPathsChart = new Chart(pathsCanvas, {
                type: 'line',
                data: { labels, datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            filter: (item) => item.dataset.label !== 'חציון' || item.parsed.y != null,
                            callbacks: {
                                title: (items) => items[0] ? items[0].label + ' ימים' : '',
                                label: (ctx) => {
                                    const sign = ctx.parsed.y >= 0 ? '+' : '';
                                    return `${ctx.dataset.label}: ${sign}${ctx.parsed.y.toFixed(2)}%`;
                                },
                            },
                        },
                    },
                    scales: {
                        x: {
                            ticks: { autoSkip: true, maxTicksLimit: 6, font: { size: 10 } },
                            grid:  { display: false },
                        },
                        y: {
                            ticks: { font: { size: 10 }, callback: (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%' },
                            grid:  { color: 'rgba(0,0,0,0.05)' },
                        },
                    },
                },
            });
        }

        // Expose for console debugging.
        if (window.__V2) window.__V2.patterns = analysis;

        // ── Forward tracking — locked-in snapshots, Day N/5 progress ──
        // Replaces the old backward-looking "last 5 days" panel. The
        // snapshots file is appended to by scripts/update_forward_snapshots.py
        // each trading day, so each anchor has its KNN matches + signal
        // thresholds frozen at fire time. The live observation is
        // computed here from the current hist array.
        if (window.ForwardTracking) {
            window.ForwardTracking.load().then(data => {
                const snaps = data.snapshots || [];
                window.ForwardTracking.render(snaps, hist);
                if (window.ForwardTracking.renderMaturedTable) {
                    window.ForwardTracking.renderMaturedTable(snaps, hist);
                }
            }).catch(err => {
                console.warn('ForwardTracking render failed:', err);
            });
        }

        // ── Enrich the Daily Narrative with a "בעבר" line ──
        // The narrative was already rendered without this layer (sync).
        // We fill it in now that the patterns analysis settled. If the
        // 5th DOM slot exists, populate it; otherwise no-op so the page
        // stays valid for older HTML.
        enrichNarrativeWithHistory(analysis);
    } catch (err) {
        console.warn('renderHistoricalEcho failed:', err);
        panel.style.display = 'none';
        enrichNarrativeWithHistory(null);
    }
}

function renderEqTicker(metrics, hist) {
    // Both EQ500 and SPX-rebased are end-of-day tiles, populated once
    // per page load from the CSV history. The live ETF tiles
    // (SPY/QQQ/DIA/IWM) refresh every 60s — these don't.
    if (!metrics) return;

    const startDate = hist && hist.length ? hist[0].date : null;
    const [sy, sm, sd] = (startDate || '').split('-');
    const startFmt = sy ? `${sd}/${sm}/${sy}` : '—';

    // Render one EOD tile — used twice below for EQ500 and SPX-rebased
    // so the formatting + tooltip enrichment stays in sync between them.
    function paint(prefix, idx, label) {
        if (!idx) return;
        const { level, dailyChgPct } = idx;
        const valEl = $(prefix);
        const chgEl = $(prefix + 'Chg');
        const dateEl = $(prefix + 'Date');
        if (valEl && Number.isFinite(level)) {
            valEl.textContent = level.toFixed(2);
        }
        if (chgEl) {
            // Honest daily-change: never render a null or a Barchart
            // derived-zero as a green "+0.00%". null → "טרם התעדכן";
            // |x|<0.005 → "ללא שינוי" (neutral); else signed + colored.
            if (!Number.isFinite(dailyChgPct)) {
                chgEl.textContent = 'טרם התעדכן';
                chgEl.style.color = 'var(--ov2-text-3)';
            } else if (Math.abs(dailyChgPct) < 0.005) {
                chgEl.textContent = 'ללא שינוי';
                chgEl.style.color = 'var(--ov2-text-3)';
            } else {
                const arrow = dailyChgPct > 0 ? '▲' : '▼';
                const sign  = dailyChgPct > 0 ? '+' : '';
                chgEl.textContent = `${arrow} ${sign}${dailyChgPct.toFixed(2)}%`;
                chgEl.style.color = dailyChgPct > 0 ? 'var(--ov2-pos)' : 'var(--ov2-neg)';
            }
        }
        // Date sub-line now shows the BASELINE date (first day of the
        // CSV history, when the level was set to 100) — labelled
        // "מאז ..." so it doesn't get confused with the latest update
        // timestamp (which lives in the strip's "תאריך נתונים" tile).
        if (dateEl) {
            dateEl.textContent = startFmt !== '—' ? `מאז ${startFmt}` : '—';
        }
        // Hover tooltip carries the start date + cumulative % so the
        // number is verifiable without external context.
        const tile = valEl ? valEl.closest('.ov2-ticker-item') : null;
        if (tile && Number.isFinite(level)) {
            const cumPct = (level - 100).toFixed(2);
            const sign = (level - 100) >= 0 ? '+' : '';
            tile.setAttribute('data-tooltip',
                `${label} · מתחיל ב-100 ביום ${startFmt}. ` +
                `היום: ${level.toFixed(2)} (${sign}${cumPct}% מצטבר). ` +
                `מתעדכן רק עם CSV חדש (לא חי).`
            );
        }
    }

    paint('tkEq', metrics.eqIndex,
          'מדד שוויוני · ממוצע שווה-משקל של 500 המניות');
    paint('tkSpxBase', metrics.spxRebased,
          'SPX מנורמל · מדד S&P 500 הקאפ-משוקלל מנורמל לאותו בסיס');
}

function renderNarrative(metrics, hist, phase, phaseDuration) {
    // Narrative is a "nice to have" overlay — never let a bug here
    // poison the rest of the dashboard. If anything throws we hide the
    // panel and log; the user still gets the MCC + KPIs below.
    if (!window.Narrative) return;
    try {
        const out = window.Narrative.build(metrics, hist, phase, phaseDuration);

        // Meta-headline (state label + one-phrase rationale)
        $('narrativeMeta').textContent = out.headline.metaLabel;
        $('narrativeMeta').className =
            'ov2-narrative-meta ov2-' + (out.headline.stateClass || 'muted');
        $('narrativeRationale').textContent = out.headline.rationale;

        // 4 structured layers
        $('narrativeToday').textContent      = out.today      || '—';
        $('narrativeWeek').textContent       = out.week       || '—';
        $('narrativeBackground').textContent = out.background || '—';
        $('narrativeWatchFor').textContent   = (out.watchFor && out.watchFor.length)
            ? out.watchFor.join(' · ')
            : 'אין רמות בולטות לעקוב כעת.';

        // Color the top accent strip with the phase color so the eye
        // picks up regime state without parsing the headline.
        const accent = $('narrativeAccent');
        if (accent && phase && phase.phase && phase.phase.color) {
            accent.style.background = phase.phase.color;
        }
        // Expose for console debugging (mirrors window.__V2 pattern).
        if (window.__V2) window.__V2.narrativeDebug = out.debug;
    } catch (err) {
        console.warn('renderNarrative failed:', err);
        const panel = $('narrative');
        if (panel) panel.style.display = 'none';
    }
}

// ─── Adaptive interpretation sentence under the MCC score ───────────
//
// Builds a Hebrew one-liner that explains how today's combined score
// was derived. Per-component rules:
//
//   |Δ| < 5  → component is skipped entirely (no noise)
//   5..9   → mention with previous value: "טכני בריא (68, היה 65)"
//   ≥10    → full story with reason: "טכני נחתך מ-93 ל-68 בשל ..."
//
// When breadth is included, also append its 3 most-informative inputs
// (per the §section-2 design). All thresholds are adjustable here.
//
// Returns null when there is no yesterday to compare against.
const _INTERP_THRESH_SMALL = 5;
const _INTERP_THRESH_BIG   = 10;

function _interpLabel(kind, score) {
    if (score == null) return '—';
    if (kind === 'tech') {
        if (score >= 75) return 'טכנית השוק חזק';
        if (score >= 60) return 'טכנית השוק בריא';
        if (score >= 45) return 'טכנית השוק מאוזן';
        if (score >= 30) return 'טכנית השוק חלש';
        return 'טכנית השוק חלש מאוד';
    }
    if (kind === 'flow') {
        if (score >= 80) return 'זרימת האופציות שורית חזקה';
        if (score >= 60) return 'זרימת האופציות שורית מתונה';
        if (score >= 40) return 'זרימת האופציות מאוזנת';
        if (score >= 20) return 'זרימת האופציות באריש מתונה';
        return 'זרימת האופציות באריש חזקה';
    }
    // breadth
    if (score >= 75) return 'הרוחב חזק';
    if (score >= 60) return 'הרוחב בריא';
    if (score >= 45) return 'הרוחב בינוני';
    if (score >= 30) return 'הרוחב חלש';
    return 'הרוחב חלש מאוד';
}

function _interpTechReason(metrics, yest) {
    // Pick the dominant driver of today's tech-score change.
    const spx = metrics.spx || {};
    const reasons = [];
    if (spx.chgPct != null && spx.chgPct <= -1.5) {
        reasons.push(`ירידה חריגה של ${spx.chgPct.toFixed(2)}% ב-SPX`);
    } else if (spx.chgPct != null && spx.chgPct >= 1.0) {
        reasons.push(`עלייה של +${spx.chgPct.toFixed(2)}% ב-SPX`);
    }
    if (metrics.vix1dPct != null && metrics.vix1dPct >= 25) {
        reasons.push(`קפיצה של +${metrics.vix1dPct.toFixed(0)}% ב-VIX`);
    } else if (metrics.vix1dPct != null && metrics.vix1dPct <= -10) {
        reasons.push(`ירידה של ${metrics.vix1dPct.toFixed(0)}% ב-VIX`);
    }
    if (reasons.length === 0) return '';
    return ' בשל ' + reasons.join(' ו');
}

function _interpFlowReason(metrics, yest) {
    const f = metrics.flow && metrics.flow.raw;
    if (!f) return '';
    const reasons = [];
    const callDir = (f.callAskP || 0) + (f.callBidP || 0);
    const putDir  = (f.putAskP  || 0) + (f.putBidP  || 0);
    const share = (callDir + putDir) > 0 ? callDir / (callDir + putDir) * 100 : null;
    if (share != null) {
        const yestRaw = yest && yest.flowRaw;
        if (yestRaw) {
            const yCall = (yestRaw.callAskP || 0) + (yestRaw.callBidP || 0);
            const yPut  = (yestRaw.putAskP  || 0) + (yestRaw.putBidP  || 0);
            const yShare = (yCall + yPut) > 0 ? yCall / (yCall + yPut) * 100 : null;
            if (yShare != null && Math.abs(share - yShare) >= 15) {
                reasons.push(`callShare זז מ-${yShare.toFixed(0)}% ל-${share.toFixed(0)}%`);
            }
        }
    }
    if (metrics.flowCoverage && metrics.flowCoverage.midPct >= 70) {
        reasons.push(`${Math.round(metrics.flowCoverage.midPct)}% מהפרמיה ב-Mid (בלוקים)`);
    }
    if (reasons.length === 0) return '';
    return ' בשל ' + reasons.join(' ו');
}

function _interpBreadthReason(metrics) {
    const reasons = [];
    if (metrics.avgChange != null && metrics.avgChange <= -1.0) {
        reasons.push(`RSP ${metrics.avgChange.toFixed(2)}% היום`);
    } else if (metrics.avgChange != null && metrics.avgChange >= 1.0) {
        reasons.push(`RSP +${metrics.avgChange.toFixed(2)}% היום`);
    }
    if (metrics.breadth5dDelta != null && Math.abs(metrics.breadth5dDelta) >= 5) {
        const sign = metrics.breadth5dDelta >= 0 ? '+' : '';
        reasons.push(`%MA200 ${sign}${metrics.breadth5dDelta.toFixed(1)}% ב-5 ימים`);
    }
    if (reasons.length === 0) return '';
    return ' בשל ' + reasons.join(' ו');
}

function _interpBreadthDetail(metrics) {
    // Always-on breakdown of the 3 most informative breadth inputs.
    const parts = [];
    if (metrics.pctMa200 != null) parts.push(`${Math.round(metrics.pctMa200)}% מהמניות מעל MA200`);
    if (metrics.avgChange != null) {
        const sign = metrics.avgChange >= 0 ? '+' : '';
        parts.push(`RSP ${sign}${metrics.avgChange.toFixed(2)}% היום`);
    }
    if (metrics.nhMinusNl != null && metrics.newHighs != null && metrics.newLows != null) {
        if (metrics.newLows > 0) {
            parts.push(`יחס שיאים/שפלים ${(metrics.newHighs / metrics.newLows).toFixed(2)}`);
        } else if (metrics.newHighs > 0) {
            parts.push(`יחס שיאים/שפלים ∞`);
        }
    }
    return parts.length ? ' (' + parts.join(', ') + ')' : '';
}

function buildScoreInterpretation(metrics) {
    if (metrics.combined == null) return null;
    const yest = metrics.yesterdayScores;
    const parts = [];

    // ─ Tech part ─
    const t = metrics.techScore;
    const yt = yest && yest.tech;
    if (t != null) {
        const dt = yt != null ? t - yt : null;
        const absDt = dt != null ? Math.abs(dt) : 0;
        if (yt != null && absDt >= _INTERP_THRESH_BIG) {
            const dir = dt < 0 ? 'נחתך' : 'קפץ';
            const reason = _interpTechReason(metrics, yest);
            parts.push(`<b>הציון הטכני ${dir} מ-${yt} ל-${t}</b>${reason}`);
        } else if (yt != null && absDt >= _INTERP_THRESH_SMALL) {
            parts.push(`${_interpLabel('tech', t)} (<b>${t}</b>, היה ${yt})`);
        } else if (yt == null) {
            // No yesterday — single-shot phrasing
            parts.push(`${_interpLabel('tech', t)} (<b>${t}</b>)`);
        }
        // else: |Δ| < 5 → skip this component entirely
    }

    // ─ Flow part ─
    const f = metrics.flowScore;
    const yf = yest && yest.flow;
    if (f != null) {
        const dt = yf != null ? f - yf : null;
        const absDt = dt != null ? Math.abs(dt) : 0;
        if (yf != null && absDt >= _INTERP_THRESH_BIG) {
            const dir = dt < 0 ? 'נחתכה' : 'קפצה';
            const reason = _interpFlowReason(metrics, yest);
            parts.push(`<b>זרימת האופציות ${dir} מ-${yf} ל-${f}</b>${reason}`);
        } else if (yf != null && absDt >= _INTERP_THRESH_SMALL) {
            parts.push(`${_interpLabel('flow', f)} (<b>${f}</b>, היה ${yf})`);
        } else if (yf == null) {
            parts.push(`${_interpLabel('flow', f)} (<b>${f}</b>, בהתאם לניתוח היומי)`);
        }
    }

    // ─ Breadth part — always carries its breakdown when shown ─
    const b = metrics.breadthScore;
    const yb = yest && yest.breadth;
    if (b != null) {
        const dt = yb != null ? b - yb : null;
        const absDt = dt != null ? Math.abs(dt) : 0;
        const detail = _interpBreadthDetail(metrics);
        if (yb != null && absDt >= _INTERP_THRESH_BIG) {
            const dir = dt < 0 ? 'נחתך' : 'עלה';
            const reason = _interpBreadthReason(metrics);
            parts.push(`<b>הרוחב ${dir} מ-${yb} ל-${b}</b>${reason}${detail}`);
        } else if (yb != null && absDt >= _INTERP_THRESH_SMALL) {
            parts.push(`${_interpLabel('breadth', b)} (<b>${b}</b>, היה ${yb})${detail}`);
        } else if (yb == null) {
            parts.push(`${_interpLabel('breadth', b)} (<b>${b}</b>)${detail}`);
        }
    }

    if (parts.length === 0) {
        // All three within ±5 — nothing notable to say.
        return `<b>${metrics.combined}</b> — ללא שינוי משמעותי מאתמול (טכני ${t}, אופציות ${f}, רוחב ${b}).`;
    }
    return `<b>${metrics.combined}</b> — ${parts.join('; ')}.`;
}

function renderMCC(phase, metrics, chips, phaseDuration) {
    const p = phase.phase;
    // Glyph + Phase label
    $('mccGlyph').textContent = p.glyph;
    $('mccGlyph').style.color = p.color;
    $('mccPhaseLabel').textContent = p.labelEn;
    $('mccPhaseLabelHe').textContent = p.labelHe;
    $('mccPhaseAccent').style.background = p.color;

    // Duration — Hebrew
    if (phaseDuration && phaseDuration.days >= 0) {
        $('mccDuration').textContent = phaseDuration.days === 0
            ? '⏱ זה עתה שינוי שלב'
            : `⏱ ${phaseDuration.days} ימים בשלב`;
        $('mccEntered').textContent = phaseDuration.entered
            ? `מאז ${fmtDate(phaseDuration.entered)}`
            : '';
    }

    // Confidence — value is now rendered in the same structure as the
    // combined score (big number + small unit suffix + side label).
    // The "%" sign lives in its own .ov2-mcc-score-max span in HTML;
    // this JS writes only the number. The bar width drives the fill;
    // the gradient comes from CSS (matches the score bar exactly).
    $('mccConfVal').textContent = phase.confidence;
    $('mccConfBar').style.width = phase.confidence + '%';

    // Score + bar
    $('mccScoreVal').textContent = metrics.combined != null ? metrics.combined : '—';
    $('mccBarFill').style.width = (metrics.combined || 0) + '%';

    // Adaptive interpretation line — one Hebrew sentence under the score
    // that explains how it was derived, with day-over-day deltas and
    // reasons when components moved significantly. See §section-2.
    const interpEl = $('mccInterpretation');
    if (interpEl) {
        const sentence = buildScoreInterpretation(metrics);
        if (sentence) {
            interpEl.style.display = '';
            interpEl.innerHTML = sentence;
        } else {
            interpEl.style.display = 'none';
        }
    }

    // Coverage chip — surface when any composite score was computed from
    // partial data. See README §audit-fix-2.
    const covChip = $('coverageChip');
    if (covChip) {
        const parts = [];
        if (metrics.techCoverage && metrics.techCoverage.coverage < 1) {
            parts.push(`Tech ${Math.round(metrics.techCoverage.coverage * 100)}%`);
        }
        if (metrics.breadthCoverage && metrics.breadthCoverage.coverage < 1) {
            parts.push(`Breadth ${Math.round(metrics.breadthCoverage.coverage * 100)}%`);
        }
        if (metrics.flowCoverage && metrics.flowCoverage.midPct >= 50) {
            parts.push(`Flow ${Math.round(metrics.flowCoverage.coverage * 100)}% directional · ${Math.round(metrics.flowCoverage.midPct)}% Mid`);
        }
        if (parts.length) {
            covChip.style.display = '';
            covChip.innerHTML = `⚠ <b>שלמות נתונים חלקית:</b> ${parts.join(' · ')}`;
            const missing = [
                ...(metrics.techCoverage && metrics.techCoverage.missing || []).map(m => `Tech: ${m}`),
                ...(metrics.breadthCoverage && metrics.breadthCoverage.missing || []).map(m => `Breadth: ${m}`),
                ...(metrics.flowCoverage && metrics.flowCoverage.missing || []).map(m => `Flow: ${m}`),
            ];
            if (missing.length) covChip.title = missing.join('\n');
        } else {
            covChip.style.display = 'none';
        }
    }

    // Risk + bias (already Hebrew from regime.js)
    $('mccRisk').textContent = p.risk;
    $('mccBias').textContent = p.bias;

    // Narrative — use phase.description (cleaner than reasons[0]) + first reason as context
    const desc = p.description || '';
    const firstReason = phase.reasons[0] || '';
    $('mccNarrative').textContent = desc + (firstReason ? ' · ' + firstReason : '');

    // Drivers
    $('drvNhnl').textContent = metrics.nhNlRatio === 99 ? '∞' : metrics.nhNlRatio.toFixed(2);
    $('drvMa200').textContent = metrics.pctMa200 != null ? Math.round(metrics.pctMa200) + '%' : '—';
    $('drvVix').textContent = metrics.vix ? metrics.vix.toFixed(1) : '—';
    $('drvDist').textContent = `${metrics.distributionDays}/25`;
    $('drvCombined').textContent = metrics.combined != null ? metrics.combined : '—';
    $('drvBreadth').textContent = `${Math.round(metrics.pctMa200)}%`;

    // Chips
    renderChips(chips);

    // Conclusion — one-paragraph synthesis under the chips. Reads the
    // active chip IDs and core metrics to compose a context-aware
    // sentence: "what's the real story behind these numbers?"
    renderMccConclusion(phase, metrics, chips);
}

// ─── MCC conclusion synthesizer ──────────────────────────────────────
//
// Takes today's phase + metrics + active chips and produces one short
// paragraph that answers: "given all these signals together, what's
// the actual story?" The phase label tells you the headline, the chips
// tell you the moving parts — this line ties them into a single
// readable observation a non-trader can act on.
//
// Rules ordered specific-first: each combination of (phase + chip set)
// returns a different sentence. Falls through to a generic line if
// no specific pattern matches.
function renderMccConclusion(phase, metrics, chips) {
    const el = $('mccConclusion');
    if (!el) return;
    const phaseId = phase && phase.phase ? phase.phase.id : null;
    const isBullish = ['confirmed_uptrend','uptrend_pressure','thrust'].includes(phaseId);
    const isBearish = ['correction','capitulation','distribution'].includes(phaseId);

    const chipIds = new Set((chips || []).map(c => c.id));
    const hasNewLows      = chipIds.has('new-lows-rising');
    const hasDivergent    = chipIds.has('tech-flow-divergent')
                         || chipIds.has('price-breadth-divergent');
    const hasBreadthWide  = chipIds.has('breadth-widening');
    const hasBreadthNarrow= chipIds.has('breadth-narrowing');
    const hasThrust       = chipIds.has('thrust-confirmed');
    const hasBroad        = chipIds.has('broad-participation')
                         || chipIds.has('broad-leadership');
    const hasNarrowLead   = chipIds.has('narrow-leadership');
    const hasHedges       = chipIds.has('hedges-elevated');
    const hasOverbought   = chipIds.has('overbought-concentration');

    // Narrow leadership heuristic: explicit chip, or pctMa200 below
    // 60% (the "broad uptrend" threshold). Below 60% with a bullish
    // headline is the K-shape signature.
    const narrowFromBreadth = metrics.pctMa200 != null && metrics.pctMa200 < 60;
    const narrow = hasNarrowLead || (isBullish && narrowFromBreadth);

    let text = '', klass = 'ov2-muted';

    if (isBullish) {
        if (narrow && hasNewLows) {
            text = 'השוק במגמה שורית אבל לא הומוגנית — מובילים בודדים דוחפים את המדד, יש חולשה רחבה מתחת לפני השטח. הסיכון: אם הקבוצה המובילה תיחלש, אין רשת ביטחון רחבה תחת המחיר.';
            klass = 'ov2-warn';
        } else if (narrow) {
            text = 'מגמה שורית מובלת ע"י קבוצה צרה של מובילות. כל עוד הן חזקות — המגמה נמשכת. הבסיס מתחת פחות רחב מהאידיאלי.';
            klass = 'ov2-warn';
        } else if (hasNewLows) {
            text = 'המגמה השורית נמשכת והרוחב סביר, אבל יש זנב של מניות בחולשה חריגה — שווה לוודא אם זה ספציפי לסקטור מסוים.';
            klass = 'ov2-warn';
        } else if (hasDivergent && hasHedges) {
            text = 'המחיר עולה אבל הכסף הגדול קונה הגנות במקביל — סטייה כפולה (גם בציוני המשנה וגם ב-P/C). דפוס שמופיע לעיתים לפני תיקון.';
            klass = 'ov2-warn';
        } else if (hasDivergent) {
            text = 'המחיר עולה והרוחב טוב, אבל הכסף הגדול באופציות לא רודף באותה עוצמה — סטייה שעשויה להקדים תיקון. לא איתות מכירה, אבל סיגנל לתשומת לב.';
            klass = 'ov2-warn';
        } else if (hasOverbought) {
            text = 'מגמה שורית בריאה, אבל ריכוז של מניות בקניית-יתר מעיד שחלק מהמהלך כבר התרחב — סיכון מוגבר לתיקון קצר-טווח גם בלי שינוי משטר.';
            klass = 'ov2-warn';
        } else if (hasThrust && hasBreadthWide && hasBroad) {
            text = 'מגמה שורית הומוגנית — מומנטום רחב, רוחב משתפר, השתתפות רחבה. בריא מבחינה מבנית; פוטנציאל קצר-טווח מצומצם כי המהלך כבר נצבר.';
            klass = 'ov2-pos';
        } else if (hasBreadthWide && hasBroad) {
            text = 'מגמה שורית עם רוחב משתפר והשתתפות רחבה — מבנה תומך. שווה לחפש מובילים חדשים, פחות לדאוג מהזנבות.';
            klass = 'ov2-pos';
        } else {
            text = 'מגמה שורית יציבה — אין סיגנלי אזהרה משמעותיים במבנה הפנימי.';
            klass = 'ov2-pos';
        }
    } else if (isBearish) {
        if (hasThrust) {
            text = 'משטר דובי אבל סיגנל פריצה ראשונית — מומנטום נכנס. שווה לעקוב אחרי אישור עם רוחב משתפר בימים הקרובים לפני שינוי גישה.';
            klass = 'ov2-pos';
        } else if (hasBreadthWide) {
            text = 'משטר עדיין דובי, אבל הרוחב מתחיל להשתפר — סימן ראשון של אפשרות התייצבות. אין מספיק אישור עדיין.';
            klass = 'ov2-warn';
        } else {
            text = `משטר דובי — ${phase.phase.bias}. ההתמקדות עכשיו על הגנה ועל זיהוי סימני התייצבות, לא על הוספת חשיפה.`;
            klass = 'ov2-neg';
        }
    } else {
        // Mid / neutral / base-building / pressure
        if (hasBreadthWide) {
            text = 'מצב ביניים שמתחיל להשתפר — רוחב מתרחב. אם זה ימשיך 5-10 ימי מסחר, הסיכוי לעבור לשלב חיובי גדל.';
            klass = 'ov2-pos';
        } else if (hasBreadthNarrow) {
            text = 'מצב ביניים שמתחיל להחליש — רוחב מצטמצם. שלב מעבר — עדיף לעקוב לפני פעולה.';
            klass = 'ov2-warn';
        } else {
            text = 'מצב ביניים — אין כיוון מבנה ברור. עדיפות להמתין לאות חד-משמעי לפני הגדלת/הקטנת חשיפה.';
            klass = 'ov2-muted';
        }
    }

    el.textContent = text;
    el.className = 'ov2-mcc-conclusion ' + klass;
}

function renderChips(chips) {
    const wrap = $('mccChips');
    wrap.innerHTML = '';
    if (!chips.length) {
        wrap.innerHTML = '<span class="ov2-chip">אין סיגנלים פעילים</span>';
        return;
    }
    for (const c of chips) {
        const el = document.createElement('span');
        el.className = `ov2-chip ov2-chip-${c.type} ov2-chip-cat-${c.category}`;
        el.textContent = c.text;
        // Tooltip = Hebrew meaning (custom CSS tooltip from data-tooltip)
        if (c.meaning) el.setAttribute('data-tooltip', c.meaning);
        wrap.appendChild(el);
    }
}

function renderKPIs(m) {
    $('kpiP200Val').textContent = `${Math.round(m.pctMa200)}%`;
    $('kpiP200Delta').textContent = `${deltaArrow(m.breadth5dDelta)} ${fmtSigned(m.breadth5dDelta, 0)}pp / 5d`;
    $('kpiP200Delta').className = 'ov2-kpi-delta ' + 'ov2-' + deltaClass(m.breadth5dDelta);

    $('kpiNhNlVal').textContent = m.nhNlRatio === 99 ? '∞' : m.nhNlRatio.toFixed(2);
    $('kpiNhNlDelta').textContent = `${m.nhCount} / ${m.nlCount}`;
    $('kpiNhNlDelta').className = 'ov2-kpi-delta ' + (m.nhCount > m.nlCount ? 'ov2-pos' : 'ov2-neg');

    $('kpiAvgChgVal').textContent = m.avgChange != null ? fmtPct(m.avgChange, 2) : '—';
    $('kpiAvgChgVal').className = 'ov2-kpi-value ' + 'ov2-' + deltaClass(m.avgChange);
    $('kpiAvgChgDelta').textContent = `${m.advancing} עולות / ${m.declining} יורדות`;

    $('kpiVixVal').textContent = m.vix ? m.vix.toFixed(2) : '—';
    $('kpiVixDelta').textContent = m.vix5dDelta ? `${deltaArrow(-m.vix5dDelta)} ${fmtSigned(m.vix5dDelta, 1)} ב-5 ימים` : '—';
    $('kpiVixDelta').className = 'ov2-kpi-delta ' + 'ov2-' + deltaClass(-m.vix5dDelta);

    $('kpiDistVal').textContent = `${m.distributionDays}/25`;
    $('kpiDistDelta').textContent = m.distributionDays >= 4 ? 'מוגבר — לעקוב' : m.distributionDays >= 2 ? 'בטווח תקין' : 'בריא';
    $('kpiDistDelta').className = 'ov2-kpi-delta ' + (m.distributionDays >= 4 ? 'ov2-neg' : m.distributionDays >= 2 ? 'ov2-warn' : 'ov2-pos');

    $('kpiHealthVal').textContent = m.healthScore != null ? m.healthScore : '—';
    $('kpiHealthDelta').textContent = m.healthScore >= 70 ? 'חזק' : m.healthScore >= 55 ? 'הוגן' : m.healthScore >= 40 ? 'חלש' : 'שלילי';
    $('kpiHealthDelta').className = 'ov2-kpi-delta ' + (m.healthScore >= 70 ? 'ov2-pos' : m.healthScore >= 55 ? 'ov2-warn' : 'ov2-neg');

    $('kpiThrustVal').textContent = m.rsiThrust;
    $('kpiThrustDelta').textContent = m.rsiThrust >= 30 ? 'פריצה ✓' : m.rsiThrust >= 15 ? 'בבנייה' : 'שקט';
    $('kpiThrustDelta').className = 'ov2-kpi-delta ' + (m.rsiThrust >= 30 ? 'ov2-pos' : m.rsiThrust >= 15 ? 'ov2-warn' : 'ov2-muted');

    $('kpiCombinedVal').textContent = m.combined != null ? m.combined : '—';
    $('kpiCombinedVal').className = 'ov2-kpi-value ' + (m.combined >= 70 ? 'ov2-pos' : m.combined >= 50 ? 'ov2-warn' : 'ov2-neg');
    $('kpiCombinedDelta').textContent = m.combined >= 70 ? 'מאושר' : m.combined >= 50 ? 'זהיר' : 'חלש';
}

function renderSectorSnapshot(metrics, sectorsMap) {
    const codes = (sectorsMap && sectorsMap.codes) || {};
    const wrap = $('sectorHeatmap');
    wrap.innerHTML = '';
    const sorted = [...metrics.sectors].sort((a, b) => b.avgChg - a.avgChg);
    for (const s of sorted) {
        const cell = document.createElement('div');
        cell.className = 'ov2-hm-cell ' + sectorHmClass(s.avgChg);
        cell.innerHTML = `
            <span class="ov2-hm-sym">${codes[s.code] || s.code}</span>
            <span class="ov2-hm-val">${fmtPct(s.avgChg, 1)}</span>
        `;
        cell.setAttribute('data-tooltip',
            `${codes[s.code] || s.code} · ${Math.round(s.pct200)}% מהמניות מעל MA200 · ${s.total} מניות בסקטור`);
        wrap.appendChild(cell);
    }

    // Summary lines — separate "today's move" from "long-term strength"
    const top = sorted[0];
    const bot = sorted[sorted.length - 1];
    if (top) {
        const topName = codes[top.code] || top.code;
        $('sectorBest').textContent = `${topName} · ${fmtPct(top.avgChg, 1)} היום`;
        $('sectorBest').setAttribute('data-tooltip',
            `${topName} · המוביל בביצועי יום־אחד. לטווח ארוך: ${Math.round(top.pct200)}% מהמניות מעל MA200`);
    }
    if (bot) {
        const botName = codes[bot.code] || bot.code;
        $('sectorWorst').textContent = `${botName} · ${fmtPct(bot.avgChg, 1)} היום`;
        $('sectorWorst').setAttribute('data-tooltip',
            `${botName} · החלש בביצועי יום־אחד. לטווח ארוך: ${Math.round(bot.pct200)}% מהמניות מעל MA200`);
    }
    const dispersion = top && bot ? (top.avgChg - bot.avgChg) : 0;
    $('sectorDispersion').textContent = `${dispersion.toFixed(1)}%`;
    $('sectorDispersion').setAttribute('data-tooltip',
        `הפער בין הסקטור החזק לחלש היום. ${dispersion > 2 ? 'גבוה = רוטציה אקטיבית' : 'נמוך = השוק זז ביחד'}`);
}

const CHIP_TYPE_LABEL = {
    warning:      'אזהרה',
    transition:   'מעבר',
    confirmation: 'אישור',
    state:        'מצב'
};
// Category labels — Hebrew translations. The raw category keys come from
// regime.js (breadth/momentum/risk/flow/sector/macro) and now render in
// Hebrew alongside the type label.
const CHIP_CATEGORY_LABEL = {
    breadth:  'רוחב',
    momentum: 'מומנטום',
    risk:     'סיכון',
    flow:     'זרימה',
    sector:   'סקטור',
    macro:    'מאקרו',
};

function renderAlertsRail(chips, metrics) {
    const rail = $('railContent');
    rail.innerHTML = '';

    // Map chips to alert cards, top 5 by priority
    const railChips = chips.slice(0, 5);
    if (!railChips.length) {
        rail.innerHTML = '<div style="padding:16px; color:var(--ov2-text-3); font-size:12px;">אין התראות פעילות</div>';
        $('railCount').textContent = '0';
        return;
    }

    const severityFor = type => ({
        warning:      'warn',
        transition:   'info',
        confirmation: 'pos',
        state:        'info'
    }[type] || 'info');

    const iconFor = type => ({
        warning:      '⚠',
        transition:   '↗',
        confirmation: '✓',
        state:        '●'
    }[type] || '●');

    for (const c of railChips) {
        const sev = severityFor(c.type);
        const el = document.createElement('div');
        el.className = `ov2-alert ov2-severity-${sev}`;
        const typeLabel = CHIP_TYPE_LABEL[c.type] || c.type;
        const catLabel = CHIP_CATEGORY_LABEL[c.category] || c.category;
        const meaningHtml = c.meaning
            ? `<div class="ov2-alert-meaning">${c.meaning}</div>` : '';
        el.innerHTML = `
            <div class="ov2-alert-head">
                <span class="ov2-alert-icon">${iconFor(c.type)}</span>
                <span class="ov2-alert-title">${typeLabel} · ${catLabel}</span>
            </div>
            <div class="ov2-alert-body">${c.text}</div>
            ${meaningHtml}
            <div class="ov2-alert-meta">
                <span>עדיפות ${c.priority}</span>
            </div>
        `;
        // Meaning is now rendered inline above (in meaningHtml) — no
        // need for a hover tooltip duplicating the same text.
        rail.appendChild(el);
    }

    // Legend card — appended at the bottom. Explains the 4 chip types and
    // the 6 categories in plain Hebrew so a cold reader can decode every
    // chip above without scrolling away from the panel.
    const legend = document.createElement('div');
    legend.className = 'ov2-alert ov2-severity-info ov2-alert-legend';
    legend.innerHTML = `
        <div class="ov2-alert-head">
            <span class="ov2-alert-icon">📖</span>
            <span class="ov2-alert-title">מקרא · הסבר הצ'יפים</span>
        </div>
        <div class="ov2-alert-body" style="font-size:11.5px; line-height:1.55;">
            <div style="margin-bottom:6px;"><strong>4 סוגי אות:</strong></div>
            <div style="margin-bottom:4px;">✓ <strong>אישור</strong> — מחזק את התמונה הנוכחית</div>
            <div style="margin-bottom:4px;">⚠ <strong>אזהרה</strong> — סיגנל שמטריד, שווה לעקוב</div>
            <div style="margin-bottom:4px;">↗ <strong>מעבר</strong> — משהו זז בכיוון חדש</div>
            <div style="margin-bottom:8px;">● <strong>מצב</strong> — תיאור סטטי של "איפה אנחנו עכשיו"</div>
            <div style="margin-bottom:6px;"><strong>6 קטגוריות:</strong></div>
            <div style="font-size:11px; color:var(--ov2-text-2);">
                <strong>רוחב</strong> = כמה מניות משתתפות ·
                <strong>מומנטום</strong> = תאוצת מגמה ·
                <strong>סיכון</strong> = VIX ותנודתיות ·
                <strong>זרימה</strong> = אופציות וכסף מוסדי ·
                <strong>סקטור</strong> = רוטציה ·
                <strong>מאקרו</strong> = ריבית/מטבע/אג"ח
            </div>
            <div style="margin-top:8px; font-size:11px; color:var(--ov2-text-3);">
                <strong>עדיפות 0-100</strong> — גבוה יותר = חשוב יותר. הצ'יפים ממוינים מלמעלה למטה.
            </div>
        </div>
    `;
    rail.appendChild(legend);

    $('railCount').textContent = chips.length;
}

// ═════════════════════════════════════════════════════════════════════
// FLOW CARD — surfaces SPX options flow as a first-class section
// Extended 2026-05-22: Call/Put breakdown + Ask/Bid direction + formula
// ═════════════════════════════════════════════════════════════════════
function renderFlowCard(metrics, flowAnalytics) {
    const wrap = $('flowCard');
    if (!wrap) return;
    const f = metrics.flow;
    if (!f || !f.raw) {
        wrap.style.display = 'none';
        return;
    }
    const raw = f.raw;
    const z = f.z || {};
    const score = f.score;
    // Historical context (used at end of card)
    const allDays = (flowAnalytics && flowAnalytics.days) || [];

    // Status text — deterministic, based on score
    let status, statusClass;
    if (score == null)        { status = '—';                                  statusClass = ''; }
    else if (score >= 70)     { status = 'Risk-On · כסף תוקפני לעליות';        statusClass = 'ov2-pos'; }
    else if (score >= 55)     { status = 'נייטרלי-חיובי';                       statusClass = 'ov2-pos'; }
    else if (score >= 45)     { status = 'מאוזן · ללא כיוון ברור';              statusClass = 'ov2-warn'; }
    else if (score >= 30)     { status = 'הגנתי · כסף קונה protection';        statusClass = 'ov2-warn'; }
    else                       { status = 'הגנה אגרסיבית · חששות';             statusClass = 'ov2-neg'; }

    // Top score block — main number is the directional score, with a
    // small footer showing the absolute (overall premium) read for
    // context when Mid dominates. The mid-warning surfaces only when
    // Mid is >=70% (the "block-heavy day" regime).
    $('flowScoreVal').textContent = score != null ? score : '—';
    $('flowStatus').textContent = status;
    $('flowStatus').className = 'ov2-flow-status ' + statusClass;
    const sideEl = $('flowScoreSide');
    if (sideEl) {
        // Build a 3-layer context: Mid warning (existing), absolute score
        // reference (existing), plus a NEW "institutional positioning"
        // line that fires when the directional flow has a notable
        // concentration in put-writing, put-buying, call-writing, or
        // call-buying. The score by itself can hide what the big money
        // is actually DOING — these contexts add the missing color.
        // Flow confidence tier — derived from Mid dominance.
        // See README §audit-fix-6. The Flow Score is computed from
        // directional premium only; when Mid > 50% of total, the
        // score reflects a SMALLER slice of the day's flow and should
        // be flagged. > 80% means almost everything was blocks and
        // the score is borderline meaningless.
        const lines = [];
        if (f.midPct != null) {
            if (f.midPct >= 80) {
                lines.push(`<span style="color:#991b1b; font-weight:800;">⛔ ${f.midPct.toFixed(0)}% Mid — ביטחון נמוך בציון</span>`);
            } else if (f.midPct >= 70) {
                lines.push(`<span style="color:#b45309; font-weight:700;">⚠ ${f.midPct.toFixed(0)}% Mid — ביטחון מוגבל</span>`);
            } else if (f.midPct >= 50) {
                lines.push(`<span style="color:#92400e;">⚠ ${f.midPct.toFixed(0)}% Mid (בלוקים/דילרים)</span>`);
            }
        }
        if (f.scoreAbsolute != null && (f.midPct >= 70 || Math.abs(f.scoreAbsolute - score) >= 10)) {
            lines.push(`<span style="color:var(--ov2-text-3);">absolute: <b>${f.scoreAbsolute}</b></span>`);
        }
        // Institutional positioning context — looks for large notional
        // on Bid/Ask sides ($1B+ is a "headline" event for SPX flow).
        const pBid = raw.putBidP || 0;
        const pAsk = raw.putAskP || 0;
        const cBid = raw.callBidP || 0;
        const cAsk = raw.callAskP || 0;
        const billionsToStr = v => `$${(v / 1e9).toFixed(2)}B`;
        const contextLines = [];
        if (pBid >= 1e9) {
            contextLines.push(`<span style="color:#047857;">📥 כתיבת puts מסיבית (${billionsToStr(pBid)})</span> — מוסדיים מוכנים לקנות בתחתית, contrarian-bullish`);
        }
        if (pAsk >= 1e9) {
            contextLines.push(`<span style="color:#b91c1c;">🛡 קניית puts אגרסיבית (${billionsToStr(pAsk)})</span> — דרישת הגנה כבדה`);
        }
        if (cBid >= 1e9) {
            contextLines.push(`<span style="color:#b91c1c;">🔻 כתיבת calls אגרסיבית (${billionsToStr(cBid)})</span> — תקרה על העלייה`);
        }
        if (cAsk >= 1e9) {
            contextLines.push(`<span style="color:#047857;">📈 קניית calls מסיבית (${billionsToStr(cAsk)})</span> — הימור על המשך עלייה`);
        }
        if (lines.length || contextLines.length) {
            sideEl.style.display = '';
            sideEl.innerHTML =
                (lines.length ? lines.join(' · ') : '') +
                (contextLines.length ? `<div style="margin-top:6px; line-height:1.6;">${contextLines.join('<br>')}</div>` : '');
        } else {
            sideEl.style.display = 'none';
        }
    }

    // Top metrics row
    $('flowPcPremiumVal').textContent = raw.pc_premium != null ? raw.pc_premium.toFixed(2) : '—';
    const zPc = z.pc_premium;
    $('flowPcPremiumSub').textContent = zPc != null
        ? (zPc > 0 ? `+${zPc.toFixed(1)}σ מעל ממוצע 22D` : `${zPc.toFixed(1)}σ מתחת לממוצע 22D`)
        : 'אין baseline';

    $('flowCallPctVal').textContent = raw.call_premium_pct != null ? Math.round(raw.call_premium_pct) + '%' : '—';
    $('flowCallPctSub').textContent = raw.callP != null
        ? `${(raw.callP / 1e9).toFixed(2)}B$ פרמיה`
        : '—';

    $('flowIvSkewVal').textContent = raw.iv_skew != null ? raw.iv_skew.toFixed(1) : '—';
    $('flowIvSkewSub').textContent = raw.iv_skew != null
        ? (raw.iv_skew > 9 ? 'פחד מוגבר' : raw.iv_skew > 6 ? 'נורמלי' : 'רגוע')
        : '—';

    $('flowBigTradesVal').textContent = raw.big_trades != null ? raw.big_trades : '—';
    $('flowBigTradesSub').textContent = raw.big_trades >= 140 ? 'פעילות מוסדית חזקה'
                                       : raw.big_trades >= 100 ? 'פעילות מוסדית נורמלית'
                                       : 'פעילות שקטה';

    // ─── Call vs Put breakdown (Side × {Trades, Premium}) ───
    const fmtP = v => {
        if (v == null) return '—';
        if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
        if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M';
        return '$' + Math.round(v).toLocaleString();
    };
    const buildSideTable = (label, tr, prem, askTr, bidTr, midTr, askP, bidP, midP, askTrPct, askPremPct, askDte, bidDte, midDte) => {
        const dirTr = askTr + bidTr;
        const bidTrPct  = dirTr ? Math.round(bidTr / dirTr * 100) : 0;
        const askTrPctR = dirTr ? Math.round(askTr / dirTr * 100) : 0;
        const dirP = askP + bidP;
        const bidPremPct = dirP ? Math.round(bidP / dirP * 100) : 0;
        const askPremPctR= dirP ? Math.round(askP / dirP * 100) : 0;
        // NEW · average premium per trade
        const askAvg = askTr > 0 ? askP / askTr : 0;
        const bidAvg = bidTr > 0 ? bidP / bidTr : 0;
        const midAvg = midTr > 0 ? midP / midTr : 0;
        // Asymmetry callout — Bid avg vs Ask avg
        const sizeRatio = (askAvg > 0 && bidAvg > 0) ? (bidAvg / askAvg) : null;
        let sizeNote = '';
        if (sizeRatio != null) {
            if (sizeRatio >= 2)        sizeNote = `Bid גדול פי <b>${sizeRatio.toFixed(1)}</b> מ-Ask — כסף גדול במוכרים`;
            else if (sizeRatio <= 0.5) sizeNote = `Ask גדול פי <b>${(1/sizeRatio).toFixed(1)}</b> מ-Bid — כסף גדול בקונים`;
            else                       sizeNote = `Ask ו-Bid דומים בגודל ממוצע`;
        }
        const dteFmt = d => d != null ? d + 'd' : '—';
        return `
        <table class="ov2-flow-side-table">
            <thead><tr><th></th><th>עסקאות</th><th>פרמיה</th><th>ממוצע/עסקה</th><th>ימים עד פקיעה</th></tr></thead>
            <tbody>
                <tr class="ov2-flow-side-ask">
                    <td><b>Ask</b><br><span class="ov2-flow-side-sub">קונה אגרסיבי</span></td>
                    <td><b>${askTr}</b> <span class="ov2-flow-side-pct">(${askTrPctR}%)</span></td>
                    <td><b>${fmtP(askP)}</b> <span class="ov2-flow-side-pct">(${askPremPctR}%)</span></td>
                    <td><span class="ov2-flow-side-avg">${fmtP(askAvg)}</span></td>
                    <td><span class="ov2-flow-side-dte">${dteFmt(askDte)}</span></td>
                </tr>
                <tr class="ov2-flow-side-bid">
                    <td><b>Bid</b><br><span class="ov2-flow-side-sub">מוכר אגרסיבי</span></td>
                    <td><b>${bidTr}</b> <span class="ov2-flow-side-pct">(${bidTrPct}%)</span></td>
                    <td><b>${fmtP(bidP)}</b> <span class="ov2-flow-side-pct">(${bidPremPct}%)</span></td>
                    <td><span class="ov2-flow-side-avg">${fmtP(bidAvg)}</span></td>
                    <td><span class="ov2-flow-side-dte">${dteFmt(bidDte)}</span></td>
                </tr>
                <tr class="ov2-flow-side-mid">
                    <td><b>Mid</b><br><span class="ov2-flow-side-sub">ניטרלי</span></td>
                    <td><b>${midTr}</b></td>
                    <td><b>${fmtP(midP)}</b></td>
                    <td><span class="ov2-flow-side-avg">${fmtP(midAvg)}</span></td>
                    <td><span class="ov2-flow-side-dte">${dteFmt(midDte)}</span></td>
                </tr>
            </tbody>
            <tfoot>
                <tr>
                    <td colspan="5" class="ov2-flow-side-foot">
                        <span class="ov2-flow-side-signal">Ask על directional:</span>
                        <span>עסקאות <b>${askTrPctR}%</b></span>
                        <span>·</span>
                        <span>פרמיה <b>${askPremPctR}%</b></span>
                    </td>
                </tr>
                ${sizeNote ? `<tr><td colspan="5" class="ov2-flow-side-size-note">${sizeNote}</td></tr>` : ''}
            </tfoot>
        </table>`;
    };

    const callTable = buildSideTable('Calls',
        raw.callTr, raw.callP,
        raw.callAsk, raw.callBid, raw.callMid,
        raw.callAskP, raw.callBidP, raw.callMidP,
        raw.callAskPct, raw.callAskPremPct,
        raw.callAskDte, raw.callBidDte, raw.callMidDte);
    const putTable = buildSideTable('Puts',
        raw.putTr, raw.putP,
        raw.putAsk, raw.putBid, raw.putMid,
        raw.putAskP, raw.putBidP, raw.putMidP,
        raw.putAskPct, raw.putAskPremPct,
        raw.putAskDte, raw.putBidDte, raw.putMidDte);

    setEl('flowCallSummary', `${raw.callTr} עסקאות · ${fmtP(raw.callP)} · ממוצע ${raw.callAvgDte != null ? raw.callAvgDte + ' ימים עד פקיעה' : 'DTE לא ידוע'}`);
    setEl('flowPutSummary',  `${raw.putTr} עסקאות · ${fmtP(raw.putP)} · ממוצע ${raw.putAvgDte != null ? raw.putAvgDte + ' ימים עד פקיעה' : 'DTE לא ידוע'}`);
    const callTableEl = $('flowCallTable'); if (callTableEl) callTableEl.innerHTML = callTable;
    const putTableEl  = $('flowPutTable');  if (putTableEl)  putTableEl.innerHTML  = putTable;

    // ─── DTE Summary: Calls vs Puts time-horizon interpretation ───
    const dteSummaryEl = $('flowDteSummary');
    if (dteSummaryEl) {
        const cDte = raw.callAvgDte, pDte = raw.putAvgDte;
        let dteSummaryHtml = '';
        if (cDte != null && pDte != null) {
            const labelDte = d => {
                if (d <= 7)  return 'קצר (≤שבוע)';
                if (d <= 30) return 'בינוני (≤חודש)';
                if (d <= 90) return 'בינוני-ארוך (1-3 חודשים)';
                if (d <= 180) return 'ארוך (3-6 חודשים)';
                return 'ארוך מאוד (חצי שנה+)';
            };
            let comparison = '';
            const diff = cDte - pDte;
            if (Math.abs(diff) <= 5) {
                comparison = 'טווחי הזמן דומים — קונים calls ו-puts לאותו טווח';
            } else if (diff > 5) {
                comparison = `Calls לטווח ארוך יותר ב-${diff} ימים — פוזיציות שורי אסטרטגיות, hedging puts קצר-טווח`;
            } else {
                comparison = `Puts לטווח ארוך יותר ב-${-diff} ימים — הגנה אסטרטגית, calls קצרי-טווח (scalp/momentum)`;
            }
            // ─── Distribution visualization ───
            const buildDistBar = (buckets, totalP) => {
                if (!totalP) return '';
                const pcts = {};
                let dominantBucket = null, dominantPct = 0;
                for (const b of raw.dteBuckets) {
                    pcts[b] = totalP > 0 ? buckets[b] / totalP * 100 : 0;
                    if (pcts[b] > dominantPct) { dominantPct = pcts[b]; dominantBucket = b; }
                }
                const seg = b => {
                    const p = pcts[b];
                    if (p < 1) return ''; // skip near-zero
                    const cls = 'bucket-' + b.replace('+', 'plus').replace(/-/g, '_');
                    const showLabel = p >= 8;  // only show % if segment wide enough
                    return `<div class="ov2-dte-bucket ${cls}" style="width:${p.toFixed(1)}%"
                                 data-tooltip="${b}: ${fmtP(buckets[b])} (${Math.round(p)}% מהפרמיה)">
                                ${showLabel ? `<span class="ov2-dte-bucket-pct">${Math.round(p)}%</span>` : ''}
                            </div>`;
                };
                return {
                    html: `<div class="ov2-dte-stack">${raw.dteBuckets.map(seg).join('')}</div>`,
                    dominantBucket,
                    dominantPct: Math.round(dominantPct)
                };
            };

            const callDist = buildDistBar(raw.callDtePremByBucket, raw.callP);
            const putDist  = buildDistBar(raw.putDtePremByBucket,  raw.putP);

            // ─── Concentration interpretation ───
            const concentrationLabel = (dom, pct) => {
                if (pct >= 60) return `מרוכזים מאוד ב-${dom} (${pct}%)`;
                if (pct >= 40) return `מובלים ע"י ${dom} (${pct}%)`;
                if (pct >= 25) return `דומיננטי: ${dom} (${pct}%)`;
                return `מפוזרים על פני הטווחים`;
            };

            const bucketMeaning = b => ({
                '0-7d':    'scalp / 0DTE / hedging קצר',
                '8-30d':   'משחקי כיוון קצרי-טווח',
                '31-90d':  'פוזיציות אסטרטגיות בינוניות',
                '91-180d': 'מיצוב ארוך-טווח',
                '180+d':   'LEAPS · אורך טווח'
            }[b] || '');

            let distInterp = '';
            if (callDist.dominantBucket && putDist.dominantBucket) {
                distInterp = `Calls ${concentrationLabel(callDist.dominantBucket, callDist.dominantPct)} — ${bucketMeaning(callDist.dominantBucket)}. ` +
                             `Puts ${concentrationLabel(putDist.dominantBucket, putDist.dominantPct)} — ${bucketMeaning(putDist.dominantBucket)}.`;
            }

            const distHtml = (callDist.html || putDist.html) ? `
                <div class="ov2-flow-dte-dist">
                    <div class="ov2-eyebrow" style="margin-bottom:8px;">התפלגות פרמיה לפי טווח</div>
                    <div class="ov2-flow-dte-dist-row">
                        <span class="ov2-flow-dte-dist-label">Calls</span>
                        ${callDist.html || '<span class="ov2-flow-side-sub">אין נתון</span>'}
                    </div>
                    <div class="ov2-flow-dte-dist-row">
                        <span class="ov2-flow-dte-dist-label">Puts</span>
                        ${putDist.html || '<span class="ov2-flow-side-sub">אין נתון</span>'}
                    </div>
                    <div class="ov2-flow-dte-dist-legend">
                        <span class="ov2-dte-legend bucket-0_7d">0-7d</span>
                        <span class="ov2-dte-legend bucket-8_30d">8-30d</span>
                        <span class="ov2-dte-legend bucket-31_90d">31-90d</span>
                        <span class="ov2-dte-legend bucket-91_180d">91-180d</span>
                        <span class="ov2-dte-legend bucket-180plusd">180+d</span>
                    </div>
                    ${distInterp ? `<div class="ov2-flow-dte-interp" style="margin-top:8px;">${distInterp}</div>` : ''}
                </div>` : '';

            dteSummaryHtml = `
                <div class="ov2-flow-dte-summary">
                    <div class="ov2-eyebrow">טווחי הזמן הממוצעים (משוקלל לפי פרמיה)</div>
                    <div class="ov2-flow-dte-row">
                        <div class="ov2-flow-dte-cell"><span class="ov2-flow-dte-label">Calls</span><span class="ov2-flow-dte-value">${cDte} ימים</span><span class="ov2-flow-dte-sub">${labelDte(cDte)}</span></div>
                        <div class="ov2-flow-dte-cell"><span class="ov2-flow-dte-label">Puts</span><span class="ov2-flow-dte-value">${pDte} ימים</span><span class="ov2-flow-dte-sub">${labelDte(pDte)}</span></div>
                    </div>
                    <div class="ov2-flow-dte-interp">${comparison}</div>
                    ${distHtml}
                </div>`;
        }
        dteSummaryEl.innerHTML = dteSummaryHtml;
    }

    // ─── Aggressive direction interpretation ───
    //
    // Single source of truth: directional premium share (Mid excluded).
    // call$ vs put$ tells us where aggressive money is going. Same
    // classifier the Flow Score and 7-day pattern badges use.
    const cAskPm = raw.callAskPremPct;
    const pAskPm = raw.putAskPremPct;
    const cAskTr = raw.callAskPct;
    const pAskTr = raw.putAskPct;
    const callDirP = (raw.callAskP || 0) + (raw.callBidP || 0);
    const putDirP  = (raw.putAskP  || 0) + (raw.putBidP  || 0);
    const pattern = classifyByScore(score, raw);

    let headline = '', meaning = '';
    if (pattern.id === 'unknown') {
        headline = 'אין מספיק עסקאות directional לקריאה ברורה';
    } else {
        const cShare = pattern.callShare;
        const pShare = Math.round((100 - cShare) * 10) / 10;
        const callDirM = Math.round(callDirP / 1e6);
        const putDirM  = Math.round(putDirP  / 1e6);
        if (pattern.id === 'bullish_strong') {
            headline = `${pattern.emoji} ${pattern.label} (${cShare}% calls)`;
            meaning = `הכסף הגדול שופך ל-calls — $${callDirM}M directional ב-calls מול $${putDirM}M ב-puts. ביטחון בעלייה.`;
        } else if (pattern.id === 'bullish_mild') {
            headline = `${pattern.emoji} ${pattern.label} (${cShare}% calls)`;
            meaning = `יותר כסף ל-calls מאשר ל-puts — $${callDirM}M מול $${putDirM}M. נטייה לעלייה.`;
        } else if (pattern.id === 'balanced') {
            headline = `${pattern.emoji} ${pattern.label} (${cShare}% / ${pShare}%)`;
            meaning = `הפרמיה ה-directional חצויה כמעט שווה — $${callDirM}M calls מול $${putDirM}M puts. ללא כיוון ברור.`;
        } else if (pattern.id === 'bearish_mild') {
            headline = `${pattern.emoji} ${pattern.label} (${pShare}% puts)`;
            meaning = `יותר כסף ל-puts מאשר ל-calls — $${putDirM}M מול $${callDirM}M. נטייה לזהירות.`;
        } else if (pattern.id === 'bearish_strong') {
            headline = `${pattern.emoji} ${pattern.label} (${pShare}% puts)`;
            meaning = `הכסף הגדול שופך ל-puts — $${putDirM}M directional ב-puts מול $${callDirM}M ב-calls. חששות אגרסיביים או הגנה כבדה.`;
        }
    }

    // ── Evidence table (Hebrew-leading, no inline mixing) ──
    let evidenceHtml = '';
    if (cAskPm != null && pAskPm != null) {
        evidenceHtml = `
            <table class="ov2-flow-evidence-table">
                <thead>
                    <tr>
                        <th></th>
                        <th>Ask (קונה)</th>
                        <th>Bid (מוכר)</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><b>Calls</b></td>
                        <td>${Math.round(cAskPm)}% פרמיה</td>
                        <td>${Math.round(100 - cAskPm)}% פרמיה</td>
                    </tr>
                    <tr>
                        <td><b>Puts</b></td>
                        <td>${Math.round(pAskPm)}% פרמיה</td>
                        <td>${Math.round(100 - pAskPm)}% פרמיה</td>
                    </tr>
                </tbody>
            </table>`;
    }

    // ── Divergence — explain clearly (crowd vs smart money) ──
    // Distinguish between:
    //   DIRECTION divergence: trade-count side ≠ premium side (e.g. trades buying, premium selling)
    //   INTENSITY divergence: same side, but big money much more aggressive
    const divergences = [];
    const buildDivergence = (typeName, tr, pm) => {
        const crowdBuying = tr > 50;
        const moneyBuying = pm > 50;
        const sameSide = crowdBuying === moneyBuying;
        if (sameSide) {
            const side = crowdBuying ? 'קונים' : 'מוכרים';
            // Note: pm percentage of Ask. So crowd Ask% vs money Ask% — same direction but different magnitude
            const moneyIntensity = crowdBuying ? Math.round(pm) : Math.round(100 - pm);
            const crowdIntensity = crowdBuying ? Math.round(tr) : Math.round(100 - tr);
            return {
                title: `ב-${typeName} — אותו כיוון, עוצמה שונה`,
                body:  `<b>שניהם ${side}</b>, אבל הכסף הגדול אגרסיבי הרבה יותר: <b>${crowdIntensity}% מהעסקאות</b> מול <b>${moneyIntensity}% מהפרמיה</b>.`,
                sub:   `כשפער כזה קיים, סביר שמעט עסקאות מוסדיות גדולות (Ask גדול או Bid גדול) מטות את התמונה הכספית. סימן לפעולה מוסדית ממוקדת.`
            };
        } else {
            const crowdSide = crowdBuying ? 'קונה' : 'מוכר';
            const moneySide = moneyBuying ? 'קונה' : 'מוכר';
            return {
                title: `ב-${typeName} — כיוונים הפוכים`,
                body:  `<b>הציבור ${crowdSide}</b> (${Math.round(tr)}% מהעסקאות) אבל <b>הכסף הגדול ${moneySide}</b> (${Math.round(pm)}% מהפרמיה).`,
                sub:   `הרבה סוחרים קטנים (הציבור) בכיוון אחד, מעט מוסדיים גדולים בכיוון ההפוך. היסטורית — המוסדיים נוטים להיות צודקים.`
            };
        }
    };
    if (cAskTr != null && cAskPm != null && Math.abs(cAskPm - cAskTr) >= 15) {
        divergences.push(buildDivergence('קאלים', cAskTr, cAskPm));
    }
    if (pAskTr != null && pAskPm != null && Math.abs(pAskPm - pAskTr) >= 15) {
        divergences.push(buildDivergence('puts', pAskTr, pAskPm));
    }

    // Render as structured multi-line HTML — Hebrew-friendly, no inline LTR/RTL mixing
    const interpHtml = `
        <div class="ov2-flow-agg-headline">${headline}</div>
        <div class="ov2-flow-agg-meaning">${meaning}</div>
        ${evidenceHtml}
        ${divergences.length ? `<div class="ov2-flow-agg-divergence-head">⚠ אי-התאמה בין הציבור לכסף הגדול:</div>
            ${divergences.map(d => `
                <div class="ov2-flow-agg-divergence">
                    <div class="ov2-flow-agg-div-title">${d.title}</div>
                    <div class="ov2-flow-agg-div-body">${d.body}</div>
                    ${d.sub ? `<div class="ov2-flow-agg-div-sub">${d.sub}</div>` : ''}
                </div>
            `).join('')}` : ''}
    `;
    setHTML('flowAggInterp', interpHtml);

    // ─── Trade Quality (codes + ToOpen) ───
    renderFlowQuality(raw);

    // ─── Historical Context (today vs 22d) ───
    renderFlowHistory(raw, score, allDays);

    // ─── NEW: Score formula breakdown ───
    const t = metrics.techScore, b = metrics.breadthScore, fScore = f.score, combined = metrics.combined;
    const breakdown = $('flowFormulaCombined');
    if (breakdown) {
        breakdown.innerHTML = `
            <b>הציון המשולב (${combined != null ? combined : '—'})</b> =
            40% × Tech (${t != null ? t : '—'}) +
            35% × Flow (${fScore != null ? fScore : '—'}) +
            25% × Breadth (${b != null ? b : '—'})
        `;
    }

    // Flow internal formula — directional (Mid excluded as of 2026-06-03).
    // Component A used to be call_premium_pct (overall premium, included
    // Mid). On block-heavy days that read as misleadingly bullish — see
    // computeFlowAnalytics scoreFromMetrics comment. Now A uses only
    // directional premium (Ask + Bid).
    const flowFormula = $('flowFormulaInternal');
    if (flowFormula) {
        // Recompute A_directional locally for display
        const dCall = (raw.callAskP || 0) + (raw.callBidP || 0);
        const dPut  = (raw.putAskP  || 0) + (raw.putBidP  || 0);
        const dTot  = dCall + dPut;
        const A = dTot > 0 ? (dCall / dTot) * 100 : null;
        const B = raw.callAskPremPct;
        const C = raw.putAskPremPct;
        const A_absolute = raw.call_premium_pct;
        const fmtPct = v => v != null && Number.isFinite(v)
                            ? v.toFixed(1) + '%' : '—';
        // Contributions matching the formula in computeFlowAnalytics
        const contribA = A != null ? (A - 50) * 1.0 : 0;
        const contribB = B != null ? (B - 50) * 0.5 : 0;
        const contribC = C != null ? -(C - 50) * 0.5 : 0;
        const fmtContrib = v => (v >= 0 ? '+' : '') + v.toFixed(1);
        const midNote = f.midPct >= 70
            ? `<div style="margin-top:6px;font-size:11px;color:#b45309;background:rgba(245,158,11,0.10);padding:6px 10px;border-radius:4px;border-right:3px solid #f59e0b;">⚠ <b>${f.midPct.toFixed(0)}% מהפרמיה ב-Mid</b> — דילרים/בלוקים דומיננטיים, רק ${(100-f.midPct).toFixed(0)}% directional. הציון המתוקן (${f.score}) משקף את ה-directional בלבד; הציון "אבסולוטי" הישן (${f.scoreAbsolute}) היה ${f.scoreAbsolute - f.score >= 0 ? 'גבוה יותר ב-' + (f.scoreAbsolute - f.score) + ' נקודות' : 'נמוך יותר ב-' + (f.score - f.scoreAbsolute) + ' נקודות'} כי הוא כלל את ה-Mid.</div>`
            : '';
        flowFormula.innerHTML = `
            ציון Flow מתחיל מ-50 ומתעדכן לפי שלושה רכיבי flow גולמיים של היום (ללא baseline היסטורי):<br>
            <b>+ A — אחוז קולים בעסקאות directional</b> (Ask+Bid בלבד, ללא Mid) ((${fmtPct(A)} − 50) × 1.0 = ${fmtContrib(contribA)})
            <b>+ B — Ask% מתוך קולים directional</b> ((${fmtPct(B)} − 50) × 0.5 = ${fmtContrib(contribB)})
            <b>− C — Ask% מתוך פוטים directional</b> ((${fmtPct(C)} − 50) × 0.5 → ${fmtContrib(contribC)})
            <br>50 ${fmtContrib(contribA)} ${fmtContrib(contribB)} ${fmtContrib(contribC)} = <b>${fScore != null ? fScore : '—'}/100</b>
            <div style="margin-top:8px;font-size:11px;color:var(--ov2-text-3);">
                להשוואה: ציון "אבסולוטי" (גרסה ישנה, A על-בסיס כל הפרמיה כולל Mid) = <b>${f.scoreAbsolute != null ? f.scoreAbsolute : '—'}/100</b>.
                A_absolute = ${fmtPct(A_absolute)}.
            </div>
            ${midNote}
        `;
    }
}

function setEl(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
}

function setHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
}

// ═════════════════════════════════════════════════════════════════════
// MARKET × FLOW SYNERGY · cross-analysis of Phase + Flow
// Produces a "flow lean" score (-100 bearish to +100 bullish), compares
// it to what's expected for the current phase, and generates a
// cross-signal narrative.
// ═════════════════════════════════════════════════════════════════════

// Compute a single bullishness lean score from multiple flow signals.
// Range: -100 (very bearish) to +100 (very bullish), 0 = neutral.
function computeFlowLean(metrics) {
    const f = metrics.flow;
    if (!f || !f.raw) return null;
    const raw = f.raw;
    const opens = raw.opens;
    let lean = 0;
    let totalWeight = 0;
    const clampL = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // Component 1 · Flow score deviation from 50 (35% weight)
    if (f.score != null) {
        const flowScoreLean = clampL((f.score - 50) * 2, -100, 100);
        lean += flowScoreLean * 0.35;
        totalWeight += 0.35;
    }
    // Component 2 · ToOpen direction by premium (25%)
    if (opens) {
        const bullP = (opens.callBuyP || 0) + (opens.putSellP || 0);
        const bearP = (opens.callSellP || 0) + (opens.putBuyP || 0);
        if (bullP + bearP > 0) {
            const openLean = clampL(((bullP - bearP) / (bullP + bearP)) * 100, -100, 100);
            lean += openLean * 0.25;
            totalWeight += 0.25;
        }
    }
    // Component 3 · Ask% premium on calls (15%) — high = aggressive buying calls = bullish
    if (raw.callAskPremPct != null) {
        const callLean = clampL((raw.callAskPremPct - 50) * 2, -100, 100);
        lean += callLean * 0.15;
        totalWeight += 0.15;
    }
    // Component 4 · Ask% premium on puts (15%) — high = aggressive buying puts = bearish (inverted)
    if (raw.putAskPremPct != null) {
        const putLean = -1 * clampL((raw.putAskPremPct - 50) * 2, -100, 100);
        lean += putLean * 0.15;
        totalWeight += 0.15;
    }
    // Component 5 · DTE asymmetry (10%) — calls longer than puts = bullish (strategic vs hedge)
    if (raw.callAvgDte != null && raw.putAvgDte != null) {
        const dteDiff = raw.callAvgDte - raw.putAvgDte;
        const dteLean = clampL(dteDiff * 1.5, -50, 50);  // ±33d = ±50 lean
        lean += dteLean * 0.10;
        totalWeight += 0.10;
    }

    if (totalWeight === 0) return null;
    // Normalize so partial-data days still produce a score on the same scale
    return Math.round(lean / totalWeight);
}

// Compare flow lean to phase expectations and produce alignment classification.
function classifyPhaseFlowAlignment(phaseId, flowLean) {
    if (flowLean == null) return { level: 'unknown', label: 'אין נתון', emoji: '—' };

    // Each phase has an EXPECTED flow lean range.
    // Inside range = CONFIRM. Outside = divergence (above = bullish surprise, below = bearish surprise).
    const expectations = {
        confirmed_uptrend:   { min:  25, max: 100, desc: 'מגמה חיובית דורשת flow תומך' },
        uptrend_pressure:    { min: -15, max:  35, desc: 'בלימבו — flow מאוזן עד מעט שורי' },
        distribution:        { min: -50, max:  10, desc: 'הפצה דורשת flow מתון עד שלילי' },
        correction:          { min: -100, max: -10, desc: 'תיקון דורש flow שלילי' },
        capitulation:        { min: -100, max: -30, desc: 'משבר דורש flow שלילי קיצוני' },
        base_building:       { min: -25, max:  35, desc: 'התאוששות דורשת flow מתון משופר' },
        thrust:              { min:  30, max: 100, desc: 'פריצה דורשת flow חיובי חזק' }
    };
    const range = expectations[phaseId];
    if (!range) return { level: 'unknown', label: 'אין הגדרה לשלב', emoji: '—' };

    if (flowLean >= range.min && flowLean <= range.max) {
        return { level: 'confirm', label: 'מאשר', emoji: '✓', desc: range.desc };
    }
    if (flowLean > range.max) {
        return {
            level: 'bullish_div',
            label: 'flow חיובי מהצפוי',
            emoji: '↗',
            desc: `flow lean ${flowLean} מעל הטווח הצפוי (${range.min}..${range.max}) — אולי שלב משתפר`
        };
    }
    return {
        level: 'bearish_div',
        label: 'flow שלילי מהצפוי',
        emoji: '↘',
        desc: `flow lean ${flowLean} מתחת לטווח הצפוי (${range.min}..${range.max}) — אולי שלב מתדרדר`
    };
}

// Generate cross-signal bullet points (what's notable in the combination).
function generateCrossSignals(phase, metrics, flowLean) {
    const signals = [];
    const f = metrics.flow;
    if (!f || !f.raw) return signals;
    const raw = f.raw;
    const opens = raw.opens || {};
    const phaseId = phase.phase.id;

    // 1. DTE asymmetry signal
    if (raw.callAvgDte != null && raw.putAvgDte != null) {
        const diff = raw.callAvgDte - raw.putAvgDte;
        if (diff >= 20) {
            signals.push({ icon: '✓', tone: 'pos', text: `Calls אסטרטגיים (${raw.callAvgDte}d) vs Puts קצרים (${raw.putAvgDte}d) — מוסדיים נערכים לעלייה ארוכת-טווח` });
        } else if (diff <= -20) {
            signals.push({ icon: '⚠', tone: 'neg', text: `Puts אסטרטגיים (${raw.putAvgDte}d) vs Calls קצרים (${raw.callAvgDte}d) — הגנה ארוכת-טווח, calls רק לscalping` });
        }
    }

    // 2. ToOpen conviction by premium
    const bullP = (opens.callBuyP || 0) + (opens.putSellP || 0);
    const bearP = (opens.callSellP || 0) + (opens.putBuyP || 0);
    if (bullP + bearP > 0) {
        const bullPct = Math.round(bullP / (bullP + bearP) * 100);
        if (bullPct >= 75) {
            signals.push({ icon: '✓', tone: 'pos', text: `Conviction שורי חזק בפותחות (${bullPct}% לפי פרמיה) — מוסדיים מסתדרים לכיוון עליה` });
        } else if (bullPct <= 25) {
            signals.push({ icon: '⚠', tone: 'neg', text: `Conviction דובי חזק בפותחות (${100-bullPct}% לפי פרמיה) — מוסדיים נערכים לירידה` });
        }
    }

    // 3. Direction divergence (crowd vs money)
    if (raw.callAskPct != null && raw.callAskPremPct != null) {
        const trDir = raw.callAskPct > 50;
        const pmDir = raw.callAskPremPct > 50;
        if (trDir !== pmDir) {
            signals.push({ icon: '⚠', tone: 'neg', text: `סטייה בקאלים: הציבור ${trDir ? 'קונה' : 'מוכר'} (${Math.round(raw.callAskPct)}%), הכסף הגדול ${pmDir ? 'קונה' : 'מוכר'} (${Math.round(raw.callAskPremPct)}% פרמיה)` });
        }
    }
    if (raw.putAskPct != null && raw.putAskPremPct != null) {
        const trDir = raw.putAskPct > 50;
        const pmDir = raw.putAskPremPct > 50;
        if (trDir !== pmDir) {
            signals.push({ icon: '⚠', tone: 'neg', text: `סטייה ב-puts: הציבור ${trDir ? 'קונה' : 'מוכר'} (${Math.round(raw.putAskPct)}%), הכסף הגדול ${pmDir ? 'קונה' : 'מוכר'} (${Math.round(raw.putAskPremPct)}% פרמיה)` });
        }
    }

    // 4. VIX vs flow lean
    if (metrics.vix && flowLean != null) {
        if (metrics.vix < 15 && flowLean < -20) {
            signals.push({ icon: '⚠', tone: 'neg', text: `VIX נמוך (${metrics.vix.toFixed(1)}) אבל flow lean שלילי (${flowLean}) — שאננות בשוק בזמן שהכסף הגדול נערך לרע` });
        } else if (metrics.vix > 22 && flowLean > 20) {
            signals.push({ icon: '↗', tone: 'pos', text: `VIX מוגבר (${metrics.vix.toFixed(1)}) אבל flow lean חיובי (${flowLean}) — פחד בקהל, הזדמנות אצל המוסדיים` });
        }
    }

    // 5. Phase-specific signals
    if (phaseId === 'uptrend_pressure') {
        if (flowLean >= 30) {
            signals.push({ icon: '↗', tone: 'pos', text: `Flow lean +${flowLean} חזק מהממוצע ל-❷ — סימן ל-transition אפשרי ל-❶` });
        } else if (flowLean <= -15) {
            signals.push({ icon: '⚠', tone: 'neg', text: `Flow lean ${flowLean} חלש מהממוצע ל-❷ — סיכון transition ל-❸` });
        }
    } else if (phaseId === 'confirmed_uptrend' && flowLean < 0) {
        signals.push({ icon: '⚠⚠', tone: 'neg', text: `❶ פעיל אבל flow שלילי (${flowLean}) — distribution אולי מתחיל מתחת לפני השטח` });
    } else if (phaseId === 'distribution' && flowLean > 0) {
        signals.push({ icon: '↗', tone: 'pos', text: `❸ פעיל אבל flow חיובי (+${flowLean}) — distribution אולי לא אמיתי` });
    } else if (phaseId === 'correction' && flowLean > 10) {
        signals.push({ icon: '↗', tone: 'pos', text: `❹ פעיל אבל flow חיובי (+${flowLean}) — מוסדיים קונים בירידה, סימן לתחתית אפשרית` });
    }

    return signals;
}

// Build the final narrative — one short paragraph synthesizing it all.
function buildSynergyNarrative(phase, alignment, flowLean, metrics) {
    const p = phase.phase;
    const f = metrics.flow;
    if (!f || flowLean == null) return 'אין מספיק נתוני flow לקישור ל-phase.';

    // Base statement per alignment level
    const phaseLabel = p.labelHe;
    const flowDescriptor =
        flowLean >= 50  ? 'flow חיובי חזק' :
        flowLean >= 20  ? 'flow חיובי מתון' :
        flowLean >= -20 ? 'flow מאוזן' :
        flowLean >= -50 ? 'flow שלילי מתון' :
                          'flow שלילי חזק';

    let story = `השוק במצב <b>${phaseLabel}</b> · ${flowDescriptor} (lean ${flowLean >= 0 ? '+' : ''}${flowLean}). `;

    if (alignment.level === 'confirm') {
        story += `ה-flow תואם לציפיות של הפאזה — שני הסיפורים מספרים אותו דבר.`;
    } else if (alignment.level === 'bullish_div') {
        story += `<b>הכסף הגדול יותר אופטימי מהפאזה</b> — סימן שהשלב הנוכחי עלול להתחזק או לעבור לשלב גבוה יותר.`;
    } else if (alignment.level === 'bearish_div') {
        story += `<b>הכסף הגדול יותר זהיר מהפאזה</b> — סימן אזהרה שמתחת לפני השטח הולך ומחליש.`;
    }

    return story;
}

// Main entry point — called from renderFlowCard / init
function analyzeMarketFlow(phase, metrics) {
    // flowLean is kept only as input to generateCrossSignals (Q2 items);
    // alignment + headlines are derived from the premium classifier so
    // every panel on the page tells the same sentiment story.
    const flowLean = computeFlowLean(metrics);

    const raw = metrics.flow && metrics.flow.raw;
    const fScore = metrics.flow && metrics.flow.score;
    const flowSentiment = raw ? classifyFlowPattern(raw, fScore) : { id: 'unknown', label: 'לא ידוע' };
    const phaseId = phase.phase.id;
    const isBullishPhase = ['confirmed_uptrend','uptrend_pressure','thrust'].includes(phaseId);
    const isBearishPhase = ['correction','capitulation','distribution'].includes(phaseId);
    const flowBullish = flowSentiment.id === 'bullish_strong' || flowSentiment.id === 'bullish_mild';
    const flowBearish = flowSentiment.id === 'bearish_strong' || flowSentiment.id === 'bearish_mild';
    const flowBalanced = flowSentiment.id === 'balanced';

    // Alignment from premium sentiment vs phase direction
    let alignment;
    if (flowSentiment.id === 'unknown') {
        alignment = { level: 'unknown', label: 'אין נתון', emoji: '—', desc: 'אין מספיק נתוני זרימה', flowSentiment };
    } else if (isBullishPhase && flowBullish) {
        alignment = { level: 'confirm', label: 'תואם', emoji: '✓', desc: `פאזה שורית + flow ${flowSentiment.label}`, flowSentiment };
    } else if (isBearishPhase && flowBearish) {
        alignment = { level: 'confirm', label: 'תואם', emoji: '✓', desc: `פאזה דובית + flow ${flowSentiment.label}`, flowSentiment };
    } else if (isBullishPhase && flowBearish) {
        alignment = { level: 'bearish_div', label: 'סטייה דובית', emoji: '↘', desc: `פאזה שורית מול flow ${flowSentiment.label}`, flowSentiment };
    } else if (isBearishPhase && flowBullish) {
        alignment = { level: 'bullish_div', label: 'סטייה שורית', emoji: '↗', desc: `פאזה דובית מול flow ${flowSentiment.label}`, flowSentiment };
    } else if (flowBalanced) {
        alignment = { level: isBullishPhase || isBearishPhase ? 'neutral_div' : 'confirm', label: 'מאוזן', emoji: '⚖️', desc: `flow מאוזן (${flowSentiment.callShare}%)`, flowSentiment };
    } else {
        alignment = { level: 'confirm', label: 'תואם', emoji: '✓', desc: `flow ${flowSentiment.label}`, flowSentiment };
    }

    const signals = generateCrossSignals(phase, metrics, flowLean);
    const narrative = buildSynergyNarrative(phase, alignment, flowLean, metrics);
    return { flowLean, alignment, signals, narrative, flowSentiment };
}

// ─── Unified sentiment classifier — derives from Flow Score ───
//
// Single source of truth for sentiment across the whole page. Maps the
// (already directional, premium-based) Flow Score to a 5-level label.
// Used by:
//   1. Flow Score's status text (Risk-On / nautral / defensive...)
//   2. 7-day pattern badges
//   3. Aggressive-direction headline inside the Flow card
//   4. Synergy panel headline + Q1 answer
//
// Bands chosen so the labels match what people expect from a 0-100
// score: the midpoint ±10 is "balanced", and "strong" only kicks in
// past ±30 from 50.
function classifyByScore(score, raw) {
    if (score == null) return { id: 'unknown', label: 'לא ידוע', tone: 'muted', emoji: '—' };
    let id, label, tone, emoji;
    if      (score >= 80) { id = 'bullish_strong'; label = 'שורי חזק';   tone = 'pos';  emoji = '💪'; }
    else if (score >= 60) { id = 'bullish_mild';   label = 'שורי מתון';  tone = 'pos';  emoji = '📈'; }
    else if (score >= 40) { id = 'balanced';       label = 'מאוזן';      tone = 'warn'; emoji = '⚖️'; }
    else if (score >= 20) { id = 'bearish_mild';   label = 'באריש מתון'; tone = 'warn'; emoji = '📉'; }
    else                   { id = 'bearish_strong'; label = 'באריש חזק'; tone = 'neg';  emoji = '🔻'; }

    // Attach the headline directional read for callers that want to quote it.
    let callShare = null;
    if (raw) {
        const callDir = (raw.callAskP || 0) + (raw.callBidP || 0);
        const putDir  = (raw.putAskP  || 0) + (raw.putBidP  || 0);
        const tot = callDir + putDir;
        if (tot > 0) callShare = Math.round((callDir / tot) * 1000) / 10;
    }
    return { id, label, tone, emoji, callShare };
}

// Convenience: classify by Flow Score (callers always have it computed).
function classifyFlowPattern(raw, score) {
    if (!raw || score == null) return { id: 'unknown', label: 'לא ידוע' };
    return classifyByScore(score, raw);
}

// ═════════════════════════════════════════════════════════════════════
// FLOW QUALITY — Trade venue (codes) + opening-position conviction (ToOpen)
// Helper called from renderFlowCard
// ═════════════════════════════════════════════════════════════════════
function renderFlowQuality(raw) {
    if (!raw) return;

    const fmtP = v => {
        if (v == null || v === 0) return '$0';
        if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
        if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M';
        return '$' + Math.round(v).toLocaleString();
    };

    // ── Code/venue breakdown ──
    const codes = raw.codeGroups || {};
    const totP = raw.totP || 1;

    const codeMeta = {
        cbmo:       { label: 'CBOE',        sub: 'CBMO · בורסה ראשית' },
        floor:      { label: 'רצפה',         sub: 'MFSL + SLFT · מוסדי, ברוקר' },
        electronic: { label: 'אלקטרוני',     sub: 'MLET + AUTO · שוק רחב, אלגו' },
        iso:        { label: 'ISO Sweep ⚡', sub: 'ISOI · אגרסיבי multi-venue' },
        other:      { label: 'אחר',          sub: 'EXHT / MESL / ISOI אחר' }
    };
    const codeOrder = ['iso', 'floor', 'cbmo', 'electronic', 'other'];

    const codeRows = codeOrder
        .filter(k => codes[k] && (codes[k].trades > 0 || codes[k].premium > 0))
        .map(k => {
            const d = codes[k];
            const meta = codeMeta[k];
            const pct = totP > 0 ? d.premium / totP * 100 : 0;
            const isISO = k === 'iso';
            return `<tr class="${isISO ? 'ov2-flow-quality-iso' : ''}">
                <td><b>${meta.label}</b><br><span class="ov2-flow-side-sub">${meta.sub}</span></td>
                <td>${d.trades}</td>
                <td>${fmtP(d.premium)}<br><span class="ov2-flow-side-pct">${Math.round(pct)}% מהכסף</span></td>
            </tr>`;
        }).join('');

    const codeTable = `
        <table class="ov2-flow-side-table">
            <thead><tr><th>בורסה / סוג</th><th>עסקאות</th><th>פרמיה</th></tr></thead>
            <tbody>${codeRows}</tbody>
        </table>`;
    setHTML('flowQualityCodes', codeTable);

    // ── ISO note (high conviction signal) ──
    const iso = codes.iso || { trades: 0, premium: 0 };
    let isoNote = '';
    if (iso.trades > 0) {
        const pct = totP > 0 ? iso.premium / totP * 100 : 0;
        isoNote = `⚡ <b>${iso.trades} ISO Sweeps</b> זוהו (${fmtP(iso.premium)} · ${pct.toFixed(1)}% מהפרמיה היומית) — orders אגרסיביים שסורקים כמה בורסות בו-זמנית. <b>סיגנל conviction חזק</b>.`;
    } else {
        isoNote = `אין ISO sweeps היום — אין conviction trades אגרסיביים במיוחד.`;
    }
    setHTML('flowQualityIsoNote', isoNote);

    // ── ToOpen breakdown ──
    const o = raw.opens || {};
    const totalOpens = o.total || 0;
    const totalAll = raw.totTr || 1;
    const openPct = totalAll > 0 ? totalOpens / totalAll * 100 : 0;

    const directional = (o.callBuy || 0) + (o.callSell || 0) + (o.putBuy || 0) + (o.putSell || 0);
    const generic = (o.callGeneric || 0) + (o.putGeneric || 0);
    // Premium-weighted conviction (NEW · user feedback: count alone misleading)
    const callBuyP_ = o.callBuyP || 0;
    const callSellP_ = o.callSellP || 0;
    const putBuyP_ = o.putBuyP || 0;
    const putSellP_ = o.putSellP || 0;
    const bullishP = callBuyP_ + putSellP_;   // buy calls + write puts = bullish $
    const bearishP = callSellP_ + putBuyP_;   // write calls + buy puts = bearish $
    const directionalP = bullishP + bearishP;

    const openTable = `
        <table class="ov2-flow-side-table">
            <thead><tr>
                <th></th>
                <th>Buy-To-Open<br><span class="ov2-flow-side-sub">פתיחה ב-Long</span></th>
                <th>Sell-To-Open<br><span class="ov2-flow-side-sub">פתיחה ב-Short</span></th>
                <th>ToOpen<br><span class="ov2-flow-side-sub">ללא כיוון</span></th>
            </tr></thead>
            <tbody>
                <tr class="ov2-flow-side-ask">
                    <td><b>Calls</b></td>
                    <td><b>${o.callBuy || 0}</b> · <span class="ov2-flow-side-prem">${fmtP(callBuyP_)}</span><br><span class="ov2-flow-side-sub">conviction שורי</span></td>
                    <td><b>${o.callSell || 0}</b> · <span class="ov2-flow-side-prem">${fmtP(callSellP_)}</span><br><span class="ov2-flow-side-sub">short-vol / כותב calls</span></td>
                    <td><b>${o.callGeneric || 0}</b></td>
                </tr>
                <tr class="ov2-flow-side-bid">
                    <td><b>Puts</b></td>
                    <td><b>${o.putBuy || 0}</b> · <span class="ov2-flow-side-prem">${fmtP(putBuyP_)}</span><br><span class="ov2-flow-side-sub">hedge / דובי</span></td>
                    <td><b>${o.putSell || 0}</b> · <span class="ov2-flow-side-prem">${fmtP(putSellP_)}</span><br><span class="ov2-flow-side-sub">כותב puts (שורי)</span></td>
                    <td><b>${o.putGeneric || 0}</b></td>
                </tr>
            </tbody>
            <tfoot>
                <tr><td colspan="4" class="ov2-flow-side-foot">
                    <b>${directional}</b> עם כיוון ברור + <b>${generic}</b> ללא כיוון =
                    <b>${totalOpens}</b> פוזיציות פותחות מתוך <b>${totalAll}</b>
                    (<b>${Math.round(openPct)}%</b>)
                </td></tr>
            </tfoot>
        </table>`;
    setHTML('flowQualityOpens', openTable);

    // ── Opening-conviction interpretation — premium-weighted ──
    let openNote = '';
    if (directionalP <= 0) {
        openNote = `אין מספיק עסקאות פותחות עם כיוון ברור היום (${directional} מתויגות) — מגבלת איכות הנתון של Barchart.`;
    } else {
        const bullPctP = Math.round(bullishP / directionalP * 100);
        const bearPctP = 100 - bullPctP;
        // Compare with count-based for completeness
        const bull = o.bullish || 0;
        const bear = o.bearish || 0;
        const conv = bull + bear;
        const bullPctC = conv > 0 ? Math.round(bull / conv * 100) : 0;

        let label, emoji;
        if (bullPctP >= 65)        { label = 'Conviction שורי';        emoji = '📈'; }
        else if (bullPctP <= 35)   { label = 'Conviction דובי/הגנתי'; emoji = '📉'; }
        else                        { label = 'Conviction מאוזן';     emoji = '🔄'; }

        openNote = `
            <div class="ov2-conv-note-main">${emoji} <b>${label}</b> · לפי פרמיה: <b>${bullPctP}% שורי</b> · ${bearPctP}% דובי</div>
            <div class="ov2-conv-note-detail">
                שורי: ${fmtP(bullishP)} (קנייה calls + כתיבה puts) · דובי: ${fmtP(bearishP)} (כתיבה calls + קנייה puts)
            </div>
            ${conv > 0 && Math.abs(bullPctP - bullPctC) >= 10 ? `
                <div class="ov2-conv-note-divergence">
                    ⓘ לפי מספר עסקאות: ${bullPctC}% שורי — שונה מ-${bullPctP}% לפי פרמיה. <b>המוסדיים מסתדרים אחרת מהציבור.</b>
                </div>
            ` : ''}
        `;
    }
    setHTML('flowQualityOpenNote', openNote);
}

// ═════════════════════════════════════════════════════════════════════
// DAILY SUMMARY — Today + 5-day history + Flow↔SPX correlation
// Simpler than before. Shows: what happened today, vs recent days, and
// whether flow signals correlate with price moves.
// ═════════════════════════════════════════════════════════════════════
function renderDailySummary(phase, m, chips, duration, sectorsMap, hist, flowAnalytics) {
    const wrap = $('summaryContent');
    if (!wrap) return;
    const p = phase.phase;

    // ─── TODAY's snapshot ───
    const spxChg = m.spx && m.spx.chgPct != null ? m.spx.chgPct : null;
    const spxChgFmt = spxChg != null ? (spxChg >= 0 ? '+' : '') + spxChg.toFixed(2) + '%' : '—';
    const spxChgClass = spxChg > 0 ? 'ov2-pos' : spxChg < 0 ? 'ov2-neg' : '';
    const dayInPhase = duration && duration.days >= 0 ? duration.days + 1 : '—';
    const flowScore = m.flow ? m.flow.score : null;

    const todayBlock = `
        <div class="ov2-summary-today">
            <div class="ov2-summary-section-label">היום · ${fmtDate(m.dataDate)}</div>
            <div class="ov2-summary-today-stats">
                <div class="ov2-summary-stat" data-tooltip="השלב הנוכחי לפי המסווג">
                    <span class="ov2-summary-stat-label">שלב</span>
                    <span class="ov2-summary-stat-value"><b>${p.glyph}</b> ${p.stateLabel}</span>
                    <span class="ov2-summary-stat-sub">${m.combined != null ? m.combined : '—'}/100 · יום ${dayInPhase}</span>
                </div>
                <div class="ov2-summary-stat" data-tooltip="שינוי SPX היום">
                    <span class="ov2-summary-stat-label">SPX</span>
                    <span class="ov2-summary-stat-value ${spxChgClass}">${spxChgFmt}</span>
                    <span class="ov2-summary-stat-sub">מחיר ${m.spx && m.spx.price ? m.spx.price.toFixed(2) : '—'}</span>
                </div>
                <div class="ov2-summary-stat" data-tooltip="ציון Flow היום">
                    <span class="ov2-summary-stat-label">Flow</span>
                    <span class="ov2-summary-stat-value">${flowScore != null ? flowScore : '—'}</span>
                    <span class="ov2-summary-stat-sub">ציון 0-100</span>
                </div>
                <div class="ov2-summary-stat" data-tooltip="אחוז מניות מעל MA200">
                    <span class="ov2-summary-stat-label">רוחב</span>
                    <span class="ov2-summary-stat-value">${Math.round(m.pctMa200)}%</span>
                    <span class="ov2-summary-stat-sub">מעל MA200</span>
                </div>
                <div class="ov2-summary-stat" data-tooltip="VIX · מד הפחד">
                    <span class="ov2-summary-stat-label">VIX</span>
                    <span class="ov2-summary-stat-value">${m.vix ? m.vix.toFixed(1) : '—'}</span>
                    <span class="ov2-summary-stat-sub">${m.vix < 15 ? 'רגוע' : m.vix < 20 ? 'נורמלי' : m.vix < 30 ? 'מוגבר' : 'משבר'}</span>
                </div>
            </div>
        </div>`;

    // ─── 5-DAY HISTORY TABLE ───
    // Build per-day rows from hist + flowAnalytics
    const lastN = 7;
    const days = (hist || []).slice(-lastN);
    const flowDays = (flowAnalytics && flowAnalytics.days) || [];
    // Build lookup: date → flow score
    const flowByDate = {};
    for (const fd of flowDays) {
        if (fd.score != null) flowByDate[fd.date] = fd.score;
    }

    const histRows = days.map((d, i) => {
        const dm = d.m;
        const dSpxChg = dm.macro && dm.macro.spx ? dm.macro.spx.chgPct : null;
        const dSpxFmt = dSpxChg != null ? (dSpxChg >= 0 ? '+' : '') + dSpxChg.toFixed(2) + '%' : '—';
        const dSpxClass = dSpxChg > 0 ? 'ov2-pos' : dSpxChg < 0 ? 'ov2-neg' : 'ov2-muted';
        const dFlow = flowByDate[d.date];
        const dBreadth = dm.pctMa200 != null ? Math.round(dm.pctMa200) + '%' : '—';
        // Classify phase for this day (simplified — no previousPhase)
        const dPhase = Regime.classifyPhase({
            combined: 50,    // approx — we don't reclassify each day fully
            breadth5dDelta: 0,
            vix: dm.macro.vix || 0,
            distributionDays: 0,
            nhMinusNl: dm.newHighs - dm.newLows,
            rsiThrust: dm.rsiThrust,
            pctMa200: dm.pctMa200,
            previousPhase: null
        });
        const isToday = i === days.length - 1;
        return `<tr class="${isToday ? 'ov2-summary-today-row' : ''}">
            <td class="ov2-summary-date">${fmtDate(d.date)}${isToday ? ' <span style="color:var(--ov2-cat-action); font-weight:700;">← היום</span>' : ''}</td>
            <td class="${dSpxClass}"><b>${dSpxFmt}</b></td>
            <td>${dFlow != null ? dFlow : '—'}</td>
            <td>${Math.round(dm.healthScore || 0)}</td>
            <td>${dBreadth}</td>
            <td>${dm.macro.vix ? dm.macro.vix.toFixed(1) : '—'}</td>
        </tr>`;
    }).join('');

    const histTable = `
        <div class="ov2-summary-history">
            <div class="ov2-summary-section-label">${days.length} ימי המסחר האחרונים</div>
            <table class="ov2-summary-table">
                <thead>
                    <tr>
                        <th>תאריך</th>
                        <th>SPX</th>
                        <th data-tooltip="ציון Flow היומי 0-100">Flow</th>
                        <th data-tooltip="ציון בריאות שוק">בריאות</th>
                        <th data-tooltip="% מניות מעל MA200">רוחב</th>
                        <th>VIX</th>
                    </tr>
                </thead>
                <tbody>${histRows}</tbody>
            </table>
        </div>`;

    // ─── CORRELATION Flow ↔ SPX ───
    const corrSamples = [];
    for (const d of days) {
        const f = flowByDate[d.date];
        const sChg = d.m.macro && d.m.macro.spx ? d.m.macro.spx.chgPct : null;
        if (f != null && sChg != null) corrSamples.push({ flow: f, spx: sChg });
    }
    const correlation = pearsonCorrelation(
        corrSamples.map(s => s.flow),
        corrSamples.map(s => s.spx)
    );

    let corrLabel, corrInterp;
    if (correlation == null || corrSamples.length < 3) {
        corrLabel = '—';
        corrInterp = 'אין מספיק נתונים לחישוב קורלציה (דרושים לפחות 3 ימים)';
    } else {
        const r = correlation;
        const absR = Math.abs(r);
        let strength;
        if (absR >= 0.7) strength = 'חזקה';
        else if (absR >= 0.4) strength = 'בינונית';
        else if (absR >= 0.2) strength = 'חלשה';
        else strength = 'אין';
        const direction = r > 0 ? 'חיובית' : r < 0 ? 'שלילית' : '';
        corrLabel = `r = ${r >= 0 ? '+' : ''}${r.toFixed(2)} · ${strength} ${direction}`;

        // Interpretation
        if (absR < 0.2) {
            corrInterp = `Flow ו-SPX לא נעו יחד ב-${corrSamples.length} הימים האחרונים. הציון לא חזה את כיוון השוק.`;
        } else if (r >= 0.4) {
            corrInterp = `Flow ו-SPX נעו יחד — ימים עם Flow גבוה היו ימים עם SPX חיובי. הציון תואם לכיוון השוק.`;
        } else if (r <= -0.4) {
            corrInterp = `Flow ו-SPX נעו הפוך — ימים עם Flow גבוה היו ימים עם SPX שלילי. <b>סימן ל-contrarian flow</b>.`;
        } else {
            corrInterp = `קשר חלש בין Flow ל-SPX — ב-${corrSamples.length} ימים אחרונים, Flow לא ניבא תנועה ברורה.`;
        }
    }

    const corrBlock = `
        <div class="ov2-summary-corr">
            <div class="ov2-summary-section-label">קורלציה Flow ↔ SPX</div>
            <div class="ov2-summary-corr-row">
                <span class="ov2-summary-corr-val">${corrLabel}</span>
                <span class="ov2-summary-corr-samples">${corrSamples.length} ימים</span>
            </div>
            <div class="ov2-summary-corr-interp">${corrInterp}</div>
        </div>`;

    wrap.innerHTML = todayBlock + histTable + corrBlock;

    // Bottom line — phase bias
    $('summaryBottomLine').textContent = `השורה התחתונה: ${p.bias}`;
}

// ═════════════════════════════════════════════════════════════════════
// SYNERGY RENDER — Market State × Flow combined narrative
// ═════════════════════════════════════════════════════════════════════
function renderMarketFlowSynergy(phase, metrics) {
    const wrap = $('synergyContent');
    if (!wrap) return;
    if (!metrics.flow) {
        wrap.innerHTML = '<div style="padding:16px; color:var(--ov2-text-3);">אין נתוני flow לקישור עם מצב השוק</div>';
        return;
    }

    const analysis = analyzeMarketFlow(phase, metrics);
    const { flowLean, alignment, signals, narrative } = analysis;
    const p = phase.phase;

    // Flow pattern (from existing classifier)
    const flowPattern = classifyFlowPattern(metrics.flow.raw, metrics.flow.score);

    // Lean visual — horizontal bar with marker
    const leanPct = flowLean != null ? Math.max(0, Math.min(100, (flowLean + 100) / 2)) : 50;
    const leanColor = flowLean == null ? 'var(--ov2-neutral)'
                    : flowLean >= 25 ? 'var(--ov2-pos)'
                    : flowLean <= -25 ? 'var(--ov2-neg)'
                    : 'var(--ov2-warn)';
    const leanText = flowLean == null ? '—'
                   : flowLean >= 50 ? 'שורי חזק'
                   : flowLean >= 25 ? 'שורי מתון'
                   : flowLean >= -25 ? 'מאוזן'
                   : flowLean >= -50 ? 'שלילי מתון'
                   : 'שלילי חזק';

    // Alignment color
    const alignClass = alignment.level === 'confirm' ? 'ov2-synergy-confirm'
                     : alignment.level === 'bullish_div' ? 'ov2-synergy-bullish-div'
                     : alignment.level === 'bearish_div' ? 'ov2-synergy-bearish-div'
                     : alignment.level === 'neutral_div' ? 'ov2-synergy-bearish-div'
                     : 'ov2-synergy-neutral';

    // ─── New layout (2026-05-26): conclusion-first + Q&A + collapsible
    // technical details. Replaces the old vertical stack (pair → lean →
    // alignment → signals → narrative) which forced the user to scan
    // five separate blocks before reaching the takeaway. The redesign:
    //   1. Status badge + headline + action (the takeaway, top)
    //   2. Three Q&A blocks (plain Hebrew, no jargon)
    //   3. Technical details collapsed by default (numbers, lean bar)
    // ──────────────────────────────────────────────────────────────────
    const synergy = buildSynergyContent(phase, metrics, flowLean, alignment, signals);

    const html = `
        <!-- Top conclusion banner — status + headline + action -->
        <div class="ov2-synergy-conclusion ${synergy.statusClass}">
            <div class="ov2-synergy-status-badge">
                <span class="ov2-synergy-status-icon">${synergy.statusIcon}</span>
                <span>${synergy.statusLabel}</span>
            </div>
            <div class="ov2-synergy-headline">${synergy.headline}</div>
            <div class="ov2-synergy-action">${synergy.action}</div>
        </div>

        <!-- Q1: alignment -->
        <div class="ov2-synergy-qa">
            <div class="ov2-synergy-q">❓ הכסף הגדול תומך במגמה?</div>
            <div class="ov2-synergy-a">${synergy.q1Answer}</div>
        </div>

        <!-- Q2: what's troubling (or confirming) -->
        ${synergy.q2Items.length ? `
        <div class="ov2-synergy-qa">
            <div class="ov2-synergy-q">${synergy.q2Question}</div>
            <ul class="ov2-synergy-list">
                ${synergy.q2Items.map(t => `<li>${t}</li>`).join('')}
            </ul>
        </div>` : ''}

        <!-- Q3: what to do -->
        <div class="ov2-synergy-qa">
            <div class="ov2-synergy-q">❓ מה לעשות עם זה?</div>
            <ul class="ov2-synergy-list">
                ${synergy.q3Items.map(t => `<li>${t}</li>`).join('')}
            </ul>
        </div>

        <!-- Technical details (collapsed by default) -->
        <details class="ov2-synergy-tech">
            <summary>פירוט טכני · מספרים גולמיים</summary>
            <div class="ov2-synergy-tech-body">
                <div class="ov2-synergy-pair">
                    <div class="ov2-synergy-side">
                        <div class="ov2-eyebrow">מצב השוק</div>
                        <div class="ov2-synergy-side-headline" style="color:${p.color}">${p.glyph} ${p.stateLabel}</div>
                        <div class="ov2-synergy-side-detail">${p.labelHe} · Combined ${metrics.combined != null ? metrics.combined : '—'}/100</div>
                    </div>
                    <div class="ov2-synergy-arrow">↔</div>
                    <div class="ov2-synergy-side">
                        <div class="ov2-eyebrow">זרימת אופציות</div>
                        <div class="ov2-synergy-side-headline" style="color:var(--ov2-cat-flow)">${flowPattern.label}</div>
                        <div class="ov2-synergy-side-detail">Flow ${metrics.flow.score != null ? metrics.flow.score : '—'}/100 · ${flowPattern.label}</div>
                    </div>
                </div>
                <div class="ov2-synergy-lean">
                    <div class="ov2-synergy-lean-label">
                        <span>כיוון הזרימה (-100 דובי, +100 שורי)</span>
                        <span class="ov2-synergy-lean-value" style="color:${leanColor}">${flowLean != null ? (flowLean >= 0 ? '+' : '') + flowLean : '—'} · ${leanText}</span>
                    </div>
                    <div class="ov2-synergy-lean-track">
                        <div class="ov2-synergy-lean-zone-neg"></div>
                        <div class="ov2-synergy-lean-zone-mid"></div>
                        <div class="ov2-synergy-lean-zone-pos"></div>
                        <div class="ov2-synergy-lean-marker" style="left:${leanPct}%; background:${leanColor}"></div>
                    </div>
                    <div class="ov2-synergy-lean-scale">
                        <span>−100</span><span>0</span><span>+100</span>
                    </div>
                </div>
                <div class="ov2-synergy-alignment ${alignClass}">
                    <div class="ov2-synergy-align-emoji">${alignment.emoji}</div>
                    <div class="ov2-synergy-align-content">
                        <div class="ov2-synergy-align-label">השוואת מגמה לזרימה · <b>${alignment.label}</b></div>
                        <div class="ov2-synergy-align-desc">${alignment.desc || ''}</div>
                    </div>
                </div>
            </div>
        </details>
    `;
    wrap.innerHTML = html;
}

// ─── Synergy content builder ─────────────────────────────────────────
// Produces the strings the new Q&A layout needs. Takes the same inputs
// as renderMarketFlowSynergy and returns:
//   { statusClass, statusIcon, statusLabel, headline, action,
//     q1Answer, q2Question, q2Items, q3Items }
// Each field is plain Hebrew; numbers are quoted only when essential.
function buildSynergyContent(phase, metrics, flowLean, alignment, signals) {
    const phaseId = phase.phase.id;
    const isBullishPhase = ['confirmed_uptrend','uptrend_pressure','thrust'].includes(phaseId);
    const isBearishPhase = ['correction','capitulation','distribution'].includes(phaseId);
    const level = alignment.level; // confirm / bullish_div / bearish_div / neutral / unknown

    const flowSentiment = alignment.flowSentiment || { id: 'unknown', label: 'לא ידוע' };
    const flowLabel = flowSentiment.label;
    const flowStrong = flowSentiment.id === 'bullish_strong' || flowSentiment.id === 'bearish_strong';

    // ─── Status badge (top-left of conclusion banner) ──
    let statusIcon = '⚪', statusLabel = 'אין נתון', statusClass = 'ov2-synergy-muted';
    if (level === 'confirm') {
        statusIcon = '🟢'; statusLabel = `תואם · ${flowLabel}`; statusClass = 'ov2-synergy-confirm';
    } else if (level === 'bullish_div') {
        statusIcon = '🟢'; statusLabel = `סטייה שורית · ${flowLabel}`;
        statusClass = 'ov2-synergy-bullish-div';
    } else if (level === 'bearish_div') {
        statusIcon = flowStrong ? '🔴' : '🟡';
        statusLabel = `סטייה דובית · ${flowLabel}`;
        statusClass = 'ov2-synergy-bearish-div';
    } else if (level === 'neutral_div') {
        statusIcon = '🟡'; statusLabel = `flow מאוזן`;
        statusClass = 'ov2-synergy-bearish-div';
    }

    // ─── Headline + action (top conclusion) ──
    // Phrasing now mentions the actual flow sentiment label so the synergy
    // narrative is literally derived from the same classifier as the
    // Flow Score, the 7-day badges, and the Aggressive-direction line.
    let headline, action;
    if (level === 'confirm' && isBullishPhase) {
        headline = `השוק שורי והכסף הגדול ${flowLabel} — מאשר את המגמה.`;
        action = 'אישור מבנה — אפשר להמשיך בגישה הנוכחית.';
    } else if (level === 'confirm' && isBearishPhase) {
        headline = `השוק חלש והכסף הגדול ${flowLabel} — מאשר את הסיכון.`;
        action = 'אישור מבנה — להישאר בגישת הגנה.';
    } else if (level === 'confirm') {
        headline = `הזרימה ${flowLabel} — תואמת לשלב הנוכחי של השוק.`;
        action = 'אין סתירה בין המקורות — אפשר להמשיך בגישה הנוכחית.';
    } else if (level === 'bullish_div' && isBearishPhase) {
        headline = `השוק עוד חלש אבל הכסף הגדול ${flowLabel} — מתחיל להיכנס.`;
        action = 'סיגנל ראשוני להתאוששות — להמתין לאישור מחיר לפני הוספת חשיפה.';
    } else if (level === 'bullish_div') {
        headline = `הזרימה ${flowLabel} — חיובית יותר מהשלב הנוכחי.`;
        action = 'אפשר התאוששות — שווה לעקוב אחרי הפאזה לשיפור.';
    } else if (level === 'bearish_div' && isBullishPhase) {
        headline = `השוק שורי אבל הכסף הגדול ${flowLabel} — סתירה ${flowStrong ? 'דרמטית' : 'משמעותית'}.`;
        action = flowStrong
            ? 'אזהרה ברורה — הכסף הגדול נערך לירידה. לא להוסיף חשיפה, להדק stop-loss.'
            : 'סימן אזהרה — להמשיך לעקוב, לא לפעול.';
    } else if (level === 'bearish_div' && isBearishPhase) {
        headline = `הזרימה ${flowLabel} — אפילו יותר חלשה מהשוק.`;
        action = 'הסיכון מתחזק — להגן יותר.';
    } else if (level === 'bearish_div') {
        headline = `הזרימה ${flowLabel} — זהירה יותר מהשלב הנוכחי.`;
        action = 'סימן זהירות — להמתין לפני פעולה.';
    } else if (level === 'neutral_div' && isBullishPhase) {
        headline = `השוק שורי אבל הכסף הגדול ${flowLabel} — חוסר אישור.`;
        action = 'התקדמות בלי תמיכת flow — להמשיך בזהירות.';
    } else if (level === 'neutral_div' && isBearishPhase) {
        headline = `השוק חלש אבל הכסף הגדול ${flowLabel} — אין שיפור עדיין.`;
        action = 'אין סימן להתאוששות — להמשיך בהגנה.';
    } else {
        headline = 'אין מספיק נתונים לחיבור בין השוק לזרימה.';
        action = '—';
    }

    // ─── Q1 answer — supportive? ──
    const combinedStr = metrics.combined != null ? `${metrics.combined}/100` : '—';
    const flowScoreStr = metrics.flow && metrics.flow.score != null
                        ? `${metrics.flow.score}/100` : '—';
    const shareStr = flowSentiment.callShare != null
        ? `${flowSentiment.callShare}% מהפרמיה ה-directional ל-calls`
        : '';
    let q1Answer;
    if (level === 'confirm') {
        q1Answer = `<b>כן.</b> השוק (${combinedStr}) והזרימה (${flowScoreStr} · ${flowLabel}) באותו הכיוון. ${shareStr}.`;
    } else if (level === 'bullish_div') {
        q1Answer = `<b>הזרימה חזקה יותר.</b> הפאזה (${combinedStr}) פחות שורית מהזרימה (${flowScoreStr} · ${flowLabel}). ${shareStr}.`;
    } else if (level === 'bearish_div') {
        q1Answer = `<b>לא.</b> הפאזה ב-${combinedStr} אבל הזרימה ${flowLabel} (${flowScoreStr}). ${shareStr} — הכסף הגדול בכיוון הפוך.`;
    } else if (level === 'neutral_div') {
        q1Answer = `<b>לא ברור.</b> הפאזה (${combinedStr}) אבל הזרימה ${flowLabel} (${flowScoreStr}). ${shareStr} — אין הכרעה מצד הכסף הגדול.`;
    } else {
        q1Answer = '<b>לא ניתן לקבוע.</b> אין מספיק נתוני זרימה לקישור.';
    }

    // ─── Q2 items — translate the existing signals to friendlier Hebrew ──
    const q2Items = signals.map(s => translateSignal(s));
    const q2Question = level === 'confirm' && isBullishPhase
        ? '❓ מה מחזק את התמונה?'
        : '❓ מה מטריד את הכסף הגדול?';

    // ─── Q3 items — action recommendations based on alignment + phase ──
    const q3Items = [];
    if (level === 'confirm' && isBullishPhase) {
        q3Items.push('☞ אפשר להמשיך בגישת long, אבל לא בלי משמעת stop-loss');
        q3Items.push('☞ לעקוב אחרי MA50 — ירידה מתחת ל-50% מסמנת חולשה');
    } else if (level === 'bearish_div' && isBullishPhase) {
        q3Items.push('☞ לא להוסיף חשיפה כרגע — להמתין לאישור הכסף הגדול');
        q3Items.push('☞ לעקוב אחרי כיוון הזרימה — חזרה ל-25+ תסגור את הסטייה');
        q3Items.push('☞ לעקוב אחרי MA50 — ירידה מתחת ל-50% תאשר חולשה');
    } else if (level === 'bullish_div' && isBearishPhase) {
        q3Items.push('☞ עדיין לא לרכוש — להמתין לאישור מחיר');
        q3Items.push('☞ לעקוב אחרי % מעל MA200 — מעל 50% יסמן התייצבות');
        q3Items.push('☞ לעקוב אחרי VIX — ירידה ל-18 ומטה תרמז סוף משבר');
    } else if (level === 'bearish_div' && isBearishPhase) {
        q3Items.push('☞ להעמיק הגנה — הסיכון מצטבר');
        q3Items.push('☞ לא לתפוס תחתית עד שהזרימה תהפוך חיובית');
    } else if (level === 'confirm' && isBearishPhase) {
        q3Items.push('☞ להישאר בגישת הגנה — שני המקורות מאשרים סיכון');
        q3Items.push('☞ לחפש סימני היפוך — VIX יורד, רוחב משתפר');
    } else {
        q3Items.push('☞ להמתין לסיגנל ברור לפני פעולה');
    }

    return {
        statusClass, statusIcon, statusLabel,
        headline, action,
        q1Answer, q2Question, q2Items, q3Items,
    };
}

// Translate a cross-signal object (existing format from generateCrossSignals)
// to plain Hebrew without internal jargon — drops words like "Conviction",
// "scalping", "BTO/STO" in favor of full Hebrew explanations.
function translateSignal(s) {
    const icon = s.icon || '·';
    let text = s.text || '';
    // Strip internal terms that confuse first-time readers
    text = text
        .replace(/Conviction דובי חזק בפותחות \((\d+)% לפי פרמיה\)/g,
                 'פותחות פוזיציות חדשות היו $1% לכיוון דובי')
        .replace(/Conviction שורי חזק בפותחות \((\d+)% לפי פרמיה\)/g,
                 'פותחות פוזיציות חדשות היו $1% לכיוון שורי')
        .replace(/Calls אסטרטגיים \((\d+)d\) vs Puts קצרים \((\d+)d\)/g,
                 'קולים ל-$1 ימים מול פוטים ל-$2 ימים')
        .replace(/Puts אסטרטגיים \((\d+)d\) vs Calls קצרים \((\d+)d\)/g,
                 'פוטים ל-$1 ימים (הגנה ארוכה) מול קולים ל-$2 ימים (טווח קצר)')
        .replace(/scalping/g, 'טווח קצר')
        .replace(/calls רק לטווח קצר/g, 'הקולים רק לטווח קצר — פחות אמונה במגמה')
        .replace(/Flow lean ([+-]?\d+)/g, 'כיוון הזרימה $1')
        .replace(/transition אפשרי ל-❶/g, 'מעבר אפשרי לפאזה חיובית יותר')
        .replace(/transition ל-❸/g, 'מעבר לפאזת הפצה');
    return `${icon} ${text}`;
}

// ═════════════════════════════════════════════════════════════════════
// FLOW HISTORICAL CONTEXT — today vs 22-day baseline + pattern frequency
// Answers: "Is today unusual? How often have we seen this pattern?"
// ═════════════════════════════════════════════════════════════════════
function renderFlowHistory(rawToday, scoreToday, allDays) {
    const wrap = $('flowHistory');
    if (!wrap || !allDays || allDays.length === 0) return;

    // Today's pattern — derived from the Flow Score
    const todayPattern = classifyFlowPattern(rawToday, scoreToday);

    // Count pattern occurrences across all historical days
    let sameAsToday = 0;
    const patternCounts = {};  // by id
    for (const d of allDays) {
        const p = classifyFlowPattern(d.raw, d.score);
        patternCounts[p.id] = (patternCounts[p.id] || 0) + 1;
        if (p.id === todayPattern.id) sameAsToday++;
    }
    const totalDays = allDays.length;
    const patternPct = totalDays > 0 ? Math.round(sameAsToday / totalDays * 100) : 0;

    // Score stats
    const scores = allDays.map(d => d.score).filter(s => s != null);
    const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const deviation = (scoreToday != null && avgScore != null) ? scoreToday - avgScore : null;

    const last7Scores = scores.slice(-7);
    const minScore7 = last7Scores.length ? Math.min(...last7Scores) : null;
    const maxScore7 = last7Scores.length ? Math.max(...last7Scores) : null;

    // Trend: compare today vs 5d ago
    let trendArrow = '─', trendLabel = 'יציב', trendDelta = 0;
    if (scores.length >= 6 && scoreToday != null) {
        const score5dAgo = scores[scores.length - 6];
        trendDelta = scoreToday - score5dAgo;
        if (trendDelta >= 5)       { trendArrow = '↗'; trendLabel = 'עולה'; }
        else if (trendDelta <= -5) { trendArrow = '↘'; trendLabel = 'יורד'; }
    }

    // Recent pattern history — last 7 days
    const last7Days = allDays.slice(-7);
    const recentPatterns = last7Days.map(d => {
        const p = classifyFlowPattern(d.raw, d.score);
        return { date: d.date, score: d.score, patternId: p.id, patternLabel: p.label };
    });

    // Deviation label
    let devLabel = 'קרוב לממוצע';
    if (deviation != null) {
        if (deviation >= 8)       devLabel = `מעל הממוצע (+${deviation})`;
        else if (deviation >= 3)  devLabel = `קצת מעל הממוצע (+${deviation})`;
        else if (deviation <= -8) devLabel = `מתחת לממוצע (${deviation})`;
        else if (deviation <= -3) devLabel = `קצת מתחת לממוצע (${deviation})`;
    }

    // Pattern uniqueness label
    let patternRareLabel = '';
    if (patternPct >= 50)       patternRareLabel = 'תבנית שכיחה לאחרונה';
    else if (patternPct >= 25)  patternRareLabel = 'תבנית מוכרת';
    else if (patternPct >= 10)  patternRareLabel = 'תבנית לא תדירה';
    else                        patternRareLabel = 'תבנית נדירה — שווה תשומת לב';

    const html = `
        <div class="ov2-flow-history-grid">
            <div class="ov2-flow-history-item" data-tooltip="ציון Flow היום מול ממוצע של ${totalDays} ימי מסחר אחרונים">
                <div class="ov2-flow-history-label">Flow היום vs ממוצע 22D</div>
                <div class="ov2-flow-history-value">${scoreToday != null ? scoreToday : '—'} <span class="ov2-flow-history-sub">/ ${avgScore != null ? avgScore : '—'}</span></div>
                <div class="ov2-flow-history-foot ${deviation > 0 ? 'ov2-pos' : deviation < 0 ? 'ov2-neg' : ''}">${devLabel}</div>
            </div>
            <div class="ov2-flow-history-item" data-tooltip="כמה פעמים התבנית הנוכחית הופיעה ב-${totalDays} הימים האחרונים">
                <div class="ov2-flow-history-label">תבנית "${todayPattern.label}"</div>
                <div class="ov2-flow-history-value">${sameAsToday} <span class="ov2-flow-history-sub">/ ${totalDays} ימים</span></div>
                <div class="ov2-flow-history-foot">${patternPct}% — ${patternRareLabel}</div>
            </div>
            <div class="ov2-flow-history-item" data-tooltip="טווח ציון Flow ב-7 ימי המסחר האחרונים (כולל היום)">
                <div class="ov2-flow-history-label">טווח Flow השבוע</div>
                <div class="ov2-flow-history-value">${minScore7 != null ? minScore7 : '—'} – ${maxScore7 != null ? maxScore7 : '—'}</div>
                <div class="ov2-flow-history-foot">7 ימים אחרונים</div>
            </div>
            <div class="ov2-flow-history-item" data-tooltip="כיוון ה-Flow השבוע — השוואה ל-5 ימים אחורנית">
                <div class="ov2-flow-history-label">מגמת Flow</div>
                <div class="ov2-flow-history-value">${trendArrow} ${trendLabel}</div>
                <div class="ov2-flow-history-foot">${trendDelta >= 0 ? '+' : ''}${trendDelta} נק' מ-5 ימים</div>
            </div>
        </div>

        <div class="ov2-flow-history-timeline">
            <div class="ov2-eyebrow" style="margin-bottom:8px;">תבניות 7 הימים האחרונים</div>
            <div class="ov2-flow-pattern-row">
                ${recentPatterns.map((p, i) => {
                    const isToday = i === recentPatterns.length - 1;
                    const patternClass = `pat-${p.patternId}`;
                    return `<div class="ov2-flow-pattern-cell ${patternClass} ${isToday ? 'is-today' : ''}"
                                 data-tooltip="${fmtDate(p.date)} · ${p.patternLabel} · ציון ${p.score}">
                        <span class="pat-date">${p.date.slice(8, 10)}/${p.date.slice(5, 7)}</span>
                        <span class="pat-label">${p.patternLabel}</span>
                        <span class="pat-score">${p.score}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>
    `;
    wrap.innerHTML = html;
}

// ─── Pearson correlation helper ───
function pearsonCorrelation(xs, ys) {
    if (!xs || !ys || xs.length !== ys.length || xs.length < 2) return null;
    const n = xs.length;
    let sumX = 0, sumY = 0;
    for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; }
    const mX = sumX / n, mY = sumY / n;
    let num = 0, sx2 = 0, sy2 = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mX, dy = ys[i] - mY;
        num += dx * dy;
        sx2 += dx * dx;
        sy2 += dy * dy;
    }
    const den = Math.sqrt(sx2 * sy2);
    return den === 0 ? null : num / den;
}

// ═════════════════════════════════════════════════════════════════════
// LIVE TICKER — auto-refresh every 2 minutes (Stooq via CORS proxy)
// ═════════════════════════════════════════════════════════════════════
let _tickerTimer = null;

async function startLiveTicker(metrics) {
    // Initial fallback for SPY — uses today's SPX snapshot until live fetch arrives
    if (metrics.spx && metrics.spx.price != null) {
        const spyEl = $('tkSPY');
        const spyChgEl = $('tkSPYChg');
        if (spyEl) spyEl.textContent = (metrics.spx.price / 10).toFixed(2);  // SPY ≈ SPX/10
        if (spyChgEl) {
            spyChgEl.textContent = (metrics.spx.chgPct >= 0 ? '+' : '') + metrics.spx.chgPct.toFixed(2) + '%';
            spyChgEl.style.color = metrics.spx.chgPct >= 0 ? 'var(--ov2-pos)' : 'var(--ov2-neg)';
        }
    }
    await fetchLiveIndices();
    // Refresh every 5 minutes — balances freshness with proxy quota.
    // Each tick fires 4 Yahoo calls (one per ETF) through the proxy
    // chain; 60s was hammering Jina unnecessarily for a dashboard
    // the user checks a few times a day, not actively trades from.
    if (_tickerTimer) clearInterval(_tickerTimer);
    _tickerTimer = setInterval(fetchLiveIndices, 5 * 60 * 1000);
}

// Try the same-origin data/live_ticker.json first. GitHub Actions
// refreshes it every 5 min during US trading hours (13:30-21:00 UTC).
// Outside trading hours the file is naturally stale — that's correct,
// markets are closed and prices aren't moving. The dashboard shows the
// last close until the next session starts.
//
// Returns null only when the file is missing/malformed OR genuinely
// stale during US trading hours (cron failed). In that case the caller
// falls back to the live proxy chain.
async function fetchTickerFromRepo() {
    try {
        const r = await fetch('data/live_ticker.json?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return null;
        const data = await r.json();
        if (!data || !Array.isArray(data.tickers)) return null;
        if (data.fetchedAt) {
            const ageMin = (Date.now() - new Date(data.fetchedAt).getTime()) / 60000;
            const now = new Date();
            const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
            const day = now.getUTCDay();   // 0=Sun, 6=Sat
            // US trading session: weekday 13:30-21:00 UTC. The cron runs
            // every 5 min in that window, so during it a > 30 min stale
            // file means the cron failed and we should try the proxy.
            // 13:40 start = market open +10 min, giving the first cron
            // run time to land before we declare the file stale.
            // Outside the session ANY age is fine (markets are closed,
            // the last close IS the current state).
            const inUsSession = day >= 1 && day <= 5
                && utcMinutes >= (13 * 60 + 40) && utcMinutes < (21 * 60);
            if (inUsSession && ageMin > 30) return null;
        }
        return data;
    } catch (_) {
        return null;
    }
}

async function fetchLiveIndices() {
    // Primary path: same-origin data/live_ticker.json (refreshed by
    // .github/workflows/update-ticker.yml every 5 min during trading
    // hours). No CORS, no third-party proxy, 100% reliable.
    //
    // Fallback path: the CORS proxy chain (Jina + allorigins) per-symbol
    // — used only when the repo file is stale or missing.
    //
    // Each successful fetch is cached in localStorage. When everything
    // fails we hydrate from cache and mark the ticker "stale" so the
    // user knows the data isn't live. See README §audit-fix-8.
    const symbols = {
        SPY: 'SPY', NDX: 'QQQ', DJI: 'DIA', RUT: 'IWM',
        // Macro trio — fear index, 10Y treasury yield, dollar index
        VIX: '^VIX', TNX: '^TNX', DXY: 'DX-Y.NYB',
    };
    // Per-tile formatting: TNX is a yield (suffix %), VIX/DXY plain 2dp.
    const TILE_SUFFIX = { TNX: '%' };
    const apply = (key, close, prev) => {
        const valEl = $('tk' + key);
        const chgEl = $('tk' + key + 'Chg');
        if (!valEl || !chgEl) return;
        const c = parseFloat(close), p = parseFloat(prev);
        if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return;
        const pctChg = (c - p) / p * 100;
        valEl.textContent = c.toLocaleString('en-US', { maximumFractionDigits: 2 })
            + (TILE_SUFFIX[key] || '');
        chgEl.textContent = (pctChg >= 0 ? '+' : '') + pctChg.toFixed(2) + '%';
        chgEl.style.color = pctChg >= 0 ? 'var(--ov2-pos)' : 'var(--ov2-neg)';
    };
    const cacheKey = sym => `liveTicker_${sym}`;
    const setStamp = (mode, ageInfo) => {
        const upd = $('tkUpdated');
        if (!upd) return;
        const now = new Date();
        const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
        if (mode === 'repo') {
            upd.textContent = `${hhmm}${ageInfo ? ' · ' + ageInfo : ''}`;
            upd.style.color = '';
            upd.title = 'מהקובץ data/live_ticker.json (GitHub Actions, כל 5 דק׳)';
        } else if (mode === 'proxy') {
            upd.textContent = hhmm + ' · live';
            upd.style.color = '';
            upd.title = 'מ-proxy (Yahoo דרך Jina)';
        } else if (mode === 'cached') {
            upd.textContent = '⚠ ' + hhmm + ' · cached';
            upd.style.color = 'var(--ov2-warn)';
            upd.title = 'נתונים מ-cache מקומי — proxy לא זמין';
        } else {
            upd.textContent = '⛔ —';
            upd.style.color = 'var(--ov2-neg)';
            upd.title = 'נתונים לא זמינים';
        }
    };

    // ── Path 1: same-origin file (best path) ──
    const repoData = await fetchTickerFromRepo();
    if (repoData) {
        const bySym = {};
        for (const t of repoData.tickers) bySym[t.symbol] = t;
        // Risk-off banner reconciliation against the live session.
        // Timestamp priority: the quote's own market time (epoch sec),
        // then the file's fetchedAt.
        const spyT = bySym['SPY'];
        if (spyT && spyT.price && spyT.prev) {
            const ts = spyT.time ? new Date(spyT.time * 1000)
                     : (repoData.fetchedAt ? new Date(repoData.fetchedAt) : null);
            try { updateRiskOffLive((spyT.price / spyT.prev - 1) * 100, ts); } catch (_) {}
        }
        for (const [key, sym] of Object.entries(symbols)) {
            const t = bySym[sym];
            if (t) apply(key, t.price, t.prev);
            // Hydrate localStorage cache too so the proxy fallback isn't
            // the first thing the user sees on a network blip later.
            if (t) {
                try {
                    localStorage.setItem(cacheKey(sym), JSON.stringify({
                        close: t.price, prev: t.prev, fetchedAt: Date.now(),
                    }));
                } catch (_) {}
            }
        }
        let ageInfo = '';
        if (repoData.fetchedAt) {
            const ageMin = Math.round((Date.now() - new Date(repoData.fetchedAt).getTime()) / 60000);
            if (ageMin >= 1) ageInfo = `לפני ${ageMin} דק׳`;
        }
        setStamp('repo', ageInfo);
        return;
    }

    // ── Path 2: proxy chain per-symbol (fallback) ──
    let anyFresh = false, anyStaleFromCache = false;
    const fetchOne = async (key, sym) => {
        // encodeURIComponent — ^VIX / ^TNX carry a caret, DX-Y.NYB a dot
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`;
        try {
            const json = await proxyFetchJSON(yahooUrl);
            const result = json && json.chart && json.chart.result && json.chart.result[0];
            const meta = result && result.meta;
            if (!meta) throw new Error('no meta');
            // Yahoo's daily 'close' series includes today's in-progress
            // bar (close == live price). For dense series (SPY) the last
            // returned bar is usually yesterday; for sparse cash-index
            // series (^TNX, ^VIX) the only bar can BE today's, making
            // prev == price → a bogus 0.00%. So drop a trailing bar that
            // matches the live price, then take the last remaining close;
            // if none remain, chartPreviousClose IS the prior close for
            // those indices. Mirrors scripts/fetch_ticker.py exactly.
            const price = meta.regularMarketPrice;
            const closes = ((result.indicators || {}).quote || [{}])[0].close || [];
            let clean = closes.filter(c => c != null && Number.isFinite(c));
            if (price != null && clean.length
                    && Math.abs(clean[clean.length - 1] - price) < Math.abs(price) * 2e-4) {
                clean = clean.slice(0, -1);
            }
            const prev = clean.length ? clean[clean.length - 1] : meta.chartPreviousClose;
            apply(key, price, prev);
            if (key === 'SPY' && meta.regularMarketPrice && prev) {
                const ts = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : null;
                try { updateRiskOffLive((meta.regularMarketPrice / prev - 1) * 100, ts); } catch (_) {}
            }
            anyFresh = true;
            try {
                localStorage.setItem(cacheKey(sym), JSON.stringify({
                    close: meta.regularMarketPrice,
                    prev:  prev,
                    fetchedAt: Date.now(),
                }));
            } catch (_) {}
        } catch (_) {
            try {
                const cached = localStorage.getItem(cacheKey(sym));
                if (cached) {
                    const parsed = JSON.parse(cached);
                    apply(key, parsed.close, parsed.prev);
                    anyStaleFromCache = true;
                }
            } catch (_) {}
        }
    };
    await Promise.all(Object.entries(symbols).map(([k, s]) => fetchOne(k, s)));
    setStamp(anyFresh ? 'proxy' : anyStaleFromCache ? 'cached' : 'unavailable');
}

function renderError(e) {
    const main = $('main');
    const err = e && e.message ? e.message : String(e);
    main.innerHTML = `
      <div class="ov2-panel ov2-error-panel" style="margin:32px auto; max-width:600px;">
        <div class="ov2-panel-accent" style="background:var(--ov2-neg)"></div>
        <div class="ov2-eyebrow" style="color:var(--ov2-neg)">שגיאת טעינת נתונים</div>
        <div class="ov2-title-m" style="margin:8px 0;">לא הצלחתי לטעון את הנתונים</div>
        <pre style="background:var(--ov2-bg-2); padding:12px; border-radius:6px; font-size:12px; overflow:auto; color:var(--ov2-text-1); border:1px solid var(--ov2-border); direction:ltr; text-align:left;">${err}</pre>
        <div class="ov2-panel-footer">
          לבדוק: (1) שיש שרת רץ (לא file://); (2) שהנתיב <code>../data/</code> נכון;
          (3) שיש קבצי CSV ב-<code>data/</code>.
        </div>
      </div>`;
}

function hideLoading() { $('loading').style.display = 'none'; }

// ─── Bootstrap ────────────────────────────────────────────────────────

async function init() {
    try {
        const data = await loadData();
        const dailyState = await fetchJSON(`${DATA_BASE}/daily_state.json`).catch(() => null);
        const uoaDaily = await fetchJSON(`${DATA_BASE}/uoa_daily.json`).catch(() => null);   // phase 3.5
        const { todayM, hist, metrics, flowAnalytics } = computeMetrics(data);
        metrics._uoa = uoaDaily || null;

        // ── Single source of truth (phase-3.0 stage 2) ──
        // Trust the Python-computed scored brain (data/daily_state.json)
        // when it's present AND for the same trading day as the data we
        // loaded. Otherwise fall back to the live JS computation above —
        // zero regression if the file is missing or stale. This is what
        // lets phase 3.1-3.3 formula changes live in Python only and still
        // reach the dashboard without a JS edit.
        if (dailyState && dailyState.scores && dailyState.date === metrics.dataDate) {
            const s = dailyState.scores;
            if (s.tech != null)     metrics.techScore = s.tech;
            if (s.breadth != null)  metrics.breadthScore = s.breadth;
            if (s.flow != null)     metrics.flowScore = s.flow;
            if (s.combined != null) metrics.combined = s.combined;
            metrics._verdict = dailyState.verdict || null;   // pre-computed headline/lights
            metrics._flowWeight = dailyState.flowWeight || null;   // phase 3.1
            metrics._vixTermRatio = dailyState.vixTermRatio;       // phase 4b
            metrics._evidence = dailyState.evidence || null;      // phase 4b
            metrics._rotation = dailyState.rotation || null;      // review fix 2 (Rotation v2)
            metrics._pressure = dailyState.riskOff || null;       // pressure card redesign
        }

        const phaseResult = Regime.classifyPhase({
            combined: metrics.combined != null ? metrics.combined : 50,
            breadth5dDelta: metrics.breadth5dDelta,
            vix: metrics.vix,
            distributionDays: metrics.distributionDays,
            nhMinusNl: metrics.nhMinusNl,
            rsiThrust: metrics.rsiThrust,
            pctMa200: metrics.pctMa200,
            previousPhase: metrics.previousPhase
        });

        const duration = computeDaysInPhase(hist, data.sectors, phaseResult.phase.id);
        const chips = Regime.generateChips(metrics, 6);

        // Each render call is wrapped so a bug in ONE panel doesn't kill
        // the whole pipeline. Critical for the v3 page where many legacy
        // DOM elements are missing entirely and renderers that touch
        // them would otherwise throw and abort the chain (including the
        // v3 renderers below).
        const safe = (label, fn) => {
            try { fn(); } catch (err) { console.warn(`[render:${label}]`, err); }
        };
        safe('riskOff',      () => renderRiskOffBanner(metrics));
        safe('strip',        () => renderStrip(metrics, phaseResult));
        safe('eqTicker',     () => renderEqTicker(metrics, hist));
        safe('narrative',    () => renderNarrative(metrics, hist, phaseResult, duration));
        safe('macroTrail',   () => renderMacroTrail(hist));
        safe('echo',         () => renderHistoricalEcho(hist));
        safe('flowVsPrice',  () => renderFlowVsPrice(metrics, flowAnalytics, hist));
        safe('mcc',          () => renderMCC(phaseResult, metrics, chips, duration));
        safe('flowCard',     () => renderFlowCard(metrics, flowAnalytics));
        safe('synergy',      () => renderMarketFlowSynergy(phaseResult, metrics));
        safe('kpis',         () => renderKPIs(metrics));
        safe('sectorSnap',   () => renderSectorSnapshot(metrics, data.sectors));
        safe('dailySummary', () => renderDailySummary(phaseResult, metrics, chips, duration, data.sectors, hist, flowAnalytics));
        safe('alertsRail',   () => renderAlertsRail(chips, metrics));
        safe('liveTicker',   () => startLiveTicker(metrics));

        // Expose for console inspection
        window.__V2 = {
            data, metrics, phase: phaseResult, chips, duration,
            flowAnalytics,                          // full analytics object
            flowDebug: flowAnalytics.debug,         // chip fire decisions log
        };
        // Console-friendly debug print
        if (flowAnalytics.score != null) {
            console.log('=== FLOW DEBUG (v1.5) ===');
            console.log('Today (raw):', flowAnalytics.today);
            console.log('Today (EMA-smoothed):', flowAnalytics.ema);
            console.log('Baselines (last 22d):', flowAnalytics.baselines);
            console.log('Z-scores:', flowAnalytics.z);
            console.log('Flow score:', flowAnalytics.score);
            console.log('Chip decisions:');
            flowAnalytics.debug.forEach(d => console.log(`  [${d.fired ? 'FIRE' : '----'}] ${d.id}: ${d.reason}`));
        } else {
            console.warn('FLOW: no analytics — flowHistory empty or insufficient');
        }

        // V3 layout — populate the 7 sections if the v3 root is present.
        // index-v3.html has both the v3 IDs (above) and the legacy IDs
        // (hidden inside <details>) so the existing renderers fire too.
        if (document.getElementById('v3_root')) {
            try {
                renderV3Cards(metrics, phaseResult, data, hist, duration);
            } catch (v3err) {
                console.warn('renderV3Cards failed:', v3err);
            }
        }

        hideLoading();
    } catch (e) {
        console.error(e);
        hideLoading();
        renderError(e);
    }
}

// ═════════════════════════════════════════════════════════════════════
// V3 RENDERERS — populate the 7 sections on index-v3.html:
//   1. סטטוס השוק (status: bottom line + score + interpretation)
//   2. המלצות (recommendations)
//   3. טכנית  4. אופציות  5. סקטורים  6. מניות חמות
//   7. סיכום יומי (narrative)
// Reuses metrics + phase already computed by the standard pipeline —
// zero new computation, selection + formatting only.
// ═════════════════════════════════════════════════════════════════════
// ─── Score forward-tracking distribution (phase 3.4) ────────────────
// Reads data/score_forward.json (built in CI from scores_history) and
// groups the matured 20-day SPX returns by combined-score band, so we
// can see whether a high score actually preceded gains. Display-layer
// aggregation only — the forward returns themselves come from Python.
async function renderScoreForwardTable() {
    const el = document.getElementById('v3_scoreFwd');
    if (!el) return;
    let rows;
    try {
        rows = await fetchJSON(`${DATA_BASE}/score_forward.json`);
    } catch (_) {
        el.style.display = 'none';
        return;
    }
    const matured = (rows || []).filter(r => r && r.fwd20 != null && r.combined != null);
    if (matured.length < 3) {
        el.innerHTML = '<div class="v3-stocks-note">אין עדיין מספיק היסטוריה — הטבלה מתמלאת ככל שהציונים היומיים מבשילים (20 ימי מסחר קדימה). נדרשות לפחות 3 תבניות שהבשילו.</div>';
        return;
    }
    const BANDS = [
        { lo: 70, hi: 101, label: '70–100 (חזק)' },
        { lo: 55, hi: 70,  label: '55–70 (מתון)' },
        { lo: 30, hi: 55,  label: '30–55 (חלש)' },
        { lo: 0,  hi: 30,  label: '0–30 (שלילי)' },
    ];
    const median = arr => {
        const s = arr.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const body = BANDS.map(b => {
        const inB = matured.filter(r => r.combined >= b.lo && r.combined < b.hi);
        if (!inB.length) {
            return `<tr><td>${b.label}</td><td class="v3-muted">—</td><td class="v3-muted">—</td><td class="v3-muted">0</td></tr>`;
        }
        const rets = inB.map(r => r.fwd20);
        const med = median(rets);
        const hit = rets.filter(v => v > 0).length;
        const medCls = med > 0 ? 'v3-pos' : med < 0 ? 'v3-neg' : '';
        return `<tr>
            <td>${b.label}</td>
            <td class="${medCls}">${med >= 0 ? '+' : ''}${med.toFixed(2)}%</td>
            <td>${hit} מתוך ${inB.length}</td>
            <td>${inB.length}</td>
        </tr>`;
    }).join('');
    el.innerHTML = `
        <table class="v3-sector-table">
            <thead><tr>
                <th>טווח ציון משולב</th><th>חציון 20d</th><th>חיוביים</th><th>מדגם</th>
            </tr></thead>
            <tbody>${body}</tbody>
        </table>
        <div class="v3-stocks-note">כמה עלה/ירד SPX 20 ימי מסחר אחרי כל ציון, לפי טווח. מבוסס על ${matured.length} תבניות שהבשילו.</div>`;
}

// ─── Evidence Zone — 4 cards (one per status light), phase 4b ───────
// Each card: 2-3 numbers with a decision threshold beside each (iron
// rule) + a sparkline of the last 20 sessions from `hist`. The light
// tone comes from the single-source verdict; the display numbers from
// daily_state.evidence; the sparkline series from the loaded history.
function _lightColor(tone) {
    return tone === 'pos' ? '#10b981' : tone === 'warn' ? '#f59e0b'
         : tone === 'neg' ? '#ef4444' : '#94a3b8';
}
function _drawSpark(canvasId, data, color) {
    const el = document.getElementById(canvasId);
    if (!el || !window.Chart || !data || data.length < 2) return;
    if (el._chart) el._chart.destroy();
    el._chart = new Chart(el, {
        type: 'line',
        data: { labels: data.map((_, i) => i),
            datasets: [{ data, borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false }] },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } },
        },
    });
}
function renderV3Evidence(metrics, hist, data) {
    const lights = (metrics._verdict && metrics._verdict.lights) || {};
    const ev = metrics._evidence || {};
    const setDot = (id, tone) => {
        const el = document.getElementById(id);
        if (el) el.className = 'v3-ev-dot v3-light-' + (tone || 'na');
    };
    const num = (label, val, thr, tone) =>
        `<div class="v3-ev-num"><span class="v3-ev-num-label">${label}</span>`
        + `<span class="v3-ev-num-val ${tone || ''}">${val}</span>`
        + `<span class="v3-ev-num-thr">${thr}</span></div>`;
    const put = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

    // Series from the last 20 sessions of loaded history
    const recent = (hist || []).slice(-20);
    const px  = h => (h.m && h.m.macro && h.m.macro.spx) ? h.m.macro.spx.price : null;
    const spx = recent.map(px).filter(v => v != null);
    const brd = recent.map(h => (h.m && h.m.pctMa200 != null) ? h.m.pctMa200 : null).filter(v => v != null);
    const vixS = recent.map(h => (h.m && h.m.macro) ? h.m.macro.vix : null).filter(v => v != null);
    const spread = [];
    if (recent.length) {
        let eq = 100; const p0 = px(recent[0]);
        for (const h of recent) {
            const ac = h.m ? h.m.avgChange : null;
            if (ac != null) eq *= (1 + ac / 100);
            const p = px(h);
            if (p0 && p) spread.push(eq - (p / p0 * 100));
        }
    }

    // Trend
    setDot('v3_evDotTrend', lights.trend);
    let html = '';
    if (ev.spxPrice && ev.spxMa200) {
        const pct = (ev.spxPrice / ev.spxMa200 - 1) * 100;
        html += num('SPX מול MA200', `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`, 'מעל = מגמה חיובית', pct > 0 ? 'v3-pos' : 'v3-neg');
    }
    if (metrics.techScore != null) {
        html += num('ציון טכני', metrics.techScore, '≥60 חזק · <40 חלש',
            metrics.techScore >= 60 ? 'v3-pos' : metrics.techScore >= 40 ? 'v3-warn' : 'v3-neg');
    }
    put('v3_evTrend', html);
    _drawSpark('v3_evSparkTrend', spx, _lightColor(lights.trend));

    // Breadth
    setDot('v3_evDotBreadth', lights.breadth);
    html = '';
    if (ev.pctMa200 != null) {
        html += num('% מעל MA200', `${ev.pctMa200}%`, '>50% בריא · <40% חלש',
            ev.pctMa200 >= 50 ? 'v3-pos' : ev.pctMa200 >= 40 ? 'v3-warn' : 'v3-neg');
    }
    if (ev.nhCount != null && ev.nlCount != null) {
        html += num('שיאים / שפלים', `${ev.nhCount} / ${ev.nlCount}`, 'שיאים > שפלים = חיובי', ev.nhCount > ev.nlCount ? 'v3-pos' : 'v3-neg');
    }
    // Review fix 2 — the EQ500-vs-SPX 20d spread is a breadth measure
    // (equal-weight vs cap-weight participation), so it lives here now,
    // not in the Rotation card. From daily_state (single source), with a
    // fallback to the JS-computed series.
    const eqSpx = (ev.eqSpx20 != null) ? ev.eqSpx20
        : (spread.length ? spread[spread.length - 1] : null);
    if (eqSpx != null) {
        html += num('פער EQ-SPX (20 ימים)', `${eqSpx >= 0 ? '+' : ''}${eqSpx.toFixed(1)}%`, '>0 השתתפות רחבה · <-1% צר', eqSpx >= 0 ? 'v3-pos' : eqSpx > -1 ? 'v3-warn' : 'v3-neg');
    }
    put('v3_evBreadth', html);
    _drawSpark('v3_evSparkBreadth', brd, _lightColor(lights.breadth));

    // Volatility
    setDot('v3_evDotVol', lights.volatility);
    html = '';
    if (ev.vix != null) {
        html += num('VIX', ev.vix.toFixed(1), '<20 רגוע · >25 לחוץ', ev.vix < 20 ? 'v3-pos' : ev.vix < 25 ? 'v3-warn' : 'v3-neg');
    }
    if (metrics._vixTermRatio != null) {
        const r = metrics._vixTermRatio;
        html += num('VIX / VIX3M', r.toFixed(2), '<1 רגוע (contango) · ≥1 סטרס', r < 0.9 ? 'v3-pos' : r < 1 ? 'v3-warn' : 'v3-neg');
    }
    put('v3_evVol', html);
    _drawSpark('v3_evSparkVol', vixS, _lightColor(lights.volatility));

    // Rotation — review fix 2: TRUE sectoral rotation (cyclical vs
    // defensive leadership) from daily_state, not the old EQ-SPX spread.
    setDot('v3_evDotRot', lights.rotation);
    const rot = metrics._rotation;
    if (rot && Array.isArray(rot.leadingSectors)) {
        const cd = (data && data.sectors && data.sectors.codes) || {};
        const cyc = rot.cyclicalLeading || 0, def = rot.defensiveLeading || 0;
        let rHtml = num('סקטורים מחזוריים מובילים', String(cyc), '3+ = רוטציה בריאה',
            cyc >= 3 ? 'v3-pos' : (def >= 2 && cyc <= 1) ? 'v3-neg' : 'v3-warn');
        rHtml += num('סקטורים דפנסיביים מובילים', String(def), 'הובלה דפנסיבית = סיכון-off',
            def >= 2 && cyc <= 1 ? 'v3-neg' : 'v3-warn');
        const names = (rot.leadingSectors || []).map(c => cd[c] || c).join(' · ') || '—';
        rHtml += `<div class="v3-ev-num"><span class="v3-ev-num-label">מובילים</span>`
            + `<span class="v3-ev-num-thr" style="text-align:right">${names}</span></div>`;
        put('v3_evRot', rHtml);
    } else {
        put('v3_evRot', '<div class="v3-ev-num"><span class="v3-ev-num-thr">אין מספיק היסטוריה</span></div>');
    }
    const rotSeries = (rot && Array.isArray(rot.series)) ? rot.series : [];
    _drawSpark('v3_evSparkRot', rotSeries, _lightColor(lights.rotation));
}

function renderV3Cards(metrics, phaseResult, data, hist, duration) {
    // Single verdict pipeline owns the main-screen bottom line: headline,
    // subline, tone, status-lights, and the Action list. When the Python
    // single-source verdict is present (metrics._verdict from
    // daily_state.json) we render IT directly — only the Action list is
    // still assembled in JS. Otherwise Verdict.build computes live.
    if (window.Verdict) {
        try {
            const v = metrics._verdict
                ? Object.assign({}, metrics._verdict, {
                      actions: (typeof computeRecommendations === 'function')
                          ? computeRecommendations(metrics, phaseResult).slice(0, 4) : [],
                  })
                : window.Verdict.build(metrics, phaseResult);
            window.Verdict.render(v);
        } catch (e) { console.warn('[v3:verdict]', e); }
    }
    renderV3Status(metrics, phaseResult);   // score panel only now
    renderV3Evidence(metrics, hist, data);        // phase 4b — 4 cards + sparklines
    renderV3ActionZone(metrics, data);      // phase 4c — leading-sector movers
    renderV3TechCard(metrics);
    renderV3OptionsCard(metrics);
    renderV3SectorsCard(metrics, data && data.sectors);
    renderV3StocksCard(data);
    renderV3UoaConfirmation(metrics, data);   // phase 2.5b — UOA confirmation/divergence
    renderV3DailySummary(metrics, hist, phaseResult, duration);
    renderV3TrendCard();
    renderScoreForwardTable();   // phase 3.4 — async, fills when history matures
}

// ─── 1. Status score panel — combined score + phase + interpretation ──
// The headline / subline / tone / status-lights on the LEFT of this strip
// are now owned by the single verdict pipeline (v2/verdict.js →
// Verdict.render). This function only fills the SCORE side, so there's
// exactly one source of the bottom line. See phase-1.2.
function renderV3Status(metrics, phaseResult) {
    // Score + phase + adaptive interpretation (right side of the strip)
    const c = metrics.combined;
    const scoreEl = document.getElementById('v3_scoreBig');
    const phaseEl = document.getElementById('v3_phaseLabel');
    const confEl  = document.getElementById('v3_phaseConf');
    const interpEl = document.getElementById('v3_scoreInterp');
    if (scoreEl) {
        scoreEl.textContent = c != null ? c : '—';
        // Phase 4a — colour the big Regime score by the verdict tone
        // (from daily_state when present, else derived from the score).
        const tone = (metrics._verdict && metrics._verdict.tone)
            || (c == null ? '' : c >= 70 ? 'pos' : c >= 40 ? 'warn' : 'neg');
        scoreEl.className = 'v3-score-big' + (tone ? ' v3-score-' + tone : '');
    }
    if (phaseEl && phaseResult && phaseResult.phase) {
        phaseEl.textContent = phaseResult.phase.labelHe || phaseResult.phase.labelEn || '—';
    }
    if (confEl && phaseResult) {
        confEl.textContent = `ביטחון בסיווג: ${phaseResult.confidence || 0}%`;
    }
    if (interpEl) {
        const sentence = (typeof buildScoreInterpretation === 'function')
            ? buildScoreInterpretation(metrics)
            : null;
        interpEl.innerHTML = sentence || '—';
    }
}

// ─── 2. Recommendations — "what to do today" action list ────────────
//
// Pulls from three existing engines (no new logic):
//   a. Risk-Off reasons (when active) — defensive items first
//   b. Synergy panel's q3Items (phase × flow alignment actions)
//   c. The regime phase's positioning bias as a closing line
// Tone classes color each item: neg (defensive), warn (caution),
// pos (constructive).
// Pure: builds the deduped, capped recommendation list. Consumed by the
// verdict pipeline (v2/verdict.js) for the main-screen Action list and
// available to any drill-down that wants the full set. No DOM writes.
function computeRecommendations(metrics, phaseResult) {
    const items = [];   // {text, tone}

    // a. Risk-off → defensive recommendations take the top slots.
    // Acute (same-day event) = hard stop. Background (accumulation only)
    // = a softer caution, not "no exposure today" on a green day.
    const ro = metrics.riskOff;
    if (ro && ro.active && ro.acute) {
        items.push({ text: '⛔ לא להוסיף חשיפה היום — יום סיכון פעיל', tone: 'neg' });
        items.push({ text: '☞ להדק stop-loss על פוזיציות קיימות', tone: 'neg' });
    } else if (ro && ro.active) {
        items.push({ text: '⚠️ לחץ מכירות מצטבר בחודש האחרון — להוסיף חשיפה בזהירות ובמנות קטנות', tone: 'warn' });
    }

    // b. Synergy q3 items — phase × flow derived actions
    try {
        const analysis = analyzeMarketFlow(phaseResult, metrics);
        const content = buildSynergyContent(
            phaseResult, metrics, analysis.flowLean, analysis.alignment, analysis.signals);
        for (const q3 of (content.q3Items || [])) {
            // q3 items arrive with a leading "☞ " — keep as-is
            const tone = /הגנה|סיכון|לא ל|זהירות|אזהרה/.test(q3) ? 'warn' : 'pos';
            items.push({ text: q3, tone });
        }
    } catch (err) {
        console.warn('[v3:recs] synergy unavailable:', err);
    }

    // c. Phase bias as the closing positioning line
    if (phaseResult && phaseResult.phase && phaseResult.phase.bias) {
        items.push({ text: `🧭 הטיית פוזיציה לפי המשטר: ${phaseResult.phase.bias}`, tone: '' });
    }

    if (items.length === 0) {
        items.push({ text: 'אין המלצות מיוחדות — להמשיך לפי התוכנית הקיימת', tone: '' });
    }

    // Dedupe (risk-off items can overlap q3 defensive items) + cap at 6
    const seen = new Set();
    return items.filter(i => {
        const key = i.text.replace(/^[⛔☞🧭⚠️]\s*/, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 6);
}

// ─── 7. Daily summary — the Hebrew story (narrative.js) ─────────────
function renderV3DailySummary(metrics, hist, phaseResult, duration) {
    const headEl = document.getElementById('v3_summaryHeadline');
    if (!headEl || !window.Narrative) return;
    try {
        const out = window.Narrative.build(metrics, hist, phaseResult, duration);
        headEl.textContent = out.headline && out.headline.metaLabel || '—';
        const set = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text || '—';
        };
        set('v3_summaryRationale', out.headline && out.headline.rationale);
        set('v3_summaryToday', out.today);
        set('v3_summaryWeek', out.week);
        set('v3_summaryBackground', out.background);
        set('v3_summaryWatchFor',
            (out.watchFor && out.watchFor.length) ? out.watchFor.join(' · ') : 'אין רמות בולטות לעקוב כעת.');
    } catch (err) {
        console.warn('[v3:summary] narrative unavailable:', err);
        headEl.textContent = '—';
    }
}

function renderV3TechCard(metrics) {
    const ul = document.getElementById('v3_techList');
    if (!ul) return;
    const spx = metrics.spx || {};
    const items = [];

    // SPX vs MAs
    const maStatus = [];
    if (spx.ma20)  maStatus.push(spx.price > spx.ma20  ? 'MA20 ✓' : 'MA20 ✗');
    if (spx.ma50)  maStatus.push(spx.price > spx.ma50  ? 'MA50 ✓' : 'MA50 ✗');
    if (spx.ma200) maStatus.push(spx.price > spx.ma200 ? 'MA200 ✓' : 'MA200 ✗');
    items.push({ label: 'SPX מול ממוצעים', val: maStatus.join(' · '), tone: '' });

    // 52W high
    if (spx.high52 != null) {
        const d = spx.high52;
        const tone = Math.abs(d) <= 5 ? 'v3-pos' : Math.abs(d) <= 15 ? '' : 'v3-warn';
        items.push({ label: 'מרחק משיא 52W', val: `${d.toFixed(2)}%`, tone });
    }

    // VIX level + 1d
    if (metrics.vix) {
        const v1d = metrics.vix1dPct;
        const tone = metrics.vix >= 25 ? 'v3-warn' : '';
        const v1dStr = v1d != null ? `${v1d >= 0 ? '+' : ''}${v1d.toFixed(1)}%` : '';
        items.push({ label: 'VIX', val: `${metrics.vix.toFixed(1)} ${v1dStr ? '(' + v1dStr + ')' : ''}`, tone });
    }

    // Distribution days
    if (metrics.distributionDays != null) {
        const dd = metrics.distributionDays;
        const tone = dd >= 5 ? 'v3-neg' : dd >= 4 ? 'v3-warn' : '';
        let extra = '';
        if (metrics.sellDaysRecent3 >= 2) extra = ` (${metrics.sellDaysRecent3} ב-3 ימים אחרונים ⚠)`;
        items.push({ label: 'ימי מכירות', val: `${dd}/25${extra}`, tone });
    }

    // SPX daily %change
    if (spx.chgPct != null) {
        const c = spx.chgPct;
        const tone = c > 0 ? 'v3-pos' : c < 0 ? 'v3-neg' : '';
        items.push({ label: 'שינוי SPX היום', val: `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`, tone });
    }

    // ── Extended-view rows (hidden when the columns aren't in the CSV) ──
    // SPX numeric RSI — the classic momentum oscillator on the index itself.
    if (spx.rsi != null) {
        const tone = spx.rsi < 30 ? 'v3-warn' : spx.rsi > 70 ? 'v3-warn' : '';
        const zone = spx.rsi < 30 ? ' (oversold)' : spx.rsi > 70 ? ' (overbought)' : '';
        items.push({ label: 'RSI של SPX (14 ימים)', val: `${spx.rsi.toFixed(1)}${zone}`, tone });
    }
    // Up/Down volume — institutional pressure read. 3:1+ either way is
    // a meaningful day; 9:1 is panic / thrust territory.
    if (metrics.udVolRatio != null) {
        const r = metrics.udVolRatio;
        let tone = '', note = '';
        if (r >= 3)       { tone = 'v3-pos'; note = r >= 9 ? ' — יום דחף!' : ' — קונים שולטים'; }
        else if (r <= 1/3) { tone = 'v3-neg'; note = r <= 1/9 ? ' — יום פאניקה!' : ' — מוכרים שולטים'; }
        const valStr = r >= 1
            ? `${r.toFixed(1)} : 1 לעולות${note}`
            : `1 : ${(1 / r).toFixed(1)} ליורדות${note}`;
        items.push({ label: 'נפח עולות מול יורדות', val: valStr, tone });
    }
    // Cross-sectional RSI — median + precise oversold/overbought counts.
    if (metrics.medianRsi != null) {
        items.push({
            label: 'RSI חציוני (504 מניות)',
            val: `${metrics.medianRsi.toFixed(0)} · ${metrics.oversoldNum} oversold · ${metrics.overboughtNum} overbought`,
            tone: '',
        });
    }

    ul.innerHTML = items.map(i =>
        `<li><span class="v3-stat-label">${i.label}</span><span class="v3-stat-val ${i.tone}">${i.val}</span></li>`
    ).join('');
}

// ─── Quick numbers strip on the main tab ────────────────────────────
function renderV3QuickStrip(metrics) {
    const toneOf = v => v == null ? '' : v >= 70 ? 'v3-pos' : v >= 40 ? 'v3-warn' : 'v3-neg';
    const set = (id, val, tone) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = val;
        el.className = 'v3-quick-val ' + (tone || '');
    };
    set('v3_qsTech', metrics.techScore != null ? metrics.techScore : '—', toneOf(metrics.techScore));
    set('v3_qsFlow', metrics.flowScore != null ? metrics.flowScore : '—', toneOf(metrics.flowScore));
    set('v3_qsBreadth', metrics.breadthScore != null ? metrics.breadthScore : '—', toneOf(metrics.breadthScore));
    // KNN cell filled async by renderV3TrendCard's fetch (see below)
}

function renderV3OptionsCard(metrics) {
    const scoreEl = document.getElementById('v3_flowScore');
    const labelEl = document.getElementById('v3_flowLabel');
    const confEl  = document.getElementById('v3_flowConfidence');
    const ul = document.getElementById('v3_flowContext');
    if (!ul) return;
    const f = metrics.flow;
    const fScore = metrics.flowScore;
    if (scoreEl) scoreEl.textContent = fScore != null ? fScore : '—';
    if (labelEl) {
        const lab = (typeof classifyByScore === 'function' && f && f.raw)
            ? classifyByScore(fScore, f.raw)
            : null;
        labelEl.textContent = lab ? `${lab.emoji} ${lab.label}` : '—';
    }
    if (confEl && metrics.flowCoverage) {
        const mid = Math.round(metrics.flowCoverage.midPct || 0);
        if (mid >= 80) confEl.innerHTML = `<span class="v3-neg">⛔ ${mid}% Mid — ביטחון נמוך</span>`;
        else if (mid >= 70) confEl.innerHTML = `<span class="v3-warn">⚠ ${mid}% Mid — ביטחון מוגבל</span>`;
        else if (mid >= 50) confEl.innerHTML = `<span class="v3-warn">${mid}% Mid (בלוקים)</span>`;
        else confEl.textContent = `${mid}% Mid · ביטחון תקין`;
    }

    const items = [];
    // Phase 3.1 — effective Flow weight in the combined score (from the
    // single-source daily_state). Low weight = most premium was Mid, so
    // Flow was trusted less. Default 35% when no dynamic value is present.
    if (metrics._flowWeight && metrics._flowWeight.effective != null) {
        const wPct = Math.round(metrics._flowWeight.effective * 100);
        const midPct = metrics._flowWeight.midShare != null
            ? Math.round(metrics._flowWeight.midShare * 100) : null;
        items.push({
            label: 'משקל Flow בציון היום',
            val: midPct != null ? `${wPct}% · ${midPct}% מהפרמיה ב-Mid` : `${wPct}%`,
            tone: wPct < 20 ? 'v3-warn' : '',
        });
    }
    if (f && f.raw) {
        const cAsk = f.raw.callAskP || 0;
        const cBid = f.raw.callBidP || 0;
        const pAsk = f.raw.putAskP  || 0;
        const pBid = f.raw.putBidP  || 0;
        const fmtB = v => `$${(v / 1e9).toFixed(2)}B`;
        if (pBid >= 1e9) items.push({ label: '📥 כתיבת puts מסיבית', val: fmtB(pBid), tone: 'v3-pos' });
        if (pAsk >= 1e9) items.push({ label: '🛡 קניית puts אגרסיבית', val: fmtB(pAsk), tone: 'v3-neg' });
        if (cBid >= 1e9) items.push({ label: '🔻 כתיבת calls אגרסיבית', val: fmtB(cBid), tone: 'v3-neg' });
        if (cAsk >= 1e9) items.push({ label: '📈 קניית calls מסיבית', val: fmtB(cAsk), tone: 'v3-pos' });
        // Always show: directional call share
        if (metrics.flowCoverage && metrics.flowCoverage.directionalP) {
            const callDir = cAsk + cBid;
            const putDir  = pAsk + pBid;
            if (callDir + putDir > 0) {
                const share = callDir / (callDir + putDir) * 100;
                items.push({
                    label: 'חלוקה (Ask+Bid, ללא Mid)',
                    val: `${share.toFixed(0)}% calls · ${(100 - share).toFixed(0)}% puts`,
                    tone: '',
                });
            }
        }
    }
    if (items.length === 0) {
        items.push({ label: 'אין סיגנלים חריגים', val: '—', tone: 'v3-muted' });
    }
    ul.innerHTML = items.map(i =>
        `<li><span class="v3-stat-label">${i.label}</span><span class="v3-stat-val ${i.tone}">${i.val}</span></li>`
    ).join('');
}

function renderV3SectorsCard(metrics, sectorsMap) {
    const tbody = document.querySelector('#v3_sectorTable tbody');
    const stats = document.getElementById('v3_sectorStats');
    if (!tbody || !metrics.sectors) return;
    // Sector rows carry a `code` (e.g. "IT"); the Hebrew display names
    // live in sectors.json's `codes` map — same translation the legacy
    // heatmap uses.
    const codes = (sectorsMap && sectorsMap.codes) || {};
    const nameOf = s => codes[s.code] || s.code || '—';
    const sorted = [...metrics.sectors].sort((a, b) => b.avgChg - a.avgChg);
    const hasAlpha = sorted.some(s => s.avgAlpha != null);
    // Phase 2.5b — net UOA (unusual options) direction per sector: does
    // the smart money back this sector's strength, or fade it?
    const uoaBySec = (metrics._uoa && metrics._uoa.bySector) || {};
    const hasUoa = Object.keys(uoaBySec).length > 0;
    tbody.innerHTML = sorted.map(s => {
        const avg = s.avgChg;
        let bg = '#f7fafc', color = '#4a5568';
        if (avg >= 0.5)        { bg = '#d1fae5'; color = '#065f46'; }
        else if (avg >= 0.1)   { bg = '#ecfdf5'; color = '#047857'; }
        else if (avg >= -0.1)  { bg = '#f7fafc'; color = '#4a5568'; }
        else if (avg >= -0.5)  { bg = '#fef3c7'; color = '#92400e'; }
        else                   { bg = '#fee2e2'; color = '#991b1b'; }
        const sign = avg >= 0 ? '+' : '';
        // Long-term leadership tilt (avg Wtd Alpha) as a third column —
        // a sector can be red today but still own the year (and vice
        // versa). Muted color so it doesn't compete with the daily move.
        let alphaCell = '';
        if (hasAlpha) {
            const a = s.avgAlpha;
            const aTxt = a == null ? '—' : `${a >= 0 ? '+' : ''}${a.toFixed(0)}α`;
            const aColor = a == null ? '#a0aec0' : a >= 0 ? '#047857' : '#991b1b';
            alphaCell = `<td style="color:${aColor};font-size:11px;opacity:0.85;" title="ממוצע Wtd Alpha — מנהיגות שנתית מול המדד">${aTxt}</td>`;
        }
        let uoaCell = '';
        if (hasUoa) {
            const su = uoaBySec[s.code];
            if (su && su.net) {
                const netM = su.net / 1e6;
                const uColor = su.dir === 'Call' ? '#047857' : '#991b1b';
                const dot = su.dir === 'Call' ? '🟢' : '🔴';
                uoaCell = `<td style="color:${uColor};font-size:11px;white-space:nowrap;" title="פעילות אופציות חריגה נטו — ${su.count} מניות בסקטור">${dot} ${netM >= 0 ? '+' : '−'}$${Math.abs(netM).toFixed(0)}M</td>`;
            } else {
                uoaCell = `<td style="color:#cbd5e0;font-size:11px;">—</td>`;
            }
        }
        return `<tr style="background:${bg};">
            <td style="color:${color};">${nameOf(s)}</td>
            <td style="color:${color};">${sign}${avg.toFixed(2)}%</td>
            ${alphaCell}
            ${uoaCell}
        </tr>`;
    }).join('');
    if (stats && sorted.length) {
        const leader = sorted[0], laggard = sorted[sorted.length - 1];
        const dispersion = leader.avgChg - laggard.avgChg;
        stats.innerHTML = `<b>מוביל:</b> ${nameOf(leader)} (${leader.avgChg >= 0 ? '+' : ''}${leader.avgChg.toFixed(2)}%) · <b>חלש:</b> ${nameOf(laggard)} (${laggard.avgChg.toFixed(2)}%) · פיזור ${dispersion.toFixed(1)}%`;
    }
}

// ─── 6. Hot stocks — momentum + unusual volume, not just daily % ────
//
// "Hot" = structurally strong AND moving today. Momentum score mirrors
// the email's stock-picker weights:
//   above MA200 +30 · strong RSI +25 · RVOL>1.2 +20 · up today +15 ·
//   near 52W high (≥ -10%) +10. Ties broken by daily %change.
// Weak side = lowest momentum among stocks that are ALSO down today.
function renderV3StocksCard(data) {
    const topEl = document.getElementById('v3_stocksTop');
    const botEl = document.getElementById('v3_stocksBottom');
    if (!topEl || !botEl || !data || !data.today) return;
    const num = v => {
        const n = parseFloat(String(v == null ? '' : v).replace('%', '').replace('+', '').replace(',', ''));
        return Number.isFinite(n) ? n : null;
    };
    const STRONG_RSI = new Set(['Above 70', 'New Above 70', 'Above 50', 'New Above 50']);
    const stocks = data.today
        .filter(r => r.Symbol && !String(r.Symbol).startsWith('$') && String(r.Symbol).trim() !== 'RSP')
        .map(r => {
            const latest = num(r.Latest);
            const ma200 = num(r['200D MA']);
            const chg = num(r['%Change']);
            const rvol = num(r['20D RelVol']) || 0;
            const w52 = num(r['52W %/High']);
            const alpha = num(r['Wtd Alpha']);
            let momentum = 0;
            if (latest != null && ma200 && latest > ma200) momentum += 30;
            if (STRONG_RSI.has(String(r['RSI Rank'] || '').trim())) momentum += 25;
            if (rvol > 1.2) momentum += 20;
            if (chg != null && chg > 0) momentum += 15;
            if (w52 != null && w52 >= -10) momentum += 10;
            // Long-term leadership (extended view) — a stock beating the
            // index over the year is a real leader, not a one-day pop.
            if (alpha != null && alpha >= 20) momentum += 10;
            return { sym: String(r.Symbol).trim(), chg, rvol, alpha, momentum };
        })
        .filter(s => s.chg != null && Math.abs(s.chg) < 50);

    const top5 = stocks.slice()
        .sort((a, b) => (b.momentum - a.momentum) || (b.chg - a.chg))
        .slice(0, 5);
    const bot5 = stocks.slice()
        .filter(s => s.chg < 0)
        .sort((a, b) => (a.momentum - b.momentum) || (a.chg - b.chg))
        .slice(0, 5);
    const li = (s, tone) => {
        const rvolBadge = s.rvol > 1.2 ? ` <span class="v3-muted" style="font-size:10px;">×${s.rvol.toFixed(1)}</span>` : '';
        const alphaBadge = (s.alpha != null && Math.abs(s.alpha) >= 20)
            ? ` <span class="v3-muted" style="font-size:10px;">${s.alpha >= 0 ? '+' : ''}${Math.round(s.alpha)}α</span>` : '';
        return `<li><span class="v3-stocks-sym">${s.sym}${rvolBadge}${alphaBadge}</span><span class="v3-stocks-chg ${tone}">${s.chg >= 0 ? '+' : ''}${s.chg.toFixed(2)}%</span></li>`;
    };
    topEl.innerHTML = top5.map(s => li(s, 'v3-pos')).join('') || '<li class="v3-muted">אין מועמדות היום</li>';
    botEl.innerHTML = bot5.map(s => li(s, 'v3-neg')).join('') || '<li class="v3-muted">אין מניות חלשות בולטות</li>';
}

// ─── Action Zone — top movers from the LEADING sectors (phase 4c) ───
// Reuses the hot-stock momentum score, but restricts to stocks whose
// sector is among today's top-3 by average change — so the main screen
// surfaces where leadership actually is. UOA badge is a placeholder
// until phase 3.5 wires data/uoa_daily.json.
//
// Leading sectors — review fix 2 (Rotation v2): prefer the persistent
// Leading set from data/daily_state.json (RS>0 vs $SPX on BOTH 5d & 20d),
// so the Action Zone tracks real, durable leadership instead of "whoever
// popped today". Falls back to top-3-by-today's-move if daily_state is
// missing/stale (matches the scores fallback in init()).
function v3LeadingSet(metrics) {
    const lead = metrics._rotation && metrics._rotation.leadingSectors;
    if (Array.isArray(lead) && lead.length) return new Set(lead);
    return new Set((metrics.sectors || []).slice()
        .sort((a, b) => b.avgChg - a.avgChg).slice(0, 3).map(s => s.code));
}
function renderV3ActionZone(metrics, data) {
    const el = document.getElementById('v3_actionList');
    if (!el || !data || !data.today) return;
    const sm = data.sectors || {};
    const tickers = sm.tickers || {};
    const codes = sm.codes || {};
    const leading = v3LeadingSet(metrics);
    const persistent = !!(metrics._rotation && (metrics._rotation.leadingSectors || []).length);
    const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[%+,]/g, '')); return Number.isFinite(n) ? n : null; };
    const STRONG_RSI = new Set(['Above 70', 'New Above 70', 'Above 50', 'New Above 50']);
    const stocks = data.today
        .filter(r => r.Symbol && !String(r.Symbol).startsWith('$') && String(r.Symbol).trim() !== 'RSP')
        .map(r => {
            const sym = String(r.Symbol).trim();
            const latest = num(r.Latest), ma200 = num(r['200D MA']), chg = num(r['%Change']);
            const rvol = num(r['20D RelVol']) || 0, w52 = num(r['52W %/High']), alpha = num(r['Wtd Alpha']);
            let m = 0;
            if (latest != null && ma200 && latest > ma200) m += 30;
            if (STRONG_RSI.has(String(r['RSI Rank'] || '').trim())) m += 25;
            if (rvol > 1.2) m += 20;
            if (chg != null && chg > 0) m += 15;
            if (w52 != null && w52 >= -10) m += 10;
            if (alpha != null && alpha >= 20) m += 10;
            return { sym, chg, rvol, alpha, momentum: m, sector: tickers[sym] };
        })
        .filter(s => s.chg != null && Math.abs(s.chg) < 50 && s.sector && leading.has(s.sector));
    const top = stocks.sort((a, b) => (b.momentum - a.momentum) || (b.chg - a.chg)).slice(0, 5);
    if (!top.length) {
        el.innerHTML = '<div class="v3-stocks-note">אין מועמדות בולטות מהסקטורים המובילים.</div>';
        return;
    }
    const uoaMap = (metrics._uoa && metrics._uoa.symbols) || {};
    const rows = top.map(s => {
        const secName = codes[s.sector] || s.sector;
        const badges = [];
        if (s.rvol > 1.2) badges.push(`×${s.rvol.toFixed(1)}`);
        if (s.alpha != null && Math.abs(s.alpha) >= 20) badges.push(`${s.alpha >= 0 ? '+' : ''}${Math.round(s.alpha)}α`);
        // Phase 3.5 — UOA badge: unusual options activity direction + Vol/OI
        let uoaBadge = '';
        const u = uoaMap[s.sym];
        if (u) {
            const cls = u.dir === 'Call' ? 'v3-pos' : 'v3-neg';
            const arrow = u.dir === 'Call' ? '📈' : '📉';
            uoaBadge = `<span class="v3-action-uoa ${cls}" title="פעילות אופציות חריגה — ${u.dir} · Vol/OI מקס׳ ${u.volOiMax}">UOA ${arrow} ×${u.volOiMax}</span>`;
        }
        return `<div class="v3-action-row">
            <span class="v3-action-sym">${s.sym}</span>
            <span class="v3-action-sector">${secName}</span>
            <span class="v3-action-meta">${badges.join(' · ')}</span>
            ${uoaBadge}
            <span class="v3-action-chg ${s.chg >= 0 ? 'v3-pos' : 'v3-neg'}">${s.chg >= 0 ? '+' : ''}${s.chg.toFixed(2)}%</span>
        </div>`;
    }).join('');
    const leadNames = [...leading].map(c => codes[c] || c).join(' · ');
    const leadLabel = persistent
        ? `סקטורים מובילים (עוצמה יחסית מול S&P על 5 ו-20 ימים): ${leadNames}`
        : `מהסקטורים המובילים היום: ${leadNames}`;
    el.innerHTML = rows +
        `<div class="v3-stocks-note">${leadLabel}. מומנטום = מעל MA200 + RSI חזק + נפח חריג + מנהיגות שנתית.</div>`;
}

// ─── UOA confirmation / divergence (phase 2.5b) ─────────────────────
// Connects unusual options activity to STRENGTH: among technically
// strong stocks (above MA200) in today's LEADING sectors, which have
// bullish UOA (✅ conviction) vs bearish Puts (⚠️ the smart money fading
// a strong name — the divergences are the valuable part). Sectors tab.
function renderV3UoaConfirmation(metrics, data) {
    const el = document.getElementById('v3_uoaConfirm');
    if (!el) return;
    const uoa = (metrics._uoa && metrics._uoa.symbols) || {};
    if (!Object.keys(uoa).length) { el.style.display = 'none'; return; }
    el.style.display = '';
    const sm = data.sectors || {}, tk = sm.tickers || {}, cd = sm.codes || {};
    const leading = v3LeadingSet(metrics);   // review fix 2 — persistent RS leaders
    const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[%+,]/g, '')); return Number.isFinite(n) ? n : null; };
    const strength = {};
    for (const r of (data.today || [])) {
        const sym = (r.Symbol || '').trim();
        if (!sym || sym.startsWith('$')) continue;
        strength[sym] = { chg: num(r['%Change']), ma200: num(r['200D MA']), latest: num(r.Latest), sector: tk[sym] };
    }
    const confirm = [], diverge = [];
    for (const sym of Object.keys(uoa)) {
        const u = uoa[sym], st = strength[sym];
        if (!st || !st.sector || !leading.has(st.sector)) continue;   // leading sectors only
        if (!(st.ma200 && st.latest > st.ma200)) continue;            // technically strong only
        const rec = { sym, sec: cd[st.sector] || st.sector, chg: st.chg || 0, dir: u.dir, volOi: u.volOiMax };
        (u.dir === 'Call' ? confirm : diverge).push(rec);
    }
    confirm.sort((a, b) => b.volOi - a.volOi);
    diverge.sort((a, b) => b.volOi - a.volOi);
    const row = (r, tone) => `<div class="v3-uoa-row">
        <span class="v3-uoa-sym">${r.sym}</span>
        <span class="v3-uoa-sec">${r.sec}</span>
        <span class="v3-uoa-chg ${r.chg >= 0 ? 'v3-pos' : 'v3-neg'}">${r.chg >= 0 ? '+' : ''}${r.chg.toFixed(2)}%</span>
        <span class="v3-uoa-tag ${tone}">${r.dir === 'Call' ? '📈' : '📉'} ×${r.volOi}</span>
    </div>`;
    el.innerHTML =
        `<div class="v3-uoa-col">
            <div class="v3-uoa-head v3-pos">✅ אישור — כסף חכם שורי על מניות חזקות (${confirm.length})</div>
            ${confirm.slice(0, 8).map(r => row(r, 'v3-pos')).join('') || '<div class="v3-stocks-note">אין</div>'}
        </div>
        <div class="v3-uoa-col">
            <div class="v3-uoa-head v3-neg">⚠️ סתירה — Puts על מניה חזקה בסקטור מוביל (${diverge.length})</div>
            ${diverge.slice(0, 8).map(r => row(r, 'v3-neg')).join('') || '<div class="v3-stocks-note">אין סתירות — הכסף החכם מאשר את החוזק</div>'}
        </div>
        <div class="v3-stocks-note">רק מניות מעל MA200 בסקטורים המובילים (עוצמה יחסית מתמשכת מול S&P). סתירה = Puts חריגים על מניה חזקה — הכסף הגדול מהמר נגד.</div>`;
}

function renderV3TrendCard() {
    // Reads forward_snapshots.json directly — keeps the dependency
    // chain shallow. Surfaces the latest snapshot's match-quality and
    // 20d outcome IF the matches are trustworthy.
    const ul = document.getElementById('v3_trendList');
    if (!ul) return;
    fetch('data/forward_snapshots.json?t=' + Date.now(), { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
            if (!d || !d.snapshots || !d.snapshots.length) {
                ul.innerHTML = '<li><span class="v3-stat-label">אין נתוני snapshots</span></li>';
                return;
            }
            const snap = d.snapshots[d.snapshots.length - 1];
            const THRESHOLD = 1.0;
            const MIN_GOOD = 7;
            const matches = snap.matches || [];
            const good = matches.filter(m => m.distance != null && m.distance <= THRESHOLD).length;
            const out20 = (snap.outcomes && snap.outcomes['20']) || {};
            // Quick-strip KNN cell on the main tab
            const qs = document.getElementById('v3_qsKnn');
            if (qs) {
                const out20q = (snap.outcomes && snap.outcomes['20']) || {};
                if (good < MIN_GOOD) {
                    qs.textContent = 'אין התאמות';
                    qs.className = 'v3-quick-val v3-muted';
                } else if (out20q.hitRate != null && out20q.hitRate >= 0.4 && out20q.hitRate <= 0.6) {
                    qs.textContent = 'אין יתרון';
                    qs.className = 'v3-quick-val v3-muted';
                } else if (out20q.median != null) {
                    qs.textContent = `${out20q.median >= 0 ? '+' : ''}${out20q.median.toFixed(1)}%`;
                    qs.className = 'v3-quick-val ' + (out20q.median > 0 ? 'v3-pos' : 'v3-neg');
                }
            }

            const items = [];
            items.push({ label: 'תאריך זיהוי', val: snap.anchorDate || '—', tone: '' });
            items.push({ label: 'התאמות תקפות', val: `${good}/10 במרחק ≤ ${THRESHOLD}`, tone: good >= MIN_GOOD ? 'v3-pos' : 'v3-neg' });
            // Year spread of matches — a set drawn entirely from one
            // old era (e.g. all pre-2020) reads very differently from
            // a mix that includes recent market structure.
            const years = matches.map(m => (m.date || '').slice(0, 4)).filter(Boolean);
            if (years.length) {
                const yMin = years.reduce((a, b) => a < b ? a : b);
                const yMax = years.reduce((a, b) => a > b ? a : b);
                items.push({ label: 'טווח שנות ההתאמות', val: yMin === yMax ? yMin : `${yMin}-${yMax}`, tone: '' });
            }
            if (good < MIN_GOOD) {
                items.push({ label: '⛔ סטטוס', val: 'המצב נדיר היסטורית', tone: 'v3-neg' });
                items.push({ label: 'המלצה', val: 'להישען על הקלפים האחרים', tone: 'v3-warn' });
            } else if (out20.hitRate != null && out20.hitRate >= 0.4 && out20.hitRate <= 0.6) {
                // Dead-zone: analogs split ~evenly — say "no edge" rather
                // than presenting a direction-less median as a signal.
                const dzN = out20.samples || 0;
                items.push({ label: 'אינדיקציה 20 ימים', val: `אין יתרון סטטיסטי (${Math.round(out20.hitRate * dzN)} מתוך ${dzN})`, tone: 'v3-muted' });
            } else if (out20.median != null) {
                items.push({ label: 'חציון 20 ימים', val: `${out20.median >= 0 ? '+' : ''}${out20.median.toFixed(2)}%`, tone: out20.median > 0 ? 'v3-pos' : 'v3-neg' });
                if (out20.min != null && out20.max != null) {
                    items.push({ label: 'טווח', val: `${out20.min.toFixed(2)}% עד ${out20.max.toFixed(2)}%`, tone: '' });
                }
                if (out20.hitRate != null && out20.samples) {
                    items.push({ label: 'מקרים חיוביים', val: `${Math.round(out20.hitRate * out20.samples)} מתוך ${out20.samples}`, tone: '' });
                }
            }
            ul.innerHTML = items.map(i =>
                `<li><span class="v3-stat-label">${i.label}</span><span class="v3-stat-val ${i.tone}">${i.val}</span></li>`
            ).join('');
        })
        .catch(() => {
            ul.innerHTML = '<li><span class="v3-stat-label">שגיאה בטעינת snapshots</span></li>';
        });
}

document.addEventListener('DOMContentLoaded', init);

})();
