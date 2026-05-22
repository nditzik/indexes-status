/* ═══════════════════════════════════════════════════════════════════════
   REGIME CLASSIFIER + CHIP RULES
   Pure deterministic logic · no DOM, no fetches
   Exposed as window.Regime
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ─── Phase Taxonomy ───────────────────────────────────────────────────

const PHASES = {
    confirmed_uptrend: {
        id: 'confirmed_uptrend',
        glyph: '❶',
        labelEn: 'CONFIRMED UPTREND',
        labelHe: 'מגמה חיובית מאושרת',
        color: '#10b981',
        bg: 'rgba(16, 185, 129, 0.10)',
        bias: 'לתמוך בחזקות, להוסיף חשיפה בהדרגה',
        risk: 'נמוך',
        priority: 1
    },
    uptrend_pressure: {
        id: 'uptrend_pressure',
        glyph: '❷',
        labelEn: 'UPTREND UNDER PRESSURE',
        labelHe: 'מגמה תחת לחץ',
        color: '#f59e0b',
        bg: 'rgba(245, 158, 11, 0.10)',
        bias: 'להתמקד בחזקות, לא לקנות הכל',
        risk: 'בינוני',
        priority: 2
    },
    distribution: {
        id: 'distribution',
        glyph: '❸',
        labelEn: 'DISTRIBUTION ACTIVE',
        labelHe: 'distribution פעיל',
        color: '#ea580c',
        bg: 'rgba(234, 88, 12, 0.10)',
        bias: 'להגן ולקצץ חשיפה',
        risk: 'גבוה',
        priority: 3
    },
    correction: {
        id: 'correction',
        glyph: '❹',
        labelEn: 'CORRECTION',
        labelHe: 'תיקון רחב',
        color: '#ef4444',
        bg: 'rgba(239, 68, 68, 0.10)',
        bias: 'להקטין סיכון, לא להוסיף פוזיציות',
        risk: 'גבוה',
        priority: 4
    },
    capitulation: {
        id: 'capitulation',
        glyph: '❺',
        labelEn: 'CAPITULATION',
        labelHe: 'שיא הפחד',
        color: '#991b1b',
        bg: 'rgba(153, 27, 27, 0.10)',
        bias: 'לחפש סימני היפוך, להמתין לאישור',
        risk: 'גבוה מאוד',
        priority: 5
    },
    base_building: {
        id: 'base_building',
        glyph: '❻',
        labelEn: 'BASE BUILDING',
        labelHe: 'בניית בסיס',
        color: '#64748b',
        bg: 'rgba(100, 116, 139, 0.10)',
        bias: 'לעקוב אחרי leaders חדשים מתעוררים',
        risk: 'בינוני',
        priority: 6
    },
    thrust: {
        id: 'thrust',
        glyph: '❼',
        labelEn: 'THRUST · FOLLOW-THROUGH',
        labelHe: 'פריצה ראשונית',
        color: '#06b6d4',
        bg: 'rgba(6, 182, 212, 0.10)',
        bias: 'לחפש כניסות בחזקות עם נפח',
        risk: 'בינוני-נמוך',
        priority: 7
    }
};

// ─── Phase Classifier ─────────────────────────────────────────────────
//
// Cascade order: most specific → most general.
// Each branch returns the phase + confidence (0-100) + the conditions
// that matched. Confidence is "how decisively this phase fits" — based
// on distance from thresholds.
//
// Inputs (metrics object):
//   combined         number 0-100   (weighted Tech + Flow + Breadth)
//   breadth5dDelta   number         (today's pctMa200 minus 5d ago)
//   vix              number
//   vix5dDelta       number
//   distributionDays number         (count in last 25 sessions)
//   nhMinusNl        number         (today's NH count − NL count)
//   rsiThrust        number         (stocks newly crossing RSI 30 or 50 up)
//   pctMa200         number 0-100
//   previousPhase    string         (id of phase yesterday, optional)

function classifyPhase(m) {
    const reasons = [];
    const checks = {};

    // Helper: how decisively a number passes a threshold (0..1)
    const strength = (val, threshold, range) => {
        const dist = Math.abs(val - threshold);
        return Math.min(1, dist / range);
    };

    // ❼ Thrust (requires recent dark phase + breadth thrust signal)
    if (m.rsiThrust >= 30 &&
        ['correction', 'capitulation', 'base_building'].includes(m.previousPhase)) {
        const conf = 75 + Math.min(20, (m.rsiThrust - 30) * 0.8);
        return {
            phase: PHASES.thrust,
            confidence: Math.round(conf),
            reasons: [
                `${m.rsiThrust} stocks crossing RSI thresholds (≥30 required)`,
                `Previous phase was ${m.previousPhase}`
            ]
        };
    }

    // ❺ Capitulation
    if (m.combined < 30 && m.vix > 30 && m.nhMinusNl < -50) {
        const conf = 80 + strength(m.vix, 30, 10) * 15;
        return {
            phase: PHASES.capitulation,
            confidence: Math.round(conf),
            reasons: [
                `Combined score ${m.combined} (< 30 threshold)`,
                `VIX ${m.vix.toFixed(1)} (> 30 crisis level)`,
                `Net NH-NL ${m.nhMinusNl} (< -50 — broad weakness)`
            ]
        };
    }

    // ❹ Correction
    if (m.combined < 40 && m.vix > 22) {
        const conf = 70 + strength(m.combined, 40, 15) * 20;
        return {
            phase: PHASES.correction,
            confidence: Math.round(conf),
            reasons: [
                `Combined score ${m.combined} (< 40 — weak)`,
                `VIX ${m.vix.toFixed(1)} (> 22 — elevated)`
            ]
        };
    }

    // ❸ Distribution
    if (m.combined < 55 && m.distributionDays >= 4 && m.breadth5dDelta < -2) {
        const conf = 65 + (m.distributionDays - 4) * 5;
        return {
            phase: PHASES.distribution,
            confidence: Math.min(90, Math.round(conf)),
            reasons: [
                `${m.distributionDays}/25 distribution days (≥ 4 threshold)`,
                `Breadth deteriorating ${m.breadth5dDelta.toFixed(1)}pp / 5d`,
                `Combined score ${m.combined} (below uptrend zone)`
            ]
        };
    }

    // ❻ Base Building (low score recovering)
    if (m.combined >= 30 && m.combined <= 50 && m.breadth5dDelta >= 2) {
        const conf = 60 + strength(m.breadth5dDelta, 2, 8) * 25;
        return {
            phase: PHASES.base_building,
            confidence: Math.round(conf),
            reasons: [
                `Combined score ${m.combined} (in 30-50 recovery band)`,
                `Breadth improving +${m.breadth5dDelta.toFixed(1)}pp / 5d`
            ]
        };
    }

    // ❶ Confirmed Uptrend
    if (m.combined >= 70 && m.distributionDays <= 2 && m.vix < 20) {
        const conf = 75 + strength(m.combined, 70, 25) * 20;
        return {
            phase: PHASES.confirmed_uptrend,
            confidence: Math.min(95, Math.round(conf)),
            reasons: [
                `Combined score ${m.combined} (≥ 70 strong)`,
                `Only ${m.distributionDays}/25 distribution days (≤ 2)`,
                `VIX ${m.vix.toFixed(1)} (< 20 — calm)`,
                m.breadth5dDelta >= 0
                    ? `Breadth stable / improving (+${m.breadth5dDelta.toFixed(1)}pp)`
                    : `Breadth holding`
            ]
        };
    }

    // ❷ Uptrend Under Pressure (default for moderate scores)
    if (m.combined >= 50) {
        const conf = 55 + strength(m.combined, 50, 20) * 25;
        const why = [
            `Combined score ${m.combined} (50-70 cautious band)`
        ];
        if (m.vix >= 18) why.push(`VIX ${m.vix.toFixed(1)} (rising — risk gauge active)`);
        if (m.distributionDays >= 3) why.push(`${m.distributionDays}/25 distribution days (watch)`);
        if (m.breadth5dDelta < 1) why.push(`Breadth not accelerating (${m.breadth5dDelta.toFixed(1)}pp/5d)`);
        return {
            phase: PHASES.uptrend_pressure,
            confidence: Math.round(conf),
            reasons: why
        };
    }

    // Fallback: low score, no other phase fits — treat as pressure
    return {
        phase: PHASES.uptrend_pressure,
        confidence: 45,
        reasons: ['Default classification — no phase fits decisively']
    };
}


// ─── Chip Rules ───────────────────────────────────────────────────────
//
// Each chip:
//   id        unique slug
//   type      'state' | 'transition' | 'warning' | 'confirmation'
//   category  'breadth' | 'momentum' | 'risk' | 'flow' | 'sector' | 'macro'
//   trigger   (m) => bool
//   text      static fallback OR formatText(m) → string
//   priority  0-100 (higher = shown first when capped)

const CHIP_RULES = [

    // ── STATE chips ──
    {
        id: 'risk-on', type: 'state', category: 'flow', priority: 60,
        trigger: m => m.cyclicalLeadership >= 0.67,
        text: m => `RISK-ON`
    },
    {
        id: 'risk-off', type: 'state', category: 'flow', priority: 75,
        trigger: m => m.defensiveLeadership >= 0.67,
        text: m => `RISK-OFF`
    },
    {
        id: 'mixed-rotation', type: 'state', category: 'flow', priority: 40,
        trigger: m => m.cyclicalLeadership < 0.67 && m.defensiveLeadership < 0.67,
        text: m => `MIXED ROTATION`
    },
    {
        id: 'broad-leadership', type: 'state', category: 'breadth', priority: 65,
        trigger: m => m.pctMa200 >= 65,
        text: m => `BROAD LEADERSHIP · ${Math.round(m.pctMa200)}%`
    },
    {
        id: 'narrow-leadership', type: 'state', category: 'breadth', priority: 70,
        trigger: m => m.pctMa200 <= 40 && m.pctMa200 > 0,
        text: m => `NARROW LEADERSHIP · ${Math.round(m.pctMa200)}%`
    },
    {
        id: 'low-vol', type: 'state', category: 'risk', priority: 35,
        trigger: m => m.vix > 0 && m.vix < 15,
        text: m => `LOW VOL · VIX ${m.vix.toFixed(1)}`
    },
    {
        id: 'elevated-vol', type: 'state', category: 'risk', priority: 72,
        trigger: m => m.vix >= 20 && m.vix < 30,
        text: m => `ELEVATED VOL · VIX ${m.vix.toFixed(1)}`
    },
    {
        id: 'crisis-vol', type: 'state', category: 'risk', priority: 95,
        trigger: m => m.vix >= 30,
        text: m => `CRISIS VOL · VIX ${m.vix.toFixed(1)}`
    },

    // ── TRANSITION chips ──
    {
        id: 'breadth-widening', type: 'transition', category: 'breadth', priority: 68,
        trigger: m => m.breadth5dDelta >= 5,
        text: m => `↗ BREADTH WIDENING · ${m.breadth5dDelta.toFixed(0)}pp/5d`
    },
    {
        id: 'breadth-narrowing', type: 'transition', category: 'breadth', priority: 80,
        trigger: m => m.breadth5dDelta <= -5,
        text: m => `↘ BREADTH NARROWING · ${Math.abs(m.breadth5dDelta).toFixed(0)}pp/5d`
    },
    {
        id: 'vix-compressing', type: 'transition', category: 'risk', priority: 45,
        trigger: m => m.vix5dDelta <= -2 && m.vix > 0,
        text: m => `↘ VIX COMPRESSING · ${m.vix5dDelta.toFixed(1)}`
    },
    {
        id: 'vix-expanding', type: 'transition', category: 'risk', priority: 78,
        trigger: m => m.vix5dDelta >= 2 && m.vix > 0,
        text: m => `↗ VIX EXPANDING · +${m.vix5dDelta.toFixed(1)}`
    },

    // ── WARNING chips ──
    {
        id: 'tech-flow-divergent', type: 'warning', category: 'flow', priority: 82,
        trigger: m => m.techScore !== null && m.flowScore !== null
                  && Math.abs(m.techScore - m.flowScore) >= 14,
        text: m => `⚠ TECH↔FLOW DIVERGENT · ${Math.abs(m.techScore - m.flowScore)}pt`
    },
    {
        id: 'price-breadth-divergent', type: 'warning', category: 'breadth', priority: 78,
        trigger: m => m.techScore !== null
                  && m.techScore >= 65 && m.breadthScore !== null && m.breadthScore <= 45,
        text: m => `⚠ PRICE↔BREADTH DIVERGENT`
    },
    {
        // RECALIBRATED 2026-05-22 after data audit:
        // Old threshold pcPremium > 1.15 NEVER fired on real SPX flow data
        // (real range 0.13-0.81, median 0.30 — SPX flow is structurally call-heavy).
        // New trigger: today's pc_premium > 1.5σ above rolling 22d baseline.
        // Hysteresis: enter z>1.5, exit z<0.7.
        id: 'hedges-elevated', type: 'warning', category: 'flow', priority: 76,
        trigger: m => m.flow && m.flow.z && m.flow.z.pc_premium != null
                  && m.flow.z.pc_premium > 1.5,
        text: m => `⚠ HEDGES ELEVATED · P/C ${m.flow.raw.pc_premium.toFixed(2)} · z=+${m.flow.z.pc_premium.toFixed(1)}σ`
    },
    {
        id: 'distribution-day', type: 'warning', category: 'momentum', priority: 85,
        trigger: m => m.distributionDays >= 3,
        text: m => `⚠ DISTRIBUTION DAYS · ${m.distributionDays}/25`
    },
    {
        id: 'new-lows-rising', type: 'warning', category: 'breadth', priority: 88,
        trigger: m => m.newLows >= 20,
        text: m => `⚠ NEW LOWS RISING · ${m.newLows}`
    },
    {
        id: 'overbought-concentration', type: 'warning', category: 'momentum', priority: 50,
        trigger: m => m.overboughtCount >= 40,
        text: m => `⚠ OVERBOUGHT CONCENTRATION · ${m.overboughtCount}`
    },

    // ── CONFIRMATION chips ──
    {
        id: 'thrust-confirmed', type: 'confirmation', category: 'momentum', priority: 92,
        trigger: m => m.rsiThrust >= 30,
        text: m => `✓ THRUST CONFIRMED · ${m.rsiThrust} stocks`
    },
    {
        id: 'golden-widespread', type: 'confirmation', category: 'breadth', priority: 62,
        trigger: m => m.pctGolden >= 60,
        text: m => `✓ GOLDEN CROSS WIDESPREAD · ${Math.round(m.pctGolden)}%`
    },
    {
        id: 'no-new-lows', type: 'confirmation', category: 'breadth', priority: 58,
        trigger: m => m.newLows === 0 && m.daysSinceNewLow >= 5,
        text: m => `✓ NO NEW LOWS · ${m.daysSinceNewLow}d`
    },
    {
        id: 'broad-participation', type: 'confirmation', category: 'breadth', priority: 55,
        trigger: m => m.pctMa50 >= 70,
        text: m => `✓ BROAD PARTICIPATION · ${Math.round(m.pctMa50)}% > MA50`
    },
    {
        id: 'flow-aligned', type: 'confirmation', category: 'flow', priority: 72,
        trigger: m => m.techScore !== null && m.flowScore !== null
                  && m.techScore >= 60 && m.flowScore >= 60
                  && Math.abs(m.techScore - m.flowScore) <= 8,
        text: m => `✓ FLOW + PRICE ALIGNED`
    }
];


// ─── Chip generator ───────────────────────────────────────────────────

function generateChips(metrics, maxChips) {
    const cap = maxChips == null ? 5 : maxChips;
    const triggered = [];
    for (const rule of CHIP_RULES) {
        let active;
        try { active = !!rule.trigger(metrics); } catch (_) { active = false; }
        if (active) {
            let text;
            try { text = rule.text(metrics); } catch (_) { text = rule.id.toUpperCase(); }
            triggered.push({
                id:       rule.id,
                type:     rule.type,
                category: rule.category,
                priority: rule.priority,
                text:     text
            });
        }
    }
    triggered.sort((a, b) => b.priority - a.priority);
    return triggered.slice(0, cap);
}


// ─── Public API ───────────────────────────────────────────────────────

window.Regime = {
    PHASES:        PHASES,
    classifyPhase: classifyPhase,
    generateChips: generateChips,
    CHIP_RULES:    CHIP_RULES,   // exposed for debugging / docs
    VERSION:       '1.0.0'
};

})();
