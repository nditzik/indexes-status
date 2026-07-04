"""
build_score_forward.py — attach the actual forward SPX return to each
scores_history record once 5 / 20 trading days have elapsed. Output:
data/score_forward.json. The dashboard groups these by score band to
show "how did the combined score actually do?" (phase 3.4).

Append-only spirit: reads scores_history (never rewrites it) and derives
a parallel forward file. Empty until history accumulates + matures.
"""
import csv
import io
import glob
import json
import re

WL_RE = re.compile(r'watchlist-sp-500-intraday-(\d{2})-(\d{2})-(\d{4})\.csv$')


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


def build():
    try:
        hist = json.load(open('data/scores_history.json', encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        hist = []
    prices = spx_price_by_date()
    days = sorted(prices.keys())
    idx = {d: i for i, d in enumerate(days)}

    out = []
    for rec in hist:
        d = rec.get('date')
        row = dict(rec)
        row['fwd5'] = row['fwd20'] = None
        i = idx.get(d)
        p0 = prices.get(d)
        if i is not None and p0:
            if i + 5 < len(days):
                row['fwd5'] = round((prices[days[i + 5]] / p0 - 1) * 100, 2)
            if i + 20 < len(days):
                row['fwd20'] = round((prices[days[i + 20]] / p0 - 1) * 100, 2)
        out.append(row)
    return out


def main():
    out = build()
    with open('data/score_forward.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    matured = sum(1 for r in out if r.get('fwd20') is not None)
    print(f'Wrote data/score_forward.json ({len(out)} records, {matured} matured to 20d)')


if __name__ == '__main__':
    main()
