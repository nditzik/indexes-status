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
        stateLabel: 'חיובי',
        stateClass: 'pos',
        description: 'רוב המניות במגמה עולה · VIX נמוך · בריאות שוק חזקה',
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
        stateLabel: 'זהיר',
        stateClass: 'warn',
        description: 'השוק עדיין חיובי אך חולשה מתחת לפני השטח · רוחב נעצר',
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
        labelHe: 'הפצה פעילה',
        stateLabel: 'תחת לחץ',
        stateClass: 'warn',
        description: 'מוסדיים מוכרים בשקט · ימי distribution מצטברים · רוחב מתחיל להתפורר',
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
        stateLabel: 'שלילי',
        stateClass: 'neg',
        description: 'ירידה רחבה · VIX מוגבר · רוב המניות מתחת לממוצעים',
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
        stateLabel: 'Risk-Off',
        stateClass: 'neg',
        description: 'מכירת פאניקה · VIX קיצוני · שיאי שפל חדשים נרחבים',
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
        stateLabel: 'התייצבות',
        stateClass: 'warn',
        description: 'התאוששות ראשונית · רוחב משתפר באיטיות · מובילים חדשים מתעוררים',
        color: '#64748b',
        bg: 'rgba(100, 116, 139, 0.10)',
        bias: 'לעקוב אחרי מובילים חדשים',
        risk: 'בינוני',
        priority: 6
    },
    thrust: {
        id: 'thrust',
        glyph: '❼',
        labelEn: 'THRUST · FOLLOW-THROUGH',
        labelHe: 'פריצה ראשונית',
        stateLabel: 'פריצה חיובית',
        stateClass: 'pos',
        description: 'מומנטום רחב מתפרץ · מספר רב של מניות חוצות סף · אישור בריצה',
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
                `${m.rsiThrust} מניות חוצות סף RSI כלפי מעלה (נדרש ≥30)`,
                `השלב הקודם היה ${(PHASES[m.previousPhase] || {}).labelHe || m.previousPhase}`
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
                `ציון משולב ${m.combined} (מתחת ל-30 — חולשה קיצונית)`,
                `VIX ${m.vix.toFixed(1)} (מעל 30 — רמת משבר)`,
                `שיאים פחות שפלים ${m.nhMinusNl} (מתחת ל-50- — חולשה רחבה)`
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
                `ציון משולב ${m.combined} (מתחת ל-40 — חלש)`,
                `VIX ${m.vix.toFixed(1)} (מעל 22 — מוגבר)`
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
                `${m.distributionDays}/25 ימי הפצה (סף ≥ 4)`,
                `רוחב מתדרדר ${m.breadth5dDelta.toFixed(1)} נק' ב-5 ימים`,
                `ציון משולב ${m.combined} (מתחת לזון של מגמה חיובית)`
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
                `ציון משולב ${m.combined} (בטווח 30-50 של התאוששות)`,
                `רוחב משתפר +${m.breadth5dDelta.toFixed(1)} נק' ב-5 ימים`
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
                `ציון משולב ${m.combined} (≥ 70 — חזק)`,
                `רק ${m.distributionDays}/25 ימי הפצה (סף ≤ 2)`,
                `VIX ${m.vix.toFixed(1)} (מתחת ל-20 — רגוע)`,
                m.breadth5dDelta >= 0
                    ? `רוחב יציב / משתפר (+${m.breadth5dDelta.toFixed(1)} נק')`
                    : `רוחב מחזיק`
            ]
        };
    }

    // ❷ Uptrend Under Pressure (default for moderate scores)
    if (m.combined >= 50) {
        const conf = 55 + strength(m.combined, 50, 20) * 25;
        const why = [
            `ציון משולב ${m.combined} (טווח 50-70 — זהיר)`
        ];
        if (m.vix >= 18) why.push(`VIX ${m.vix.toFixed(1)} (עולה — מד סיכון פעיל)`);
        if (m.distributionDays >= 3) why.push(`${m.distributionDays}/25 ימי הפצה (לעקוב)`);
        if (m.breadth5dDelta < 1) why.push(`רוחב לא מאיץ (${m.breadth5dDelta.toFixed(1)} נק' ב-5 ימים)`);
        return {
            phase: PHASES.uptrend_pressure,
            confidence: Math.round(conf),
            reasons: why
        };
    }

    // Fallback
    return {
        phase: PHASES.uptrend_pressure,
        confidence: 45,
        reasons: ['סיווג ברירת מחדל — לא נמצאה התאמה החלטית לאף שלב']
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
        text: m => `Risk-On · רוטציה לסיכון`,
        meaning: 'הסקטורים המחזוריים (טכנולוגיה, אנרגיה, פיננסים) מובילים — סימן שהמשקיעים מוכנים לקחת סיכון.'
    },
    {
        id: 'risk-off', type: 'state', category: 'flow', priority: 75,
        trigger: m => m.defensiveLeadership >= 0.67,
        text: m => `Risk-Off · בריחה להגנה`,
        meaning: 'הסקטורים ההגנתיים (תרופות, חשמל, מזון) מובילים — סימן שהמשקיעים בורחים לבטוח.'
    },
    {
        id: 'mixed-rotation', type: 'state', category: 'flow', priority: 40,
        trigger: m => m.cyclicalLeadership < 0.67 && m.defensiveLeadership < 0.67,
        text: m => `רוטציה מעורבת`,
        meaning: 'אין כיוון ברור בין סקטורים מחזוריים להגנתיים — סנטימנט מבולבל.'
    },
    {
        id: 'broad-leadership', type: 'state', category: 'breadth', priority: 65,
        trigger: m => m.pctMa200 >= 65,
        text: m => `השתתפות רחבה · ${Math.round(m.pctMa200)}%`,
        meaning: 'יותר מ-65% מהמניות נסחרות מעל ממוצע 200 ימים — המגמה החיובית רחבה ובריאה.'
    },
    {
        id: 'narrow-leadership', type: 'state', category: 'breadth', priority: 70,
        trigger: m => m.pctMa200 <= 40 && m.pctMa200 > 0,
        text: m => `מובילות צרה · ${Math.round(m.pctMa200)}%`,
        meaning: 'פחות מ-40% מהמניות מעל ממוצע 200 — המדד עולה אבל רק מעטות מובילות (סימן אזהרה).'
    },
    {
        id: 'low-vol', type: 'state', category: 'risk', priority: 35,
        trigger: m => m.vix > 0 && m.vix < 15,
        text: m => `תנודתיות נמוכה · VIX ${m.vix.toFixed(1)}`,
        meaning: 'מד הפחד (VIX) מתחת ל-15 — שוק רגוע, ביטחון גבוה של משקיעים.'
    },
    {
        id: 'elevated-vol', type: 'state', category: 'risk', priority: 72,
        trigger: m => m.vix >= 20 && m.vix < 30,
        text: m => `תנודתיות מוגברת · VIX ${m.vix.toFixed(1)}`,
        meaning: 'מד הפחד בין 20-30 — לחץ מוגבר בשוק, המשקיעים מתחילים להגן על עצמם.'
    },
    {
        id: 'crisis-vol', type: 'state', category: 'risk', priority: 95,
        trigger: m => m.vix >= 30,
        text: m => `תנודתיות משבר · VIX ${m.vix.toFixed(1)}`,
        meaning: 'מד הפחד מעל 30 — רמת משבר, פאניקה. היסטורית מסמן חולשת שוק חזקה.'
    },

    // ── TRANSITION chips ──
    {
        id: 'breadth-widening', type: 'transition', category: 'breadth', priority: 68,
        trigger: m => m.breadth5dDelta >= 5,
        text: m => `↗ רוחב מתרחב · +${m.breadth5dDelta.toFixed(0)} נק' ב-5 ימים`,
        meaning: 'יותר מניות מצטרפות למגמה החיובית בשבוע האחרון — בריאות פנימית משתפרת.'
    },
    {
        id: 'breadth-narrowing', type: 'transition', category: 'breadth', priority: 80,
        trigger: m => m.breadth5dDelta <= -5,
        text: m => `↘ רוחב מצטמצם · -${Math.abs(m.breadth5dDelta).toFixed(0)} נק' ב-5 ימים`,
        meaning: 'פחות מניות משתתפות בעלייה — המדד עולה אבל המבנה הפנימי נחלש.'
    },
    {
        id: 'vix-compressing', type: 'transition', category: 'risk', priority: 45,
        trigger: m => m.vix5dDelta <= -2 && m.vix > 0,
        text: m => `↘ VIX מתכווץ · ${m.vix5dDelta.toFixed(1)}`,
        meaning: 'מד הפחד יורד — חששות המשקיעים מתפוגגים, סנטימנט משתפר.'
    },
    {
        id: 'vix-expanding', type: 'transition', category: 'risk', priority: 78,
        trigger: m => m.vix5dDelta >= 2 && m.vix > 0,
        text: m => `↗ VIX מתרחב · +${m.vix5dDelta.toFixed(1)}`,
        meaning: 'מד הפחד עולה — לחץ הולך וגובר בשוק, המשקיעים קונים הגנה.'
    },

    // ── WARNING chips ──
    {
        id: 'tech-flow-divergent', type: 'warning', category: 'flow', priority: 82,
        trigger: m => m.techScore !== null && m.flowScore !== null
                  && Math.abs(m.techScore - m.flowScore) >= 14,
        text: m => `⚠ סטייה: מחיר↔כסף · ${Math.abs(m.techScore - m.flowScore)} נק'`,
        meaning: 'הטכניקה של המחיר חזקה אבל זרימת הכסף באופציות סותרת — לעיתים תיקון מקדים.'
    },
    {
        id: 'price-breadth-divergent', type: 'warning', category: 'breadth', priority: 78,
        trigger: m => m.techScore !== null
                  && m.techScore >= 65 && m.breadthScore !== null && m.breadthScore <= 45,
        text: m => `⚠ סטייה: מחיר↔רוחב`,
        meaning: 'המדד עולה אבל רוב המניות לא משתתפות — עלייה מובלת ע"י מעטים, פגיע.'
    },
    {
        // RECALIBRATED 2026-05-22 after data audit:
        // Old threshold pcPremium > 1.15 NEVER fired on real SPX flow data
        // (real range 0.13-0.81, median 0.30 — SPX flow is structurally call-heavy).
        // New trigger: today's pc_premium > 1.5σ above rolling 22d baseline.
        id: 'hedges-elevated', type: 'warning', category: 'flow', priority: 76,
        trigger: m => m.flow && m.flow.z && m.flow.z.pc_premium != null
                  && m.flow.z.pc_premium > 1.5,
        text: m => `⚠ הגנות מוגברות · P/C ${m.flow.raw.pc_premium.toFixed(2)} (z=+${m.flow.z.pc_premium.toFixed(1)}σ)`,
        meaning: 'המשקיעים קונים יותר אופציות PUT מהרגיל ביחס ל-CALL — סימן ל-hedging חזק, חששות מתקרבים.'
    },
    {
        id: 'distribution-day', type: 'warning', category: 'momentum', priority: 85,
        trigger: m => m.distributionDays >= 3,
        text: m => `⚠ ימי הפצה · ${m.distributionDays}/25`,
        meaning: 'מספר ימים בהם המדד ירד במחזור מסחר גבוה ב-25 הימים האחרונים — סימן ללחץ מכירות מוסדי.'
    },
    {
        id: 'new-lows-rising', type: 'warning', category: 'breadth', priority: 88,
        trigger: m => m.newLows >= 20,
        text: m => `⚠ עלייה בשפלים חדשים · ${m.newLows}`,
        meaning: 'יותר מ-20 מניות בשיא שפל של 52 שבועות — חולשה רחבה מתחת לפני השטח.'
    },
    {
        id: 'overbought-concentration', type: 'warning', category: 'momentum', priority: 50,
        trigger: m => m.overboughtCount >= 40,
        text: m => `⚠ ריכוז קניית-יתר · ${m.overboughtCount} מניות`,
        meaning: 'מעל 40 מניות עם RSI > 70 — חוזק רב אבל סיכון מוגבר לתיקון.'
    },

    // ── CONFIRMATION chips ──
    {
        id: 'thrust-confirmed', type: 'confirmation', category: 'momentum', priority: 92,
        trigger: m => m.rsiThrust >= 30,
        text: m => `✓ מומנטום רחב אושר · ${m.rsiThrust} מניות`,
        meaning: 'מעל 30 מניות חוצות סף RSI כלפי מעלה היום — מומנטום חזק ורחב, אישור היפוך חיובי.'
    },
    {
        id: 'golden-widespread', type: 'confirmation', category: 'breadth', priority: 62,
        trigger: m => m.pctGolden >= 60,
        text: m => `✓ Golden Cross נרחב · ${Math.round(m.pctGolden)}%`,
        meaning: 'יותר מ-60% מהמניות עם ממוצע 50 מעל ממוצע 200 — מבנה ארוך-טווח חזק.'
    },
    {
        id: 'no-new-lows', type: 'confirmation', category: 'breadth', priority: 58,
        trigger: m => m.newLows === 0 && m.daysSinceNewLow >= 5,
        text: m => `✓ אין שפלים חדשים · ${m.daysSinceNewLow} ימים`,
        meaning: 'אף מניה לא בשיא שפל של 52 שבועות — בריאות תחתית, סימן חיובי ליציבות.'
    },
    {
        id: 'broad-participation', type: 'confirmation', category: 'breadth', priority: 55,
        trigger: m => m.pctMa50 >= 70,
        text: m => `✓ השתתפות רחבה · ${Math.round(m.pctMa50)}% מעל MA50`,
        meaning: 'יותר מ-70% מהמניות מעל ממוצע 50 ימים — תמיכה רחבה למגמה לטווח הבינוני.'
    },
    {
        id: 'flow-aligned', type: 'confirmation', category: 'flow', priority: 72,
        trigger: m => m.techScore !== null && m.flowScore !== null
                  && m.techScore >= 60 && m.flowScore >= 60
                  && Math.abs(m.techScore - m.flowScore) <= 8,
        text: m => `✓ מחיר וכסף מתואמים`,
        meaning: 'הטכניקה של המחיר וזרימת הכסף באופציות מצביעים שניהם חיובי — אישור חזק.'
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
