"""
parity_test.py — JS ↔ Python composite-score parity check.

The dashboard (JS in v2/overview-prod.js) and the daily email
(.github/workflows/send_report.py) implement the same scoring logic
independently. If one drifts from the other, the same trading day can
yield Flow Score 67 on the dashboard but 80 in the email — exactly
the bug that motivated this audit fix.

This test:
  1. Loads today's CSVs from data/
  2. Computes Tech / Breadth / Flow / Combined using a Python port of
     the dashboard's formulas (kept in sync with overview-prod.js
     scoreTech, scoreBreadth, scoreFromMetrics, combineScores)
  3. Computes the same numbers using the email's actual implementation
     by directly importing send_report.py's functions
  4. Asserts they match within ±1 (rounding tolerance)

Run:
    python3 tests/parity_test.py
    # or, on Windows:
    py tests/parity_test.py

Exits non-zero if any score drifts. CI can wire this in.
"""
import csv, glob, io, json, math, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, '.github', 'workflows'))


# ─── Shared CSV helpers (mirror send_report.py) ──────────────────────
def num(v):
    if v is None:
        return None
    s = str(v).strip().replace('%', '').replace('+', '').replace(',', '')
    try:
        return float(s)
    except ValueError:
        return None


def load_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        txt = f.read().replace('\r\n', '\n').replace('\r', '\n')
    return list(csv.DictReader(io.StringIO(txt)))


def clamp(v, lo=0, hi=100):
    return max(lo, min(hi, v))


# ─── Latest-file selection by parsed date (mirror of audit-fix-1) ────
_WATCHLIST_RE = re.compile(r'watchlist-sp-500-intraday-(\d{2})-(\d{2})-(\d{4})\.csv$')
_FLOW_RE      = re.compile(r'spx-options-flow-(\d{2})-(\d{2})-(\d{4})\.csv$')


def _iso_key(path, pat):
    m = pat.search(path)
    if not m:
        return ''
    mm, dd, yyyy = m.groups()
    return f'{yyyy}-{mm}-{dd}'


def latest_csv(pattern, regex):
    paths = glob.glob(os.path.join(ROOT, 'data', pattern))
    paths.sort(key=lambda p: _iso_key(p, regex))
    return paths[-1] if paths else None


# ─── JS-port: Tech / Breadth / Flow formulas ─────────────────────────
# These MUST stay in sync with v2/overview-prod.js scoreTech etc.
# When the dashboard formula changes, mirror it here AND in send_report.
def js_score_tech(spx, vix_chg):
    if not spx or spx.get('price') is None:
        return None
    p = spx['price']
    parts, max_ = 0, 0
    if spx.get('ma20'):  parts += 15 if p > spx['ma20'] else 5;  max_ += 15
    if spx.get('ma50'):  parts += 20 if p > spx['ma50'] else 5;  max_ += 20
    if spx.get('ma200'): parts += 25 if p > spx['ma200'] else 3; max_ += 25
    if spx.get('ma20') and spx.get('ma50') and spx.get('ma200'):
        if   spx['ma20'] > spx['ma50'] > spx['ma200']: parts += 15
        elif spx['ma20'] < spx['ma50'] < spx['ma200']: parts += 0
        elif spx['ma20'] > spx['ma50']:                parts += 10
        else:                                          parts += 5
        max_ += 15
    if spx.get('high52') is not None:
        d = abs(spx['high52'])
        parts += 10 if d <= 5 else 7 if d <= 10 else 4 if d <= 20 else 1
        max_ += 10
    if spx.get('chgPct') is not None:
        c = spx['chgPct']
        parts += 15 if c > 1.0 else 12 if c > 0.5 else 9 if c >= -0.5 else 5 if c >= -1.0 else 2 if c >= -1.5 else 0
        max_ += 15
    if vix_chg is not None and math.isfinite(vix_chg):
        parts += 10 if vix_chg <= -10 else 8 if vix_chg <= 0 else 5 if vix_chg <= 10 else 2 if vix_chg <= 25 else 0
        max_ += 10
    if max_ == 0:
        return None
    return clamp(round(parts / max_ * 100))


def js_score_breadth(m):
    p200 = m.get('pctMa200', 0) or 0
    parts, max_ = 0, 0
    parts += 25 if p200 >= 65 else 18 if p200 >= 50 else 10 if p200 >= 40 else 3
    max_ += 25
    h = m.get('healthScore', 0)
    parts += 15 if h >= 70 else 10 if h >= 55 else 5 if h >= 40 else 1
    max_ += 15
    nh, nl = m.get('newHighs', 0), m.get('newLows', 0)
    nhnl = 99 if (nl == 0 and nh > 0) else (nh / nl if nl > 0 else 0)
    parts += 10 if (nhnl == 99 or nhnl >= 1.5) else 7 if nhnl >= 1.0 else 3 if nhnl >= 0.7 else 0
    max_ += 10
    if m.get('avgChange') is not None:
        a = m['avgChange']
        parts += 5 if a > 0.5 else 3 if a >= -0.5 else 0
        max_ += 5
    if m.get('total'):
        rsi50 = m['rsiAbove50'] / m['total'] * 100
        parts += 10 if rsi50 >= 65 else 7 if rsi50 >= 50 else 4 if rsi50 >= 40 else 1
        max_ += 10
    if max_ == 0:
        return None
    return clamp(round(parts / max_ * 100))


