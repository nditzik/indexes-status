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

    // 5. Flow score (0-100) derived from z-scores
    //    Mean = 50 (neutral). Adjustments:
    //    + call_premium_pct z above mean = bullish (up to +25)
    //    - pc_premium z above mean = hedge demand (penalty up to 15)
    //    + net_premium z above mean = directional bullish (up to +10)
    //    - iv_skew z above mean = elevated fear (penalty up to 5)
    const scoreFromZ = dz => {
        let s = 50;
        if (dz.call_premium_pct != null) s += clamp(dz.call_premium_pct * 12, -25, 25);
        if (dz.pc_premium       != null) s -= clamp(dz.pc_premium * 8, -15, 15);
        if (dz.net_premium_pct  != null) s += clamp(dz.net_premium_pct * 5, -10, 10);
        if (dz.iv_skew          != null) s -= clamp(dz.iv_skew * 3, -5, 5);
        return Math.max(0, Math.min(100, Math.round(s)));
    };
    const score = scoreFromZ(z);

    // 5b. Compute historical scores per day using SHARED baseline (today's)
    //     This is approximation: yesterday's score uses today's baseline.
    //     OK for showing recent trend. Stored on days[i].score
    for (let i = 0; i < days.length; i++) {
        const r = days[i].raw;
        const dz = {
            call_premium_pct: zscore(r.call_premium_pct, baselines.call_premium_pct),
            pc_premium:       zscore(r.pc_premium,       baselines.pc_premium),
            net_premium_pct:  zscore(r.net_premium_pct,  baselines.net_premium_pct),
            iv_skew:          zscore(r.iv_skew,          baselines.iv_skew),
        };
        days[i].score = scoreFromZ(dz);
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
    for (const h of hist) {
        if (h.m && h.m.avgChange != null && Number.isFinite(h.m.avgChange)) {
            eqLevel *= (1 + h.m.avgChange / 100);
        }
    }
    const eqIndex = {
        level: eqLevel,
        dailyChgPct: todayM.avgChange,
        date: hist.length ? hist[hist.length - 1].date : null,
    };

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
        eqIndex,
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

function renderEqTicker(metrics, hist) {
    // The EQ500 tile lives in the same flex row as SPY/QQQ/DIA/IWM but
    // it's NOT refreshed every minute by fetchLiveIndices() — it's
    // computed once at page load from the CSV history. We populate it
    // here so the value is in place before the live tiles arrive.
    if (!metrics || !metrics.eqIndex) return;
    const { level, dailyChgPct, date } = metrics.eqIndex;
    const valEl = $('tkEq');
    const chgEl = $('tkEqChg');
    const dateEl = $('tkEqDate');
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
    if (dateEl && date) {
        // ISO yyyy-mm-dd -> dd/mm/yyyy to match the rest of the dashboard
        const [y, m, d] = date.split('-');
        dateEl.textContent = `${d}/${m}/${y}`;
    }
    // Enrich the hover tooltip with the actual baseline date and the
    // cumulative return since then — gives the user a way to verify
    // the level without us guessing what "104.44" means in isolation.
    const tile = valEl ? valEl.closest('.ov2-ticker-item') : null;
    if (tile && hist && hist.length > 0) {
        const startDate = hist[0].date;
        const [sy, sm, sd] = (startDate || '').split('-');
        const startFmt = sy ? `${sd}/${sm}/${sy}` : '—';
        const cumPct = Number.isFinite(level) ? (level - 100).toFixed(2) : '—';
        const sign = (level - 100) >= 0 ? '+' : '';
        tile.setAttribute('data-tooltip',
            `מדד שוויוני · ממוצע שווה-משקל של 500 המניות מה-CSV היומי. ` +
            `מתחיל ב-100 ביום ${startFmt}, היום: ${level.toFixed(2)} (${sign}${cumPct}% מצטבר). ` +
            `מתעדכן רק עם CSV חדש (לא חי).`
        );
    }
}

function renderNarrative(metrics, hist, phase, phaseDuration) {
    // Narrative is a "nice to have" overlay — never let a bug here
    // poison the rest of the dashboard. If anything throws we hide the
    // panel and log; the user still gets the MCC + KPIs below.
    if (!window.Narrative) return;
    try {
        const out = window.Narrative.build(metrics, hist, phase, phaseDuration);
        $('narrativePhase').textContent = out.headline.phaseLabel;
        $('narrativePhase').className =
            'ov2-narrative-phase ov2-' + (out.headline.stateClass || 'muted');
        $('narrativeKeyMetric').textContent = out.headline.keyMetric;
        $('narrativeSpread').textContent = out.headline.spread;
        $('narrativeParagraph').textContent = out.paragraph;
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
