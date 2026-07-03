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
        },
        'flowWeight': getattr(sr, 'flow_weight', None),   # phase 3.1
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
