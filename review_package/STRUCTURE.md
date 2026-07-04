# Project Structure — S&P 500 Daily Market Dashboard

A static, client-side Hebrew (RTL) market dashboard for the S&P 500, plus a
daily email report. Hosted on **GitHub Pages**; data refreshed by **GitHub
Actions** cron jobs. No backend server, no database — the browser reads
static CSV/JSON files same-origin, and all scoring logic runs in the browser.
A parallel Python implementation generates the daily email and must stay in
**formula-parity** with the JS (enforced by tests).

---

## 1. File Tree & Role of Each File

```
review_package/
│
├── index-v3.html          ★ PRIMARY dashboard — 5-tab layout (main / tech /
│                            options / sectors+stocks / KNN trend). Loads the
│                            v2/*.js modules and both CSS files. This is the
│                            file under active development.
├── index.html               LEGACY full-panel dashboard (single long scroll).
│                            Still maintained + linked as "old version"; shares
│                            all logic via the same v2/*.js modules. Included
│                            for completeness — review index-v3.html first.
│
├── v2/                     ── Dashboard logic (vanilla JS, no framework) ──
│   ├── overview-prod.js    ★ MAIN module (~5,200 lines). Data loading, CSV
│   │                         parsing, all scoring (Tech/Breadth/Flow/Combined),
│   │                         the live ticker, risk-off banner, and every v3
│   │                         card renderer. Entry point: init().
│   ├── regime.js             Market-regime / phase classifier (uptrend,
│   │                         pressure, correction, …) + confidence.
│   ├── narrative.js          Headline + rationale generator (buildHeadline);
│   │                         mirrored by build_headline() in send_report.py.
│   ├── patterns.js           KNN engine — 9 z-scored features, nan-euclidean
│   │                         distance, K=10 nearest historical days. Mirrored
│   │                         by update_forward_snapshots.py.
│   ├── forward-tracking.js   "Matured patterns" table — tracks each KNN
│   │                         snapshot forward (5-day interim + Day-20 verdict).
│   ├── historical.js         Long-history SPX/EQ500 series helpers (macro trail).
│   ├── overview-prod.css     Main stylesheet (~110 KB; shared by both HTMLs).
│   └── overview-v3.css       v3-only styles (tabs, status card, quick strip).
│
├── scripts/                ── Data-pipeline (Python 3, stdlib only) ──
│   ├── fetch_ticker.py       Pulls live index/macro quotes from Yahoo Finance
│   │                         → data/live_ticker.json. Run by update-ticker.yml.
│   └── update_forward_snapshots.py
│                             Python mirror of the KNN engine. Locks in one
│                             snapshot per trading day → forward_snapshots.json.
│
├── workflows/              ── GitHub Actions (CI/automation) ──
│   ├── send_report.py       ★ Daily email generator (~2,100 lines). Full Python
│   │                         re-implementation of the dashboard's scoring, KNN,
│   │                         risk-off, and narrative — kept in parity with JS.
│   ├── update-data.yml       On push of a watchlist CSV: rebuild data.txt +
│   │                         index.json, regenerate snapshots, send the email.
│   ├── update-ticker.yml     Cron */5 during US hours: run fetch_ticker.py.
│   └── send-test-email.yml   Manual trigger for a test email.
│
├── tests/                  ── Parity / regression tests ──
│   ├── parity_test.py        Asserts JS-port scores == email scores (±1) for
│   │                         Tech/Breadth/Flow/Combined. Run before every push.
│   ├── knn_parity_test.py    Asserts the JS and Python KNN engines return the
│   │                         identical nearest-neighbour set.
│   └── knn_parity_runner.mjs  Node harness that evals patterns.js for the above.
│
├── config/                 ── Small static / example config ──
│   ├── sectors.json          Ticker→sector map + sector-code→Hebrew name.
│   ├── index.json            Ordered list of watchlist files (history source).
│   └── email_subscribers.example.json   Template for the recipient list.
│
├── docs/
│   ├── README.md             Original project readme.
│   └── AUDIT-FIXES.md         Log of a prior reliability-audit pass.
│
├── STRUCTURE.md            (this file)
├── data_samples.md         Headers + sample rows of every input file.
└── KNOWN_ISSUES.md         Known quirks, temporary code, and caveats.
```

`★` = start here.

---

## 2. Data Files — What the Dashboard Consumes

All data lives in `data/` in the real repo (excluded from this package except
small config + samples). The browser fetches everything **same-origin** — no
API keys in the client.

