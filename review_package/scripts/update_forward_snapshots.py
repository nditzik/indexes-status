#!/usr/bin/env python3
"""
update_forward_snapshots.py
───────────────────────────
Generates a "forward tracking" snapshot for the latest trading day in
data/, then appends it to data/forward_snapshots.json (creating the file
if missing). The snapshot locks in the KNN matches + signal thresholds
as they were on the anchor date, so future dashboard loads can compare
the actual forward 5-day path against those thresholds.

Mirrors the JS logic in v2/patterns.js exactly:
  - 9 features per day (SPX 5d/20d ret, EQ 5d ret, spread 5d, drawdown
    60d, vol 20d, VIX level/5d delta/vs MA20)
  - z-score normalisation across full history
  - K=10 nearest neighbours, Euclidean distance, ±20d cluster dedup,
    30d exclusion from anchor
  - Cohen's d separation between bullish (20d ≥ +1%) and non-bullish
    cohorts; threshold = midpoint of cohort means

Run after each trading day's CSVs are added:
    python scripts/update_forward_snapshots.py

Idempotent — running twice on the same data produces the same JSON.
"""

import csv
import json
import math
import os
import re
import sys
from datetime import datetime, date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
HIST_DIR = os.path.join(DATA, 'historical')
SNAP_FILE = os.path.join(DATA, 'forward_snapshots.json')

LOOKBACK = 60
K = 10
EXCLUDE_RECENT = 30
# 40 >= the 20d outcome window, so accepted matches have NON-OVERLAPPING
# forward windows — the K outcomes are quasi-independent episodes.
# (Was 20, which allowed 19 of 20 outcome days to overlap.)
CLUSTER_DEDUP = 40
EARLY_DAYS = 5
OUTCOME_WINDOW = 20
BULL_T = 1.0
BEAR_T = -1.0

# Feature weights for the distance metric. All 9 features are still
# computed + stored, but two are excluded from similarity because they
# double-count information already in other dimensions:
#   idx 2 eqRet5d   — linearly dependent on spread5d + spxRet5d
#   idx 8 vixVsMa20 — correlated with vixLevel + vix5dDelta (VIX shocks
#                     were triple-counted, starving crash days of matches)
# Mirrors FEATURE_WEIGHTS in v2/patterns.js — keep in sync.
FEATURE_WEIGHTS = [1, 1, 0, 1, 1, 1, 1, 1, 0]

# Reliability guard for early-warning signals: with 8 features tested on
# ~10 samples, some |d| will always be high by chance. Only signals
# passing BOTH bars are marked reliable (UI shows the rest as hints).
SIGNAL_MIN_ABS_D = 0.8
SIGNAL_MIN_BULL_N = 4
SIGNAL_MIN_OTHER_N = 3


# ─── Stats helpers ───────────────────────────────────────────────────
def mean(xs):
    xs = [x for x in xs if x is not None and math.isfinite(x)]
    return sum(xs) / len(xs) if xs else None


def std(xs, mu=None):
    xs = [x for x in xs if x is not None and math.isfinite(x)]
    if not xs:
        return None
    if mu is None:
        mu = sum(xs) / len(xs)
    return math.sqrt(sum((v - mu) ** 2 for v in xs) / len(xs))


def percentile(sorted_xs, p):
    if not sorted_xs:
        return None
    idx = (len(sorted_xs) - 1) * p
    lo, hi = int(math.floor(idx)), int(math.ceil(idx))
    if lo == hi:
        return sorted_xs[lo]
    return sorted_xs[lo] + (sorted_xs[hi] - sorted_xs[lo]) * (idx - lo)


