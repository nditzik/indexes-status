// v2/verdict.js — the single "verdict" pipeline for the v3 main screen.
//
// Before this module, ~9 engines wrote a competing "bottom line" onto the
// main tab (status headline, MCC conclusion, score interpretation,
// synergy, recommendations, phase bias, chips, daily summary, …).
// buildVerdict() consolidates that into ONE output object; Verdict.render()
// paints it. The logic here is RECYCLED, not invented:
//   • headline / subline / tone — the renderV3Status score-band branching
//   • actions — computeRecommendations() (overview-prod.js)
//   • lights — the live Tech / Breadth / VIX scores
// Every other engine keeps running untouched inside the drill-down tabs.
//
// Loaded AFTER overview-prod.js, so the globals it references
// (computeRecommendations, fmtDate) exist by the time render() runs.
(function () {
    'use strict';

    // Score → light. Same bands the quick-strip already uses.
    function scoreLight(s) {
        if (s == null || !Number.isFinite(s)) return 'na';
        return s >= 60 ? 'pos' : s >= 40 ? 'warn' : 'neg';
    }
    // Volatility light from VIX level + 1-day move. Rotation stays 'na'
    // until phase 3 wires in RSP / VIX term-structure.
    function volLight(metrics) {
        const vix = metrics.vix, chg = metrics.vix1dPct;
        if (vix == null || vix === 0) return 'na';
        if (vix >= 25 || (chg != null && chg >= 25)) return 'neg';
        if (vix >= 20 || (chg != null && chg >= 10)) return 'warn';
        return 'pos';
    }

    function buildVerdict(metrics, phaseResult) {
        const c = metrics.combined;
        const ro = metrics.riskOff;
        const acute = ro && ro.active && ro.acute;
        const background = ro && ro.active && !ro.acute;

        let tone = 'warn', emoji = '🟡', headline = '—', subline = '';
        if (acute) {
            // Same-day risk event — full red alarm.
            tone = 'neg'; emoji = '🔴';
            headline = 'יום סיכון — לא להוסיף חשיפה';
            subline = ro.reasons.map(r => r.text).join(' · ');
        } else if (background) {
            // Accumulation only (no same-day event) — a standing caution,
            // never "יום סיכון" on a green day. Severity by the score.
            if (c != null && c >= 55) {
                tone = 'warn'; emoji = '🟡';
                headline = 'השוק יציב — אך עם לחץ מכירות מצטבר, בזהירות';
            } else {
                tone = 'neg'; emoji = '🔴';
                headline = 'חולשה מצטברת — להישאר בהגנה';
            }
            subline = ro.reasons.map(r => r.text).join(' · ');
        } else if (c == null) {
            headline = 'אין מספיק נתונים';
        } else if (c >= 70) {
            tone = 'pos'; emoji = '🟢';
            headline = 'השוק בריא — אפשר להמשיך בגישת long';
            subline = `ציון משולב ${c}/100 · לעקוב אחרי VIX ורוחב`;
        } else if (c >= 55) {
            tone = 'warn'; emoji = '🟡';
            headline = 'השוק יציב — להמשיך בזהירות';
            subline = `ציון משולב ${c}/100 · מצב מבני סביר, לא בוטח בעלייה רחבה`;
        } else if (c >= 40) {
            tone = 'warn'; emoji = '🟡';
            headline = 'מצב מעורב — להמתין לסיגנל ברור';
            subline = `ציון משולב ${c}/100 · ללא הכרעה בכיוון`;
        } else {
            tone = 'neg'; emoji = '🔴';
            headline = 'מצב חלש — להישאר בהגנה';
            subline = `ציון משולב ${c}/100 · אינדיקטורים מבניים מצטברים שליליים`;
        }

        // One "score + phase" context line — append the regime label.
        const phaseLabel = phaseResult && phaseResult.phase &&
            (phaseResult.phase.labelHe || phaseResult.phase.labelEn);
        if (phaseLabel && subline.indexOf(phaseLabel) === -1) {
            subline += `${subline ? ' · ' : ''}${phaseLabel}`;
        }

        const actions = (typeof computeRecommendations === 'function')
            ? computeRecommendations(metrics, phaseResult).slice(0, 4)
            : [];

        return {
            headline, subline, tone, emoji, actions,
            lights: {
                trend:      scoreLight(metrics.techScore),
                breadth:    scoreLight(metrics.breadthScore),
                volatility: volLight(metrics),
                rotation:   'na',
            },
        };
    }

    // Fixed order so the row reads the same every day.
    const LIGHT_ORDER = ['trend', 'breadth', 'volatility', 'rotation'];
    const LIGHT_LABEL = {
        trend: 'מגמה', breadth: 'רוחב', volatility: 'תנודתיות', rotation: 'רוטציה',
    };
    const LIGHT_TIP = {
        trend: 'כיוון המדד מול הממוצעים הנעים (ציון טכני)',
        breadth: 'כמה מניות משתתפות במהלך (ציון רוחב)',
        volatility: 'רמת הפחד — VIX ושינוי יומי',
        rotation: 'רוחב ההובלה — משקל-שווה מול המדד ל-20 ימים (עלייה צרה מול רחבה)',
    };

    function renderVerdict(v) {
        const $ = id => document.getElementById(id);
        const wrap = $('v3_status');
        if (wrap) wrap.setAttribute('data-tone', v.tone);
        if ($('v3_blIcon'))     $('v3_blIcon').textContent = v.emoji;
        if ($('v3_blHeadline')) $('v3_blHeadline').textContent = v.headline;
        if ($('v3_blSub'))      $('v3_blSub').textContent = v.subline || '—';

        const lightsEl = $('v3_lights');
        if (lightsEl) {
            lightsEl.innerHTML = LIGHT_ORDER.map(k => {
                const st = v.lights[k] || 'na';
                return `<span class="v3-light v3-light-${st}" title="${LIGHT_TIP[k]}">`
                     + `<span class="v3-light-dot"></span>${LIGHT_LABEL[k]}</span>`;
            }).join('');
        }

        const ul = $('v3_recsList');
        if (ul) {
            const acts = (v.actions && v.actions.length) ? v.actions
                : [{ text: 'אין המלצות מיוחדות — להמשיך לפי התוכנית הקיימת', tone: '' }];
            ul.innerHTML = acts.map(i =>
                `<li class="${i.tone ? 'v3-rec-' + i.tone : ''}">${i.text}</li>`).join('');
        }
    }

    window.Verdict = { build: buildVerdict, render: renderVerdict };
})();
