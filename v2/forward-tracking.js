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

    // ─── Render the forward-tracking panel ───────────────────────────
    //
    // Layout: one card per snapshot, ordered NEWEST first. Each card
    // shows the anchor date, Day N/5 progress, top 3 signals with their
    // live observation vs threshold, and a verdict line.
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

        // Snapshots come oldest → newest from the JSON. We want newest
        // first, and we want to focus on the ones still in-flight or
        // just-matured (within last EARLY_DAYS + 2 trading days).
        const sorted = snapshots.slice().sort((a, b) =>
            (a.anchorDate < b.anchorDate ? 1 : a.anchorDate > b.anchorDate ? -1 : 0)
        );
        // Find which snapshots have anchorDate in the current hist array
        // and are within EARLY_DAYS of the latest hist day.
        const lastDate = hist && hist.length ? hist[hist.length - 1].date : null;
        const inFlight = [];
        for (const s of sorted) {
            const idx = findHistIdx(hist, s.anchorDate);
            if (idx < 0) continue;
            const fwd = (hist.length - 1) - idx;
            if (fwd > EARLY_DAYS) break;   // older — stop (they're already mature)
            inFlight.push({ snap: s, fwd });
        }

        if (inFlight.length === 0) {
            panel.style.display = 'none';
            return;
        }

        if (subEl) {
            subEl.textContent =
                `מעקב קדימה: ${inFlight.length} תבניות פעילות (תוך 5 ימי מסחר אחרונים). ` +
                'כל כרטיסייה — מהיום שבו הופעלה תבנית עד היום.';
        }

        // Render
        if (signalsEl) signalsEl.innerHTML = '';

        let bullVotes = 0, bearVotes = 0, totalVotes = 0;

        for (const { snap, fwd } of inFlight) {
            const obs = evaluate(snap, hist);
            const dayLabel = obs.dayIndex >= EARLY_DAYS
                ? `Day ${EARLY_DAYS}/${EARLY_DAYS} — חלון הושלם`
                : obs.dayIndex === 0
                    ? `Day 0/${EARLY_DAYS} — ממתינים לימי מסחר`
                    : `Day ${obs.dayIndex}/${EARLY_DAYS}`;

            const sigCards = [];
            const top = (snap.signals || []).slice(0, 3);
            let cardBull = 0, cardBear = 0, cardVotes = 0;

            for (const sig of top) {
                const strong = sig.absD >= 0.7;
                const sign = sig.threshold >= 0 ? '+' : '';
                const thStr = `${sign}${sig.threshold.toFixed(2)}%`;

                let rule;
                if (sig.interpret === 'bull_above') {
                    rule = `אם ≥ <strong>${thStr}</strong> → ${sig.tipBull} (חיובי). אחרת → ${sig.tipBear} (אזהרה).`;
                } else {
                    rule = `אם ≤ <strong>${thStr}</strong> → ${sig.tipBull} (חיובי). אחרת → ${sig.tipBear} (אזהרה).`;
                }

                let liveBlock = '';
                const v = obs.values ? obs.values[sig.feature] : null;
                if (v != null && Number.isFinite(v) && obs.dayIndex > 0) {
                    cardVotes++; totalVotes++;
                    const valSign = v >= 0 ? '+' : '';
                    const valStr = `${valSign}${v.toFixed(2)}%`;
                    let leaning, klass;
                    if (sig.interpret === 'bull_above') {
                        if (v >= sig.threshold) { leaning = 'נוטה חיובי'; klass = 'pos'; cardBull++; bullVotes++; }
                        else                     { leaning = 'נוטה אזהרה'; klass = 'neg'; cardBear++; bearVotes++; }
                    } else {
                        if (v <= sig.threshold) { leaning = 'נוטה חיובי'; klass = 'pos'; cardBull++; bullVotes++; }
                        else                     { leaning = 'נוטה אזהרה'; klass = 'neg'; cardBear++; bearVotes++; }
                    }
                    const partial = obs.dayIndex < EARLY_DAYS
                        ? ` <span class="ov2-ft-partial">(${obs.dayIndex}/${EARLY_DAYS} ימים)</span>`
                        : '';
                    liveBlock = `
                        <div class="ov2-echo-ew-signal-live">
                            <span class="ov2-echo-ew-signal-live-label">נכון להיום:</span>
                            <span class="ov2-echo-ew-signal-live-val">${valStr}</span>
                            <span class="ov2-echo-ew-signal-live-status ov2-${klass}">${leaning}</span>
                            ${partial}
                        </div>`;
                } else if (obs.dayIndex === 0) {
                    liveBlock = `
                        <div class="ov2-echo-ew-signal-live">
                            <span class="ov2-echo-ew-signal-live-label">ממתינים</span>
                            <span class="ov2-echo-ew-signal-live-pending">אין עדיין ימי מסחר אחרי המקור</span>
                        </div>`;
                }

                const signCD = sig.cohensD >= 0 ? '+' : '';
                sigCards.push(`
                    <div class="ov2-echo-ew-signal${strong ? ' ov2-strong' : ''}">
                        <div class="ov2-echo-ew-signal-head">${sig.label}</div>
                        <div class="ov2-echo-ew-signal-rule">${rule}</div>
                        ${liveBlock}
                        <div class="ov2-echo-ew-signal-stats">
                            חיוביים (n=${sig.bullN}): ${sig.bullMean >= 0 ? '+' : ''}${sig.bullMean.toFixed(2)}% ·
                            אחרים (n=${sig.bearN}): ${sig.bearMean >= 0 ? '+' : ''}${sig.bearMean.toFixed(2)}% ·
                            Cohen d: ${signCD}${sig.cohensD.toFixed(2)} ${strong ? '— מובהקת' : '— בינונית'}
                        </div>
                    </div>`);
            }

            const cardVerdict = cardVotes === 0
                ? ''
                : cardBull === cardVotes
                    ? `<span class="ov2-ft-snap-verdict ov2-pos">${cardBull}/${cardVotes} חיובי</span>`
                    : cardBear === cardVotes
                        ? `<span class="ov2-ft-snap-verdict ov2-neg">${cardBear}/${cardVotes} אזהרה</span>`
                        : `<span class="ov2-ft-snap-verdict">${cardBull} חיובי · ${cardBear} אזהרה</span>`;

            // Build wrapper for this snapshot
            const wrap = document.createElement('div');
            wrap.className = 'ov2-ft-snapshot';
            wrap.innerHTML = `
                <div class="ov2-ft-snap-head">
                    <span class="ov2-ft-snap-anchor">מקור ${formatDate(snap.anchorDate)}</span>
                    <span class="ov2-ft-snap-day ov2-ft-day-${Math.min(obs.dayIndex, EARLY_DAYS)}">${dayLabel}</span>
                    ${cardVerdict}
                </div>
                <div class="ov2-ft-snap-cards">
                    ${sigCards.join('')}
                </div>
            `;
            if (signalsEl) signalsEl.appendChild(wrap);
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
