"""
build_knn_forecast.py — the "צפי מול בפועל" (forecast vs actual) series
for the KNN tab, WITH data-quality flags.

For each locked-in KNN snapshot the historical analogs already implied a
20-trading-day forward-return band, stored in `outcomes["20"]` as
{min, median, max}. This attaches the realized 20-day SPX return (once it
matures) and — so the chart is honest about how much to trust each day —
two quality flags derived from the KNN's OWN distance metric:

  • confidence  — 'high' / 'low' from the median match distance. A day whose
    10 analogs are all FAR (median distance > LOW_CONF_MEDDIST) has no real
    historical precedent; its forecast is unreliable and is marked.
  • gaps        — trading days in the window with NO snapshot at all (the
    snapshot builder only stamps the latest day per run) are emitted as
    gap rows so they show as a visible break, not a silent absence.

Display only. Wide min–max band, 20-day horizon only (user choice).
"""
import csv
import io
import glob
import json
import re
import statistics

WL_RE = re.compile(r'watchlist-sp-500-intraday-(\d{2})-(\d{2})-(\d{4})\.csv$')
HORIZON = 20  # trading days — the only horizon (user request)

# Median match-distance above which a day's analogs are too far to be
# statistically reliable (~p75 of the observed 42-snapshot distribution,
# calibrated 2026-07). Below it = 'high' confidence.
LOW_CONF_MEDDIST = 0.90


def spx_price_by_date():
    """{ 'YYYY-MM-DD': spx_close } from every watchlist CSV."""
    out = {}
    for p in glob.glob('data/watchlist-sp-500-intraday-*.csv'):
        g = WL_RE.search(p)
        if not g:
            continue
        mm, dd, yyyy = g.groups()
        iso = f'{yyyy}-{mm}-{dd}'
        try:
            txt = open(p, encoding='utf-8-sig').read().replace('\r\n', '\n')
        except OSError:
            continue
        for r in csv.DictReader(io.StringIO(txt)):
            if (r.get('Symbol') or '').strip() == '$SPX':
                v = (r.get('Latest') or '').replace(',', '').strip()
                try:
                    out[iso] = float(v)
                except ValueError:
                    pass
                break
    return out


def _r2(v):
    return round(v, 2) if v is not None else None


def build():
    try:
        snaps = json.load(open('data/forward_snapshots.json',
                               encoding='utf-8')).get('snapshots', [])
    except (FileNotFoundError, json.JSONDecodeError):
        snaps = []
    prices = spx_price_by_date()
    days = sorted(prices.keys())
    idx = {d: i for i, d in enumerate(days)}

    # Index usable snapshots (must carry the 20-day outcomes) by anchor date.
    by_date = {}
    for s in snaps:
        d = s.get('anchorDate')
        oc = (s.get('outcomes') or {}).get(str(HORIZON))
        if d and oc:
            by_date[d] = (s, oc)

    if not by_date:
        return {'horizon': HORIZON, 'hitRate': None, 'maturedCount': 0,
                'total': 0, 'gapDates': [], 'lowConfCount': 0, 'series': []}

    lo, hi = min(by_date), max(by_date)
    # Every trading day in the window — days without a snapshot become a
    # visible gap instead of silently vanishing from the chart.
    window = [d for d in days if lo <= d <= hi]

    rows, gap_dates = [], []
    for d in window:
        if d not in by_date:
            rows.append({'date': d, 'gap': True, 'fcMin': None, 'fcMax': None,
                         'fcMedian': None, 'actual': None, 'hit': None,
                         'confidence': None, 'medDist': None})
            gap_dates.append(d)
            continue
        s, oc = by_date[d]
        dists = [m.get('distance') for m in s.get('matches', [])
                 if m.get('distance') is not None]
        med_dist = round(statistics.median(dists), 2) if dists else None
        conf = ('high' if (med_dist is not None and med_dist <= LOW_CONF_MEDDIST)
                else 'low')
        row = {
            'date': d, 'gap': False,
            'fcMin': _r2(oc.get('min')), 'fcMax': _r2(oc.get('max')),
            'fcMedian': _r2(oc.get('median')),
            'actual': None, 'hit': None,
            'confidence': conf, 'medDist': med_dist,
        }
        i = idx.get(d)
        p0 = prices.get(d)
        if i is not None and p0 and i + HORIZON < len(days):
            actual = round((prices[days[i + HORIZON]] / p0 - 1) * 100, 2)
            row['actual'] = actual
            if row['fcMin'] is not None and row['fcMax'] is not None:
                row['hit'] = bool(row['fcMin'] <= actual <= row['fcMax'])
        rows.append(row)

    matured = [r for r in rows if r['actual'] is not None]
    hits = [r for r in matured if r['hit']]
    low_conf = [r for r in rows if r['confidence'] == 'low']
    return {
        'horizon': HORIZON,
        'hitRate': round(len(hits) / len(matured), 3) if matured else None,
        'maturedCount': len(matured),
        'total': sum(1 for r in rows if not r['gap']),
        'gapDates': gap_dates,
        'lowConfCount': len(low_conf),
        'series': rows,
    }


def main():
    out = build()
    with open('data/knn_forecast.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Wrote data/knn_forecast.json ({out['total']} snapshots, "
          f"{out['maturedCount']} matured, hitRate={out['hitRate']}, "
          f"{out['lowConfCount']} low-conf, {len(out['gapDates'])} gaps)")


if __name__ == '__main__':
    main()
