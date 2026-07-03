"""
normalize_incoming.py — rename manually-exported CSVs to the canonical
names the pipeline expects, so a "nearly-right" filename never silently
vanishes from the dashboard.

Canonical targets:
    watchlist-sp-500-intraday-MM-DD-YYYY.csv
    spx-options-flow-MM-DD-YYYY.csv
    uoa-stocks-MM-DD-YYYY.csv

Runs first in update-data.yml (before any processing). Rules:
  • Only renames files matching a KNOWN pattern.
  • Never deletes; never overwrites an existing canonical target (skip+warn).
  • Idempotent — an already-canonical file is left untouched.
  • Rename via `git mv` (falls back to os.rename if the file isn't tracked).

Run standalone for a dry preview:
    python3 scripts/normalize_incoming.py --dry-run
"""
import os
import re
import sys
import glob
import subprocess
from datetime import date, datetime, timezone

DATA_DIR = 'data'

# A file already in exactly this shape is left alone.
CANON_RE = {
    'watchlist': re.compile(r'^watchlist-sp-500-intraday-\d{2}-\d{2}-\d{4}\.csv$'),
    'flow':      re.compile(r'^spx-options-flow-\d{2}-\d{2}-\d{4}\.csv$'),
    'uoa':       re.compile(r'^uoa-stocks-\d{2}-\d{2}-\d{4}\.csv$'),
}
CANON_FMT = {
    'watchlist': 'watchlist-sp-500-intraday-{mm}-{dd}-{yyyy}.csv',
    'flow':      'spx-options-flow-{mm}-{dd}-{yyyy}.csv',
    'uoa':       'uoa-stocks-{mm}-{dd}-{yyyy}.csv',
}


def classify(name):
    """Return 'uoa' | 'watchlist' | 'flow' | None for a filename.
    Order matters: UOA carries a specific keyword and is checked first so
    an 'unusual options' export is never mistaken for the SPX flow file.
    Separators are collapsed so 'Watch List S&P 500' matches 'watchlist'."""
    c = re.sub(r'[^a-z0-9]', '', name.lower())   # 'Watch List S&P 500' → 'watchlistsp500'
    if 'unusual' in c or 'uoa' in c:
        return 'uoa'
    if 'watchlist' in c and '500' in c and ('sp' in c or 'sandp' in c):
        return 'watchlist'
    if 'spx' in c and 'option' in c and 'flow' in c:
        return 'flow'
    return None


def extract_date(name, fallback):
    """(mm, dd, yyyy) strings from the filename, or from `fallback` (a
    date) when the name carries no date. Handles ISO (YYYY-MM-DD) and US
    (MM-DD-YYYY) with -, _ or space separators."""
    m = re.search(r'(20\d{2})[-_ ](\d{1,2})[-_ ](\d{1,2})', name)   # ISO
    if m:
        yyyy, mm, dd = m.group(1), m.group(2), m.group(3)
        return f'{int(mm):02d}', f'{int(dd):02d}', yyyy
    m = re.search(r'(\d{1,2})[-_ ](\d{1,2})[-_ ](20\d{2})', name)   # US
    if m:
        mm, dd, yyyy = m.group(1), m.group(2), m.group(3)
        return f'{int(mm):02d}', f'{int(dd):02d}', yyyy
    return f'{fallback.month:02d}', f'{fallback.day:02d}', f'{fallback.year:04d}'


def canonical_name(name, fallback):
    """Pure: filename → canonical filename, or None if it isn't a known
    type OR it's already canonical."""
    kind = classify(name)
    if kind is None:
        return None
    if CANON_RE[kind].match(name):
        return None
    mm, dd, yyyy = extract_date(name, fallback)
    return CANON_FMT[kind].format(mm=mm, dd=dd, yyyy=yyyy)


def _git_mv(src, dst):
    try:
        subprocess.run(['git', 'mv', src, dst], check=True,
                       capture_output=True, text=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        # Not tracked yet, or git unavailable — plain rename; a later
        # `git add -A data/` in the workflow will stage it.
        os.rename(src, dst)
        return True


def main(dry_run=False):
    renamed, skipped = [], []
    for path in sorted(glob.glob(os.path.join(DATA_DIR, '*.csv'))):
        name = os.path.basename(path)
        try:
            mtime = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).date()
        except OSError:
            mtime = datetime.now(timezone.utc).date()
        target = canonical_name(name, mtime)
        if not target or target == name:
            continue
        dst = os.path.join(DATA_DIR, target)
        if os.path.exists(dst):
            skipped.append(f'{name} → {target} (target already exists — SKIP)')
            continue
        if dry_run:
            renamed.append(f'{name} → {target} (dry-run)')
            continue
        _git_mv(path, dst)
        renamed.append(f'{name} → {target}')

    for r in renamed:
        print(f'  renamed: {r}')
    for s in skipped:
        print(f'  ⚠ skipped: {s}', file=sys.stderr)
    if not renamed and not skipped:
        print('  (no non-canonical files found — nothing to normalize)')
    return 0


if __name__ == '__main__':
    sys.exit(main(dry_run='--dry-run' in sys.argv))
