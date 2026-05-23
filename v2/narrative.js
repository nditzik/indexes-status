// ─── Daily Narrative — deterministic story builder ─────────────────────
//
// Receives the same `metrics`, `hist`, `phase`, and sector `codes` map
// that the rest of the dashboard consumes, and returns two strings:
//
//   { headline: { phase, keyMetric, spread, stateClass },
//     paragraph: "..." }
//
// All logic here is rule-based — no LLM, no API. The output is a
// reproducible function of the day's CSV + the previous 60-ish days of
// history. That makes the narrative debuggable (a chip-style audit log
// is attached to window.__V2.narrativeDebug after each build) and lets
// future work feed the same outputs into a pattern-matching layer for
// short-horizon market-direction inference.
//
// Hebrew is the user-facing language. English remains in comments and
// the debug log so future readers (LLMs included) can navigate the
// rule firings without translation.

(function () {
    'use strict';

    const VERSION = '1.0';

    // ─── small helpers ────────────────────────────────────────────────
    function fmtPct1(v) {
        if (v == null || !Number.isFinite(v)) return '—';
        const sign = v > 0 ? '+' : '';
        return sign + v.toFixed(1) + '%';
    }
    function fmtPctAbs1(v) {
        // Magnitude-only formatter for spread phrasing — the direction
        // is already encoded in the surrounding Hebrew sentence
        // ("המדד חזק מהרוחב ב-1.3%"), so a sign would read as a typo.
        if (v == null || !Number.isFinite(v)) return '—';
        return Math.abs(v).toFixed(1) + '%';
    }

    // ─── Verbal ranking (no percentile until ≥30 samples) ─────────────
    //
    // The user explicitly asked for a verbal gradation while history is
    // still thin (~66 days so far). This returns phrases like
    // "הנמוך ביותר ב-12 ימים" / "הגבוה זה 8 ימים" / "ללא סטייה משמעותית"
    // so the narrative reads naturally regardless of sample size.
    //
    // `series` is oldest→newest including TODAY as the last element.
    function verbalRank(series, opts) {
        opts = opts || {};
        // `direction` lets the caller flip the semantics: for VIX or
        // distribution-days, "מתח" lives at the HIGH end, not the low.
        // 'higher_is_extreme' (default): high = noteworthy
        // 'lower_is_extreme': low = noteworthy
        const direction = opts.direction || 'higher_is_extreme';
        const nullPhrase = opts.nullPhrase || 'ללא נתוני השוואה';

        if (!Array.isArray(series) || series.length < 3) return nullPhrase;
        const clean = series.filter(v => v != null && Number.isFinite(v));
        if (clean.length < 3) return nullPhrase;
        const today = clean[clean.length - 1];

        // How many days back did we last see a more-extreme value?
        let daysSinceMoreExtreme = 0;
        for (let i = clean.length - 2; i >= 0; i--) {
            const prior = clean[i];
            const moreExtreme = direction === 'higher_is_extreme'
                ? prior >= today
                : prior <= today;
            if (moreExtreme) break;
            daysSinceMoreExtreme++;
        }

        // Sort to find rank
        const sorted = [...clean].sort((a, b) => a - b);
        const idx = sorted.indexOf(today);
        const pct = idx / (sorted.length - 1);   // 0..1

        const sample = clean.length;
        // Phrases are gender-neutral so the same template works for
        // any subject ("הבריאות בשפל של 11 ימים", "ה-VIX בשיא של 6 ימים").
        // The Hebrew adjectives "הגבוה/הנמוך" inflect; "בשיא/בשפל" don't.
        const extremePhrase = direction === 'higher_is_extreme' ? 'בשיא' : 'בשפל';
        const oppositePhrase = direction === 'higher_is_extreme' ? 'בשפל' : 'בשיא';
        const extremeNoun = direction === 'higher_is_extreme' ? 'מהגבוהים' : 'מהנמוכים';
        const oppositeNoun = direction === 'higher_is_extreme' ? 'מהנמוכים' : 'מהגבוהים';

        // "Most extreme in N days" — most useful phrasing when true
        if (daysSinceMoreExtreme >= 5) {
            return `${extremePhrase} של ${daysSinceMoreExtreme} ימים`;
        }

        // Top / bottom of the WHOLE sample (less common, more dramatic)
        if (pct >= 0.95) return `${extremePhrase} של ${sample} ימי המסחר`;
        if (pct <= 0.05) return `${oppositePhrase} של ${sample} ימי המסחר`;

        // Quintile labels — soft hedges, used when nothing dramatic
        if (pct >= 0.80) return `${extremeNoun} בתקופה`;
        if (pct <= 0.20) return `${oppositeNoun} בתקופה`;
        return 'באמצע הטווח של התקופה';
    }

    // ─── Cumulative equal-vs-cap spread ───────────────────────────────
    //
    // Equal-weighted = mean of the 500 stocks' daily %Change (already
    // exposed as `metrics.avgChange` for today; we recompute per-day
    // from `hist[i].m.avgChange`).
    // Cap-weighted = SPX's own daily %Change.
    // The spread is the sum over the window. A positive cumulative
    // spread means equal-weight outperformed (broad strength); negative
    // means the index outperformed (narrow strength — mega-caps doing
    // the lifting).
    function cumulativeSpread(hist, days) {
        if (!Array.isArray(hist) || hist.length === 0) return null;
        const window = hist.slice(-days);
        let total = 0, counted = 0;
        for (const h of window) {
            const eq  = h.m && h.m.avgChange != null ? h.m.avgChange : null;
            const cap = h.m && h.m.macro && h.m.macro.spx && h.m.macro.spx.chgPct != null
                        ? h.m.macro.spx.chgPct : null;
            if (eq == null || cap == null) continue;
            total += (eq - cap);
            counted++;
        }
        if (counted === 0) return null;
        return total;
    }

    // ─── Build the headline ───────────────────────────────────────────
    //
    // Three slots, each picked by a small ladder of rules:
    //   1. phaseLabel        — straight from regime classification
    //   2. keyMetric         — the single most-interesting breadth number
    //   3. spread            — "המדד חזק מהרוחב ב-X%" / opposite / neutral
    function buildHeadline(metrics, hist, phase) {
        const phaseLabel = phase && phase.phase ? phase.phase.labelHe : '—';
        const stateClass = phase && phase.phase ? phase.phase.stateClass : 'muted';

        // ── slot 2: key metric ──
        // Ladder ordered by "would a trader stop reading and stare at this".
        // First match wins; the trailing default keeps the headline complete
        // on calm days when nothing crosses a threshold.
        let keyMetric = '';
        const p50  = metrics.pctMa50;
        const p200 = metrics.pctMa200;
        const nhnl = metrics.nhMinusNl;
        const dist = metrics.distributionDays;

        if (p50 != null && p50 < 45) {
            keyMetric = `רק ${Math.round(p50)}% מהמניות מעל MA50`;
        } else if (p200 != null && p200 < 40) {
            keyMetric = `רק ${Math.round(p200)}% מעל MA200`;
        } else if (nhnl != null && nhnl <= -25) {
            keyMetric = `${nhnl} שיאים-שפלים נטו`;
        } else if (nhnl != null && nhnl >= 40) {
            keyMetric = `+${nhnl} שיאים-שפלים נטו`;
        } else if (dist != null && dist >= 5) {
            keyMetric = `${dist} ימי הפצה ב-25 ימים`;
        } else if (p200 != null && p200 >= 65) {
            keyMetric = `${Math.round(p200)}% מהמניות מעל MA200`;
        } else if (p50 != null) {
            keyMetric = `${Math.round(p50)}% מעל MA50`;
        } else {
            keyMetric = 'נתוני רוחב חלקיים';
        }

        // ── slot 3: equal-vs-cap spread (5-day cumulative) ──
        // 5d is the sweet spot — long enough that one quiet session
        // doesn't dominate, short enough to react to current rotation.
        // The phrasing is intentionally directional ("המדד חזק מהרוחב")
        // rather than signed because Hebrew handles direction better
        // in words than with +/-.
        const spread5d = cumulativeSpread(hist, 5);
        let spread = 'אין מספיק היסטוריה לפער';
        if (spread5d != null) {
            const mag = fmtPctAbs1(spread5d);
            if (spread5d > 1.0) {
                spread = `הרוחב חזק מהמדד ב-${mag} בשבוע`;
            } else if (spread5d < -1.0) {
                spread = `המדד חזק מהרוחב ב-${mag} בשבוע`;
            } else {
                spread = 'המדד והרוחב בקצב דומה השבוע';
            }
        }

        return { phaseLabel, keyMetric, spread, stateClass };
    }

    // ─── Options sentiment (general direction + intensity) ────────────
    //
    // We only need one rough label for the narrative: bullish / bearish
    // / neutral, with weak / medium / strong as an intensity tag. The
    // raw input is the P/C-premium z-score the flow analytics already
    // computes — POSITIVE z means more put premium than usual (hedging
    // demand / bearish), NEGATIVE z means more call premium (bullish).
    function optionsSentiment(metrics) {
        if (!metrics.flow || !metrics.flow.z || metrics.flow.z.pc_premium == null) {
            return null;
        }
        const z = metrics.flow.z.pc_premium;
        const az = Math.abs(z);
        const intensityWord = az >= 1.5 ? 'חזק' : az >= 0.7 ? 'בינוני' : 'חלש';
        if (z >= 0.5) {
            return { tone: 'bearish', text: `שוק האופציות נוטה להגנה (${intensityWord})` };
        }
        if (z <= -0.5) {
            return { tone: 'bullish', text: `שוק האופציות נוטה לאופטימיות (${intensityWord})` };
        }
        return { tone: 'neutral', text: 'שוק האופציות בקצב רגיל' };
    }

    // ─── Sector rotation phrasing ────────────────────────────────────
    //
    // Both `cyclicalLeadership` and `defensiveLeadership` are already
    // computed upstream as ratios in [0, 1] over the top-3 sectors.
    // Strong cyclical leadership = risk-on / aggressive; strong
    // defensive leadership = risk-off / cautious; mix = no clear tilt.
    function sectorTilt(metrics) {
        const cyc = metrics.cyclicalLeadership;
        const def = metrics.defensiveLeadership;
        if (cyc == null && def == null) return null;
        if (cyc >= 0.67 && def === 0) {
            return 'הסקטורים המחזוריים מובילים את הטופ-3 — תמהיל אגרסיבי';
        }
        if (def >= 0.67 && cyc === 0) {
            return 'הסקטורים ההגנתיים מובילים את הטופ-3 — תמהיל זהיר';
        }
        if (cyc > def) {
            return 'תמהיל הסקטורים נוטה למחזוריים, בלי הובלה ברורה';
        }
        if (def > cyc) {
            return 'תמהיל הסקטורים נוטה להגנתיים, בלי הובלה ברורה';
        }
        return 'תמהיל הסקטורים מאוזן בין מחזוריים להגנתיים';
    }

    // ─── Build the paragraph (2-3 sentences) ─────────────────────────
    function buildParagraph(metrics, hist, phase, phaseDuration) {
        const parts = [];

        // ── Sentence 1: equal-vs-cap, with weekly context ──
        const todayEq  = metrics.avgChange;
        const todayCap = metrics.spx ? metrics.spx.chgPct : null;
        const spread5d = cumulativeSpread(hist, 5);
        if (todayEq != null && todayCap != null) {
            const eqVerb  = todayEq  >= 0 ? 'עלתה'  : 'ירדה';
            const capVerb = todayCap >= 0 ? 'עולה' : 'יורד';
            let context = '';
            if (spread5d != null) {
                if (spread5d < -1.0) {
                    context = ' — דפוס של ראלי צר, מובל על-ידי מעטות';
                } else if (spread5d > 1.0) {
                    context = ' — דפוס של ראלי רחב, רבות משתתפות';
                }
            }
            parts.push(
                `המניה הממוצעת ${eqVerb} היום ${fmtPctAbs1(todayEq)} בעוד המדד ${capVerb} ${fmtPctAbs1(todayCap)}${context}.`
            );
        }

        // ── Sentence 2: sector rotation + phase duration if notable ──
        const sectorBit = sectorTilt(metrics);
        let phaseDurationBit = '';
        if (phaseDuration && phaseDuration.days != null) {
            if (phaseDuration.days >= 10) {
                phaseDurationBit = ` הפאזה הנוכחית נמשכת ${phaseDuration.days} ימים — ממושכת ביחס לתבנית הרגילה.`;
            } else if (phaseDuration.days <= 1) {
                phaseDurationBit = ' זהו יום ראשון בפאזה חדשה — שינוי טרי.';
            }
        }
        if (sectorBit) parts.push(sectorBit + '.' + phaseDurationBit);
        else if (phaseDurationBit) parts.push(phaseDurationBit.trim());

        // ── Sentence 3: options + historical anchor on health ──
        const opt = optionsSentiment(metrics);
        const healthSeries = hist.map(h => h.m && h.m.healthScore != null
                                           ? h.m.healthScore : null);
        const healthRank = verbalRank(healthSeries, {
            direction: 'higher_is_extreme',
            nullPhrase: 'בלי השוואה היסטורית עדיין',
        });
        const healthBit = `הבריאות הכוללת ${healthRank}`;
        if (opt) {
            parts.push(`${opt.text}, ו${healthBit}.`);
        } else {
            parts.push(`${healthBit}.`);
        }

        return parts.join(' ');
    }

    // ─── Public API ──────────────────────────────────────────────────
    window.Narrative = {
        VERSION,
        build(metrics, hist, phase, phaseDuration) {
            const headline = buildHeadline(metrics, hist, phase);
            const paragraph = buildParagraph(metrics, hist, phase, phaseDuration);
            const debug = {
                inputs: {
                    pctMa50: metrics.pctMa50,
                    pctMa200: metrics.pctMa200,
                    nhMinusNl: metrics.nhMinusNl,
                    distributionDays: metrics.distributionDays,
                    avgChange: metrics.avgChange,
                    spxChgPct: metrics.spx ? metrics.spx.chgPct : null,
                    spread5d: cumulativeSpread(hist, 5),
                    spread20d: cumulativeSpread(hist, 20),
                    cyclicalLeadership: metrics.cyclicalLeadership,
                    defensiveLeadership: metrics.defensiveLeadership,
                    optionsZ: metrics.flow && metrics.flow.z
                              ? metrics.flow.z.pc_premium : null,
                    phaseId: phase && phase.phase ? phase.phase.id : null,
                    phaseDurationDays: phaseDuration ? phaseDuration.days : null,
                    histSamples: hist ? hist.length : 0,
                },
            };
            return { headline, paragraph, debug };
        },
    };
})();
