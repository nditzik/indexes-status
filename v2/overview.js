/* ═══════════════════════════════════════════════════════════════════════
   OVERVIEW V2 · data loading + computation + rendering
   Depends on: regime.js (window.Regime)
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ─── Constants ────────────────────────────────────────────────────────

const DATA_BASE = '../data';
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
function computeFlowDay(rows) {
    if (!rows || !rows.length) return null;
    let callTr = 0, putTr = 0, callP = 0, putP = 0, bigTrades = 0;
    const ivsCall = [], ivsPut = [];

    for (const r of rows) {
        const t = String(r.Type || '').trim().toLowerCase();
        const prem = num(r.Premium) || 0;
        const ivStr = String(r.IV || '').replace('%', '').trim();
        const iv = parseFloat(ivStr);

        if (t === 'call') {
            callTr++; callP += prem;
            if (Number.isFinite(iv) && iv > 0) ivsCall.push(iv);
        } else if (t === 'put') {
            putTr++; putP += prem;
            if (Number.isFinite(iv) && iv > 0) ivsPut.push(iv);
        }
        if (prem >= 5_000_000) bigTrades++;
    }

    const totP = callP + putP;
    const totTr = callTr + putTr;
    if (totTr === 0) return null;

    const ivCallMed = median(ivsCall);
    const ivPutMed  = median(ivsPut);

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
    // Daily %Change for VIX/DXY/10Y comes straight from the CSV's
    // %Change column. Strip renders these with the instrument's raw
    // direction (up = green ▲, down = red ▼) — no inversion.
    const vix1dPct = todayM.macro.vixChgPct;
    const dxy1dPct = todayM.macro.dxyChgPct;
    const tnx1dPct = todayM.macro.tnxChgPct;

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
        vix1dPct,
        dxy1dPct,
        tnx1dPct,
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

const $ = id => document.getElementById(id);

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
    if (chg <= -1)   return 'hm-bg-strong-neg';
    if (chg <= -0.3) return 'hm-bg-neg';
    if (chg <= -0.1) return 'hm-bg-weak-neg';
    if (chg <=  0.1) return 'hm-bg-neutral';
    if (chg <=  0.3) return 'hm-bg-weak-pos';
    if (chg <=  1)   return 'hm-bg-pos';
    return 'hm-bg-strong-pos';
}

function renderStrip(m) {
    // State badge dot color by combined score
    const dot = $('stateDot');
    const phaseColor = m.combined >= 70 ? 'pos' : m.combined >= 50 ? 'warn' : 'neg';
    dot.className = `state-dot ${phaseColor}`;

    $('stateScore').textContent = m.combined != null ? m.combined : '—';

    $('idxSpxVal').textContent = m.spx && m.spx.price != null ? m.spx.price.toFixed(2) : '—';
    $('idxSpxChg').textContent = m.spx && m.spx.chgPct != null ? `${deltaArrow(m.spx.chgPct)} ${fmtPct(m.spx.chgPct)}` : '—';
    $('idxSpxChg').className = 'idx-chg ' + deltaClass(m.spx ? m.spx.chgPct : 0);

    $('idxVixVal').textContent = m.vix ? m.vix.toFixed(2) : '—';
    // All three macro tiles show daily %Change with the instrument's
    // raw direction: ▲ + green when the value rose, ▼ + red when it
    // fell. No "good/bad for equities" inversion — the visual mirrors
    // the chart of the instrument itself.
    $('idxVixChg').textContent = m.vix1dPct != null ? `${deltaArrow(m.vix1dPct)} ${fmtPct(m.vix1dPct, 2)}` : '—';
    $('idxVixChg').className = 'idx-chg ' + deltaClass(m.vix1dPct);

    $('idxDxyVal').textContent = m.dxy ? m.dxy.toFixed(2) : '—';
    $('idxDxyChg').textContent = m.dxy1dPct != null ? `${deltaArrow(m.dxy1dPct)} ${fmtPct(m.dxy1dPct, 2)}` : '—';
    $('idxDxyChg').className = 'idx-chg ' + deltaClass(m.dxy1dPct);

    $('idxTnxVal').textContent = m.tnx ? m.tnx.toFixed(2) : '—';
    $('idxTnxChg').textContent = m.tnx1dPct != null ? `${deltaArrow(m.tnx1dPct)} ${fmtPct(m.tnx1dPct, 2)}` : '—';
    $('idxTnxChg').className = 'idx-chg ' + deltaClass(m.tnx1dPct);

    $('dataDate').textContent = fmtDate(m.dataDate);
    $('stateName').textContent = (Regime.classifyPhase({
        combined: m.combined != null ? m.combined : 50,
        breadth5dDelta: m.breadth5dDelta,
        vix: m.vix,
        distributionDays: m.distributionDays,
        nhMinusNl: m.nhMinusNl,
        rsiThrust: m.rsiThrust,
        pctMa200: m.pctMa200,
        previousPhase: m.previousPhase
    }).phase.labelHe);
}

function renderMCC(phase, metrics, chips, phaseDuration) {
    const p = phase.phase;
    // Glyph + Phase label
    $('mccGlyph').textContent = p.glyph;
    $('mccGlyph').style.color = p.color;
    $('mccPhaseLabel').textContent = p.labelEn;
    $('mccPhaseLabelHe').textContent = p.labelHe;
    $('mccPhaseAccent').style.background = p.color;
    $('mcc').style.background = `linear-gradient(135deg, var(--bg-1) 0%, ${p.bg} 100%)`;

    // Duration
    if (phaseDuration && phaseDuration.days >= 0) {
        $('mccDuration').textContent = phaseDuration.days === 0
            ? '⏱ Just transitioned'
            : `⏱ ${phaseDuration.days}d in phase`;
        $('mccEntered').textContent = phaseDuration.entered
            ? `since ${fmtDate(phaseDuration.entered)}`
            : '';
    }

    // Confidence
    $('mccConfVal').textContent = phase.confidence + '%';
    $('mccConfBar').style.width = phase.confidence + '%';
    $('mccConfBar').style.background = p.color;

    // Score + bar
    $('mccScoreVal').textContent = metrics.combined != null ? metrics.combined : '—';
    $('mccBarFill').style.width = (metrics.combined || 0) + '%';

    // Risk + bias
    $('mccRisk').textContent = p.risk;
    $('mccBias').textContent = p.bias;

    // Narrative subtitle — deterministic, from reasons
    const narr = phase.reasons[0] || '';
    $('mccNarrative').textContent = narr;

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
        wrap.innerHTML = '<span class="chip">no active signals</span>';
        return;
    }
    for (const c of chips) {
        const el = document.createElement('span');
        el.className = `chip chip-${c.type} chip-cat-${c.category}`;
        el.textContent = c.text;
        el.title = `${c.type.toUpperCase()} · ${c.category} · priority ${c.priority}`;
        wrap.appendChild(el);
    }
}

function renderKPIs(m) {
    $('kpiP200Val').textContent = `${Math.round(m.pctMa200)}%`;
    $('kpiP200Delta').textContent = `${deltaArrow(m.breadth5dDelta)} ${fmtSigned(m.breadth5dDelta, 0)}pp / 5d`;
    $('kpiP200Delta').className = 'kpi-delta ' + deltaClass(m.breadth5dDelta);

    $('kpiNhNlVal').textContent = m.nhNlRatio === 99 ? '∞' : m.nhNlRatio.toFixed(2);
    $('kpiNhNlDelta').textContent = `${m.nhCount} / ${m.nlCount}`;
    $('kpiNhNlDelta').className = 'kpi-delta ' + (m.nhCount > m.nlCount ? 'pos' : 'neg');

    $('kpiAvgChgVal').textContent = m.avgChange != null ? fmtPct(m.avgChange, 2) : '—';
    $('kpiAvgChgVal').className = 'kpi-value ' + deltaClass(m.avgChange);
    $('kpiAvgChgDelta').textContent = `${m.advancing}↑ / ${m.declining}↓`;

    $('kpiVixVal').textContent = m.vix ? m.vix.toFixed(2) : '—';
    $('kpiVixDelta').textContent = m.vix5dDelta ? `${deltaArrow(-m.vix5dDelta)} ${fmtSigned(m.vix5dDelta, 1)} / 5d` : '—';
    $('kpiVixDelta').className = 'kpi-delta ' + deltaClass(-m.vix5dDelta);

    $('kpiDistVal').textContent = `${m.distributionDays}/25`;
    $('kpiDistDelta').textContent = m.distributionDays >= 4 ? 'elevated' : m.distributionDays >= 2 ? 'in range' : 'healthy';
    $('kpiDistDelta').className = 'kpi-delta ' + (m.distributionDays >= 4 ? 'neg' : m.distributionDays >= 2 ? 'warn' : 'pos');

    $('kpiHealthVal').textContent = m.healthScore != null ? m.healthScore : '—';
    $('kpiHealthDelta').textContent = m.healthScore >= 70 ? 'strong' : m.healthScore >= 55 ? 'fair' : m.healthScore >= 40 ? 'weak' : 'poor';
    $('kpiHealthDelta').className = 'kpi-delta ' + (m.healthScore >= 70 ? 'pos' : m.healthScore >= 55 ? 'warn' : 'neg');

    $('kpiThrustVal').textContent = m.rsiThrust;
    $('kpiThrustDelta').textContent = m.rsiThrust >= 30 ? 'thrust ✓' : m.rsiThrust >= 15 ? 'building' : 'quiet';
    $('kpiThrustDelta').className = 'kpi-delta ' + (m.rsiThrust >= 30 ? 'pos' : m.rsiThrust >= 15 ? 'warn' : 'muted');

    $('kpiCombinedVal').textContent = m.combined != null ? m.combined : '—';
    $('kpiCombinedVal').className = 'kpi-value ' + (m.combined >= 70 ? 'pos' : m.combined >= 50 ? 'warn' : 'neg');
    $('kpiCombinedDelta').textContent = m.combined >= 70 ? 'confirmed' : m.combined >= 50 ? 'cautious' : 'weak';
}

function renderSectorSnapshot(metrics, sectorsMap) {
    const codes = (sectorsMap && sectorsMap.codes) || {};
    const wrap = $('sectorHeatmap');
    wrap.innerHTML = '';
    const sorted = [...metrics.sectors].sort((a, b) => b.avgChg - a.avgChg);
    for (const s of sorted) {
        const cell = document.createElement('div');
        cell.className = 'hm-cell ' + sectorHmClass(s.avgChg);
        cell.innerHTML = `
            <span class="hm-sym">${codes[s.code] || s.code}</span>
            <span class="hm-val">${fmtPct(s.avgChg, 1)}</span>
        `;
        cell.title = `${codes[s.code] || s.code} · ${Math.round(s.pct200)}% > MA200 · ${s.total} stocks`;
        wrap.appendChild(cell);
    }

    // Summary lines
    const top = sorted[0];
    const bot = sorted[sorted.length - 1];
    if (top) $('sectorBest').textContent = `${codes[top.code] || top.code} · ${Math.round(top.pct200)}% > MA200`;
    if (bot) $('sectorWorst').textContent = `${codes[bot.code] || bot.code} · ${Math.round(bot.pct200)}% > MA200`;
    const dispersion = top && bot ? (top.avgChg - bot.avgChg) : 0;
    $('sectorDispersion').textContent = `${dispersion.toFixed(1)}%`;
}

function renderAlertsRail(chips, metrics) {
    const rail = $('railContent');
    rail.innerHTML = '';

    // Map chips to alert cards, top 5 by priority
    const railChips = chips.slice(0, 5);
    if (!railChips.length) {
        rail.innerHTML = '<div style="padding:var(--space-4); color:var(--text-3); font-size:12px;">No active alerts</div>';
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
        el.className = `alert severity-${sev}`;
        el.innerHTML = `
            <div class="alert-head">
                <span class="alert-icon">${iconFor(c.type)}</span>
                <span class="alert-title">${c.type.toUpperCase()} · ${c.category}</span>
            </div>
            <div class="alert-body">${c.text}</div>
            <div class="alert-meta">
                <span>priority ${c.priority}</span>
                <span class="alert-action">why →</span>
            </div>
        `;
        rail.appendChild(el);
    }

    $('railCount').textContent = chips.length;
}

function renderError(e) {
    const main = $('main');
    const err = e && e.message ? e.message : String(e);
    main.innerHTML = `
      <div class="panel" style="margin:32px auto; max-width:600px;">
        <div class="panel-accent" style="background:var(--neg)"></div>
        <div class="eyebrow" style="color:var(--neg)">DATA LOAD ERROR</div>
        <div class="title-m" style="margin:8px 0;">לא הצלחתי לטעון את הנתונים</div>
        <pre style="background:var(--bg-2); padding:12px; border-radius:6px; font-size:12px; overflow:auto; color:var(--text-2);">${err}</pre>
        <div class="panel-footer">
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

        renderStrip(metrics);
        renderMCC(phaseResult, metrics, chips, duration);
        renderKPIs(metrics);
        renderSectorSnapshot(metrics, data.sectors);
        renderAlertsRail(chips, metrics);

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
