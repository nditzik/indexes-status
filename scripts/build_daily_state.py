"""
build_daily_state.py — emit data/daily_state.json, the single source of the
"scored brain": scores, phase, risk-off, verdict (+ status lights) and the
narrative. Imports send_report (side-effect-free after phase-3.0/1a) to
reuse its Python computation, so the dashboard and the email consume ONE
computed state instead of duplicating every formula.

Run:
    python3 scripts/build_daily_state.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join('.github', 'workflows'))
import send_report as sr   # importing computes everything; sends nothing


def build_state():
    date = sr.history_rich[-1]['date'] if sr.history_rich else None
    verdict = sr.build_verdict_state()
    # Rotation v2 (review fix 2): real sector relative-strength vs $SPX.
    sector_rs = sr.compute_sector_rs()
    leading = sr.leading_sectors(sector_rs)
    return {
        'date': date,
        'formulaVersion': sr.FORMULA_VERSION,
        'scores': {
            'tech': sr.t_score,
            'breadth': sr.b_score,
            'flow': sr.f_score,
            'combined': sr.c_score,
        },
        'phase': {
            'id': sr.phase_id_now,
            'label': sr.phase_label_now,
        },
        'riskOff': {
            'active': bool(sr.risk_off_reasons),
            'acute': bool(sr.risk_off_acute),
            'reasons': list(sr.risk_off_reasons),
            'sellingDays': [{'date': d, 'chg': round(c, 2) if c is not None else None}
                            for d, c in sr.risk_off_selling_days],
            # Redesigned pressure card — three fixed lines + the 25-dot map.
            # All text built in Python; the dashboard/email only render it.
            'tone': 'red' if sr.risk_off_acute else 'neutral',
            'stateLine': sr.build_pressure_state_line(sr.c_score, sr.risk_off_acute),
            'evidenceLine': sr.build_pressure_evidence_line(sr.dist_days, sr.sell_days_10),
            'actionLine': sr.build_pressure_action(
                sr.c_score, sr.dist_days, sr.sell_days_3, sr.risk_off_acute),
            'sellDaysMap': sr.sell_days_map(),
        },
        'flowWeight': getattr(sr, 'flow_weight', None),   # phase 3.1
        'vixTermRatio': getattr(sr, 'vix_term_ratio', None),   # phase 3.2 / 4b
        'evidence': {   # phase 4b — numbers for the Evidence cards
            'spxPrice': sr.spx.get('price') if sr.spx else None,
            'spxMa200': sr.spx.get('ma200') if sr.spx else None,
            'pctMa200': round(sr.p200, 1) if getattr(sr, 'p200', None) is not None else None,
            'vix': sr.vix,
            'nhCount': getattr(sr, 'nh', None),
            'nlCount': getattr(sr, 'nl', None),
            'eqSpx20': sr.compute_eq_spx_spread(),   # review fix 2 → Breadth card
        },
        # Rotation v2 (review fix 2): the dashboard's Action Zone + UOA
        # confirmation card pick from persistent Leading sectors instead
        # of "top-3 by today's move", and the Rotation evidence card shows
        # cyclical-vs-defensive leadership. JS renders these; no JS logic.
        'rotation': {
            'leadingSectors': leading,
            'sectorRs': sector_rs,
            'cyclicalLeading': sum(1 for c in leading if c in sr.CYCLICAL_SECTORS),
            'defensiveLeading': sum(1 for c in leading if c in sr.DEFENSIVE_SECTORS),
            'series': sr.compute_rotation_series(),   # cyclical−defensive momentum sparkline
        },
        'verdict': verdict,   # {headline, subline, tone, emoji, lights}
        'narrative': {
            'headline': sr.meta_label_now,
            'rationale': sr.rationale_now,
            'today': sr.today_line_now,
            'week': sr.week_line_now,
            'background': sr.background_line_now,
            'watchFor': getattr(sr, 'watch_for_str', '') or '',
        },
    }


def main():
    state = build_state()
    with open('data/daily_state.json', 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    print(f"Wrote data/daily_state.json for {state['date']} "
          f"(T{state['scores']['tech']}/B{state['scores']['breadth']}/"
          f"F{state['scores']['flow']}/C{state['scores']['combined']})")


if __name__ == '__main__':
    main()
