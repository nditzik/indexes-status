// ─── Daily Narrative — strategic 4-layer story builder ────────────────
//
// v2.0 — Returns a structured object with five fields the renderer
// drops into separate DOM slots:
//
//   {
//     headline:    { metaLabel, rationale, stateClass },
//     today:       "...",
//     week:        "...",
//     background:  "...",
//     watchFor:    ["...", "..."],
//     debug:       {...}
//   }
//
// Layered design (was a single paragraph in v1):
//   1. headline    — meta-judgement combining regime + recent direction
//   2. today       — one-day breadth + sector tilt
//   3. week        — 5-day equal-vs-cap spread
//   4. background  — phase + duration + dominant regime driver (no jargon)
//   5. watchFor    — 1-2 specific levels worth monitoring next
//
// Everything is rule-based, no LLM. Plain Hebrew throughout — terms
// like "distribution days" / "P/C ratio" are translated inline
// ("ימי מכירה כבדה (ירידות בנפח גבוה)") rather than left to the user.

(function () {
    'use strict';

    const VERSION = '2.0';

    // ─── helpers ──────────────────────────────────────────────────────
    function fmtAbs1(v) {
        if (v == null || !Number.isFinite(v)) return '—';
        return Math.abs(v).toFixed(1);
    }
    function fmtAbs2(v) {
        if (v == null || !Number.isFinite(v)) return '—';
        return Math.abs(v).toFixed(2);
    }

    // 5-day cumulative equal-vs-cap spread, computed exactly the same
    // way as in v1 — sum of (eq_avg − spx_chg) over the last 5 history
    // days. Positive = breadth beat the index that week, negative =
    // index outpaced the average stock (narrow rally).
    function cumulativeSpread(hist, days) {
        if (!Array.isArray(hist) || hist.length === 0) return null;
        const window = hist.slice(-days);
        let total = 0, counted = 0;
        for (const h of window) {
            const eq  = h.m && h.m.avgChange != null ? h.m.avgChange : null;
            const cap = h.m && h.m.macro && h.m.macro.spx
                        && h.m.macro.spx.chgPct != null
                        ? h.m.macro.spx.chgPct : null;
            if (eq == null || cap == null) continue;
            total += (eq - cap);
            counted++;
        }
        return counted === 0 ? null : total;
    }

    // ─── 1. Headline — meta-judgement ─────────────────────────────────
    //
    // The headline collapses everything into one of six meta-labels
    // plus a one-phrase rationale. Mapping:
    //
    //   regime POS × recent POS  →  "ראלי חזק"          (green)
    //   regime POS × recent NEG  →  "חולשה מתהווה"      (warn)
    //   regime NEG × recent POS  →  "מצב מעורב"         (warn)
    //   regime NEG × recent NEG  →  "אזהרה מסלימה"       (red)
    //   regime MID × recent POS  →  "שיפור מתהווה"      (pos)
    //   regime MID × recent NEG  →  "התייצבות שברירית"  (warn)
    //   regime MID × recent MID  →  "התייצבות"          (warn)
    //
    // The rationale half describes WHY in two phrases joined by "אבל":
    // the positive driver + the negative driver, so the contradiction
    // (when present) is named rather than hidden.

    function recentDriverPhrase(metrics, hist) {
        // What's making the recent tape feel positive?
        const spread5d = cumulativeSpread(hist, 5);
        const breadthDelta = metrics.breadth5dDelta;
        if (spread5d != null && spread5d > 1.5) {
            return 'רוחב משתפר משמעותית';
        }
        if (spread5d != null && spread5d > 0.5) {
            return 'רוחב משתפר';
        }
        if (breadthDelta != null && breadthDelta > 5) {
            return 'יותר מניות מעל ממוצעים';
        }
        return 'תנועה חיובית קצרת-טווח';
    }

    function regimeDriverPhrase(metrics) {
        // What's the most pressing regime concern? Highest-impact first.
        const dist = metrics.distributionDays;
        const pctMa200 = metrics.pctMa200;
        const vix = metrics.vix;
        const nhnl = metrics.nhMinusNl;

        if (dist != null && dist >= 8) return 'ימי מכירה כבדה גבוהים';
        if (pctMa200 != null && pctMa200 < 30) return 'רוב המניות מתחת ל-MA200';
        if (vix != null && vix > 25) return 'VIX מעל סף הפאניקה';
        if (nhnl != null && nhnl <= -50) return 'שיאים-שפלים שליליים בכמות חריגה';
        if (dist != null && dist >= 5) return 'ימי מכירה כבדה מעל סף האזהרה';
        if (pctMa200 != null && pctMa200 < 50) return 'רוחב טווח-ארוך חלש';
        return 'הפאזה הטכנית עדיין שלילית';
    }

    function buildHeadline(metrics, hist, phase) {
        const regimeStateClass = phase && phase.phase ? phase.phase.stateClass : 'muted';

        // Recent positivity score: blend of equal-vs-cap spread (5d)
        // and the change in % of stocks above MA200 (5d). Tuned so
        // ~+0.5 to +1.5 is the "yes, recent improvement" band.
        const spread5d = cumulativeSpread(hist, 5) || 0;
        const breadthDelta = metrics.breadth5dDelta || 0;
        const recentScore = spread5d * 0.5 + breadthDelta * 0.05;
        const recentPos = recentScore > 0.5;
        const recentNeg = recentScore < -0.5;

        let metaLabel, stateClass, rationale;

        if (regimeStateClass === 'pos') {
            if (recentPos) {
                metaLabel = 'ראלי חזק';
                stateClass = 'pos';
                rationale = 'המגמה והרוחב יד ביד';
            } else if (recentNeg) {
                metaLabel = 'חולשה מתהווה';
                stateClass = 'warn';
                rationale = 'המגמה חיובית אבל הקצר-טווח נחלש';
            } else {
                metaLabel = 'מגמה יציבה';
                stateClass = 'pos';
                rationale = 'ללא סטייה משמעותית השבוע';
            }
        } else if (regimeStateClass === 'neg') {
            if (recentPos) {
                metaLabel = 'מצב מעורב';
                stateClass = 'warn';
                // Connector " אבל " carries the contrast on its own — no
                // need for a trailing "עדיין מסוכן" that wouldn't agree
                // grammatically with all driver-phrase plural subjects.
                rationale = recentDriverPhrase(metrics, hist) + ' אבל '
                          + regimeDriverPhrase(metrics);
            } else if (recentNeg) {
                metaLabel = 'אזהרה מסלימה';
                stateClass = 'neg';
                rationale = 'גם המגמה וגם השבוע מצביעים על חולשה';
            } else {
                metaLabel = 'מגמה תחת לחץ';
                stateClass = 'neg';
                rationale = 'יציב, אבל ' + regimeDriverPhrase(metrics);
            }
        } else {
            // regime 'warn' or 'muted'
            if (recentPos) {
                metaLabel = 'שיפור מתהווה';
                stateClass = 'pos';
                rationale = recentDriverPhrase(metrics, hist) + ' על רקע התייצבות';
            } else if (recentNeg) {
                metaLabel = 'התייצבות שברירית';
                stateClass = 'warn';
                rationale = 'רוחב מתרופף, אין מגמה מבוססת';
            } else {
                metaLabel = 'התייצבות';
                stateClass = 'warn';
                rationale = 'ללא כיוון מבוסס';
            }
        }

        return { metaLabel, rationale, stateClass };
    }

    // ─── 2. Today — one-day breadth + sector tilt ─────────────────────
    function buildToday(metrics) {
        const avg = metrics.avgChange;
        const spx = metrics.spx && metrics.spx.chgPct;
        if (avg == null || spx == null) return 'אין נתוני יום נוכחי.';

        // Both verbs in past tense ("המניה עלתה", "המדד עלה") so the
        // sentence reads naturally. "בעוד" works for both same-direction
        // and opposite-direction days; mixing מול+past sounded clunky.
        const avgVerb = avg >= 0 ? 'עלתה' : 'ירדה';
        const spxVerb = spx >= 0 ? 'עלה'  : 'ירד';

        // Sector tilt — only mention when there's a clear lead, so we
        // don't add noise on a mixed day.
        const cyc = metrics.cyclicalLeadership;
        const def = metrics.defensiveLeadership;
        let sectorTail = '';
        if (cyc != null && cyc >= 0.67) {
            sectorTail = ' — סקטורים מחזוריים מובילים, השתתפות רחבה';
        } else if (def != null && def >= 0.67) {
            sectorTail = ' — סקטורים הגנתיים מובילים, השוק זהיר';
        } else if (cyc != null && def != null) {
            if (cyc > def + 0.1) sectorTail = ' — נטייה למחזוריים';
            else if (def > cyc + 0.1) sectorTail = ' — נטייה להגנתיים';
        }

        return `המניה הממוצעת ${avgVerb} ${fmtAbs2(avg)}% בעוד המדד `
             + `${spxVerb} ${fmtAbs2(spx)}%${sectorTail}.`;
    }

    // ─── 3. Week — 5-day equal-vs-cap spread ──────────────────────────
    function buildWeek(hist) {
        const spread5d = cumulativeSpread(hist, 5);
        if (spread5d == null) return 'אין מספיק היסטוריה לחישוב שבועי.';

        const mag = fmtAbs1(spread5d);
        if (spread5d > 1.0) {
            return `המניה הממוצעת הביסה את המדד ב-${mag}% — מגמת השתתפות חיובית.`;
        }
        if (spread5d < -1.0) {
            return `המדד הביס את המניה הממוצעת ב-${mag}% — דפוס של ראלי צר, מובל ע"י מעטות.`;
        }
        return 'המניה הממוצעת והמדד בקצב דומה — אין נטייה ברורה.';
    }

    // ─── 4. Background — phase + duration + dominant driver ───────────
    function buildBackground(metrics, phase, phaseDuration) {
        const phaseLabel = phase && phase.phase ? phase.phase.labelHe : 'לא ידוע';
        const days = phaseDuration ? phaseDuration.days : null;
        const parts = [];

        if (days == null) {
            parts.push(`הפאזה הנוכחית: "${phaseLabel}".`);
        } else if (days >= 30) {
            parts.push(`הפאזה "${phaseLabel}" נמשכת ${days} ימים — ממושכת ביחס לתבנית הרגילה.`);
        } else if (days >= 10) {
            parts.push(`הפאזה "${phaseLabel}" נמשכת ${days} ימים.`);
        } else if (days >= 1) {
            parts.push(`הפאזה "${phaseLabel}" — שלב טרי (${days} ימים).`);
        } else {
            parts.push(`הפאזה "${phaseLabel}" — שלב חדש שהתחיל היום.`);
        }

        // Add the dominant regime fact, translated to plain Hebrew. We
        // mention at most ONE so the layer stays short.
        const dist = metrics.distributionDays;
        const pctMa200 = metrics.pctMa200;
        if (dist != null && dist >= 5) {
            parts.push(`${dist} ימי מכירה כבדה (ירידות בנפח גבוה) ב-25 ימים אחרונים, מעל סף האזהרה של 5.`);
        } else if (pctMa200 != null && pctMa200 < 40) {
            parts.push(`רק ${Math.round(pctMa200)}% מהמניות מעל ממוצע 200 — חולשה מבנית.`);
        } else if (pctMa200 != null && pctMa200 >= 70) {
            parts.push(`${Math.round(pctMa200)}% מהמניות מעל ממוצע 200 — מבנה חזק.`);
        }

        return parts.join(' ');
    }

    // ─── 5. Watch-for — 1-2 next-most-actionable triggers ─────────────
    //
    // We test each candidate trigger and assign it a priority. Picks
    // the top 2 highest-priority firing triggers (lower number = more
    // important). Designed so the layer reads as 1-2 sentences that
    // would meaningfully change the trader's read if they hit.
    function buildWatchFor(metrics) {
        const triggers = [];

        // %MA50 — a clean classical breadth threshold (50%). Picking
        // 'cross 50 up' or 'cross 50 down' based on where we are now.
        const p50 = metrics.pctMa50;
        if (p50 != null) {
            if (p50 < 50 && p50 > 25) {
                triggers.push({
                    priority: 1,
                    text: `%MA50 חוצה 50% (כעת ${Math.round(p50)}%) → הפאזה תשתפר.`,
                });
            } else if (p50 >= 50 && p50 < 75) {
                triggers.push({
                    priority: 3,
                    text: `%MA50 יורד מתחת ל-50% (כעת ${Math.round(p50)}%) → סיכון להידרדרות.`,
                });
            }
        }

        // VIX — the volatility fear gauge. 18 / 22 are the conventional
        // 'calm' / 'caution' rails.
        const vix = metrics.vix;
        if (vix != null) {
            if (vix < 18) {
                triggers.push({
                    priority: 3,
                    text: `VIX מעל 22 (כעת ${vix.toFixed(1)}) → אזהרה חדשה.`,
                });
            } else if (vix >= 18 && vix < 22) {
                triggers.push({
                    priority: 2,
                    text: `VIX מעל 22 (כעת ${vix.toFixed(1)}) → אזהרה חדשה.`,
                });
            } else if (vix >= 22) {
                triggers.push({
                    priority: 1,
                    text: `VIX יורד מתחת ל-18 (כעת ${vix.toFixed(1)}) → רגיעה ובחזרה לסיכון.`,
                });
            }
        }

        // Distribution-days unwind — only when currently elevated.
        const dist = metrics.distributionDays;
        if (dist != null && dist >= 5) {
            triggers.push({
                priority: 1,
                text: `ימי מכירה כבדה יורדים מתחת ל-5 (כעת ${dist}) → שיפור פאזה.`,
            });
        }

        // New-high / new-low rebalance, only when very lopsided.
        const nhnl = metrics.nhMinusNl;
        if (nhnl != null && nhnl <= -30) {
            triggers.push({
                priority: 2,
                text: `שיאים-שפלים מתאזנים (כעת ${nhnl}) → סוף החולשה.`,
            });
        } else if (nhnl != null && nhnl >= 50) {
            triggers.push({
                priority: 3,
                text: `שיאים-שפלים יורדים מתחת ל-20 → אובדן מומנטום.`,
            });
        }

        // Equal-vs-cap cumulative spread sign change — premium signal
        // for the broad/narrow rally narrative.
        // (We don't add this here without hist context; the rationale
        // already mentions the spread, so this would be redundant.)

        triggers.sort((a, b) => a.priority - b.priority);
        return triggers.slice(0, 2).map(t => t.text);
    }

    // ─── Public API ──────────────────────────────────────────────────
    window.Narrative = {
        VERSION,
        build(metrics, hist, phase, phaseDuration) {
            const headline = buildHeadline(metrics, hist, phase);
            const today = buildToday(metrics);
            const week = buildWeek(hist);
            const background = buildBackground(metrics, phase, phaseDuration);
            const watchFor = buildWatchFor(metrics);

            const debug = {
                version: VERSION,
                inputs: {
                    pctMa50: metrics.pctMa50,
                    pctMa200: metrics.pctMa200,
                    nhMinusNl: metrics.nhMinusNl,
                    distributionDays: metrics.distributionDays,
                    vix: metrics.vix,
                    avgChange: metrics.avgChange,
                    spxChgPct: metrics.spx ? metrics.spx.chgPct : null,
                    breadth5dDelta: metrics.breadth5dDelta,
                    spread5d: cumulativeSpread(hist, 5),
                    spread20d: cumulativeSpread(hist, 20),
                    cyclicalLeadership: metrics.cyclicalLeadership,
                    defensiveLeadership: metrics.defensiveLeadership,
                    phaseId: phase && phase.phase ? phase.phase.id : null,
                    phaseStateClass: phase && phase.phase ? phase.phase.stateClass : null,
                    phaseDurationDays: phaseDuration ? phaseDuration.days : null,
                    histSamples: hist ? hist.length : 0,
                },
            };

            return { headline, today, week, background, watchFor, debug };
        },
    };
})();
