/* ═══════════════════════════════════════════════════════════════════════
   OVERVIEW V2 · data loading + computation + rendering
   Depends on: regime.js (window.Regime)
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ─── Constants ────────────────────────────────────────────────────────

const DATA_BASE = 'data';
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
        rvol:  num(r['20D RelVol'])
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
    const url = 'https://corsproxy.io/?' + encodeURIComponent(yahooUrl);
    try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return {};
        const json = await r.json();
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
                high52: num(r['52W %/High'])
            };
        }
    }

    // Stocks
    const stocks = rows
        .filter(r => isStockRow(String(r.Symbol || '').trim()))
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

    const chgs = stocks.map(s => s.chg).filter(v => v !== null && v !== 0);
    const avgChange = chgs.length ? chgs.reduce((a,b) => a+b, 0) / chgs.length : null;
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
        if (!bySector[sec]) bySector[sec] = { total: 0, above200: 0, chgs: [], rvols: [] };
        const b = bySector[sec];
        b.total++;
        if (s.ma200 && s.latest > s.ma200) b.above200++;
        if (s.chg !== null) b.chgs.push(s.chg);
        if (s.rvol !== null) b.rvols.push(s.rvol);
    }
    const sectors = Object.entries(bySector).map(([code, d]) => ({
        code,
        total:    d.total,
        pct200:   d.total ? (d.above200 / d.total * 100) : 0,
        avgChg:   d.chgs.length ? d.chgs.reduce((a,b) => a+b, 0) / d.chgs.length : 0,
        avgRvol:  d.rvols.length ? d.rvols.reduce((a,b) => a+b, 0) / d.rvols.length : 0
    }));

    return {
        macro,
        total, a20, a50, a150, a200, golden,
        newHighs, newLows,
        oversold, overbought, strong, rsiAbove50, rsiThrust,
        avgChange, advancing, declining,
        pctMa200, pctMa50, pctMa20, pctGolden,
        healthScore,
        sectors
    };
}

// ─── Scoring ──────────────────────────────────────────────────────────

function scoreTech(spx) {
    if (!spx || spx.price == null) return null;
    let parts = 0, max = 0;
    const p = spx.price;
    if (spx.ma20)  { parts += p > spx.ma20  ? 15 : 5; max += 15; }
    if (spx.ma50)  { parts += p > spx.ma50  ? 20 : 5; max += 20; }
    if (spx.ma200) { parts += p > spx.ma200 ? 25 : 3; max += 25; }
    if (spx.ma20 && spx.ma50 && spx.ma200) {
        if (spx.ma20 > spx.ma50 && spx.ma50 > spx.ma200) parts += 15;
        else if (spx.ma20 < spx.ma50 && spx.ma50 < spx.ma200) parts += 0;
        else if (spx.ma20 > spx.ma50) parts += 10;
        else parts += 5;
        max += 15;
    }
    if (spx.high52 != null) {
        const d = Math.abs(spx.high52);
        parts += d <= 5 ? 10 : d <= 10 ? 7 : d <= 20 ? 4 : 1;
        max += 10;
    }
    if (spx.chgPct != null) {
        parts += spx.chgPct > 0.5 ? 5 : spx.chgPct >= -0.5 ? 3 : 0;
        max += 5;
    }
    if (max === 0) return null;
    return Math.max(0, Math.min(100, Math.round(parts / max * 100)));
}

function scoreBreadth(metrics) {
    // Mirror of MCC score logic — keep aligned with email_monitor logic
    const p200 = metrics.pctMa200 || 0;
    let parts = 0, max = 0;

    // MA200 component (25)
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
    }
    // RSI dispersion: avg of strong / oversold weighted
    if (metrics.total) {
        const rsi50pct = metrics.rsiAbove50 / metrics.total * 100;
        parts += rsi50pct >= 65 ? 10 : rsi50pct >= 50 ? 7 : rsi50pct >= 40 ? 4 : 1;
        max += 10;
    }
    if (max === 0) return null;
    return Math.max(0, Math.min(100, Math.round(parts / max * 100)));
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
    function scoreFromMetrics(r) {
        if (!r) return null;
        let s = 50;
        // A — P/C premium balance (dominant input)
        if (r.call_premium_pct != null && Number.isFinite(r.call_premium_pct)) {
            s += (r.call_premium_pct - 50) * 1.0;
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

    const score = scoreFromMetrics(today);

    // 5b. Each historical day's score is computed from its OWN flow
    //     metrics — no shared baseline, no z-scores. days[i].score is
    //     therefore reproducible from days[i].raw alone.
    for (let i = 0; i < days.length; i++) {
        days[i].score = scoreFromMetrics(days[i].raw);
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

    return { score, today, ema, z, baselines, days, debug };
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

    // Days since last "new low" appeared
    let daysSinceNewLow = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].m.newLows === 0) daysSinceNewLow++;
        else break;
    }

    // Scores
    const techScore = scoreTech(todayM.macro.spx);
    const breadthScore = scoreBreadth(todayM);
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
    if (hist.length >= 2) {
        const yest = hist[hist.length - 2];
        const yestAgo5 = hist[Math.max(0, hist.length - 7)];
        const yestBreadth5d = yestAgo5 ? (yest.m.pctMa200 - yestAgo5.m.pctMa200) : 0;
        const yestDist = hist.slice(-26, -1)
            .filter(h => h.m.avgChange != null && h.m.avgChange < -0.2).length;
        const yestTech = scoreTech(yest.m.macro.spx);
        const yestBreadth = scoreBreadth(yest.m);
        const yestCombined = combineScores(yestTech, null, yestBreadth);
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
    }

    // Composed metrics for regime + chips
    const metrics = {
        // Today scores
        techScore, flowScore, breadthScore, combined,

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
        daysSinceNewLow,

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
        const t = scoreTech(m.macro.spx);
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

function renderStrip(m, phase) {
    // Strip label is now derived FROM the combined score, not from the
    // regime classifier — they were disagreeing in the UI before (score
    // 75 sitting next to "זהיר" looked broken). The regime phase still
    // gets its own dedicated display in the MCC card below; the strip
    // is the executive view and consistency at the top trumps mixing.
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
    const top = ew.signals.slice(0, 3);
    let bullVotes = 0, bearVotes = 0, totalVotes = 0;
    for (const sig of top) {
        const card = document.createElement('div');
        const strong = sig.absD >= 0.7;
        card.className = 'ov2-echo-ew-signal' + (strong ? ' ov2-strong' : '');

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
            totalVotes++;
            const valSign = currentVal >= 0 ? '+' : '';
            const valStr = `${valSign}${currentVal.toFixed(2)}%`;
            let leaning, leaningClass;
            if (sig.interpret === 'bull_above') {
                if (currentVal >= sig.threshold) { leaning = 'נוטה חיובי'; leaningClass = 'pos'; bullVotes++; }
                else                              { leaning = 'נוטה אזהרה'; leaningClass = 'neg'; bearVotes++; }
            } else {
                if (currentVal <= sig.threshold) { leaning = 'נוטה חיובי'; leaningClass = 'pos'; bullVotes++; }
                else                              { leaning = 'נוטה אזהרה'; leaningClass = 'neg'; bearVotes++; }
            }
            liveBlock = `
                <div class="ov2-echo-ew-signal-live">
                    <span class="ov2-echo-ew-signal-live-label">ב-5 הימים האחרונים:</span>
                    <span class="ov2-echo-ew-signal-live-val">${valStr}</span>
                    <span class="ov2-echo-ew-signal-live-status ov2-${leaningClass}">${leaning}</span>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="ov2-echo-ew-signal-head">${sig.label}</div>
            <div class="ov2-echo-ew-signal-rule">${rule}</div>
            ${liveBlock}
            <div class="ov2-echo-ew-signal-stats">
                חיוביים (n=${sig.bullN}): ${sig.bullMean >= 0 ? '+' : ''}${sig.bullMean.toFixed(2)}% ·
                אחרים (n=${sig.bearN}): ${sig.bearMean >= 0 ? '+' : ''}${sig.bearMean.toFixed(2)}% ·
                Cohen d: ${signCD}${sig.cohensD.toFixed(2)} ${strong ? '— מובהקת' : '— בינונית'}
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
    let text;
    if (med > 1.0 && hit >= 0.6) {
        text = `${N} ימים דומים בעבר → השוק עלה ב-${(hit*100).toFixed(0)}% מהמקרים תוך 20 ימים, חציון +${med.toFixed(2)}%.`;
    } else if (med < -1.0 && hit <= 0.4) {
        text = `${N} ימים דומים בעבר → השוק ירד ב-${((1-hit)*100).toFixed(0)}% מהמקרים תוך 20 ימים, חציון ${med.toFixed(2)}%.`;
    } else {
        const sign = med >= 0 ? '+' : '';
        text = `${N} ימים דומים בעבר → תוצאה מעורבת: ${(hit*100).toFixed(0)}% חיוביים, חציון ${sign}${med.toFixed(2)}% תוך 20 ימים.`;
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

        // Sub-line — context about the sample
        const subEl = $('echoSub');
        if (subEl) {
            subEl.textContent =
                `${analysis.matches.length} ימים דומים מתוך ${analysis.sampleSize} ימי מסחר ב-10 השנים האחרונות. ` +
                `נכון ל-${fmtDate(analysis.asOfDate)}.`;
        }

        // Verdict — Hebrew summary sentence with state-aware coloring.
        // Anchored to 20d (the most "what's the trend" horizon) but
        // weighted by the hit rate so we don't overstate weak signals.
        const o20 = analysis.outcomes[20];
        const verdictEl = $('echoVerdict');
        if (verdictEl && o20 && o20.samples) {
            const med = o20.median;
            const hit = o20.hitRate;
            let phrase, stateClass;
            if (med > 1.0 && hit >= 0.6) {
                phrase = `נטייה היסטורית חיובית: ב-${(hit*100).toFixed(0)}% מהמקרים הדומים, השוק עלה תוך 20 ימים (חציון +${med.toFixed(2)}%).`;
                stateClass = 'ov2-pos';
            } else if (med < -1.0 && hit <= 0.4) {
                phrase = `נטייה היסטורית שלילית: ב-${((1-hit)*100).toFixed(0)}% מהמקרים הדומים, השוק ירד תוך 20 ימים (חציון ${med.toFixed(2)}%).`;
                stateClass = 'ov2-neg';
            } else {
                phrase = `תוצאה מעורבת: חציון תשואת 20 ימים ${med >= 0 ? '+' : ''}${med.toFixed(2)}%, ${(hit*100).toFixed(0)}% מהמקרים חיוביים. הטווח רחב — אין נטייה ברורה.`;
                stateClass = '';
            }
            verdictEl.textContent = phrase;
            verdictEl.className = 'ov2-echo-verdict ' + stateClass;
        }

        // 3-card horizon grid: 5d / 10d / 20d
        const horizonsEl = $('echoHorizons');
        if (horizonsEl) {
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
                        <div class="ov2-echo-horizon-meta">חציון · ${(o.hitRate*100).toFixed(0)}% חיובי</div>
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
        if (scenarioEl) {
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
                                <strong>${hitPct}%</strong> מהמקרים נסגרו בחיובי.
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

        // Match-chip list — each chip is the date, with a tooltip
        // describing the distance for the curious.
        const matchesEl = $('echoMatches');
        if (matchesEl) {
            matchesEl.innerHTML = '';
            for (const m of analysis.matches) {
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
                window.ForwardTracking.render(data.snapshots || [], hist);
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
        if (chgEl && Number.isFinite(dailyChgPct)) {
            const arrow = dailyChgPct > 0 ? '▲' : dailyChgPct < 0 ? '▼' : '─';
            const sign  = dailyChgPct > 0 ? '+' : '';
            chgEl.textContent = `${arrow} ${sign}${dailyChgPct.toFixed(2)}%`;
            chgEl.style.color = dailyChgPct > 0
                ? 'var(--ov2-pos)'
                : dailyChgPct < 0 ? 'var(--ov2-neg)' : 'var(--ov2-text-3)';
        } else if (chgEl) {
            chgEl.textContent = '—';
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
        const meaningHtml = c.meaning
            ? `<div class="ov2-alert-meaning">${c.meaning}</div>` : '';
        el.innerHTML = `
            <div class="ov2-alert-head">
                <span class="ov2-alert-icon">${iconFor(c.type)}</span>
                <span class="ov2-alert-title">${typeLabel} · ${c.category}</span>
            </div>
            <div class="ov2-alert-body">${c.text}</div>
            ${meaningHtml}
            <div class="ov2-alert-meta">
                <span>עדיפות ${c.priority}</span>
            </div>
        `;
        // Keep tooltip for additional hover context (some users prefer popover)
        if (c.meaning) el.setAttribute('data-tooltip', c.meaning);
        rail.appendChild(el);
    }

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

    // Top score block
    $('flowScoreVal').textContent = score != null ? score : '—';
    $('flowStatus').textContent = status;
    $('flowStatus').className = 'ov2-flow-status ' + statusClass;

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

    // ─── Aggressive direction interpretation (PREMIUM-WEIGHTED 6-quadrant) ───
    //
    // Premium-Ask% high  = aggressive BUYERS (paid up)
    // Premium-Ask% low   = aggressive SELLERS (hit bids)
    //
    // For calls:  high = bullish (buying)   · low = bearish OR short-vol (writing)
    // For puts:   high = bearish (hedging)  · low = bullish OR short-vol (writing)
    //
    // 6 quadrants:
    //   • Both high   → Long Volatility (buying premium both sides)
    //   • Both low    → Short Volatility (writing premium both sides) ← THIS IS TODAY
    //   • C-high P-low → Strong Bull (buy calls + write puts)
    //   • C-low  P-high → Strong Bear / Hedge (write calls + buy puts)
    //   • Mixed       → directional lean per side
    let aggInterpretation;
    const cAskPm = raw.callAskPremPct;
    const pAskPm = raw.putAskPremPct;
    const cAskTr = raw.callAskPct;
    const pAskTr = raw.putAskPct;

    let headline = '', meaning = '';
    if (cAskPm == null || pAskPm == null) {
        headline = 'אין מספיק עסקאות directional לקריאה ברורה';
    } else {
        const cHigh = cAskPm >= 60, cLow = cAskPm <= 40;
        const pHigh = pAskPm >= 60, pLow = pAskPm <= 40;

        if (cHigh && pLow) {
            headline = 'שורי חזק 📈';
            meaning = 'הכסף הגדול קונה calls וכותב puts — מהמרים על עלייה.';
        } else if (cLow && pHigh) {
            headline = 'הגנתי / דובי 📉';
            meaning = 'הכסף הגדול כותב calls וקונה puts — נערכים לירידה או הגנה.';
        } else if (cLow && pLow) {
            headline = 'Short Volatility — הימור על דשדוש ⚖️';
            meaning = 'הכסף הגדול מוכר פרמיה בשני הצדדים — לא מהמרים על כיוון, מהמרים על תנועה הצידה (שוק שלא יזוז משמעותית).';
        } else if (cHigh && pHigh) {
            headline = 'Long Volatility — צופים תנודה חזקה ⚡';
            meaning = 'הכסף הגדול קונה פרמיה בשני הצדדים — מצפים לזעזוע (כיוון לא ידוע).';
        } else if (cAskPm >= 55) {
            headline = 'שורי מתון 📈';
            meaning = 'נטייה לקנייה ב-calls, puts מאוזנים.';
        } else if (cAskPm <= 45) {
            headline = 'מטה למכירת calls 🔻';
            meaning = 'הכסף הגדול כותב calls — סימן ל-cap על העלייה.';
        } else if (pAskPm >= 55) {
            headline = 'דרישת הגנה 🛡';
            meaning = 'הכסף הגדול קונה puts, calls מאוזנים.';
        } else if (pAskPm <= 45) {
            headline = 'כותבי puts פעילים 📈';
            meaning = 'הכסף הגדול כותב puts — אופטימיות שקטה (סימן ל"השוק לא יירד").';
        } else {
            headline = 'מאוזן 🔄';
            meaning = 'אין דומיננטיות ברורה.';
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

    // Flow internal formula
    const zCall = z.call_premium_pct, zPCp = z.pc_premium, zNet = z.net_premium_pct, zSkew = z.iv_skew;
    const flowFormula = $('flowFormulaInternal');
    if (flowFormula) {
        const fmtZ = v => v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) + 'σ' : '—';
        flowFormula.innerHTML = `
            ציון Flow מתחיל מ-50 ועובר תיקונים:<br>
            <b>+ Call %</b> (${fmtZ(zCall)} × 12, capped ±25)
            <b>- P/C Premium</b> (${fmtZ(zPCp)} × 8, capped ±15)
            <b>+ Net Premium</b> (${fmtZ(zNet)} × 5, capped ±10)
            <b>- IV Skew</b> (${fmtZ(zSkew)} × 3, capped ±5)
            <br>= <b>${fScore != null ? fScore : '—'}/100</b>
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
    const flowLean = computeFlowLean(metrics);
    const alignment = classifyPhaseFlowAlignment(phase.phase.id, flowLean);
    const signals = generateCrossSignals(phase, metrics, flowLean);
    const narrative = buildSynergyNarrative(phase, alignment, flowLean, metrics);
    return { flowLean, alignment, signals, narrative };
}

// ─── Flow pattern classifier (shared between today + history) ───
// Same 9 quadrants used in the interpretation text.
function classifyFlowPattern(cAskPm, pAskPm) {
    if (cAskPm == null || pAskPm == null) return { id: 'unknown', label: 'לא ידוע' };
    const cHigh = cAskPm >= 60, cLow = cAskPm <= 40;
    const pHigh = pAskPm >= 60, pLow = pAskPm <= 40;
    if (cHigh && pLow)         return { id: 'bullish_strong',  label: 'שורי חזק' };
    if (cLow && pHigh)         return { id: 'bearish_strong',  label: 'דובי חזק' };
    if (cLow && pLow)          return { id: 'short_vol',       label: 'Short Volatility' };
    if (cHigh && pHigh)        return { id: 'long_vol',        label: 'Long Volatility' };
    if (cAskPm >= 55)          return { id: 'bullish_mild',    label: 'שורי מתון' };
    if (cAskPm <= 45)          return { id: 'bearish_mild',    label: 'מטה למכירת calls' };
    if (pAskPm >= 55)          return { id: 'hedge_demand',    label: 'דרישת הגנה' };
    if (pAskPm <= 45)          return { id: 'writing_puts',    label: 'כותבי puts' };
    return                              { id: 'balanced',      label: 'מאוזן' };
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
    const flowPattern = classifyFlowPattern(metrics.flow.raw.callAskPremPct, metrics.flow.raw.putAskPremPct);

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
                     : 'ov2-synergy-neutral';

    const html = `
        <!-- Pair: Phase × Flow -->
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

        <!-- Flow Lean bar -->
        <div class="ov2-synergy-lean">
            <div class="ov2-synergy-lean-label">
                <span>Flow Lean</span>
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

        <!-- Alignment verdict -->
        <div class="ov2-synergy-alignment ${alignClass}">
            <div class="ov2-synergy-align-emoji">${alignment.emoji}</div>
            <div class="ov2-synergy-align-content">
                <div class="ov2-synergy-align-label">Phase × Flow alignment · <b>${alignment.label}</b></div>
                <div class="ov2-synergy-align-desc">${alignment.desc || ''}</div>
            </div>
        </div>

        <!-- Cross signals -->
        ${signals.length ? `
            <div class="ov2-synergy-signals">
                <div class="ov2-eyebrow">סיגנלים מצולבים</div>
                ${signals.map(s => `
                    <div class="ov2-synergy-signal ov2-signal-${s.tone}">
                        <span class="ov2-synergy-signal-icon">${s.icon}</span>
                        <span class="ov2-synergy-signal-text">${s.text}</span>
                    </div>
                `).join('')}
            </div>` : ''}

        <!-- Narrative -->
        <div class="ov2-synergy-narrative">
            <div class="ov2-eyebrow" style="margin-bottom:6px;">השורה התחתונה</div>
            <div class="ov2-synergy-narrative-text">${narrative}</div>
        </div>
    `;
    wrap.innerHTML = html;
}

// ═════════════════════════════════════════════════════════════════════
// FLOW HISTORICAL CONTEXT — today vs 22-day baseline + pattern frequency
// Answers: "Is today unusual? How often have we seen this pattern?"
// ═════════════════════════════════════════════════════════════════════
function renderFlowHistory(rawToday, scoreToday, allDays) {
    const wrap = $('flowHistory');
    if (!wrap || !allDays || allDays.length === 0) return;

    // Today's pattern (using premium-weighted Ask%)
    const todayPattern = classifyFlowPattern(rawToday.callAskPremPct, rawToday.putAskPremPct);

    // Count pattern occurrences across all historical days
    let sameAsToday = 0;
    const patternCounts = {};  // by id
    for (const d of allDays) {
        const p = classifyFlowPattern(d.raw.callAskPremPct, d.raw.putAskPremPct);
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
        const p = classifyFlowPattern(d.raw.callAskPremPct, d.raw.putAskPremPct);
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
    // Refresh every 60 seconds (was 120s — user wants more responsive)
    if (_tickerTimer) clearInterval(_tickerTimer);
    _tickerTimer = setInterval(fetchLiveIndices, 60000);
}

async function fetchLiveIndices() {
    // Use ETFs instead of indices — they have extended hours + frequent updates on Stooq
    const symbols = { SPY: 'spy.us', NDX: 'qqq.us', DJI: 'dia.us', RUT: 'iwm.us' };
    const query = Object.values(symbols).join('+');
    const stooq = `https://stooq.com/q/l/?s=${query}&f=snd2t2ohlcpv&h&e=csv`;
    const url = 'https://corsproxy.io/?' + encodeURIComponent(stooq);
    try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return;
        const text = await r.text();
        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) return;
        const header = lines[0].split(',');
        const iSym = header.indexOf('Symbol');
        const iClose = header.indexOf('Close');
        const iPrev = header.indexOf('Prev');
        const bySym = {};
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            bySym[(cols[iSym] || '').toUpperCase()] = cols;
        }
        const apply = (key, close, prev) => {
            const valEl = $('tk' + key);
            const chgEl = $('tk' + key + 'Chg');
            if (!valEl || !chgEl || !close || !prev) return;
            const c = parseFloat(close), p = parseFloat(prev);
            if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return;
            const pctChg = (c - p) / p * 100;
            valEl.textContent = c.toLocaleString('en-US', { maximumFractionDigits: 2 });
            chgEl.textContent = (pctChg >= 0 ? '+' : '') + pctChg.toFixed(2) + '%';
            chgEl.style.color = pctChg >= 0 ? 'var(--ov2-pos)' : 'var(--ov2-neg)';
        };
        for (const [key, sym] of Object.entries(symbols)) {
            const row = bySym[sym.toUpperCase()];
            if (row) apply(key, row[iClose], row[iPrev]);
        }
        const upd = $('tkUpdated');
        if (upd) {
            const now = new Date();
            upd.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
        }
    } catch (e) { /* silent — keep showing last value */ }
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
        const { todayM, hist, metrics, flowAnalytics } = computeMetrics(data);

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

        renderStrip(metrics, phaseResult);
        renderEqTicker(metrics, hist);
        renderNarrative(metrics, hist, phaseResult, duration);
        // Macro Trail: long-history SPX vs EQ500 chart. Async because it
        // needs the Historical loader to settle; non-blocking — the rest
        // of the dashboard renders in parallel and the panel populates
        // when the data arrives.
        renderMacroTrail(hist);
        // Historical Echo: KNN pattern matching on top of the same
        // spliced series. Same loader, same async pattern — populates
        // when the analysis settles.
        renderHistoricalEcho(hist);
        // Flow vs Price: options sentiment timeline alongside SPX
        // cumulative — short-term (22 days) options-flow analysis.
        renderFlowVsPrice(metrics, flowAnalytics, hist);
        renderMCC(phaseResult, metrics, chips, duration);
        renderFlowCard(metrics, flowAnalytics);
        renderMarketFlowSynergy(phaseResult, metrics);
        renderKPIs(metrics);
        renderSectorSnapshot(metrics, data.sectors);
        renderDailySummary(phaseResult, metrics, chips, duration, data.sectors, hist, flowAnalytics);
        renderAlertsRail(chips, metrics);
        startLiveTicker(metrics);

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

        hideLoading();
    } catch (e) {
        console.error(e);
        hideLoading();
        renderError(e);
    }
}

document.addEventListener('DOMContentLoaded', init);

})();
