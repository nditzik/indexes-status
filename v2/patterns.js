// ─── Pattern matching — "what came next, the last time it looked like this?"
//
// Pure-statistics layer that consumes the spliced SPX + EQ500 series
// the Historical module produces, builds a per-day feature matrix
// across the full 10-year history, and exposes a KNN lookup that
// returns the K most similar past days plus the forward-return
// distribution that followed each match.
//
// This is the foundation the next narrative layer hangs on: instead
// of "today is mixed", the panel can read "today is mixed, and the
// 8 most similar past days ended up +X% / -Y% over the next 20
// sessions." Not a prediction — a conditional distribution. Honesty
// matters: small sample sizes and wide ranges should be visible.
//
// Decisions baked in:
//   - 6-D feature vector: 5d/20d SPX return, 5d EQ return, 5d
//     equal-vs-cap spread, 60d drawdown, 20d realized vol.
//   - Z-score normalization across the full historical sample so
//     dimensions with different units (% vs %, ratio vs sigma) are
//     comparable.
//   - Euclidean distance, K configurable (default 12).
//   - Exclude matches within 30 trading days of today (autocorrelation)
//     and within 20 days of each other (cluster dedup).
//   - Forward windows: 5, 10, 20 trading days.

(function () {
    'use strict';

    const VERSION = '1.0';

    // ─── Small array helpers ──────────────────────────────────────────
    function mean(arr) {
        if (!arr.length) return null;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }
    function std(arr, m) {
        if (!arr.length) return null;
        const mu = m != null ? m : mean(arr);
        const sq = arr.reduce((s, v) => s + (v - mu) * (v - mu), 0);
        return Math.sqrt(sq / arr.length);
    }
    function percentile(sorted, p) {
        if (!sorted.length) return null;
        const idx = (sorted.length - 1) * p;
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        if (lo === hi) return sorted[lo];
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    }

    // ─── Feature extraction (per day) ─────────────────────────────────
    //
    // Inputs: parallel arrays of {date, pct} for SPX and EQ500, oldest
    // first. Output: a feature matrix where each row corresponds to a
    // day with enough lookback to compute all features (the first ~60
    // rows are skipped because they lack a 60-day window).
    //
    // Each feature is computed from RELATIVE moves only — never from
    // absolute price levels — so the matcher generalises across the
    // full sample regardless of where the index sat in 2016 vs today.
    const LOOKBACK = 60;   // need at least this much prior context

    function buildFeatureMatrix(spxSeries, eqSeries) {
        // Pre-build cumulative level series and align both by date.
        // We need a SPX level for the 60d drawdown; everything else
        // is computed from % returns directly.
        const spxByDate = Object.create(null);
        const eqByDate = Object.create(null);
        for (const r of spxSeries) spxByDate[r.date] = r.pct;
        for (const r of eqSeries)  eqByDate[r.date]  = r.pct;

        const dates = spxSeries.map(r => r.date);

        // Reconstruct SPX levels from % series (start at 100).
        const spxLevels = new Array(dates.length);
        let lvl = 100;
        for (let i = 0; i < dates.length; i++) {
            const p = spxSeries[i].pct;
            if (Number.isFinite(p)) lvl *= (1 + p / 100);
            spxLevels[i] = lvl;
        }

        const rows = [];
        for (let i = LOOKBACK; i < dates.length; i++) {
            // 5-day SPX cumulative return (compounded)
            let spxRet5d = 1, spxRet20d = 1, eqRet5d = 1;
            for (let k = i - 4; k <= i; k++) {
                const p = spxSeries[k].pct;
                if (Number.isFinite(p)) spxRet5d *= (1 + p / 100);
            }
            for (let k = i - 19; k <= i; k++) {
                const p = spxSeries[k].pct;
                if (Number.isFinite(p)) spxRet20d *= (1 + p / 100);
            }
            for (let k = i - 4; k <= i; k++) {
                const eqDate = dates[k];
                const e = eqByDate[eqDate];
                if (Number.isFinite(e)) eqRet5d *= (1 + e / 100);
            }
            spxRet5d  = (spxRet5d  - 1) * 100;
            spxRet20d = (spxRet20d - 1) * 100;
            eqRet5d   = (eqRet5d   - 1) * 100;

            // 5-day equal-vs-cap spread (sum of daily diffs)
            let spread5d = 0;
            for (let k = i - 4; k <= i; k++) {
                const sp = spxSeries[k].pct;
                const eq = eqByDate[dates[k]];
                if (Number.isFinite(sp) && Number.isFinite(eq)) {
                    spread5d += (eq - sp);
                }
            }

            // 60-day drawdown: distance below the 60d high (as % below)
            let high = spxLevels[i];
            for (let k = i - LOOKBACK + 1; k <= i; k++) {
                if (spxLevels[k] > high) high = spxLevels[k];
            }
            const drawdown60d = (spxLevels[i] / high - 1) * 100;  // ≤ 0

            // 20-day realized vol (std of daily %)
            const window = [];
            for (let k = i - 19; k <= i; k++) {
                if (Number.isFinite(spxSeries[k].pct)) window.push(spxSeries[k].pct);
            }
            const vol20d = std(window);

            rows.push({
                idx: i,
                date: dates[i],
                level: spxLevels[i],
                features: [spxRet5d, spxRet20d, eqRet5d, spread5d, drawdown60d, vol20d],
            });
        }

        const featureNames = [
            'SPX 5d', 'SPX 20d', 'EQ500 5d', 'Spread 5d', 'Drawdown 60d', 'Vol 20d',
        ];

        return { rows, dates, spxLevels, featureNames };
    }

    // ─── Z-score normalization ────────────────────────────────────────
    //
    // Each feature dimension gets its own (mean, std) computed across
    // the entire historical sample. We store the params so the same
    // normalization can be applied to a single "today" vector later.
    function computeNormalizationParams(rows) {
        if (!rows.length) return { mu: [], sigma: [] };
        const D = rows[0].features.length;
        const mu = new Array(D).fill(0);
        const sigma = new Array(D).fill(0);
        for (let d = 0; d < D; d++) {
            const col = rows.map(r => r.features[d]).filter(Number.isFinite);
            mu[d] = mean(col);
            sigma[d] = std(col, mu[d]);
            // Guard: if a dimension is constant the std is 0; using 1
            // avoids div-by-zero and means that dimension contributes
            // nothing to the distance.
            if (!sigma[d] || !Number.isFinite(sigma[d])) sigma[d] = 1;
        }
        return { mu, sigma };
    }

    function normalize(vec, params) {
        const out = new Array(vec.length);
        for (let d = 0; d < vec.length; d++) {
            out[d] = (vec[d] - params.mu[d]) / params.sigma[d];
        }
        return out;
    }

    // ─── KNN: find closest historical days ────────────────────────────
    //
    // - excludeRecent: skip matches within N trading days of today (i.e.
    //   the last entries in the matrix). Default 30 — autocorrelation
    //   makes very recent days trivially "similar" to today, which
    //   tells us nothing.
    // - clusterDedup: after picking a match, skip any subsequent match
    //   within ±20 trading days of it. Keeps the K matches diverse.
    function findMatches(rows, params, todayVec, opts) {
        opts = opts || {};
        const K = opts.k || 12;
        const excludeRecent = opts.excludeRecent != null ? opts.excludeRecent : 30;
        const clusterDedup = opts.clusterDedup != null ? opts.clusterDedup : 20;

        const todayNorm = normalize(todayVec, params);
        const lastIdx = rows[rows.length - 1].idx;
        // Compute distance to every row except the most-recent N
        const candidates = [];
        for (const r of rows) {
            if (lastIdx - r.idx <= excludeRecent) continue;
            const v = normalize(r.features, params);
            let d2 = 0;
            for (let k = 0; k < v.length; k++) {
                const d = v[k] - todayNorm[k];
                d2 += d * d;
            }
            candidates.push({ row: r, distance: Math.sqrt(d2) });
        }
        candidates.sort((a, b) => a.distance - b.distance);

        // Cluster dedup: walk in order of closeness, drop any candidate
        // within ±clusterDedup days of an already-accepted match.
        const accepted = [];
        for (const c of candidates) {
            if (accepted.length >= K) break;
            let tooClose = false;
            for (const a of accepted) {
                if (Math.abs(c.row.idx - a.row.idx) <= clusterDedup) {
                    tooClose = true;
                    break;
                }
            }
            if (!tooClose) accepted.push(c);
        }
        return accepted;
    }

    // ─── Forward-return outcomes ─────────────────────────────────────
    //
    // For each match, look up the SPX level N days later and compute
    // the return. We use the underlying spxLevels array (rebuilt to 100
    // at start). Aggregates across matches into median, quartiles and
    // hit rate (positive / total) per horizon.
    function computeOutcomes(matches, spxLevels, windows) {
        windows = windows || [5, 10, 20];
        const out = {};
        for (const W of windows) {
            const returns = [];
            for (const m of matches) {
                const fromIdx = m.row.idx;
                const toIdx = fromIdx + W;
                if (toIdx >= spxLevels.length) continue;     // future falls off the data
                const r = (spxLevels[toIdx] / spxLevels[fromIdx] - 1) * 100;
                if (Number.isFinite(r)) returns.push({ matchDate: m.row.date, r });
            }
            if (!returns.length) {
                out[W] = { samples: 0 };
                continue;
            }
            const sorted = returns.map(x => x.r).slice().sort((a, b) => a - b);
            const pos = returns.filter(x => x.r > 0).length;
            out[W] = {
                samples: returns.length,
                median: percentile(sorted, 0.5),
                q25: percentile(sorted, 0.25),
                q75: percentile(sorted, 0.75),
                min: sorted[0],
                max: sorted[sorted.length - 1],
                hitRate: pos / returns.length,
                returns,         // per-match values, kept for the UI
            };
        }
        return out;
    }

    // ─── Forward-path trajectories ───────────────────────────────────
    //
    // For each match, produce the full daily-return path over the next
    // `horizon` trading days — relative to the match date, expressed in
    // % from match-day close. Useful for visualising the matched
    // trajectories overlaid on a single chart instead of just summary
    // statistics.
    //
    // Returns {
    //   horizon: int,
    //   paths:    [{matchDate, points: [{day: 0..horizon, ret: %}, ...]}],
    //   median:   [{day, ret}]  // median % across matches at each day
    // }
    function computePaths(matches, spxLevels, horizon) {
        horizon = horizon || 20;
        const paths = [];
        for (const m of matches) {
            const fromIdx = m.row.idx;
            const fromLvl = spxLevels[fromIdx];
            if (!Number.isFinite(fromLvl) || fromLvl <= 0) continue;
            const points = [];
            for (let d = 0; d <= horizon; d++) {
                const i = fromIdx + d;
                if (i >= spxLevels.length) break;
                const ret = (spxLevels[i] / fromLvl - 1) * 100;
                if (Number.isFinite(ret)) points.push({ day: d, ret });
            }
            if (points.length) paths.push({ matchDate: m.row.date, points });
        }
        // Median path: at each day offset, collect the available returns
        // across matches and take the median. Some matches near the end
        // of the data will be shorter — those days just have fewer samples.
        const median = [];
        for (let d = 0; d <= horizon; d++) {
            const at = [];
            for (const p of paths) {
                const point = p.points.find(pt => pt.day === d);
                if (point) at.push(point.ret);
            }
            if (!at.length) continue;
            at.sort((a, b) => a - b);
            median.push({ day: d, ret: percentile(at, 0.5) });
        }
        return { horizon, paths, median };
    }

    // ─── End-to-end convenience ──────────────────────────────────────
    //
    // Pass the {spx, eq} arrays Historical.buildSplicedSeries returns
    // and get the full analysis package — feature matrix, today's
    // vector, top matches, forward-return outcomes. The UI just reads.
    function analyze(spliced, opts) {
        opts = opts || {};
        const fm = buildFeatureMatrix(spliced.spx, spliced.eq);
        if (fm.rows.length === 0) {
            return { error: 'Not enough history to compute features.' };
        }
        const params = computeNormalizationParams(fm.rows);
        const todayRow = fm.rows[fm.rows.length - 1];
        const matches = findMatches(fm.rows, params, todayRow.features, opts);
        const outcomes = computeOutcomes(matches, fm.spxLevels, opts.windows);
        const paths = computePaths(matches, fm.spxLevels, opts.pathHorizon || 20);
        return {
            asOfDate: todayRow.date,
            todayFeatures: todayRow.features,
            featureNames: fm.featureNames,
            normParams: params,
            matches: matches.map(m => ({
                date: m.row.date,
                idx: m.row.idx,
                distance: m.distance,
                features: m.row.features,
            })),
            outcomes,
            paths,
            sampleSize: fm.rows.length,
        };
    }

    window.Patterns = {
        VERSION,
        analyze,
        buildFeatureMatrix,
        computeNormalizationParams,
        normalize,
        findMatches,
        computeOutcomes,
        computePaths,
    };
})();
