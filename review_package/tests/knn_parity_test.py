"""
knn_parity_test.py — JS ↔ Python KNN engine parity check.

The dashboard's live KNN (v2/patterns.js, runs in the browser) and the
snapshot generator (scripts/update_forward_snapshots.py, runs in CI)
implement the same algorithm independently. This test feeds BOTH the
exact same spliced series and asserts they find the same matches at the
same distances.

What it catches: drift in feature definitions, normalization, feature
weights, cluster dedup, K, or exclusion windows — changed in one engine
but not the other.

Run:
    python3 tests/knn_parity_test.py

Requires node on PATH (used to execute the browser engine). Exits 0 on
parity, 1 on mismatch, and 0-with-warning when node is unavailable.
"""
import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DATE_TOLERANCE_NOTE = (
    "Match dates must be identical; distances must agree to 1e-6 "
    "(both engines use float64 with the same operations)."
)
DIST_TOL = 1e-6


def load_python_engine():
    spec = importlib.util.spec_from_file_location(
        'ufs', os.path.join(ROOT, 'scripts', 'update_forward_snapshots.py'))
    ufs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ufs)
    return ufs


def main():
    os.chdir(ROOT)
    ufs = load_python_engine()

    # ── Python side ──
    series = ufs.build_spliced_series()
    fm = ufs.build_feature_matrix(series['spx'], series['eq'], series['vix'])
    rows = fm['rows']
    if not rows:
        print('SKIP — not enough history to build features')
        return
    params = ufs.compute_norm_params(rows)
    anchor_idx = len(rows) - 1
    py_matches = ufs.find_matches(rows, params, anchor_idx, rows[anchor_idx]['features'])
    py_result = [{'date': m['row']['date'], 'distance': m['distance']} for m in py_matches]
    anchor_date = rows[anchor_idx]['date']
    print(f'Anchor: {anchor_date} · Python found {len(py_result)} matches')

    # ── JS side (same series, browser engine via node) ──
    with tempfile.NamedTemporaryFile(
            mode='w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(series, f)
        series_path = f.name
    try:
        try:
            proc = subprocess.run(
                ['node', os.path.join(ROOT, 'tests', 'knn_parity_runner.mjs'), series_path],
                capture_output=True, text=True, timeout=120)
        except FileNotFoundError:
            print('WARN — node not found on PATH; JS side skipped. '
                  'Run where node is available for the full parity check.')
            return
        if proc.returncode != 0:
            print('JS runner failed:')
            print(proc.stderr)
            sys.exit(1)
        js_out = json.loads(proc.stdout)
    finally:
        os.unlink(series_path)

    js_result = js_out['matches']
    print(f'JS engine found {len(js_result)} matches (asOf {js_out["asOfDate"]})')
    print()

    # ── Compare ──
    failed = False
    if js_out['asOfDate'] != anchor_date:
        print(f'FAIL — anchor mismatch: py={anchor_date} js={js_out["asOfDate"]}')
        failed = True
    if len(js_result) != len(py_result):
        print(f'FAIL — match count: py={len(py_result)} js={len(js_result)}')
        failed = True

    n = min(len(py_result), len(js_result))
    print(f'{"#":>3} {"py date":12} {"js date":12} {"py dist":>10} {"js dist":>10}  status')
    print('-' * 60)
    for i in range(n):
        p, j = py_result[i], js_result[i]
        date_ok = p['date'] == j['date']
        dist_ok = math.isfinite(p['distance']) and math.isfinite(j['distance']) \
            and abs(p['distance'] - j['distance']) <= DIST_TOL
        ok = date_ok and dist_ok
        if not ok:
            failed = True
        print(f'{i+1:>3} {p["date"]:12} {j["date"]:12} '
              f'{p["distance"]:>10.6f} {j["distance"]:>10.6f}  {"OK" if ok else "FAIL"}')

    print()
    if failed:
        print('KNN PARITY FAILED — the two engines disagree. ' + DATE_TOLERANCE_NOTE)
        sys.exit(1)
    print('KNN PARITY OK — both engines produce identical matches.')


if __name__ == '__main__':
    main()