| File | Produced by | Refresh cadence | Consumed by |
|---|---|---|---|
| `watchlist-sp-500-intraday-MM-DD-YYYY.csv` | **Manual** export from Barchart.com | Once per trading day (user uploads) | Dashboard history + all breadth/tech scores |
| `spx-options-flow-MM-DD-YYYY.csv` | **Manual** export from an options-flow provider | Once per trading day (user uploads) | Flow Score, options tab |
| `data.txt` | `update-data.yml` (copy of latest watchlist) | On each watchlist push | Dashboard "today" |
| `index.json` | `update-data.yml` (ISO-sorted file list) | On each watchlist push | Dashboard history loader |
| `live_ticker.json` | `scripts/fetch_ticker.py` (Yahoo Finance) | **Every 5 min**, US market hours | Live ticker strip + risk-off live reconciliation |
| `forward_snapshots.json` | `scripts/update_forward_snapshots.py` | Once per trading day | KNN / trend tab, matured-patterns table |
| `sectors.json` | Static (hand-maintained) | Rarely | Sector heatmap labels |

**Data-flow summary**

```
 Barchart export ─┐
                  ├─► data/*.csv ──(push)──► update-data.yml ──► data.txt + index.json
 Flow export ─────┘                              │                    │
                                                 ├──► update_forward_snapshots.py ─► forward_snapshots.json
                                                 └──► send_report.py ─► daily email (Brevo API)

 Yahoo Finance ──(cron */5)──► fetch_ticker.py ──► live_ticker.json

 Browser (index-v3.html) ──fetch()──► data.txt, index.json, *.csv, *.json  (all same-origin, static)
```

---

## 3. Dependencies / Requirements

**Frontend (browser):** zero build step, zero npm install.
- **Chart.js 4.4.0** — the *only* third-party JS, loaded from CDN with an SRI
  integrity hash (`jsdelivr`). Everything else is vanilla ES6.
- Google Fonts (Inter, JetBrains Mono) via CDN — cosmetic only.

**Backend / pipeline (Python):** **standard library only — no `requirements.txt`
needed.** Verified imports across all scripts: `csv, json, math, os, re, sys,
datetime, glob, io, hashlib, urllib`. Runs on any Python ≥ 3.8.

**Tests:** Python stdlib + **Node.js** (for `knn_parity_runner.mjs`, which
evals `patterns.js`).

**External services (server-side only, keys in GitHub Secrets):**
- Yahoo Finance v8 chart API (no key) — live quotes.
- Brevo (Sendinblue) transactional email API — `BREVO_API_KEY`.

---

## 4. How to Run

### View the dashboard locally
It's fully static — serve the folder over HTTP (needed for `fetch()` same-origin):
```bash
# from the repo root (where index-v3.html + data/ live)
python3 -m http.server 8000
# then open http://localhost:8000/index-v3.html
```
> Opening the file with `file://` will **not** work — the browser blocks
> same-origin `fetch()` of the CSV/JSON. Any static server is fine.

### Regenerate derived data (normally done by CI)
```bash
python3 scripts/fetch_ticker.py             # → data/live_ticker.json
python3 scripts/update_forward_snapshots.py # → data/forward_snapshots.json
```

### Generate the email locally (dry run, no send)
```bash
TEST_RECIPIENTS=you@example.com BREVO_API_KEY= python3 workflows/send_report.py
```

### Run the parity tests (must pass before any formula change ships)
```bash
python3 tests/parity_test.py        # Tech/Breadth/Flow/Combined: JS-port == email
python3 tests/knn_parity_test.py    # JS KNN == Python KNN (needs Node.js)
```

---

## 5. Architecture Notes for the Reviewer

- **Dual implementation by design.** Every scoring formula exists twice — once
  in JS (`v2/*.js`, runs in the browser) and once in Python
  (`workflows/send_report.py` + `scripts/*.py`, runs in CI for the email). The
  two **must** produce identical numbers; `tests/parity_test.py` and
  `tests/knn_parity_test.py` enforce this. When reviewing a formula, check both
  sides.
- **No secrets in the client.** The browser only reads static files. All API
  keys live in GitHub Actions secrets.
- **Cache-busting.** Local JS/CSS are referenced with `?v=YYYYMMDDx` query
  strings that are bumped on each change (GitHub Pages + browser caching were
  serving stale code otherwise).
- **Scoring model (quick reference):**
  `Combined = 0.40·Tech + 0.35·Flow + 0.25·Breadth` (re-normalized if a
  component is missing). Flow uses *directional* option premium (Ask+Bid, Mid
  excluded). KNN uses 9 z-scored features, K=10, nan-euclidean distance.