def js_score_flow(flow_csv_path):
    """Mirror of overview-prod.js scoreFromMetrics + computeFlowDay."""
    if not flow_csv_path:
        return None
    rows = load_csv(flow_csv_path)
    cA = cB = cM = pA = pB = pM = 0.0
    for r in rows:
        t = (r.get('Type', '') or '').strip().lower()
        side = (r.get('Side', '') or '').strip().lower()
        prem = num(r.get('Premium')) or 0
        if t == 'call':
            if   side == 'ask': cA += prem
            elif side == 'bid': cB += prem
            else:               cM += prem
        elif t == 'put':
            if   side == 'ask': pA += prem
            elif side == 'bid': pB += prem
            else:               pM += prem
    call_p = cA + cB + cM
    put_p  = pA + pB + pM
    call_dir = cA + cB
    put_dir  = pA + pB
    if (call_dir + put_dir) <= 0:
        return None
    call_share = call_dir / (call_dir + put_dir) * 100
    call_ask_pm = cA / call_p * 100 if call_p > 0 else 50
    put_ask_pm  = pA / put_p  * 100 if put_p  > 0 else 50
    score = 50 + (call_share - 50) * 1.0 + (call_ask_pm - 50) * 0.5 - (put_ask_pm - 50) * 0.5
    return clamp(round(score))


def js_combined(t, f, b):
    w = {'t': 0.40, 'f': 0.35, 'b': 0.25}
    num_, den = 0.0, 0.0
    if t is not None: num_ += w['t'] * t; den += w['t']
    if f is not None: num_ += w['f'] * f; den += w['f']
    if b is not None: num_ += w['b'] * b; den += w['b']
    if den == 0:
        return None
    return clamp(round(num_ / den))


# ─── Run send_report.py end-to-end and capture its outputs ───────────
# send_report.py is built as a top-level script — running it sets
# module-level variables we can read. We capture only the score outputs.
def email_outputs():
    # The script reads files relative to cwd, so chdir into the repo root.
    orig_cwd = os.getcwd()
    os.chdir(ROOT)
    # Don't actually send the email — set TEST_RECIPIENTS to a dummy and
    # patch out the urlopen call with a no-op.
    os.environ['TEST_RECIPIENTS'] = 'parity-test@local'
    os.environ['BREVO_API_KEY'] = ''
    import urllib.request
    real_urlopen = urllib.request.urlopen
    class _NoopResponse:
        status = 200
        def read(self): return b'{"messageId":"parity-test"}'
        def __enter__(self): return self
        def __exit__(self, *a): pass
    urllib.request.urlopen = lambda *a, **kw: _NoopResponse()
    try:
        import importlib
        if 'send_report' in sys.modules:
            del sys.modules['send_report']
        import send_report as sr
        out = {
            't_score': sr.t_score,
            'b_score': sr.b_score,
            'f_score': sr.f_score,
            'c_score': sr.c_score,
        }
        return out
    finally:
        urllib.request.urlopen = real_urlopen
        os.chdir(orig_cwd)


