// ─── Forward-tracking module ──────────────────────────────────────────
//
// Consumes data/forward_snapshots.json (locked-in KNN snapshots produced
// by scripts/update_forward_snapshots.py) and pairs them with the live
// daily-CSV history to render "Day N/5" cards: for each snapshot still
// in-flight (≤ 5 trading days old), show the top signal thresholds and
// where the actual forward path currently sits.
//
// Conceptual fix vs the old "last 5 days" panel: instead of asking
// "did the most-recent 5 days resemble historically bullish ones",
// we ask "on the date a pattern fired (locked in then), how is the
// real-world 5-day window AFTER it playing out?" The old panel looked
// backward from today; this one tracks forward from each anchor.
//
// Data shape (data/forward_snapshots.json):
//   { version, snapshots: [
//       { anchorDate, createdAt,
//         anchor: { vixLevel, spxLevel },
//         signals: [{ feature, label, interpret, threshold,
//                     tipBull, tipBear, bullMean, bearMean,
//                     bullN, bearN, cohensD, absD }, ...],
//         counts, outcomes, matches, ...
//       }, ...
//   ]}
//
// Live observation per snapshot is computed from the dashboard's hist
// array — anchor+1, anchor+2, ..., up to the latest available day. This
// stays naturally consistent as new trading days are added to the CSV
// history without touching the snapshot file.

