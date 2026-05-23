// ─── Historical macro series — SPX + EQ500 spliced trail ─────────────
//
// Loads two daily-close CSVs (data/historical/spx_daily.csv and
// data/historical/rsp_daily.csv) shipped from Barchart, parses them
// into [{date, pctChange}] arrays, and exposes the cumulative levels
// rebased to 100 at the FIRST available trading day across both files.
//
// Why this exists: the dashboard's daily CSV only covers ~60 days of
// history. The narrative panel can describe TODAY, but the moment we
// want to ask "in the past, when this happened, what came next?" we
// need years of comparable data. The Barchart files give us 2016 →
// 2026-04-24, after which the daily watchlist CSV takes over (it has
// both $SPX rows AND 500 stock %Changes that mean-collapse to ≈ RSP).
//
// Splice contract:
//   historical SPX  → through 2026-04-24
//   live $SPX row    → 2026-04-25 onward
//   historical RSP  → through 2026-04-24
//   live EQ500 mean → 2026-04-25 onward (mean of 500 stocks' %Change)
//
// Validated: on the overlap window the two sources agree within
// ~0.05% daily for EQ500/RSP and to 4 decimal places for SPX (same
// upstream source). See conversation: "calibration check" run on
// 22 overlap days, 2026-03-26 → 2026-04-24.

