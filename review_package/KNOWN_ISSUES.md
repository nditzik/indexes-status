# Known Issues, Caveats & Temporary Code

Honest notes for the reviewer — known quirks, workarounds, and things not yet
finished. Ordered roughly by impact.

---

## Data-source fragility (highest-impact area)

### 1. Manual daily CSV upload with a strict filename contract
The two core inputs (`watchlist-…csv`, `spx-options-flow-…csv`) are **exported
by hand** from Barchart / an options-flow provider once per trading day. The
whole pipeline keys off exact filenames:
`watchlist-sp-500-intraday-MM-DD-YYYY.csv` and `spx-options-flow-MM-DD-YYYY.csv`.
- If an export lands under a different naming scheme (e.g. `watchlist-sandp-500-…`
  or ISO-dated `SPX-options-flow-YYYY-MM-DD.csv`), the file is **silently
  skipped** — no error, the day just vanishes from history until renamed.
- There is **no auto-normalization** step. A rename-on-ingest hook in
  `update-data.yml` would harden this; deliberately not added yet.

### 2. Barchart leaves the cash-index `%Change` blank intermittently
`$SPX` and `$TNX` rows sometimes arrive with `%Change = 0.00%` even though the
price moved — the export was taken before the official cash-index settle (ETFs
settle immediately, cash indices lag). **Worked around** by deriving the daily
change from price-vs-previous-close whenever the field is null/~0 (identical
logic in `overview-prod.js`, `send_report.py`, and `parity_test.py`). Robust,
but it's a compensating hack for an upstream data defect — verified-good days
are left untouched.

### 3. Yahoo returns sparse daily bars for cash indices
`^TNX` / `^VIX` often return a single non-null close in the 2-day window, and it
can BE today's bar → naive "previous close" logic produced `prev == price` →
0.00%. **Worked around** in `fetch_ticker.py` (drop a trailing bar equal to the
live price; fall back to `chartPreviousClose`). Dense series (SPY/QQQ) were
never affected.

---

## Architectural debt

### 4. Every formula is implemented twice (JS + Python)
Scoring, KNN, risk-off, and narrative logic exist in both `v2/*.js` (browser)
and `workflows/send_report.py` + `scripts/*.py` (email/CI). This is intentional
(the dashboard is client-only; the email runs headless), but it doubles the
surface area and invites drift. Mitigated — not eliminated — by
`tests/parity_test.py` and `tests/knn_parity_test.py`. **Any formula change must
touch both sides or the parity test fails.**

### 5. `overview-prod.js` is a ~5,200-line monolith
The main module holds data loading, parsing, all scoring, the ticker, the
risk-off banner, and ~10 card renderers in one file. It works and is internally
organized by section comments, but it's a candidate for splitting (parsing /
scoring / rendering).

### 6. KNN snapshots are never back-filled
`update_forward_snapshots.py` locks in **only the latest trading day** each run
(by design — a retroactively-computed "live" snapshot has no audit value). But
it means any day the pipeline missed (late file, wrong filename) has **no
snapshot forever** — the KNN/trend tab simply has a gap for those dates. The
underlying watchlist history is still loaded; only the pattern-tracking row is
absent.

---

## Dead / legacy code still in the repo

### 7. Superseded files
- `index.html` — the older full-panel (single-scroll) dashboard. **Still
  maintained and linked** as "old version", so not strictly dead, but the active
  product is `index-v3.html`.
- Not included in this package but present in the repo and unused by v3:
  `v2/overview.js`, `v2/overview.html`, `v2/styles.css`, `market-dashboard.html`,
  `data/quotes.json`. These are earlier iterations — safe to delete, kept only
  out of caution.

---

## Reliability / UX caveats

### 8. Live-quote proxy fallback is best-effort
Primary live-price path is the server-fetched `live_ticker.json` (reliable). The
browser also has a **proxy-chain fallback** (`r.jina.ai`, `allorigins.win`) for
when that file is stale — but public CORS proxies rate-limit unpredictably, so
this path is unreliable by nature. It exists as a safety net, not a guarantee.

### 9. Chart.js is a hard CDN dependency
Charts load Chart.js 4.4.0 from jsDelivr with an SRI hash. If the CDN or the
integrity check fails, charts won't render (the rest of the dashboard still
works). No bundled local copy.

### 10. Cache-busting is manual
Local JS/CSS are versioned with `?v=YYYYMMDDx` query strings that must be
**bumped by hand** on every change (GitHub Pages + browser caching served stale
code otherwise). Easy to forget; a build step would automate it.

### 11. No visual/DOM regression tests
Tests cover scoring **parity** only. The ~10 card renderers, the tab switching,
and RTL layout are unverified by automation — regressions there surface only by
eye.

---

## Minor notes

- **`data/email_subscribers.json`** contains the real recipient list and is
  committed to the repo (overridable via the `EMAIL_SUBSCRIBERS` secret). Only
  `email_subscribers.example.json` is included in this package.
- **All UI copy is inline Hebrew** (RTL) — no i18n layer; strings are hardcoded
  throughout the JS and Python.
- **Timestamps / "today"** depend on the manual export's capture time. An export
  taken pre-close labels an in-progress day as "today" with partial data (the
  price-derived %change fix, #2, mitigates the most visible symptom).