(function () {
    'use strict';

    const VERSION = '1.0';
    const EARLY_DAYS = 5;

    function cacheBust() {
        return new Date().toISOString().slice(0, 10);
    }

    async function load() {
        try {
            const bust = cacheBust();
            const r = await fetch(`data/forward_snapshots.json?d=${bust}`,
                                  { cache: 'no-store' });
            if (!r.ok) return { version: VERSION, snapshots: [] };
            return await r.json();
        } catch (err) {
            console.warn('Forward snapshots load failed:', err);
            return { version: VERSION, snapshots: [] };
        }
    }

    // Find index in hist where date === anchorDate. hist is sorted
    // oldest → newest and each entry has a .date in 'YYYY-MM-DD' form.
    function findHistIdx(hist, date) {
        for (let i = 0; i < hist.length; i++) {
            if (hist[i] && hist[i].date === date) return i;
        }
        return -1;
    }

    // Compute live values for one snapshot. Returns an object with one
    // numeric field per signal feature, plus dayIndex (0..5) describing
    // how many forward trading days are available so far.
    //
    // dayIndex semantics:
    //   0 = anchor day only, no forward data yet
    //   1..4 = partial window (some forward days observed)
    //   5    = full 5-day window observed; signal is now "complete"
    //
    // Values are computed from the FIRST 5 forward days only — additional
    // days beyond 5 are ignored so a completed window doesn't keep drifting.
    function evaluate(snapshot, hist) {
        const anchorIdx = findHistIdx(hist, snapshot.anchorDate);
        if (anchorIdx < 0) {
            return { dayIndex: 0, available: false };
        }
        const lastIdx = hist.length - 1;
        const fwdDays = Math.max(0, Math.min(EARLY_DAYS, lastIdx - anchorIdx));

        // Compound SPX and EQ from anchor+1 through anchor+fwdDays.
        let spxCum = 1, eqCum = 1;
        let minSpx = 1, maxSpx = 1, maxDailyMag = 0;
        // VIX anchor comes from the SNAPSHOT (locked in at fire time),
        // not from hist[anchorIdx] — that way the baseline is invariant
        // even if the daily CSV's $VIX row gets revised.
        const vixAnchor = (snapshot.anchor && Number.isFinite(snapshot.anchor.vixLevel))
                          ? snapshot.anchor.vixLevel : null;
        let vixEnd = vixAnchor;
        let vixMax = vixAnchor != null ? vixAnchor : -Infinity;

        for (let k = 1; k <= fwdDays; k++) {
            const h = hist[anchorIdx + k];
            if (!h || !h.m) continue;
            const sp = h.m.macro && h.m.macro.spx && h.m.macro.spx.chgPct != null
                       ? h.m.macro.spx.chgPct : 0;
            const eq = h.m.avgChange != null ? h.m.avgChange : 0;
            spxCum *= (1 + sp / 100);
            eqCum  *= (1 + eq / 100);
            if (spxCum < minSpx) minSpx = spxCum;
            if (spxCum > maxSpx) maxSpx = spxCum;
            if (Math.abs(sp) > maxDailyMag) maxDailyMag = Math.abs(sp);
            const vix = h.m.macro ? h.m.macro.vix : null;
            if (Number.isFinite(vix)) {
                vixEnd = vix;
                if (vix > vixMax) vixMax = vix;
            }
        }

        const spxRet   = (spxCum - 1) * 100;
        const eqRet    = (eqCum  - 1) * 100;
        const spread   = eqRet - spxRet;
        const drawdown = (minSpx - 1) * 100;
        const high     = (maxSpx - 1) * 100;
        const vixPct = (vixAnchor && vixAnchor > 0 && Number.isFinite(vixEnd))
                       ? (vixEnd / vixAnchor - 1) * 100 : null;
        const vixMaxOut = vixMax > -Infinity ? vixMax : null;

        return {
            dayIndex: fwdDays,
            available: true,
            values: {
                spxRetEarly:   spxRet,
                eqRetEarly:    eqRet,
                spreadEarly:   spread,
                earlyDrawdown: drawdown,
                earlyHigh:     high,
                maxDailyMag:   maxDailyMag,
                vixEarlyPct:   vixPct,
                vixEarlyMax:   vixMaxOut,
            },
        };
    }

    // Short labels for the table chips — fits in narrow cells without
    // wrapping. Tooltip on the chip carries the full Hebrew label.
    const SHORT_LABEL = {
        'spxRetEarly':   'SPX 5d',
        'eqRetEarly':    'EQ500 5d',
        'spreadEarly':   'פער',
        'earlyDrawdown': 'drawdown',
        'earlyHigh':     'שיא חדש',
        'maxDailyMag':   'vol יומית',
        'vixEarlyPct':   'VIX Δ',
        'vixEarlyMax':   'VIX max',
    };
    function shortenLabel(longLabel) {
        // Try to match a known key by searching for it in the longLabel
        // (fall back to first two words if unknown).
        for (const key of Object.keys(SHORT_LABEL)) {
            // We don't have feature key here, only the full Hebrew label.
            // The render function will pass sig.feature separately if it
            // wants the short label — leaving this as a safety fallback.
        }
        return longLabel;
    }

    // Direct map by feature key — cleaner than text matching.
    function shortLabelFor(feature, fallback) {
        return SHORT_LABEL[feature] || fallback || feature;
    }

    // ─── Trading-day arithmetic (US market) ───────────────────────────
    // Used to project the "Day 20" target date when a pattern reaches
    // Day 5/5 — the user wants to see WHEN the 20-day historical median
    // outcome would land. Skips weekends + a hardcoded list of US market
    // holidays for 2026-2027. Years beyond 2027 will be approximate.
    const US_HOLIDAYS = new Set([
        // 2026
        '2026-01-01','2026-01-19','2026-02-16','2026-04-03',
        '2026-05-25','2026-06-19','2026-07-03','2026-09-07',
        '2026-11-26','2026-12-25',
        // 2027
        '2027-01-01','2027-01-18','2027-02-15','2027-03-26',
        '2027-05-31','2027-06-18','2027-07-05','2027-09-06',
        '2027-11-25','2027-12-24',
    ]);

    function isoFromDate(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
    }

    function addTradingDays(isoDate, n) {
        const [y, m, d] = isoDate.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        let added = 0;
        while (added < n) {
            date.setDate(date.getDate() + 1);
            const day = date.getDay();
            if (day === 0 || day === 6) continue;          // weekend
            if (US_HOLIDAYS.has(isoFromDate(date))) continue; // holiday
            added++;
        }
        return isoFromDate(date);
    }

    // Build the "matured" projection row HTML — appears immediately below
    // any pattern that has reached Day 5/5. Pulls outcome stats from the
    // snapshot's 20-day distribution.
    function maturedRowHtml(snap, rowBull, rowVotes) {
        const out20 = (snap.outcomes && snap.outcomes['20']) || {};
        if (!out20.samples) return '';
        const day20Iso = addTradingDays(snap.anchorDate, 20);
        const day20 = formatDate(day20Iso);
        const med = out20.median, mn = out20.min, mx = out20.max;
        const hit = out20.hitRate || 0;
        const medClass = med > 0 ? 'ov2-pos' : med < 0 ? 'ov2-neg' : '';
        const medSign = med >= 0 ? '+' : '';
        const minSign = mn >= 0 ? '+' : '';
        const maxSign = mx >= 0 ? '+' : '';
        // Confidence tone — full confirmation (3/3) gets a positive border,
        // partial confirmation a neutral one. Reflects how much weight to
        // place on the historical median.
        const confClass = rowVotes > 0 && rowBull === rowVotes
            ? 'ov2-ft-matured-confirmed'
            : (rowVotes > 0 && rowBull > 0
                ? 'ov2-ft-matured-mixed'
                : 'ov2-ft-matured-failed');
        const confLabel = rowVotes > 0
            ? `${rowBull}/${rowVotes} סיגנלים אישרו`
            : '';
        return `
            <tr class="ov2-ft-matured-row">
                <td colspan="4">
                    <div class="ov2-ft-matured ${confClass}">
                        <span class="ov2-ft-matured-icon">🎯</span>
                        <span><b>תבנית ${formatDate(snap.anchorDate)} השלימה 5 ימי מסחר</b>${confLabel ? ' · ' + confLabel : ''}</span>
                        <span class="ov2-ft-matured-sep">·</span>
                        <span>צפי ליום ה-20 (סביב <b>${day20}</b>):</span>
                        <b class="${medClass}">${medSign}${med.toFixed(2)}% חציון</b>
                        <span class="ov2-ft-matured-sep">·</span>
                        <span>טווח ${minSign}${mn.toFixed(2)}% עד ${maxSign}${mx.toFixed(2)}%</span>
                        <span class="ov2-ft-matured-sep">·</span>
                        <span>הצלחה היסטורית <b>${Math.round(hit * 100)}%</b></span>
                    </div>
                </td>
            </tr>
        `;
    }

    // ─── Render the forward-tracking panel ───────────────────────────
    //
    // Layout: a single table inside one card. Each row = one active
    // pattern. As new trading days produce new snapshots, rows are
    // appended automatically. Each row shows the anchor date, Day N/5
    // progress, the top 3 signals' live status as compact chips, and a
    // per-row verdict.
    //
    // The signals chips are inline (not fixed columns) because different
    // anchors can have different top-3 signals — each row carries its
    // own. This keeps the table compact and the signal interpretation
    // honest (each row's chips are for ITS thresholds, not a forced
    // unified set).
    function render(snapshots, hist, opts) {
        opts = opts || {};
        const panel = document.getElementById('ov2_echoEarlyWarning');
        if (!panel) return;
        const signalsEl = document.getElementById('ov2_echoEwSignals');
        const subEl = document.getElementById('ov2_echoEwSub');
        const verdictEl = document.getElementById('ov2_echoEwVerdict');

        if (!Array.isArray(snapshots) || snapshots.length === 0) {
            panel.style.display = 'none';
            return;
        }

        const sorted = snapshots.slice().sort((a, b) =>
            (a.anchorDate < b.anchorDate ? 1 : a.anchorDate > b.anchorDate ? -1 : 0)
        );
        const inFlight = [];
        for (const s of sorted) {
            const idx = findHistIdx(hist, s.anchorDate);
            if (idx < 0) continue;
            const fwd = (hist.length - 1) - idx;
            if (fwd > EARLY_DAYS) break;
            inFlight.push({ snap: s, fwd });
        }

        if (inFlight.length === 0) {
            panel.style.display = 'none';
            return;
        }

        if (subEl) {
            subEl.textContent =
                `${inFlight.length} ${inFlight.length === 1 ? 'תבנית פעילה' : 'תבניות פעילות'} ` +
                '(תוך 5 ימי מסחר אחרונים). שורה לכל תבנית; ' +
                'מתווספת אוטומטית בכל יום מסחר חדש.';
        }

        if (signalsEl) signalsEl.innerHTML = '';

        let bullVotes = 0, bearVotes = 0, totalVotes = 0;

        // Build the table rows
        const rows = [];
        for (const { snap } of inFlight) {
            const obs = evaluate(snap, hist);
            const dayCell = obs.dayIndex >= EARLY_DAYS
                ? `<span class="ov2-ft-day ov2-ft-day-${EARLY_DAYS}">${EARLY_DAYS}/${EARLY_DAYS} ✓</span>`
                : `<span class="ov2-ft-day ov2-ft-day-${obs.dayIndex}">${obs.dayIndex}/${EARLY_DAYS}</span>`;

            const top = (snap.signals || []).slice(0, 3);
            let rowBull = 0, rowBear = 0, rowVotes = 0;
            const chips = [];

            for (const sig of top) {
                const thSign = sig.threshold >= 0 ? '+' : '';
                const thStr = `${thSign}${sig.threshold.toFixed(2)}${sig.feature === 'vixEarlyMax' ? '' : '%'}`;
                const v = obs.values ? obs.values[sig.feature] : null;
                const shortLabel = shortLabelFor(sig.feature, sig.label);

                if (v != null && Number.isFinite(v) && obs.dayIndex > 0) {
                    rowVotes++; totalVotes++;
                    const valSign = v >= 0 ? '+' : '';
                    const valStr = `${valSign}${v.toFixed(2)}${sig.feature === 'vixEarlyMax' ? '' : '%'}`;
                    let pass;
                    if (sig.interpret === 'bull_above')  pass = v >= sig.threshold;
                    else                                  pass = v <= sig.threshold;
                    if (pass) { rowBull++; bullVotes++; } else { rowBear++; bearVotes++; }
                    const cmp = sig.interpret === 'bull_above' ? '≥' : '≤';
                    const klass = pass ? 'pos' : 'neg';
                    const mark = pass ? '✓' : '✗';
                    chips.push(`
                        <div class="ov2-ft-chip ov2-${klass}" title="${sig.label} — ${shortLabel} · רמת הפרדה: Cohen d ${sig.cohensD >= 0 ? '+' : ''}${sig.cohensD.toFixed(2)}">
                            <span class="ov2-ft-chip-name">${shortLabel}</span>
                            <span class="ov2-ft-chip-val">${valStr}</span>
                            <span class="ov2-ft-chip-cmp">${cmp} ${thStr}</span>
                            <span class="ov2-ft-chip-mark">${mark}</span>
                        </div>`);
                } else {
                    chips.push(`
                        <div class="ov2-ft-chip ov2-ft-chip-pending" title="${sig.label} — סף ${thStr}">
                            <span class="ov2-ft-chip-name">${shortLabel}</span>
                            <span class="ov2-ft-chip-val">—</span>
                            <span class="ov2-ft-chip-cmp">סף ${thStr}</span>
                        </div>`);
                }
            }

            let verdict;
            if (rowVotes === 0) {
                verdict = '<span class="ov2-ft-verdict ov2-ft-verdict-pending">ממתינים</span>';
            } else if (rowBull === rowVotes) {
                verdict = `<span class="ov2-ft-verdict ov2-pos">${rowBull}/${rowVotes} חיובי</span>`;
            } else if (rowBear === rowVotes) {
                verdict = `<span class="ov2-ft-verdict ov2-neg">${rowBear}/${rowVotes} אזהרה</span>`;
            } else {
                verdict = `<span class="ov2-ft-verdict">${rowBull}/${rowVotes} חיובי</span>`;
            }

            rows.push(`
                <tr>
                    <td class="ov2-ft-td-anchor">${formatDate(snap.anchorDate)}</td>
                    <td class="ov2-ft-td-day">${dayCell}</td>
                    <td class="ov2-ft-td-signals">
                        <div class="ov2-ft-chips">${chips.join('')}</div>
                    </td>
                    <td class="ov2-ft-td-verdict">${verdict}</td>
                </tr>`);
            // When pattern reaches Day 5/5 (the last day it appears in
            // the table before falling out), append a "matured" projection
            // row right below it — shows day-20 target date + expected
            // outcome from the historical analogs.
            if (obs.dayIndex >= EARLY_DAYS) {
                const maturedHtml = maturedRowHtml(snap, rowBull, rowVotes);
                if (maturedHtml) rows.push(maturedHtml);
            }
        }

        if (signalsEl) {
            signalsEl.innerHTML = `
                <table class="ov2-ft-table">
                    <thead>
                        <tr>
                            <th class="ov2-ft-th-anchor">מקור</th>
                            <th class="ov2-ft-th-day">התקדמות</th>
                            <th class="ov2-ft-th-signals">סיגנלים מובילים (נכון להיום נגד סף ההפרדה)</th>
                            <th class="ov2-ft-th-verdict">סיכום</th>
                        </tr>
                    </thead>
                    <tbody>${rows.join('')}</tbody>
                </table>`;
        }

        if (verdictEl) {
            if (totalVotes === 0) {
                verdictEl.textContent = `${inFlight.length} תבניות פעילות — ממתינים לנתוני 5 ימי מסחר אחרי כל מקור.`;
                verdictEl.className = 'ov2-echo-ew-verdict';
            } else if (bullVotes === totalVotes) {
                verdictEl.textContent = `סיכום: ${bullVotes}/${totalVotes} סימנים נוטים לתרחיש החיובי (על פני ${inFlight.length} תבניות פעילות).`;
                verdictEl.className = 'ov2-echo-ew-verdict ov2-pos';
            } else if (bearVotes === totalVotes) {
                verdictEl.textContent = `סיכום: ${bearVotes}/${totalVotes} סימנים נוטים לאזהרה (על פני ${inFlight.length} תבניות פעילות).`;
                verdictEl.className = 'ov2-echo-ew-verdict ov2-neg';
            } else {
                verdictEl.textContent = `סיכום: ${bullVotes} חיובי · ${bearVotes} אזהרה — מצב מעורב (על פני ${inFlight.length} תבניות פעילות).`;
                verdictEl.className = 'ov2-echo-ew-verdict';
            }
        }

        panel.style.display = '';
    }

    function formatDate(iso) {
        if (!iso || iso.length < 10) return iso || '';
        return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
    }

    window.ForwardTracking = {
        VERSION,
        EARLY_DAYS,
        load,
        evaluate,
        render,
    };
})();