# ─── Barchart historical CSV parsing ─────────────────────────────────
def parse_barchart(path):
    """Returns [{date, pct, close}] oldest-first."""
    if not os.path.exists(path):
        return []
    out = []
    with open(path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            d = row.get('Time')
            if not d:
                continue
            pct_str = (row.get('%Change') or '').replace('%', '').replace('+', '')
            try:
                pct = float(pct_str)
            except ValueError:
                continue
            try:
                close = float(row.get('Latest') or 'nan')
            except ValueError:
                close = None
            out.append({'date': d, 'pct': pct, 'close': close})
    out.sort(key=lambda r: r['date'])
    return out


# ─── Daily watchlist CSV parsing ─────────────────────────────────────
WATCHLIST_RE = re.compile(r'watchlist-sp-500-intraday-(\d{2})-(\d{2})-(\d{4})\.csv$')


def list_watchlist_files():
    """Returns sorted list of (iso_date, full_path)."""
    out = []
    for fn in os.listdir(DATA):
        m = WATCHLIST_RE.match(fn)
        if not m:
            continue
        mm, dd, yyyy = m.group(1), m.group(2), m.group(3)
        iso = f'{yyyy}-{mm}-{dd}'
        out.append((iso, os.path.join(DATA, fn)))
    out.sort(key=lambda t: t[0])
    return out


def parse_watchlist(path):
    """Extracts SPX %change, SPX close, VIX close, avgChange of stocks."""
    spx_pct = None
    spx_close = None
    vix_close = None
    stock_chgs = []
    with open(path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            sym = (row.get('Symbol') or '').strip()
            chg_str = (row.get('%Change') or '').replace('%', '').replace('+', '').strip()
            latest_str = (row.get('Latest') or '').strip()
            try:
                chg = float(chg_str) if chg_str else None
            except ValueError:
                chg = None
            try:
                latest = float(latest_str.replace(',', '')) if latest_str else None
            except ValueError:
                latest = None
            if sym == '$SPX':
                spx_pct = chg
                spx_close = latest
            elif sym == '$VIX':
                vix_close = latest
            elif sym.startswith('$'):
                continue
            elif sym == 'RSP':
                # Use the actual RSP ETF %Change if present in the CSV.
                # Matches real quote feeds; avoids drift between simple
                # stock-mean and quarterly-rebalanced ETF performance.
                pass  # captured below
            else:
                # Exclude split-related anomalies (|%Change| > 50%) so the
                # equal-weight average matches what RSP-like ETFs report
                # (they auto-adjust for splits). See overview-prod.js note.
                if chg is not None and chg != 0 and abs(chg) < 50:
                    stock_chgs.append(chg)
    # Second pass for RSP — separate from the main loop so the variable
    # scoping is unambiguous (Python list comprehensions can't share state).
    rsp_chg = None
    with open(path, 'r', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            if (row.get('Symbol') or '').strip() == 'RSP':
                v = (row.get('%Change') or '').replace('%','').replace('+','').strip()
                try: rsp_chg = float(v)
                except: rsp_chg = None
                break
    # Prefer RSP if present and reasonable; fall back to computed mean.
    if rsp_chg is not None and abs(rsp_chg) < 50:
        avg_chg = rsp_chg
    else:
        avg_chg = sum(stock_chgs) / len(stock_chgs) if stock_chgs else None
    return {'spxPct': spx_pct, 'spxClose': spx_close, 'vixClose': vix_close,
            'avgChange': avg_chg}


# ─── Splice live data onto historical ────────────────────────────────
def splice_forward(historical, live):
    if not historical:
        return list(live)
    cutoff = historical[-1]['date']
    tail = [r for r in live if r['date'] > cutoff]
    return historical + tail


def build_spliced_series():
    """Loads + splices SPX, EQ500, VIX series the same way historical.js does."""
    hist_spx = parse_barchart(os.path.join(HIST_DIR, 'spx_daily.csv'))
    hist_rsp = parse_barchart(os.path.join(HIST_DIR, 'rsp_daily.csv'))
    hist_vix = parse_barchart(os.path.join(HIST_DIR, 'vix_daily.csv'))

    # Build live arrays from daily watchlist CSVs
    live_spx, live_eq, live_vix = [], [], []
    for iso, path in list_watchlist_files():
        m = parse_watchlist(path)
        if m['spxPct'] is not None:
            live_spx.append({'date': iso, 'pct': m['spxPct'],
                            'close': m['spxClose']})
        if m['avgChange'] is not None:
            live_eq.append({'date': iso, 'pct': m['avgChange'], 'close': None})
        if m['vixClose'] is not None:
            # Compute %change from prev day in live_vix or hist_vix tail
            prev_close = None
            if live_vix:
                prev_close = live_vix[-1]['close']
            elif hist_vix:
                prev_close = hist_vix[-1]['close']
            pct = ((m['vixClose'] / prev_close - 1) * 100
                   if prev_close and prev_close > 0 else None)
            live_vix.append({'date': iso, 'pct': pct, 'close': m['vixClose']})

    return {
        'spx': splice_forward(hist_spx, live_spx),
        'eq':  splice_forward(hist_rsp, live_eq),
        'vix': splice_forward(hist_vix, live_vix),
    }


# ─── Feature matrix (mirror of patterns.js buildFeatureMatrix) ───────
def build_feature_matrix(spx, eq, vix):
    eq_by_date = {r['date']: r['pct'] for r in eq}
    vix_by_date = {r['date']: r['close'] for r in vix if r.get('close') is not None}

    dates = [r['date'] for r in spx]
    # Reconstruct SPX levels from %changes (base 100)
    spx_levels = [None] * len(dates)
    lvl = 100.0
    for i in range(len(dates)):
        p = spx[i]['pct']
        if p is not None and math.isfinite(p):
            lvl *= (1 + p / 100)
        spx_levels[i] = lvl

    # Parallel VIX level array (None when missing)
    vix_levels = [vix_by_date.get(d) for d in dates]

    rows = []
    for i in range(LOOKBACK, len(dates)):
        # 5d / 20d SPX, 5d EQ compounded
        sp5 = 1.0
        for k in range(i - 4, i + 1):
            p = spx[k]['pct']
            if p is not None and math.isfinite(p):
                sp5 *= (1 + p / 100)
        sp20 = 1.0
        for k in range(i - 19, i + 1):
            p = spx[k]['pct']
            if p is not None and math.isfinite(p):
                sp20 *= (1 + p / 100)
        eq5 = 1.0
        for k in range(i - 4, i + 1):
            e = eq_by_date.get(dates[k])
            if e is not None and math.isfinite(e):
                eq5 *= (1 + e / 100)
        spx_ret5d = (sp5 - 1) * 100
        spx_ret20d = (sp20 - 1) * 100
        eq_ret5d = (eq5 - 1) * 100

        # 5d EQ−SPX spread (sum of daily diffs)
        spread5d = 0.0
        for k in range(i - 4, i + 1):
            sp = spx[k]['pct']
            e = eq_by_date.get(dates[k])
            if sp is not None and e is not None and math.isfinite(sp) and math.isfinite(e):
                spread5d += (e - sp)

        # 60d drawdown
        high = spx_levels[i]
        for k in range(i - LOOKBACK + 1, i + 1):
            if spx_levels[k] > high:
                high = spx_levels[k]
        drawdown60d = (spx_levels[i] / high - 1) * 100

        # 20d realized vol (std of daily %)
        win = [spx[k]['pct'] for k in range(i - 19, i + 1)
               if spx[k]['pct'] is not None and math.isfinite(spx[k]['pct'])]
        vol20d = std(win)

        # VIX features
        vix_today = vix_levels[i]
        vix_level = None
        vix_5d_delta = None
        vix_vs_ma20 = None
        if vix_today is not None and math.isfinite(vix_today):
            vix_level = vix_today
            vix_5d_ago = vix_levels[i - 5] if i - 5 >= 0 else None
            if vix_5d_ago and vix_5d_ago > 0:
                vix_5d_delta = (vix_today / vix_5d_ago - 1) * 100
            vix20 = [vix_levels[k] for k in range(i - 19, i + 1)
                     if vix_levels[k] is not None and math.isfinite(vix_levels[k])]
            if len(vix20) >= 10:
                ma20 = mean(vix20)
                if ma20 and ma20 > 0:
                    vix_vs_ma20 = (vix_today / ma20 - 1) * 100

        rows.append({
            'idx': i,
            'date': dates[i],
            'level': spx_levels[i],
            'features': [
                spx_ret5d, spx_ret20d, eq_ret5d, spread5d,
                drawdown60d, vol20d if vol20d is not None else float('nan'),
                vix_level if vix_level is not None else float('nan'),
                vix_5d_delta if vix_5d_delta is not None else float('nan'),
                vix_vs_ma20 if vix_vs_ma20 is not None else float('nan'),
            ],
        })

    return {
        'rows': rows,
        'dates': dates,
        'spxLevels': spx_levels,
        'vixLevels': vix_levels,
        'eqByDate': eq_by_date,
    }


# ─── Normalisation params + normalize ────────────────────────────────
def compute_norm_params(rows):
    if not rows:
        return {'mu': [], 'sigma': []}
    D = len(rows[0]['features'])
    mu, sigma = [0.0] * D, [1.0] * D
    for d in range(D):
        col = [r['features'][d] for r in rows if math.isfinite(r['features'][d])]
        if not col:
            continue
        mu[d] = sum(col) / len(col)
        s = math.sqrt(sum((v - mu[d]) ** 2 for v in col) / len(col))
        sigma[d] = s if s > 0 and math.isfinite(s) else 1.0
    return {'mu': mu, 'sigma': sigma}


def normalize(vec, params):
    """Z-score normalize. Missing features stay as NaN so the distance
    function can SKIP them rather than treating them as the mean (zero
    after z-score). See README §audit-fix-3."""
    out = []
    for d, v in enumerate(vec):
        if not math.isfinite(v):
            out.append(float('nan'))
            continue
        out.append((v - params['mu'][d]) / params['sigma'][d])
    return out


def pair_distance(vec_a_norm, vec_b_norm):
    """Weighted Euclidean distance between two normalized vectors that
    may have NaN dimensions. Dims with FEATURE_WEIGHTS 0 are excluded
    (redundant features); dims missing in EITHER vector are skipped.
    The partial sum is scaled back to full-weight scale (sklearn
    nan_euclidean approach) so distances stay comparable across pairs
    with different completeness.

    Returns (distance, dims_used). distance is float('inf') when no
    shared active dim exists, so the candidate is never selected.
    """
    D = len(vec_a_norm)
    total_w = sum(FEATURE_WEIGHTS[k] if k < len(FEATURE_WEIGHTS) else 1
                  for k in range(D))
    d2_sum = 0.0
    used_w = 0.0
    dims_used = 0
    for k in range(D):
        w = FEATURE_WEIGHTS[k] if k < len(FEATURE_WEIGHTS) else 1
        if w == 0:
            continue
        a, b = vec_a_norm[k], vec_b_norm[k]
        if not (math.isfinite(a) and math.isfinite(b)):
            continue
        d2_sum += w * (a - b) ** 2
        used_w += w
        dims_used += 1
    if used_w == 0:
        return float('inf'), 0
    d2_scaled = d2_sum * (total_w / used_w)
    return math.sqrt(d2_scaled), dims_used


# ─── KNN with cluster dedup ──────────────────────────────────────────
def find_matches(rows, params, anchor_idx, today_vec):
    """anchor_idx = index in rows array of the 'today' row.
    Excludes rows within EXCLUDE_RECENT trading days of the anchor (not of
    the latest row — keeps snapshots reproducible later).

    Each accepted match carries `dimsUsed` (number of feature dimensions
    actually compared) so the dashboard can warn when a match is built
    on incomplete data.
    """
    today_norm = normalize(today_vec, params)
    anchor_row_idx = rows[anchor_idx]['idx']

    candidates = []
    for r in rows:
        if anchor_row_idx - r['idx'] <= EXCLUDE_RECENT:
            continue
        v = normalize(r['features'], params)
        dist, dims_used = pair_distance(today_norm, v)
        if not math.isfinite(dist):
            continue
        candidates.append({'row': r, 'distance': dist, 'dimsUsed': dims_used})
    candidates.sort(key=lambda c: c['distance'])

    accepted = []
    for c in candidates:
        if len(accepted) >= K:
            break
        too_close = any(abs(c['row']['idx'] - a['row']['idx']) <= CLUSTER_DEDUP
                        for a in accepted)
        if not too_close:
            accepted.append(c)
    return accepted


# ─── Forward outcomes + signals ──────────────────────────────────────
def compute_outcomes(matches, spx_levels):
    out = {}
    for W in (5, 10, 20):
        rets = []
        for m in matches:
            i0 = m['row']['idx']
            ti = i0 + W
            if ti >= len(spx_levels):
                continue
            r = (spx_levels[ti] / spx_levels[i0] - 1) * 100
            if math.isfinite(r):
                rets.append({'matchDate': m['row']['date'], 'r': r})
        if not rets:
            out[W] = {'samples': 0}
            continue
        sorted_r = sorted([x['r'] for x in rets])
        pos = sum(1 for x in rets if x['r'] > 0)
        out[W] = {
            'samples': len(rets),
            'median': percentile(sorted_r, 0.5),
            'q25': percentile(sorted_r, 0.25),
            'q75': percentile(sorted_r, 0.75),
            'min': sorted_r[0],
            'max': sorted_r[-1],
            'hitRate': pos / len(rets),
            'returns': rets,
        }
    return out


FEATURE_META = [
    {'key': 'spxRetEarly', 'label': 'תשואת SPX ב-5 ימים אחרי', 'unit': '%',
     'above': {'tipBull': 'המשיך לעלות', 'tipBear': 'נעצר/ירד'},
     'below': {'tipBull': 'תזוזה מתונה', 'tipBear': 'תנועה חזקה לא טובה'}},
    {'key': 'eqRetEarly', 'label': 'תשואת EQ500 ב-5 ימים אחרי', 'unit': '%',
     'above': {'tipBull': 'רוחב המשיך', 'tipBear': 'הרוחב נעצר'},
     'below': {'tipBull': 'רוחב מתון', 'tipBear': 'רוחב חזק לא תורם'}},
    {'key': 'spreadEarly', 'label': 'פער EQ500−SPX ב-5 ימים אחרי', 'unit': '%',
     'above': {'tipBull': 'הרוחב המשיך לבד', 'tipBear': 'הפער מתאזן'},
     'below': {'tipBull': 'המגה-קאפס תופסות הובלה — ראלי בוגר',
               'tipBear': 'רוחב יתום ללא תמיכת מגה-קאפס'}},
    {'key': 'earlyDrawdown', 'label': 'נפילה מקסימלית של SPX ב-5 ימים', 'unit': '%',
     'above': {'tipBull': 'דיפים רדודים', 'tipBear': 'דיפ חד — תיקון'},
     'below': {'tipBull': 'יציבות בלי נפילות', 'tipBear': 'דיפ עמוק יחסית'}},
    {'key': 'earlyHigh', 'label': 'שיא חדש של SPX ב-5 ימים', 'unit': '%',
     'above': {'tipBull': 'פריצת שיא נוסף', 'tipBear': 'לא שיא חדש'},
     'below': {'tipBull': 'בלי פריצות מטעות', 'tipBear': 'שיא חדש לא מחזיק'}},
    {'key': 'maxDailyMag', 'label': 'תנודתיות מקסימלית ביום בודד ב-5 ימים', 'unit': '%',
     'above': {'tipBull': 'יום חזק אחד — אנרגיה בשוק', 'tipBear': 'יום נפילה חד'},
     'below': {'tipBull': 'תנועה מתונה', 'tipBear': 'תנודתיות עלתה — אזהרה'}},
    {'key': 'vixEarlyPct', 'label': 'שינוי VIX ב-5 ימים אחרי', 'unit': '%',
     'above': {'tipBull': 'הפחד עלה — אנרגיה', 'tipBear': 'הפחד עלה — אזהרה אמיתית'},
     'below': {'tipBull': 'הפחד נחלש — אישור חיובי', 'tipBear': 'הפחד נשאר גבוה'}},
    {'key': 'vixEarlyMax', 'label': 'VIX מקסימלי ב-5 ימים אחרי', 'unit': '',
     'above': {'tipBull': 'VIX קפץ אבל ירד — אישור התאוששות',
               'tipBear': 'VIX קפץ ונשאר — אזהרה'},
     'below': {'tipBull': 'VIX יציב — אישור רוגע',
               'tipBear': 'VIX יציב אבל מחיר חלש'}},
]


def compute_early_warning(matches, spx_levels, eq_levels, vix_levels):
    enriched = []
    for m in matches:
        i0 = m['row']['idx']
        if i0 + OUTCOME_WINDOW >= len(spx_levels):
            continue
        spx_start = spx_levels[i0]
        eq_start = eq_levels[i0]
        if not (spx_start and spx_start > 0 and eq_start and eq_start > 0):
            continue
        outcome20d = (spx_levels[i0 + OUTCOME_WINDOW] / spx_start - 1) * 100
        label = ('bullish' if outcome20d >= BULL_T else
                 'bearish' if outcome20d <= BEAR_T else 'flat')

        end_idx = min(i0 + EARLY_DAYS, len(spx_levels) - 1)
        eq_end_idx = min(i0 + EARLY_DAYS, len(eq_levels) - 1)
        spx_end = spx_levels[end_idx]
        eq_end = eq_levels[eq_end_idx]
        spx_ret = (spx_end / spx_start - 1) * 100
        eq_ret = (eq_end / eq_start - 1) * 100
        spread = eq_ret - spx_ret

        low, high = spx_start, spx_start
        for k in range(1, EARLY_DAYS + 1):
            if i0 + k >= len(spx_levels):
                break
            low = min(low, spx_levels[i0 + k])
            high = max(high, spx_levels[i0 + k])
        early_dd = (low / spx_start - 1) * 100
        early_high = (high / spx_start - 1) * 100

        max_daily_mag = 0.0
        for k in range(1, EARLY_DAYS + 1):
            if i0 + k >= len(spx_levels):
                break
            prev = spx_levels[i0 + k - 1]
            if not (prev and prev > 0):
                continue
            d = (spx_levels[i0 + k] / prev - 1) * 100
            if abs(d) > max_daily_mag:
                max_daily_mag = abs(d)

        vix_early_pct = float('nan')
        vix_early_max = float('nan')
        if vix_levels:
            vix_start = vix_levels[i0]
            if vix_start is not None and math.isfinite(vix_start) and vix_start > 0:
                run_max = vix_start
                vix_end = vix_start
                for k in range(1, EARLY_DAYS + 1):
                    if i0 + k >= len(vix_levels):
                        break
                    v = vix_levels[i0 + k]
                    if v is None or not math.isfinite(v):
                        continue
                    run_max = max(run_max, v)
                    vix_end = v
                vix_early_pct = (vix_end / vix_start - 1) * 100
                vix_early_max = run_max

        enriched.append({
            'date': m['row']['date'],
            'outcome20d': outcome20d,
            'outcomeLabel': label,
            'features': {
                'spxRetEarly': spx_ret, 'eqRetEarly': eq_ret,
                'spreadEarly': spread, 'earlyDrawdown': early_dd,
                'earlyHigh': early_high, 'maxDailyMag': max_daily_mag,
                'vixEarlyPct': vix_early_pct, 'vixEarlyMax': vix_early_max,
            },
        })

    bull = [e for e in enriched if e['outcomeLabel'] == 'bullish']
    not_bull = [e for e in enriched if e['outcomeLabel'] != 'bullish']

    signals = []
    for meta in FEATURE_META:
        bull_v = [e['features'][meta['key']] for e in bull
                  if math.isfinite(e['features'][meta['key']])]
        other_v = [e['features'][meta['key']] for e in not_bull
                   if math.isfinite(e['features'][meta['key']])]
        if len(bull_v) < 2 or len(other_v) < 2:
            continue
        bull_mu = mean(bull_v)
        other_mu = mean(other_v)
        bull_sd = std(bull_v, bull_mu)
        other_sd = std(other_v, other_mu)
        pooled = math.sqrt((bull_sd ** 2 + other_sd ** 2) / 2)
        cohens_d = (bull_mu - other_mu) / pooled if pooled > 0 else None
        threshold = (bull_mu + other_mu) / 2
        interpret = 'bull_above' if bull_mu >= other_mu else 'bull_below'
        tips = meta['above'] if interpret == 'bull_above' else meta['below']
        abs_d = abs(cohens_d) if cohens_d is not None else 0
        # Reliability guard — see SIGNAL_MIN_* constants. Unreliable
        # signals are still stored (UI shows them as hints) but never
        # drive ✓/✗ verdicts in the forward-tracking chips.
        reliable = (abs_d >= SIGNAL_MIN_ABS_D
                    and len(bull_v) >= SIGNAL_MIN_BULL_N
                    and len(other_v) >= SIGNAL_MIN_OTHER_N)
        signals.append({
            'feature': meta['key'],
            'label': meta['label'],
            'interpret': interpret,
            'tipBull': tips['tipBull'],
            'tipBear': tips['tipBear'],
            'bullMean': bull_mu,
            'bearMean': other_mu,
            'bullN': len(bull_v),
            'bearN': len(other_v),
            'cohensD': cohens_d,
            'absD': abs_d,
            'threshold': threshold,
            'reliable': reliable,
        })
    signals.sort(key=lambda s: s['absD'], reverse=True)
    return {
        'counts': {'bullish': len(bull), 'notBullish': len(not_bull),
                   'total': len(enriched)},
        'signals': signals,
        'earlyDays': EARLY_DAYS,
        'outcomeWindow': OUTCOME_WINDOW,
    }


# ─── Build snapshot for one anchor date ──────────────────────────────
def build_snapshot(fm, anchor_idx_in_rows):
    rows = fm['rows']
    params = compute_norm_params(rows)
    anchor_row = rows[anchor_idx_in_rows]
    matches = find_matches(rows, params, anchor_idx_in_rows, anchor_row['features'])
    outcomes = compute_outcomes(matches, fm['spxLevels'])

    # Rebuild EQ level series for the early-warning analysis
    eq_levels = [None] * len(fm['dates'])
    el = 100.0
    for i, d in enumerate(fm['dates']):
        e = fm['eqByDate'].get(d)
        if e is not None and math.isfinite(e):
            el *= (1 + e / 100)
        eq_levels[i] = el

    ew = compute_early_warning(matches, fm['spxLevels'], eq_levels, fm['vixLevels'])

    anchor_global_idx = anchor_row['idx']
    return {
        'anchorDate': anchor_row['date'],
        'createdAt': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'anchor': {
            'vixLevel': fm['vixLevels'][anchor_global_idx],
            'spxLevel': fm['spxLevels'][anchor_global_idx],
            # No EQ level stored — dashboard rebuilds it from daily CSVs
            # using each day's avgChange, the same way historical.js does.
        },
        'asOfFeatures': anchor_row['features'],
        'matches': [
            {'date': m['row']['date'], 'distance': m['distance'],
             'dimsUsed': m.get('dimsUsed', len(m['row']['features'])),
             'features': m['row']['features']}
            for m in matches
        ],
        'outcomes': {
            str(W): {k: v for k, v in outcomes[W].items() if k != 'returns'}
            for W in outcomes
        },
        'signals': ew['signals'],
        'counts': ew['counts'],
        'earlyDays': EARLY_DAYS,
        'outcomeWindow': OUTCOME_WINDOW,
    }


# ─── Snapshots file I/O ──────────────────────────────────────────────
def load_snapshots():
    if not os.path.exists(SNAP_FILE):
        return {'version': '1.0', 'snapshots': []}
    with open(SNAP_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_snapshots(data):
    with open(SNAP_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ─── Main ────────────────────────────────────────────────────────────
def main():
    print('Building spliced series...', flush=True)
    spliced = build_spliced_series()
    print(f'  SPX: {len(spliced["spx"])} rows, '
          f'EQ: {len(spliced["eq"])} rows, '
          f'VIX: {len(spliced["vix"])} rows', flush=True)

    print('Building feature matrix...', flush=True)
    fm = build_feature_matrix(spliced['spx'], spliced['eq'], spliced['vix'])
    print(f'  {len(fm["rows"])} feature rows '
          f'(first: {fm["rows"][0]["date"]}, last: {fm["rows"][-1]["date"]})',
          flush=True)

    snaps = load_snapshots()
    existing_dates = {s['anchorDate'] for s in snaps['snapshots']}

    # Snapshot ONLY the latest trading day. The system tracks forward
    # from each anchor — there's no value in backfilling past dates we
    # never tracked in real time (their "live" observations would just
    # be the same retrospective compounding the JS already does, with
    # no audit-trail value). Run this script once per trading day; it's
    # idempotent — if today's date is already snapshotted, nothing is
    # written.
    latest_idx = len(fm['rows']) - 1
    if latest_idx < 0:
        print('No feature rows available.', flush=True)
        return
    d = fm['rows'][latest_idx]['date']
    if d in existing_dates:
        print(f'Snapshot for {d} already exists — nothing to do.', flush=True)
        return

    snap = build_snapshot(fm, latest_idx)
    snaps['snapshots'].append(snap)
    snaps['snapshots'].sort(key=lambda s: s['anchorDate'])
    save_snapshots(snaps)
    print(f'  + snapshot for {d} '
          f'(matches: {len(snap["matches"])}, signals: {len(snap["signals"])})',
          flush=True)
    print(f'Wrote {SNAP_FILE} ({len(snaps["snapshots"])} total snapshots).',
          flush=True)


if __name__ == '__main__':
    main()