(function () {
    'use strict';

    const VERSION = '1.0';

    // Cache-bust per trading day so the browser refetches when a new
    // daily CSV ships (rare, but cheap to support).
    function cacheBust() {
        return new Date().toISOString().slice(0, 10);
    }

    // ─── CSV parsing (Barchart format) ────────────────────────────────
    // Header: Time,Open,High,Low,Latest,Change,%Change,Volume
    // We only need Time + %Change (and Latest as a sanity fallback).
    function parseBarchartCsv(text) {
        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) return [];
        const header = lines[0].split(',');
        const iDate = header.indexOf('Time');
        const iPct  = header.indexOf('%Change');
        const iLatest = header.indexOf('Latest');
        if (iDate < 0 || iPct < 0) return [];

        const out = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            // Footer line ("Downloaded from Barchart.com ...") starts
            // with a quote and has no comma-separated numeric data —
            // skip it cleanly without throwing.
            if (line.startsWith('"') || !line.includes(',')) continue;
            const cols = line.split(',');
            const date = cols[iDate];
            const pctStr = cols[iPct];
            if (!date || !pctStr) continue;
            const pct = parseFloat(pctStr.replace('%','').replace('+',''));
            const latest = parseFloat(cols[iLatest]);
            if (!Number.isFinite(pct)) continue;
            out.push({
                date,
                pct,
                close: Number.isFinite(latest) ? latest : null,
            });
        }
        // Barchart files are ordered oldest → newest, but defensive
        // sort guarantees the rest of the pipeline can rely on it.
        out.sort((a, b) => a.date.localeCompare(b.date));
        return out;
    }

    async function fetchCsv(url) {
        const bust = cacheBust();
        const r = await fetch(`${url}?d=${bust}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
        return r.text();
    }

    // ─── Public loader ────────────────────────────────────────────────
    //
    // Returns { spx, rsp } where each is [{date, pct, close}] oldest-first.
    // Cached in module scope after first successful load.
    let _loadPromise = null;
    let _historical = null;

    function load() {
        if (_historical) return Promise.resolve(_historical);
        if (_loadPromise) return _loadPromise;
        _loadPromise = (async () => {
            const [spxText, rspText] = await Promise.all([
                fetchCsv('data/historical/spx_daily.csv'),
                fetchCsv('data/historical/rsp_daily.csv'),
            ]);
            const spx = parseBarchartCsv(spxText);
            const rsp = parseBarchartCsv(rspText);
            _historical = { spx, rsp };
            return _historical;
        })().catch(err => {
            console.warn('Historical load failed:', err);
            _loadPromise = null;          // allow retry on next call
            _historical = { spx: [], rsp: [] };
            return _historical;
        });
        return _loadPromise;
    }

    // ─── Splice live %Change onto the historical tail ─────────────────
    //
    // Given an array of {date, pct} from the daily CSV history (the
    // 44-day hist array overview-prod.js already builds), return a
    // merged series that extends the historical tail forward.
    //
    // Rules:
    //   - Anything ≤ the last historical date is taken from historical.
    //   - Anything AFTER the last historical date is taken from live.
    //   - On a tied date the historical reading wins (Barchart was
    //     verified as the same upstream as our CSV's $SPX row).
    function spliceForward(historicalSeries, liveSeries) {
        if (!historicalSeries || historicalSeries.length === 0) {
            return (liveSeries || []).slice();
        }
        const cutoff = historicalSeries[historicalSeries.length - 1].date;
        const tail = (liveSeries || []).filter(d => d.date > cutoff);
        return historicalSeries.concat(tail);
    }

    // ─── Cumulative level (rebased to 100 at the first row) ──────────
    function toLevels(series, base) {
        const out = [];
        let level = base != null ? base : 100;
        for (const row of series) {
            if (row.pct == null || !Number.isFinite(row.pct)) {
                out.push({ date: row.date, level });
                continue;
            }
            level *= (1 + row.pct / 100);
            out.push({ date: row.date, level });
        }
        return out;
    }

    // ─── EQ500 series from the dashboard's daily hist (mean of stocks)
    //
    // The dashboard's hist[i].m.avgChange is already the mean %Change of
    // the 500 stocks in the daily watchlist CSV. We just extract date +
    // pct so it has the same shape as the Barchart RSP series.
    function eq500FromDailyHist(hist) {
        if (!Array.isArray(hist)) return [];
        const out = [];
        for (const h of hist) {
            if (!h || !h.m || h.m.avgChange == null
                    || !Number.isFinite(h.m.avgChange)) continue;
            out.push({ date: h.date, pct: h.m.avgChange });
        }
        return out;
    }

    // SPX series from the dashboard's daily hist ($SPX row in CSV).
    function spxFromDailyHist(hist) {
        if (!Array.isArray(hist)) return [];
        const out = [];
        for (const h of hist) {
            if (!h || !h.m || !h.m.macro || !h.m.macro.spx
                    || h.m.macro.spx.chgPct == null
                    || !Number.isFinite(h.m.macro.spx.chgPct)) continue;
            out.push({ date: h.date, pct: h.m.macro.spx.chgPct });
        }
        return out;
    }

    // ─── EQ500 - SPX rolling spread series ────────────────────────────
    //
    // Aligned per-day, computed AFTER the splice, so the spread reads
    // consistently from 2016 forward. Returns [{date, spreadDaily}].
    // The narrative panel and any future pattern matcher both consume
    // this as the "broad vs narrow" signal in pure-numeric form.
    function alignSpread(spxSeries, eqSeries) {
        const eqByDate = Object.create(null);
        for (const r of eqSeries) eqByDate[r.date] = r.pct;
        const out = [];
        for (const r of spxSeries) {
            const e = eqByDate[r.date];
            if (e == null) continue;     // skip dates one source is missing
            out.push({ date: r.date, spreadDaily: e - r.pct });
        }
        return out;
    }

    // ─── Public API ──────────────────────────────────────────────────
    window.Historical = {
        VERSION,
        load,
        // Builders — pure, no I/O. Hand in what loadData() already has.
        spliceForward,
        toLevels,
        eq500FromDailyHist,
        spxFromDailyHist,
        alignSpread,
        // Convenience: end-to-end. Returns the spliced + leveled series
        // ready for charting. Falls back to the live-only data when the
        // historical fetch failed (so the dashboard still renders).
        async buildSplicedSeries(dailyHist) {
            const { spx: histSpx, rsp: histRsp } = await load();
            const liveSpx = spxFromDailyHist(dailyHist);
            const liveEq  = eq500FromDailyHist(dailyHist);
            const splicedSpx = spliceForward(histSpx, liveSpx);
            const splicedEq  = spliceForward(histRsp, liveEq);

            // Find the first date present in BOTH after splicing — that
            // becomes the rebase anchor (both levels start at 100 there)
            // so the chart compares them apples-to-apples.
            const spxDates = new Set(splicedSpx.map(r => r.date));
            const eqStart = splicedEq.findIndex(r => spxDates.has(r.date));
            const spxStart = eqStart >= 0
                ? splicedSpx.findIndex(r => r.date === splicedEq[eqStart].date)
                : 0;
            const spxAligned = splicedSpx.slice(Math.max(0, spxStart));
            const eqAligned = splicedEq.slice(Math.max(0, eqStart));

            return {
                spx: splicedSpx,
                eq:  splicedEq,
                spxLevels: toLevels(spxAligned, 100),
                eqLevels:  toLevels(eqAligned, 100),
                spread: alignSpread(splicedSpx, splicedEq),
                anchorDate: eqStart >= 0 ? splicedEq[eqStart].date : null,
            };
        },
    };
})();