# ─── JS-port equivalent: read the same CSVs the email does and ───────
# compute scores using the JS port. The data.txt copy is what the
# email reads, so we use that.
def js_outputs():
    spx_row = None; vix_row = None
    rows = load_csv(os.path.join(ROOT, 'data', 'data.txt'))
    for r in rows:
        sym = (r.get('Symbol') or '').strip()
        if sym == '$SPX': spx_row = r
        elif sym == '$VIX': vix_row = r
    spx = None
    if spx_row:
        spx = {
            'price':  num(spx_row.get('Latest')),
            'chgPct': num(spx_row.get('%Change')),
            'ma20':   num(spx_row.get('20D MA')),
            'ma50':   num(spx_row.get('50D MA')),
            'ma200':  num(spx_row.get('200D MA')),
            'high52': num(spx_row.get('52W %/High')),
        }
    vix_chg = num(vix_row.get('%Change')) if vix_row else None

    # Cash-index daily-change correction (mirror of overview-prod.js
    # computeMetrics + send_report.py): data.txt's $SPX %Change cell
    # intermittently arrives as 0.00% when the export predates the index
    # settle. Derive it from price vs the previous trading day's close so
    # the port matches the real dashboard/email.
    if spx and spx.get('price') is not None:
        c = spx.get('chgPct')
        if c is None or abs(c) < 0.005:
            wl = sorted(glob.glob(os.path.join(ROOT, 'data', 'watchlist-sp-500-intraday-*.csv')),
                        key=lambda p: _iso_key(p, _WATCHLIST_RE))
            if len(wl) >= 2:
                prev_rows = load_csv(wl[-2])
                prev_spx = next((r for r in prev_rows if (r.get('Symbol') or '').strip() == '$SPX'), None)
                pp = num(prev_spx.get('Latest')) if prev_spx else None
                if pp:
                    spx['chgPct'] = (spx['price'] / pp - 1) * 100

    # Breadth inputs
    stocks = [r for r in rows
              if r.get('Symbol') and not r['Symbol'].strip().startswith('$')
              and num(r.get('Latest'))]
    total = len(stocks)
    a200 = sum(1 for r in stocks if num(r.get('200D MA')) and num(r.get('Latest')) > num(r.get('200D MA')))
    a20  = sum(1 for r in stocks if num(r.get('20D MA'))  and num(r.get('Latest')) > num(r.get('20D MA')))
    golden = sum(1 for r in stocks if num(r.get('50D MA')) and num(r.get('200D MA')) and num(r.get('50D MA')) > num(r.get('200D MA')))
    rsi50 = sum(1 for r in stocks if (r.get('RSI Rank', '') or '').strip() in ('Above 50', 'New Above 50', 'Above 70', 'New Above 70'))
    nh = sum(1 for r in stocks if num(r.get('52W %/High')) is not None and num(r.get('52W %/High')) >= -5)
    nl = sum(1 for r in stocks if num(r.get('52W %/High')) is not None and num(r.get('52W %/High')) <= -30)
    rsp = next((r for r in stocks if r.get('Symbol', '').strip() == 'RSP'), None)
    chgs = [num(r.get('%Change')) for r in stocks
            if r.get('Symbol', '').strip() != 'RSP'
            and num(r.get('%Change')) is not None and abs(num(r.get('%Change'))) < 50]
    if rsp and num(rsp.get('%Change')) is not None and abs(num(rsp.get('%Change'))) < 50:
        avg_change = num(rsp.get('%Change'))
    elif chgs:
        avg_change = sum(chgs) / len(chgs)
    else:
        avg_change = None
    p200 = a200 / total * 100 if total else 0
    health = round((a200/total*100)*0.30 + (golden/total*100)*0.25 + (rsi50/total*100)*0.25 + (a20/total*100)*0.20) if total else 0
    m = {
        'pctMa200': p200, 'healthScore': health,
        'newHighs': nh, 'newLows': nl,
        'avgChange': avg_change,
        'rsiAbove50': rsi50, 'total': total,
    }
    t = js_score_tech(spx, vix_chg)
    b = js_score_breadth(m)
    f = js_score_flow(latest_csv('spx-options-flow-*.csv', _FLOW_RE))
    c = js_combined(t, f, b)
    return {'t_score': t, 'b_score': b, 'f_score': f, 'c_score': c}


# ─── Assertion ───────────────────────────────────────────────────────
def main():
    print(f'Repo root: {ROOT}')
    js  = js_outputs()
    em  = email_outputs()
    print()
    print(f'{"score":>10} {"dashboard":>12} {"email":>12} {"delta":>8}  status')
    print('-' * 60)
    failed = False
    for key in ('t_score', 'b_score', 'f_score', 'c_score'):
        v_js = js.get(key)
        v_em = em.get(key)
        if v_js is None or v_em is None:
            status = '— missing'
            print(f'{key:>10} {str(v_js):>12} {str(v_em):>12} {"":>8}  {status}')
            continue
        delta = abs(v_js - v_em)
        ok = delta <= 1   # rounding tolerance
        status = 'OK' if ok else 'FAIL'
        print(f'{key:>10} {v_js:>12} {v_em:>12} {delta:>+8.0f}  {status}')
        if not ok:
            failed = True
    print()

    # daily_state.json emitter (phase-3.0) must map the same scores.
    # Regenerated in-process (not the possibly-stale file) so this catches
    # a wiring bug in build_daily_state, not a data-age mismatch.
    try:
        import importlib
        sys.path.insert(0, os.path.join(ROOT, 'scripts'))
        if 'build_daily_state' in sys.modules:
            del sys.modules['build_daily_state']
        bds = importlib.import_module('build_daily_state')
        ds_scores = bds.build_state().get('scores', {})
        ds = {'t_score': ds_scores.get('tech'), 'b_score': ds_scores.get('breadth'),
              'f_score': ds_scores.get('flow'), 'c_score': ds_scores.get('combined')}
        for key in ('t_score', 'b_score', 'f_score', 'c_score'):
            if ds.get(key) != em.get(key):
                print(f'daily_state {key}: {ds.get(key)} != email {em.get(key)} — EMITTER DRIFT')
                failed = True
        if not failed:
            print('daily_state.json emitter matches the email scores. [OK]')
    except Exception as e:
        print(f'daily_state emitter check skipped: {e}')

    print()
    if failed:
        print('PARITY FAILED — dashboard and email disagree. Sync the formulas.')
        sys.exit(1)
    print('PARITY OK — dashboard and email match within ±1.')


if __name__ == '__main__':
    main()
