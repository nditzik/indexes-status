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
        // Pick the strongest positive driver and quote its actual number.
        // Generic phrases like "broad strength" without a value were the
        // main complaint about v2 of the narrative — fixed here.
        const spread5d = cumulativeSpread(hist, 5);
        const breadthDelta = metrics.breadth5dDelta;
        if (spread5d != null && spread5d > 1.5) {
            return `רוחב מתחזק חזק (+${spread5d.toFixed(1)}% השבוע)`;
        }
        if (spread5d != null && spread5d > 0.5) {
            return `רוחב משתפר (+${spread5d.toFixed(1)}% השבוע)`;
        }
        if (breadthDelta != null && breadthDelta > 5) {
            return `אחוז המניות מעל MA200 עלה ב-${breadthDelta.toFixed(1)}% בשבוע`;
        }
        return 'תנועה חיובית קצרת-טווח';
    }

    function regimeDriverPhrase(metrics) {
        // What's the most pressing regime concern? Highest-impact first.
        // Note: "selling days" replaced the misleading "distribution days"
        // phrasing — the underlying count no longer claims a volume check
        // it never actually performed.
        const dist = metrics.distributionDays;
        const distRecent = metrics.sellDaysRecent10;
        const pctMa200 = metrics.pctMa200;
        const vix = metrics.vix;
        const nhnl = metrics.nhMinusNl;

        // Thresholds calibrated to the tighter -0.5% selling-day rule:
        // with that definition, even 3 sell days in 10 sessions is
        // unusual, and 5 in 25 is the new warning threshold.
        if (distRecent != null && distRecent >= 3) {
            return `${distRecent} ימים שליליים חזקים ב-10 ימים אחרונים (אשכול טרי)`;
        }
        if (dist != null && dist >= 5) {
            return `${dist} ימים שליליים חזקים ב-25 ימים אחרונים`;
        }
        if (pctMa200 != null && pctMa200 < 30) return `רק ${Math.round(pctMa200)}% מהמניות מעל MA200`;
        if (vix != null && vix > 25) return `VIX ${vix.toFixed(1)} (מעל סף הפאניקה)`;
        if (nhnl != null && nhnl <= -50) return `${nhnl} שיאים-שפלים נטו (חריג שלילי)`;
        if (pctMa200 != null && pctMa200 < 50) return `רוחב טווח-ארוך חלש (${Math.round(pctMa200)}% מעל MA200)`;
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

        // Rationale always quotes the driving NUMBER when there is one.
        // The previous version leaned on slogans ("המגמה והרוחב יד ביד",
        // "על רקע התייצבות") that the user correctly flagged as unclear.
        // Now: every rationale either names the metric + value, or names
        // the specific weakness it can't avoid.
        if (regimeStateClass === 'pos') {
            if (recentPos) {
                metaLabel = 'ראלי חזק';
                stateClass = 'pos';
                rationale = `המגמה הטכנית חיובית והרוחב מתחזק (${recentDriverPhrase(metrics, hist)})`;
            } else if (recentNeg) {
                metaLabel = 'חולשה מתהווה';
                stateClass = 'warn';
                const spread5d = cumulativeSpread(hist, 5);
                const spreadTxt = spread5d != null
                    ? `הרוחב נחלש (${spread5d.toFixed(1)}% השבוע)`
                    : 'הרוחב נחלש';
                rationale = `המגמה הטכנית עדיין חיובית אבל ${spreadTxt}`;
            } else {
                metaLabel = 'מגמה יציבה';
                stateClass = 'pos';
                rationale = 'המגמה הטכנית חיובית, אין סטייה משמעותית השבוע';
            }
        } else if (regimeStateClass === 'neg') {
            if (recentPos) {
                metaLabel = 'מצב מעורב';
                stateClass = 'warn';
                // Connector " אבל " carries the contrast on its own — no
                // trailing "עדיין מסוכן" that wouldn't agree grammatically
                // with all the plural-subject driver phrases.
                rationale = recentDriverPhrase(metrics, hist) + ' אבל '
                          + regimeDriverPhrase(metrics);
            } else if (recentNeg) {
                metaLabel = 'אזהרה מסלימה';
                stateClass = 'neg';
                rationale = `${regimeDriverPhrase(metrics)} בנוסף לחולשה השבוע`;
            } else {
                metaLabel = 'מגמה תחת לחץ';
                stateClass = 'neg';
                rationale = `${regimeDriverPhrase(metrics)} (יציב, ללא הסלמה)`;
            }
        } else {
            // regime 'warn' or 'muted' — typically distribution/baseBuilding/etc.
            if (recentPos) {
                metaLabel = 'שיפור מתהווה';
                stateClass = 'pos';
                // Old "על רקע התייצבות" was vague — "stabilization" sounds
                // positive but the reader had no idea what it referred to.
                // Replace with an honest acknowledgement that the LONG-term
                // trend has not yet confirmed the short-term improvement.
                rationale = `${recentDriverPhrase(metrics, hist)} — המגמה הטכנית ארוכת-הטווח עדיין לא אישרה`;
            } else if (recentNeg) {
                metaLabel = 'התייצבות שברירית';
                stateClass = 'warn';
                const spread5d = cumulativeSpread(hist, 5);
                const spreadTxt = spread5d != null
                    ? `(פער 5d ${spread5d.toFixed(1)}%)`
                    : '';
                rationale = `הרוחב מתרופף השבוע ${spreadTxt} ללא תמיכה מצד המגמה הטכנית`;
            } else {
                metaLabel = 'התייצבות';
                stateClass = 'warn';
                rationale = 'אין כיוון מבוסס — לא חיובי ולא שלילי';
            }
        }

        return { metaLabel, rationale, stateClass };
    }

    // ─── 2. Today — one-day breadth + sector tilt + options pulse ────
    function buildToday(metrics) {
        const avg = metrics.avgChange;
        const spx = metrics.spx && metrics.spx.chgPct;
        if (avg == null || spx == null) return 'אין נתוני יום נוכחי.';

        // Naming convention: we call the equal-weighted view "המדד
        // השוויוני" everywhere — same label as the EQ500 ticker tile —
        // so a reader doesn't have to translate between "המניה הממוצעת"
        // (technically true but informal) and the ticker.
        const avgVerb = avg >= 0 ? 'עלה' : 'ירד';
        const spxVerb = spx >= 0 ? 'עלה' : 'ירד';

        // Sector tilt — only mention when there's a clear lead, so we
        // don't add noise on a mixed day.
        const cyc = metrics.cyclicalLeadership;
        const def = metrics.defensiveLeadership;
        let sectorTail = '';
        if (cyc != null && cyc >= 0.67) {
            sectorTail = ', סקטורים מחזוריים מובילים';
        } else if (def != null && def >= 0.67) {
            sectorTail = ', סקטורים הגנתיים מובילים';
        } else if (cyc != null && def != null) {
            if (cyc > def + 0.1) sectorTail = ', נטייה למחזוריים';
            else if (def > cyc + 0.1) sectorTail = ', נטייה להגנתיים';
        }

        // Options pulse — surface what the flow z-scores say in plain
        // Hebrew. The flow data is a 35% pillar of the combined score
        // and was completely absent from the daily narrative before.
        // Trigger thresholds picked to filter noise: |z| >= 0.7 is
        // "noteworthy", >= 1.5 is "strong".
        let optionsTail = '';
        const z = metrics.flow && metrics.flow.z ? metrics.flow.z : null;
        if (z) {
            // pc_premium: positive z = more put premium than usual (hedging)
            const pc = z.pc_premium;
            // call_premium_pct: positive z = call dominance (bullish)
            const cp = z.call_premium_pct;
            const absPc = pc != null ? Math.abs(pc) : 0;
            const absCp = cp != null ? Math.abs(cp) : 0;
            // Pick whichever signal is stronger, mention it explicitly.
            if (absPc >= 1.5 && pc > 0) {
                optionsTail = `, אופציות בגידור חזק (P/C z=+${pc.toFixed(1)})`;
            } else if (absCp >= 1.5 && cp > 0) {
                optionsTail = `, פרמיית קולים חריגה (z=+${cp.toFixed(1)} — אופטימי)`;
            } else if (absPc >= 0.7 && pc > 0) {
                optionsTail = `, אופציות נוטות להגנה (P/C z=+${pc.toFixed(1)})`;
            } else if (absCp >= 0.7 && cp > 0) {
                optionsTail = `, פרמיית קולים מוגברת (z=+${cp.toFixed(1)})`;
            } else if (absPc >= 0.7 && pc < 0) {
                optionsTail = `, אופציות מורגעות (P/C z=${pc.toFixed(1)})`;
            }
        }

        return `המדד השוויוני ${avgVerb} ${fmtAbs2(avg)}% בעוד המדד `
             + `${spxVerb} ${fmtAbs2(spx)}%${sectorTail}${optionsTail}.`;
    }

    // ─── 3. Week — 5-day equal-vs-cap spread ──────────────────────────
    function buildWeek(hist) {
        const spread5d = cumulativeSpread(hist, 5);
        if (spread5d == null) return 'אין מספיק היסטוריה לחישוב שבועי.';

        const mag = fmtAbs1(spread5d);
        if (spread5d > 1.0) {
            return `המדד השוויוני הביס את המדד הקאפ-משוקלל ב-${mag}% — מגמת השתתפות חיובית.`;
        }
        if (spread5d < -1.0) {
            return `המדד הקאפ-משוקלל הביס את המדד השוויוני ב-${mag}% — דפוס של ראלי צר, מובל ע"י מעטות.`;
        }
        return 'המדד השוויוני והמדד הקאפ-משוקלל בקצב דומה — אין נטייה ברורה.';
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

        // Selling-days context: honest about what's measured (SPX-based,
        // not volume-based) and aware of FRESHNESS — a cluster in the
        // last 10 sessions is a different story than the same count
        // spread across the full 25-day window.
        const dist = metrics.distributionDays;
        const recent10 = metrics.sellDaysRecent10;
        const pctMa200 = metrics.pctMa200;

        // Threshold logic mirrors regimeDriverPhrase — with the tighter
        // -0.5% rule, 3 fresh days or 5 in the full window is the new
        // "noteworthy" line.
        if (recent10 != null && recent10 >= 3) {
            // Fresh cluster — most worrying
            parts.push(`${recent10} ימים שליליים חזקים ב-10 הימים האחרונים — אשכול טרי, סימן אזהרה.`);
        } else if (dist != null && dist >= 5) {
            // High count but spread out
            const recentFresh = recent10 != null ? ` (מהם ${recent10} ב-10 הימים האחרונים)` : '';
            parts.push(`${dist} ימים שליליים חזקים ב-25 ימים אחרונים${recentFresh} — מעל הסף הרגיל.`);
        } else if (dist != null && dist >= 2) {
            // 2-4 days: normal-noise range
            const tail = recent10 != null && recent10 > 0
                ? ` (מהם ${recent10} ב-10 ימים אחרונים)`
                : '';
            parts.push(`${dist} ימים שליליים חזקים ב-25 ימים אחרונים${tail} — בטווח נורמלי, ללא אשכול חריג.`);
        } else if (dist != null && dist <= 1) {
            // Very quiet: worth mentioning as reassurance
            parts.push(`${dist} ימים שליליים חזקים בלבד ב-25 ימים — שוק ללא מכירות בולטות.`);
        }

        // Breadth context — separate signal, not always relevant
        if (pctMa200 != null && pctMa200 < 40) {
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
