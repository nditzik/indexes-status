/* ═══════════════════════════════════════════════════════════════════════
   OVERVIEW V2 · data loading + computation + rendering
   Depends on: regime.js (window.Regime)
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ─── Constants ────────────────────────────────────────────────────────

const DATA_BASE = 'data';
const HISTORY_DAYS = 30;          // load last N CSVs for trend / distribution

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

    // Options flow — load up to 22 days for baseline + z-score (parallel)
    const flowHistory = await loadFlowHistory(history, 22);

    return { sectors, index, today, history, flowHistory };
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
        if (s === '$VIX') macro.vix = num(r.Latest);
        else if (s === '$DXY') macro.dxy = num(r.Latest);
        else if (s === '$TNX') macro.tnx = num(r.Latest);
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
// Extended 2026-05-22: tracks Side (ask/bid/mid) per Call/Put for aggressive direction
function computeFlowDay(rows) {
    if (!rows || !rows.length) return null;
    let callTr = 0, putTr = 0, callP = 0, putP = 0, bigTrades = 0;
    let callAsk = 0, callBid = 0, callMid = 0;
    let putAsk = 0, putBid = 0, putMid = 0;
    let callAskP = 0, callBidP = 0, callMidP = 0;
    let putAskP = 0, putBidP = 0, putMidP = 0;
    const ivsCall = [], ivsPut = [];

    for (const r of rows) {
        const t = String(r.Type || '').trim().toLowerCase();
        const prem = num(r.Premium) || 0;
        const side = String(r.Side || '').trim().toLowerCase();
        const ivStr = String(r.IV || '').replace('%', '').trim();
        const iv = parseFloat(ivStr);

        if (t === 'call') {
            callTr++; callP += prem;
            if (side === 'ask') { callAsk++; callAskP += prem; }
            else if (side === 'bid') { callBid++; callBidP += prem; }
            else if (side === 'mid') { callMid++; callMidP += prem; }
            if (Number.isFinite(iv) && iv > 0) ivsCall.push(iv);
        } else if (t === 'put') {
            putTr++; putP += prem;
            if (side === 'ask') { putAsk++; putAskP += prem; }
            else if (side === 'bid') { putBid++; putBidP += prem; }
            else if (side === 'mid') { putMid++; putMidP += prem; }
            if (Number.isFinite(iv) && iv > 0) ivsPut.push(iv);
        }
        if (prem >= 5_000_000) bigTrades++;
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

    // 5. Flow score (0-100) derived from z-scores
    //    Mean = 50 (neutral). Adjustments:
    //    + call_premium_pct z above mean = bullish (up to +25)
    //    - pc_premium z above mean = hedge demand (penalty up to 15)
    //    + net_premium z above mean = directional bullish (up to +10)
    //    - iv_skew z above mean = elevated fear (penalty up to 5)
    let score = 50;
    if (z.call_premium_pct != null) score += clamp(z.call_premium_pct * 12, -25, 25);
    if (z.pc_premium       != null) score -= clamp(z.pc_premium * 8, -15, 15);
    if (z.net_premium_pct  != null) score += clamp(z.net_premium_pct * 5, -10, 10);
    if (z.iv_skew          != null) score -= clamp(z.iv_skew * 3, -5, 5);
    // Boundary clamp
    score = Math.max(0, Math.min(100, Math.round(score)));

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
    const { sectors: sectorsMap, today, history, flowHistory } = data;

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

    // Distribution days: last 25 sessions with avgChange < -0.2%
    const last25 = hist.slice(-25);
    const distributionDays = last25.filter(h => h.m.avgChange != null && h.m.avgChange < -0.2).length;

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

    // Yesterday phase (for thrust detection)
    let previousPhase = null;
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
        distributionDays,
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
    // Use phase.stateClass for the dot — drives color from regime, not raw score
    const p = phase && phase.phase ? phase.phase : null;
    const stateClass = p ? p.stateClass : (m.combined >= 70 ? 'pos' : m.combined >= 50 ? 'warn' : 'neg');
    $('stateDot').className = `ov2-state-dot ov2-${stateClass}`;
    $('stateName').textContent = p ? p.stateLabel : '—';
    $('stateScore').textContent = m.combined != null ? m.combined : '—';

    $('idxSpxVal').textContent = m.spx && m.spx.price != null ? m.spx.price.toFixed(2) : '—';
    $('idxSpxChg').textContent = m.spx && m.spx.chgPct != null ? `${deltaArrow(m.spx.chgPct)} ${fmtPct(m.spx.chgPct)}` : '—';
    $('idxSpxChg').className = 'ov2-idx-chg ' + 'ov2-' + deltaClass(m.spx ? m.spx.chgPct : 0);

    $('idxVixVal').textContent = m.vix ? m.vix.toFixed(2) : '—';
    $('idxVixChg').textContent = m.vix5dDelta ? `${deltaArrow(-m.vix5dDelta)} ${fmtSigned(m.vix5dDelta, 1)}` : '—';
    // VIX down = good (pos), VIX up = bad (neg)
    $('idxVixChg').className = 'ov2-idx-chg ' + 'ov2-' + deltaClass(-m.vix5dDelta);

    $('idxDxyVal').textContent = m.dxy ? m.dxy.toFixed(2) : '—';
    $('idxTnxVal').textContent = m.tnx ? m.tnx.toFixed(2) : '—';

    $('dataDate').textContent = fmtDate(m.dataDate);
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

    // Confidence
    $('mccConfVal').textContent = phase.confidence + '%';
    $('mccConfBar').style.width = phase.confidence + '%';
    $('mccConfBar').style.background = p.color;

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
function renderFlowCard(metrics) {
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
    const buildSideTable = (label, tr, prem, askTr, bidTr, midTr, askP, bidP, midP, askTrPct, askPremPct) => {
        const tot = askTr + bidTr + midTr;
        const dirTr = askTr + bidTr;
        const bidTrPct  = dirTr ? Math.round(bidTr / dirTr * 100) : 0;
        const askTrPctR = dirTr ? Math.round(askTr / dirTr * 100) : 0;
        const dirP = askP + bidP;
        const bidPremPct = dirP ? Math.round(bidP / dirP * 100) : 0;
        const askPremPctR= dirP ? Math.round(askP / dirP * 100) : 0;
        return `
        <table class="ov2-flow-side-table">
            <thead><tr><th></th><th>עסקאות</th><th>פרמיה</th></tr></thead>
            <tbody>
                <tr class="ov2-flow-side-ask">
                    <td><b>Ask</b><br><span class="ov2-flow-side-sub">קונה אגרסיבי</span></td>
                    <td><b>${askTr}</b> <span class="ov2-flow-side-pct">(${askTrPctR}%)</span></td>
                    <td><b>${fmtP(askP)}</b> <span class="ov2-flow-side-pct">(${askPremPctR}%)</span></td>
                </tr>
                <tr class="ov2-flow-side-bid">
                    <td><b>Bid</b><br><span class="ov2-flow-side-sub">מוכר אגרסיבי</span></td>
                    <td><b>${bidTr}</b> <span class="ov2-flow-side-pct">(${bidTrPct}%)</span></td>
                    <td><b>${fmtP(bidP)}</b> <span class="ov2-flow-side-pct">(${bidPremPct}%)</span></td>
                </tr>
                <tr class="ov2-flow-side-mid">
                    <td><b>Mid</b><br><span class="ov2-flow-side-sub">ניטרלי</span></td>
                    <td><b>${midTr}</b></td>
                    <td><b>${fmtP(midP)}</b></td>
                </tr>
            </tbody>
            <tfoot>
                <tr>
                    <td colspan="3" class="ov2-flow-side-foot">
                        <span class="ov2-flow-side-signal">Ask על directional:</span>
                        <span>עסקאות <b>${askTrPctR}%</b></span>
                        <span>·</span>
                        <span>פרמיה <b>${askPremPctR}%</b></span>
                    </td>
                </tr>
            </tfoot>
        </table>`;
    };

    const callTable = buildSideTable('Calls',
        raw.callTr, raw.callP,
        raw.callAsk, raw.callBid, raw.callMid,
        raw.callAskP, raw.callBidP, raw.callMidP,
        raw.callAskPct, raw.callAskPremPct);
    const putTable = buildSideTable('Puts',
        raw.putTr, raw.putP,
        raw.putAsk, raw.putBid, raw.putMid,
        raw.putAskP, raw.putBidP, raw.putMidP,
        raw.putAskPct, raw.putAskPremPct);

    setEl('flowCallSummary', `${raw.callTr} עסקאות · ${fmtP(raw.callP)}`);
    setEl('flowPutSummary',  `${raw.putTr} עסקאות · ${fmtP(raw.putP)}`);
    const callTableEl = $('flowCallTable'); if (callTableEl) callTableEl.innerHTML = callTable;
    const putTableEl  = $('flowPutTable');  if (putTableEl)  putTableEl.innerHTML  = putTable;

    // ─── Aggressive direction interpretation (PREMIUM-WEIGHTED priority) ───
    // Premium-weighted is more informative — big money moves matter more
    let aggInterpretation;
    const cAskPm = raw.callAskPremPct;
    const pAskPm = raw.putAskPremPct;
    const cAskTr = raw.callAskPct;
    const pAskTr = raw.putAskPct;
    if (cAskPm == null || pAskPm == null) {
        aggInterpretation = 'אין מספיק עסקאות directional לקריאה ברורה';
    } else if (cAskPm >= 65 && pAskPm < 45) {
        aggInterpretation = `אגרסיביות שורית חזקה (לפי פרמיה) — קונים calls (${Math.round(cAskPm)}%) וכותבים puts (${Math.round(100-pAskPm)}%)`;
    } else if (cAskPm >= 55 && pAskPm < 50) {
        aggInterpretation = `אגרסיביות שורית מתונה — מטה לקנייה: calls Ask ${Math.round(cAskPm)}% פרמיה · puts Ask ${Math.round(pAskPm)}% פרמיה`;
    } else if (cAskPm < 45 && pAskPm >= 60) {
        aggInterpretation = `אגרסיביות הגנתית — כסף גדול קונה puts (${Math.round(pAskPm)}% מהפרמיה ב-Ask)`;
    } else if (cAskPm >= 55 && pAskPm >= 55) {
        aggInterpretation = 'מתח דו-כיווני — קונים גם calls וגם puts באגרסיביות';
    } else {
        aggInterpretation = `מאוזן · calls Ask ${Math.round(cAskPm)}% פרמיה · puts Ask ${Math.round(pAskPm)}% פרמיה`;
    }
    // Note divergence between trade-count and premium signals (interesting)
    if (cAskTr != null && cAskPm != null && Math.abs(cAskPm - cAskTr) >= 15) {
        aggInterpretation += ` · ⓘ פער עסקאות↔פרמיה (${Math.round(cAskTr)}% ↔ ${Math.round(cAskPm)}%) — הכסף הגדול שונה מהקהל`;
    }
    setEl('flowAggInterp', aggInterpretation);

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

// ═════════════════════════════════════════════════════════════════════
// DAILY SUMMARY — deterministic narrative builder
// Reads phase, metrics, chips → produces 4-5 sections + bottom line
// ═════════════════════════════════════════════════════════════════════
function renderDailySummary(phase, m, chips, duration, sectorsMap) {
    const wrap = $('summaryContent');
    if (!wrap) return;
    const codes = (sectorsMap && sectorsMap.codes) || {};
    const p = phase.phase;
    const sections = [];

    // 1. Status
    const durationText = duration && duration.days >= 0
        ? (duration.days === 0 ? 'יום ראשון בשלב' : `יום ${duration.days + 1} בשלב`)
        : '';
    sections.push({
        cls: p.stateClass,
        label: '1 · הסטטוס',
        body: `<b>${p.glyph} ${p.labelHe}</b> — ${durationText}. ${phase.reasons[0] || ''}`
    });

    // 2. The story — main weaknesses (warnings) and divergences
    const warnings = chips.filter(c => c.type === 'warning').slice(0, 4);
    if (warnings.length) {
        const bullets = warnings.map(c =>
            `<li>${c.text}${c.meaning ? ' — <span style="color:var(--ov2-text-2)">' + c.meaning + '</span>' : ''}</li>`
        ).join('');
        sections.push({
            cls: 'warn',
            label: '2 · על מה לעקוב',
            body: `<ul>${bullets}</ul>`
        });
    }

    // 3. What's positive
    const confirmations = chips.filter(c => c.type === 'confirmation').slice(0, 4);
    if (confirmations.length) {
        const bullets = confirmations.map(c =>
            `<li>${c.text}${c.meaning ? ' — <span style="color:var(--ov2-text-2)">' + c.meaning + '</span>' : ''}</li>`
        ).join('');
        sections.push({
            cls: 'pos',
            label: '3 · מה כן חיובי',
            body: `<ul>${bullets}</ul>`
        });
    }

    // 4. Sectors story
    const sorted = [...m.sectors].sort((a, b) => b.avgChg - a.avgChg);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best && worst) {
        const bestName = codes[best.code] || best.code;
        const worstName = codes[worst.code] || worst.code;
        const dispersion = (best.avgChg - worst.avgChg).toFixed(1);
        // Detect interesting "today vs long-term" mismatch
        const bestLongTermNote = best.pct200 < 50
            ? ` (אך רק ${Math.round(best.pct200)}% מהמניות בסקטור הזה מעל MA200 — חולשה ארוכת-טווח)` : '';
        const worstLongTermNote = worst.pct200 >= 70
            ? ` (אך ${Math.round(worst.pct200)}% מהמניות בסקטור עדיין מעל MA200 — חוזק ארוך-טווח, רק יום-אחד שלילי)` : '';
        sections.push({
            cls: '',
            label: '4 · סקטורים',
            body: `מוביל היום: <b>${bestName} ${fmtPct(best.avgChg, 1)}</b>${bestLongTermNote}.<br>
                   חלש היום: <b>${worstName} ${fmtPct(worst.avgChg, 1)}</b>${worstLongTermNote}.<br>
                   פיזור היום: <b>${dispersion}%</b> ${parseFloat(dispersion) > 2 ? '(רוטציה אקטיבית)' : '(תנועה אחידה)'}.`
        });
    }

    // 5. SPX Flow note
    if (m.flow && m.flow.score != null) {
        const flowMsg = m.flow.score >= 60
            ? `זרימת הכסף חיובית (${m.flow.score}/100) — כסף גדול קונה calls`
            : m.flow.score >= 45
            ? `זרימת הכסף מאוזנת (${m.flow.score}/100) — ללא כיוון ברור`
            : `זרימת הכסף הגנתית (${m.flow.score}/100) — כסף גדול קונה הגנות`;
        sections.push({
            cls: '',
            label: '5 · כסף ב-options',
            body: flowMsg
        });
    }

    // Render
    wrap.innerHTML = sections.map(s => `
        <div class="ov2-summary-section ov2-${s.cls}">
            <div class="ov2-summary-section-label">${s.label}</div>
            <div class="ov2-summary-section-body">${s.body}</div>
        </div>
    `).join('');

    // Bottom line — from phase bias + key tension
    $('summaryBottomLine').textContent = `השורה התחתונה: ${p.bias}.`;
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
        renderMCC(phaseResult, metrics, chips, duration);
        renderFlowCard(metrics);
        renderKPIs(metrics);
        renderSectorSnapshot(metrics, data.sectors);
        renderDailySummary(phaseResult, metrics, chips, duration, data.sectors);
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
