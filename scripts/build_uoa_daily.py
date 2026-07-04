"""
build_uoa_daily.py — condense the daily Unusual Options Activity export
into data/uoa_daily.json: per S&P-500 symbol, the dominant direction
(Call/Put by premium), the max Vol/OI, and total premium. Powers the
per-stock UOA badge in the dashboard Action Zone (phase 2.5 / 3.5).

Real export columns (2026-07):
  Symbol, Price~, Exp Date, DTE, Type, Strike, Bid, Latest, Ask,
  Volume, Open Int, Vol/OI, Delta, Time
There is no premium column, so premium is derived as Latest*Volume*100
(contract multiplier). Lenient parsing — column names may drift slightly.

Filters (phase 2.5, DTE option 'ג'):
  DTE >= 7 (drop 0-1DTE gambling) · Vol/OI >= 3 · symbol in sectors.json.
"""
import csv
import io
import glob
import json
import re

UOA_RE = re.compile(r'uoa-stocks-(\d{2})-(\d{2})-(\d{4})\.csv$')
DTE_MIN = 7
VOLOI_MIN = 3.0


def _num(v):
    try:
        return float(str(v).replace(',', '').replace('%', '').strip())
    except (ValueError, AttributeError):
        return None


def _col(row, *names):
    """First matching column (case/space/tilde tolerant)."""
    norm = {re.sub(r'[^a-z0-9]', '', k.lower()): k for k in row.keys()}
    for n in names:
        key = norm.get(re.sub(r'[^a-z0-9]', '', n.lower()))
        if key is not None:
            return row[key]
    return None


def latest_uoa_file():
    def keyf(p):
        m = UOA_RE.search(p)
        return f'{m.group(3)}-{m.group(1)}-{m.group(2)}' if m else ''
    files = sorted(glob.glob('data/uoa-stocks-*.csv'), key=keyf)
    return files[-1] if files else None


def load_sp500():
    try:
        sm = json.load(open('data/sectors.json', encoding='utf-8'))
        return set((sm.get('tickers') or {}).keys())
    except Exception:
        return set()


def build():
    path = latest_uoa_file()
    if not path:
        return {}
    sp = load_sp500()
    txt = open(path, encoding='utf-8-sig').read().replace('\r\n', '\n')
    rows = list(csv.DictReader(io.StringIO(txt)))
    agg = {}
    for r in rows:
        sym = (_col(r, 'Symbol') or '').strip()
        if not sym or (sp and sym not in sp):
            continue
        dte = _num(_col(r, 'DTE'))
        voloi = _num(_col(r, 'Vol/OI', 'VolOI'))
        if dte is None or dte < DTE_MIN:
            continue
        if voloi is None or voloi < VOLOI_MIN:
            continue
        typ = (_col(r, 'Type') or '').strip().lower()
        price = _num(_col(r, 'Latest', 'Midpoint', 'Last'))
        vol = _num(_col(r, 'Volume'))
        prem = (price * vol * 100) if (price and vol) else 0
        a = agg.setdefault(sym, {'callPrem': 0.0, 'putPrem': 0.0,
                                 'volOiMax': 0.0, 'contracts': 0})
        if typ == 'call':
            a['callPrem'] += prem
        elif typ == 'put':
            a['putPrem'] += prem
        else:
            continue
        a['volOiMax'] = max(a['volOiMax'], voloi)
        a['contracts'] += 1
    out = {}
    for sym, a in agg.items():
        out[sym] = {
            'dir': 'Call' if a['callPrem'] >= a['putPrem'] else 'Put',
            'volOiMax': round(a['volOiMax'], 1),
            'totalPremium': round(a['callPrem'] + a['putPrem']),
            'callPremium': round(a['callPrem']),
            'putPremium': round(a['putPrem']),
            'contracts': a['contracts'],
        }
    return out


def main():
    out = build()
    with open('data/uoa_daily.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f'Wrote data/uoa_daily.json ({len(out)} S&P-500 symbols)')


if __name__ == '__main__':
    main()
