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

    function buildFeatureMatrix(spxSeries, eqSeries, vixSeries) {
        // Pre-build cumulative level series and align both by date.
        // We need a SPX level for the 60d drawdown; everything else
        // is computed from % returns directly.
        const spxByDate = Object.create(null);
        const eqByDate = Object.create(null);
        const vixByDate = Object.create(null);
        for (const r of spxSeries) spxByDate[r.date] = r.pct;
        for (const r of eqSeries)  eqByDate[r.date]  = r.pct;
        if (Array.isArray(vixSeries)) {
            for (const r of vixSeries) vixByDate[r.date] = r.close;
        }

        const dates = spxSeries.map(r => r.date);

        // Reconstruct SPX levels from % series (start at 100).
        const spxLevels = new Array(dates.length);
        let lvl = 100;
        for (let i = 0; i < dates.length; i++) {
            const p = spxSeries[i].pct;
            if (Number.isFinite(p)) lvl *= (1 + p / 100);
            spxLevels[i] = lvl;
        }

        // Parallel VIX level array (aligned to dates). Some early days
        // may be missing if the historical VIX file doesn't cover them
        // — those rows just won't contribute VIX features.
        const vixLevels = new Array(dates.length);
        for (let i = 0; i < dates.length; i++) {
            const v = vixByDate[dates[i]];
            vixLevels[i] = Number.isFinite(v) ? v : null;
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

            // VIX features — only computed when the historical VIX file
            // covers this day. Days without VIX data fall back to NaN
            // for these three dimensions, which the normalization step
            // treats as "skip this dimension for this row" (it gets a
            // z-score of 0 and contributes nothing to KNN distance).
            const vixToday = vixLevels[i];
            let vixLevel = NaN, vix5dDelta = NaN, vixVsMa20 = NaN;
            if (Number.isFinite(vixToday)) {
                vixLevel = vixToday;
                // 5-day delta: percent change in VIX over 5 trading days
                const vix5dAgo = vixLevels[i - 5];
                if (Number.isFinite(vix5dAgo) && vix5dAgo > 0) {
                    vix5dDelta = (vixToday / vix5dAgo - 1) * 100;
                }
                // VIX vs 20-day MA: where today's VIX sits relative to
                // its recent average. Positive = VIX is elevated vs
                // recent baseline. Critical for identifying fear regimes.
                const vix20Window = [];
                for (let k = i - 19; k <= i; k++) {
                    if (Number.isFinite(vixLevels[k])) vix20Window.push(vixLevels[k]);
                }
                if (vix20Window.length >= 10) {
                    const ma20 = mean(vix20Window);
                    if (ma20 > 0) vixVsMa20 = (vixToday / ma20 - 1) * 100;
                }
            }

            rows.push({
                idx: i,
                date: dates[i],
                level: spxLevels[i],
                features: [
                    spxRet5d, spxRet20d, eqRet5d, spread5d,
                    drawdown60d, vol20d,
                    vixLevel, vix5dDelta, vixVsMa20,
                ],
            });
        }

        const featureNames = [
            'SPX 5d', 'SPX 20d', 'EQ500 5d', 'Spread 5d', 'Drawdown 60d', 'Vol 20d',
            'VIX רמה', 'VIX 5d Δ', 'VIX vs MA20',
        ];

        // Expose the date→EQ lookup too so callers (computeEarlyWarning)
        // can rebuild the EQ level series without re-walking the array.
        return { rows, dates, spxLevels, vixLevels, eqByDate, featureNames };
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
        // Keep missing features as NaN so pairDistance can SKIP them
        // (treating missing as the mean = z=0 falsely IMPROVES the
        // partial-data candidate's distance — see README §audit-fix-3).
        const out = new Array(vec.length);
        for (let d = 0; d < vec.length; d++) {
            if (!Number.isFinite(vec[d])) { out[d] = NaN; continue; }
            out[d] = (vec[d] - params.mu[d]) / params.sigma[d];
        }
        return out;
    }

    // Feature weights for the distance metric. All 9 features are still
    // COMPUTED and stored (display, debugging, future re-weighting), but
    // two are excluded from similarity because they double-count
    // information already present in other dimensions:
    //   - eqRet5d (idx 2):    linearly dependent on spread5d + spxRet5d —
    //                         breadth was counted twice.
    //   - vixVsMa20 (idx 8):  highly correlated with vixLevel + vix5dDelta —
    //                         VIX shocks were counted three times, which is
    //                         why crash days found so few "valid" matches.
    // Effective dimensionality: 7.
    const FEATURE_WEIGHTS = [1, 1, 0, 1, 1, 1, 1, 1, 0];

    // Weighted distance ignoring dimensions missing in either vector.
    // The partial squared sum is scaled back to full-weight scale
    // (sklearn nan_euclidean approach) so a 5-of-7-dim distance is
    // comparable to a 7-of-7-dim distance.
    function pairDistance(a, b) {
        const D = a.length;
        let totalW = 0;
        for (let k = 0; k < D; k++) totalW += (FEATURE_WEIGHTS[k] != null ? FEATURE_WEIGHTS[k] : 1);
        let d2 = 0, usedW = 0, dimsUsed = 0;
        for (let k = 0; k < D; k++) {
            const w = FEATURE_WEIGHTS[k] != null ? FEATURE_WEIGHTS[k] : 1;
            if (w === 0) continue;
            const av = a[k], bv = b[k];
            if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
            d2 += w * (av - bv) * (av - bv);
            usedW += w;
            dimsUsed++;
        }
        if (usedW === 0) return { distance: Infinity, dimsUsed: 0 };
        return { distance: Math.sqrt(d2 * (totalW / usedW)), dimsUsed };
    }

    // ─── KNN: find closest historical days ────────────────────────────
    //
    // - excludeRecent: skip matches within N trading days of today (i.e.
    //   the last entries in the matrix). Default 30 — autocorrelation
    //   makes very recent days trivially "similar" to today, which
    //   tells us nothing.
    // - clusterDedup: after picking a match, skip any subsequent match
    //   within ±40 trading days of it. 40 ≥ the 20d outcome window, so
    //   accepted matches have NON-OVERLAPPING forward windows — the K
    //   outcomes are quasi-independent episodes, not one episode counted
    //   K times. (Was ±20, which allowed 19 of 20 outcome days to overlap.)
    function findMatches(rows, params, todayVec, opts) {
        opts = opts || {};
        const K = opts.k || 10;   // keep in sync with K in update_forward_snapshots.py
        const excludeRecent = opts.excludeRecent != null ? opts.excludeRecent : 30;
        const clusterDedup = opts.clusterDedup != null ? opts.clusterDedup : 40;

        const todayNorm = normalize(todayVec, params);
        const lastIdx = rows[rows.length - 1].idx;
        // Compute distance to every row except the most-recent N.
        // pairDistance skips dimensions missing in either vector and
        // scales the partial sum back to full-D scale so partial-data
        // candidates aren't unfairly favoured.
        const candidates = [];
        for (const r of rows) {
            if (lastIdx - r.idx <= excludeRecent) continue;
            const v = normalize(r.features, params);
            const { distance, dimsUsed } = pairDistance(todayNorm, v);
            if (!Number.isFinite(distance)) continue;
            candidates.push({ row: r, distance, dimsUsed });
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

    // ─── Early-warning analysis ───────────────────────────────────────
    //
    // Given the K matches and their forward outcomes, look at what
    // happened in the FIRST few days after each match (default 5) and
    // search for features that separate the bullish 20-day outcomes
    // from the bearish ones. The point isn't prediction — it's a
    // diagnostic recipe: "in 5 days, check feature X. If it's above
    // threshold Y → continuation pattern. If below → blow-off pattern."
    //
    // With our typical sample (12 matches splitting into 9 bullish and
    // 2-3 bearish), the statistics are tiny — Cohen's d acts as the
    // separation metric but should be read as suggestive, not proof.
    // The UI surfaces sample sizes alongside any threshold it cites.
    function computeEarlyWarning(matches, spxLevels, eqLevels, opts) {
        opts = opts || {};
        const earlyDays = opts.earlyDays || 5;
        const outcomeWindow = opts.outcomeWindow || 20;
        const bullThreshold = opts.bullThreshold != null ? opts.bullThreshold : 1.0;
        const bearThreshold = opts.bearThreshold != null ? opts.bearThreshold : -1.0;
        // VIX levels are an optional parallel array — when provided we
        // compute a VIX-direction feature for each match's early window.
        // Days without VIX data (early history) just won't contribute
        // a vixEarly value, and that match drops out of the VIX signal
        // computation but stays in for the others.
        const vixLevels = Array.isArray(opts.vixLevels) ? opts.vixLevels : null;

        const enriched = [];
        for (const m of matches) {
            const i0 = m.row.idx;
            if (i0 + outcomeWindow >= spxLevels.length) continue;
            const spxStart = spxLevels[i0];
            const eqStart = eqLevels[i0];
            if (!Number.isFinite(spxStart) || spxStart <= 0
                    || !Number.isFinite(eqStart) || eqStart <= 0) continue;

            // 20-day outcome — same metric the outcomes object reports,
            // recomputed here to avoid coupling to caller's data shape.
            const outcome20d = (spxLevels[i0 + outcomeWindow] / spxStart - 1) * 100;
            const outcomeLabel =
                outcome20d >= bullThreshold ? 'bullish' :
                outcome20d <= bearThreshold ? 'bearish' : 'flat';

            // Early-window features (days 1..earlyDays after match).
            // We clamp to the end of the data so matches very close to
            // today don't crash — they're just dropped from the analysis
            // upstream by the outcomeWindow check.
            const endIdx = Math.min(i0 + earlyDays, spxLevels.length - 1);
            const eqEndIdx = Math.min(i0 + earlyDays, eqLevels.length - 1);
            const spxEnd = spxLevels[endIdx];
            const eqEnd  = eqLevels[eqEndIdx];
            const spxRetEarly = (spxEnd / spxStart - 1) * 100;
            const eqRetEarly  = (eqEnd  / eqStart  - 1) * 100;
            const spreadEarly = eqRetEarly - spxRetEarly;

            // Drawdown + max gain within early window — diagnostic of
            // whether the pattern broke down ("crash within 5 days") or
            // expanded ("breakout within 5 days").
            let lowSpx = spxStart, highSpx = spxStart;
            for (let k = 1; k <= earlyDays && i0 + k < spxLevels.length; k++) {
                if (spxLevels[i0 + k] < lowSpx)  lowSpx = spxLevels[i0 + k];
                if (spxLevels[i0 + k] > highSpx) highSpx = spxLevels[i0 + k];
            }
            const earlyDrawdown = (lowSpx / spxStart - 1) * 100;   // ≤ 0
            const earlyHigh     = (highSpx / spxStart - 1) * 100;  // ≥ 0

            // Max single-day move MAGNITUDE — volatility-burst proxy.
            // High value here means at least one day in the window had
            // unusually large absolute %change.
            let maxDailyMag = 0;
            for (let k = 1; k <= earlyDays && i0 + k < spxLevels.length; k++) {
                const dPrev = spxLevels[i0 + k - 1];
                if (!Number.isFinite(dPrev) || dPrev <= 0) continue;
                const d = (spxLevels[i0 + k] / dPrev - 1) * 100;
                if (Math.abs(d) > maxDailyMag) maxDailyMag = Math.abs(d);
            }

            // VIX early-window features. We compute two complementary
            // VIX metrics so the separation analysis can pick whichever
            // separates the cohorts better:
            //   vixEarlyPct = relative change in VIX over the window
            //                 (e.g., VIX fell 15% = -15)
            //   vixEarlyMax = MAX VIX seen in the window (absolute level)
            // Days where vixLevels is missing get NaN — the separation
            // analysis already skips features that lack >= 2 paired
            // samples per cohort.
            let vixEarlyPct = NaN, vixEarlyMax = NaN;
            if (vixLevels) {
                const vixStart = vixLevels[i0];
                if (Number.isFinite(vixStart) && vixStart > 0) {
                    let runMax = vixStart;
                    let vixEnd = vixStart;
                    for (let k = 1; k <= earlyDays && i0 + k < vixLevels.length; k++) {
                        const v = vixLevels[i0 + k];
                        if (!Number.isFinite(v)) continue;
                        if (v > runMax) runMax = v;
                        vixEnd = v;
                    }
                    vixEarlyPct = (vixEnd / vixStart - 1) * 100;
                    vixEarlyMax = runMax;
                }
            }

            enriched.push({
                date: m.row.date,
                outcome20d,
                outcomeLabel,
                features: { spxRetEarly, eqRetEarly, spreadEarly,
                            earlyDrawdown, earlyHigh, maxDailyMag,
                            vixEarlyPct, vixEarlyMax },
            });
        }

        // Bucket by outcome.
        // bearish AND flat are merged into a single "non-bullish" bucket
        // for the separation analysis — with K=10 matches the bearish
        // bucket on its own is almost always too small (n=1) to compute
        // a stddev. The combined bucket gives us a meaningful "what
        // distinguishes the +1% continuations from everything else?"
        // comparison.
        const bullish = enriched.filter(e => e.outcomeLabel === 'bullish');
        const bearish = enriched.filter(e => e.outcomeLabel === 'bearish');
        const flat    = enriched.filter(e => e.outcomeLabel === 'flat');
        const notBullish = enriched.filter(e => e.outcomeLabel !== 'bullish');

        // Per-feature separation: Cohen's d between bullish and not-bullish.
        // With tiny n, use a defensive pooled-std denominator and skip
        // features where one bucket has < 2 samples (std undefined).
        // Each feature carries TWO tip pairs — one for the "bullish has
        // higher values" interpretation and one for "bullish has lower
        // values". The actual direction is then picked at runtime from
        // the cohort means (rather than hardcoded), so the displayed
        // rule can't drift out of sync with the data.
        const featureMeta = [
            { key: 'spxRetEarly',   label: 'תשואת SPX ב-5 ימים אחרי', unit: '%',
              above: { tipBull: 'המשיך לעלות',        tipBear: 'נעצר/ירד' },
              below: { tipBull: 'תזוזה מתונה',         tipBear: 'תנועה חזקה לא טובה' } },
            { key: 'eqRetEarly',    label: 'תשואת EQ500 ב-5 ימים אחרי', unit: '%',
              above: { tipBull: 'רוחב המשיך',          tipBear: 'הרוחב נעצר' },
              below: { tipBull: 'רוחב מתון',           tipBear: 'רוחב חזק לא תורם' } },
            { key: 'spreadEarly',   label: 'פער EQ500−SPX ב-5 ימים אחרי', unit: '%',
              above: { tipBull: 'הרוחב המשיך לבד',     tipBear: 'הפער מתאזן' },
              below: { tipBull: 'המגה-קאפס תופסות הובלה — ראלי בוגר',
                       tipBear: 'רוחב יתום ללא תמיכת מגה-קאפס' } },
            { key: 'earlyDrawdown', label: 'נפילה מקסימלית של SPX ב-5 ימים', unit: '%',
              above: { tipBull: 'דיפים רדודים',        tipBear: 'דיפ חד — תיקון' },
              below: { tipBull: 'יציבות בלי נפילות',   tipBear: 'דיפ עמוק יחסית' } },
            { key: 'earlyHigh',     label: 'שיא חדש של SPX ב-5 ימים', unit: '%',
              above: { tipBull: 'פריצת שיא נוסף',      tipBear: 'לא שיא חדש' },
              below: { tipBull: 'בלי פריצות מטעות',    tipBear: 'שיא חדש לא מחזיק' } },
            { key: 'maxDailyMag',   label: 'תנודתיות מקסימלית ביום בודד ב-5 ימים', unit: '%',
              above: { tipBull: 'יום חזק אחד — אנרגיה בשוק', tipBear: 'יום נפילה חד' },
              below: { tipBull: 'תנועה מתונה',         tipBear: 'תנודתיות עלתה — אזהרה' } },
            // VIX-direction signal: "did fear rise or fall in the 5
            // days after a pattern fired?" Empirically: in bullish
            // continuations VIX drops further, in non-bullish it stays
            // flat or rises. Direction is data-driven so the tips work
            // regardless of which way the cohorts split.
            { key: 'vixEarlyPct',   label: 'שינוי VIX ב-5 ימים אחרי', unit: '%',
              above: { tipBull: 'הפחד עלה — אנרגיה',  tipBear: 'הפחד עלה — אזהרה אמיתית' },
              below: { tipBull: 'הפחד נחלש — אישור חיובי', tipBear: 'הפחד נשאר גבוה' } },
            // VIX peak in the window — absolute level, captures
            // "panic spikes" even if VIX returned by day 5.
            { key: 'vixEarlyMax',   label: 'VIX מקסימלי ב-5 ימים אחרי', unit: '',
              above: { tipBull: 'VIX קפץ אבל ירד — אישור התאוששות', tipBear: 'VIX קפץ ונשאר — אזהרה' },
              below: { tipBull: 'VIX יציב — אישור רוגע', tipBear: 'VIX יציב אבל מחיר חלש' } },
        ];

        const signals = [];
        for (const meta of featureMeta) {
            const bullVals = bullish.map(e => e.features[meta.key]).filter(Number.isFinite);
            const otherVals = notBullish.map(e => e.features[meta.key]).filter(Number.isFinite);
            if (bullVals.length < 2 || otherVals.length < 2) continue;
            const bullMu = mean(bullVals);
            const otherMu = mean(otherVals);
            const bullSd = std(bullVals, bullMu);
            const otherSd = std(otherVals, otherMu);
            const pooled = Math.sqrt((bullSd * bullSd + otherSd * otherSd) / 2);
            let cohensD = null;
            if (pooled > 0) cohensD = (bullMu - otherMu) / pooled;
            // Threshold = midpoint between the two cohort means. Values
            // past this on the bullish side tilt toward continuation.
            const threshold = (bullMu + otherMu) / 2;
            // Direction is data-driven: if the bullish cohort's mean is
            // higher, the rule reads "value ≥ threshold → bullish"
            // (bull_above). If lower, "value ≤ threshold → bullish"
            // (bull_below). The hardcoded interpret was the original
            // source of two display bugs (spread + vol read backwards).
            const interpret = bullMu >= otherMu ? 'bull_above' : 'bull_below';
            const tips = interpret === 'bull_above' ? meta.above : meta.below;
            // Reliability guard — with 8 features tested on ~10 samples,
            // SOME feature will always show high |d| by pure chance
            // (multiple-comparisons problem). A signal is only "reliable"
            // when the separation is large AND both cohorts have enough
            // members for the means to be meaningful. Everything else is
            // displayed as a hint, never as a ✓/✗ verdict.
            const absD = cohensD != null ? Math.abs(cohensD) : 0;
            const reliable = absD >= 0.8 && bullVals.length >= 4 && otherVals.length >= 3;
            signals.push({
                feature: meta.key,
                label: meta.label,
                interpret,
                tipBull: tips.tipBull,
                tipBear: tips.tipBear,
                bullMean: bullMu,
                bearMean: otherMu,         // historical "non-bullish" — keeps the UI name compatible
                bullN: bullVals.length,
                bearN: otherVals.length,
                cohensD,
                absD,
                threshold,
                reliable,
            });
        }
        // Sort by separation strength (largest absolute Cohen's d first)
        signals.sort((a, b) => b.absD - a.absD);

        return {
            enriched,
            counts: { bullish: bullish.length, bearish: bearish.length,
                      flat: flat.length, notBullish: notBullish.length,
                      total: enriched.length },
            signals,
            earlyDays,
            outcomeWindow,
        };
    }

    // ─── End-to-end convenience ──────────────────────────────────────
    //
    // Pass the {spx, eq} arrays Historical.buildSplicedSeries returns
    // and get the full analysis package — feature matrix, today's
    // vector, top matches, forward-return outcomes. The UI just reads.
    function analyze(spliced, opts) {
        opts = opts || {};
        const fm = buildFeatureMatrix(spliced.spx, spliced.eq, spliced.vix);
        if (fm.rows.length === 0) {
            return { error: 'Not enough history to compute features.' };
        }
        const params = computeNormalizationParams(fm.rows);
        const todayRow = fm.rows[fm.rows.length - 1];
        const matches = findMatches(fm.rows, params, todayRow.features, opts);
        const outcomes = computeOutcomes(matches, fm.spxLevels, opts.windows);
        const paths = computePaths(matches, fm.spxLevels, opts.pathHorizon || 20);
        // Early-warning needs the EQ level series too. Reconstruct it
        // here the same way buildFeatureMatrix builds the SPX series.
        const eqLevels = new Array(fm.dates.length);
        let elvl = 100;
        for (let i = 0; i < fm.dates.length; i++) {
            // The EQ series isn't part of fm.rows directly — we rebuild
            // it from the eqByDate lookup we used during feature build.
            // Defensive: if a date is missing in eq, the level just
            // carries forward (so the array is always full-length).
            const eqPct = fm.eqByDate ? fm.eqByDate[fm.dates[i]] : null;
            if (Number.isFinite(eqPct)) elvl *= (1 + eqPct / 100);
            eqLevels[i] = elvl;
        }
        const earlyWarning = computeEarlyWarning(matches, fm.spxLevels, eqLevels, {
            earlyDays: opts.earlyDays || 5,
            outcomeWindow: 20,
            vixLevels: fm.vixLevels,
        });
        return {
            asOfDate: todayRow.date,
            todayFeatures: todayRow.features,
            featureNames: fm.featureNames,
            normParams: params,
            matches: matches.map(m => ({
                date: m.row.date,
                idx: m.row.idx,
                distance: m.distance,
                dimsUsed: m.dimsUsed,
                features: m.row.features,
            })),
            outcomes,
            paths,
            earlyWarning,
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
        computeEarlyWarning,
    };
})();
