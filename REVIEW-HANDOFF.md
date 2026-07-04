# Review Handoff — S&P 500 Dashboard Upgrade

**Implements the SPEC from the 2026-07-03 code review.** This document maps every
review finding and SPEC phase to what shipped, the files that changed, and how to
verify it. All work is on `main` and deployed to GitHub Pages.

**Active product:** `index-v3.html` (5-tab dashboard). Legacy `index.html` is
frozen. Daily email: `.github/workflows/send_report.py`.

---

## 1. Review findings → status (the checklist)

| # | Finding (from the review) | Fix shipped | Phase | Key commits |
|---|---|---|---|---|
| 1 | Too many competing "bottom line" engines | Single **verdict pipeline** (`v2/verdict.js`) on the main screen; all others moved to drill-down tabs | 1.2 | `64dea6c`, `149ee53` |
| 2 | Fixed Flow weight on low-quality data | **Dynamic Flow weight** by directional share + **contradiction penalty**; **v4** Flow Ask-aggression denominators exclude Mid (align Python↔JS; fixed 54→40 on high-Mid 07-02) | 3.1, 3.3 | `c009879`, `b6f5f7f` |
| 3 | No score history / no forward tracking | Append-only **`scores_history.json`** + **`score_forward.json`** + distribution table | 2.4, 3.4 | `ecb1ec6`, `a050c82` |
| 4 | Fragile filenames (silent data loss) | **Filename normalization** on ingest + **missing-day email alert** | 2.1, 2.2 | `10d7a79`, `f9bfa86` |
| 5 | Monolith + dual JS/Python implementation | **Single source of truth** — Python emits `daily_state.json`, browser renders it | 3.0 | `2c543b2`, `de8e803`, `8ded118`, `9a0bcf2` |
| 6 | Missing VIX3M & Rotation signal | **VIX3M + term-structure** in the volatility light; **Rotation light** — now TRUE sectoral relative-strength vs $SPX (review fix 2; the EQ‑vs‑SPX spread it replaced was a second breadth measure, moved to the Breadth card) | 2.3, 3.2 | `8032696`, `00820b5` |
| 7 | Operational reliability (cache-bust) | Manual `?v=` cache-busting on every JS/CSS change (Chart.js local copy deferred) | 1/4 | (throughout) |
| 8 | Dead / legacy code | **Froze** `index.html`; **deleted** dead files + `prototypes/`, `handoff/` | 1.1 | `e61d255` |
| + | **New data: UOA (single-stock unusual options)** | Ingest → `uoa_daily.json` + per-stock **Action Zone badge** | 2.5, 3.5 | `7f663ae` |

> Finding 7 (Chart.js served from CDN, not bundled) is the only item intentionally
> **deferred** — noted below in §5.

---

## 2. Phase-by-phase detail

### Phase 1 — cleanup + single verdict + CI gate
- **1.1** `index.html` frozen (banner comment); removed `v2/overview.js`,
  `v2/overview.html`, `v2/styles.css`, `market-dashboard.html`, `prototypes/`,
  `handoff/`. **Kept** `data/quotes.json` (the SPEC listed it for deletion, but
  it is used by the email's daily quote — flagged and preserved).
- **1.2** ⭐ New `v2/verdict.js` → `buildVerdict(metrics, phaseResult)` returns one
  `{headline, subline, tone, actions[], lights{trend,breadth,volatility,rotation}}`.
  The main tab shows only this; `renderV3Recommendations` refactored into the pure
  `computeRecommendations`. Email verdict banner mirrors it (`build_verdict_state`).
- **1.3** `update-data.yml` runs `tests/parity_test.py` **before** sending the email
  (a formula drift now blocks the email instead of shipping a wrong report).

### Phase 2 — data-pipeline hardening
- **2.1** `scripts/normalize_incoming.py` renames a "nearly-right" export
  (watchlist / spx-options-flow / uoa-stocks) to the canonical name before
  processing; trigger broadened to `data/*.csv`; never deletes/overwrites.
- **2.2** `scripts/check_data_freshness.py` + `data-freshness-alert.yml` (cron
  Tue–Sat 03:30 UTC): if the newest watchlist lags the last trading day
  (weekends + US holidays excluded) it emails **the owner only**.
- **2.3** `fetch_ticker.py` adds `^VIX3M`; writes `vixTermRatio = VIX/VIX3M` to
  `live_ticker.json`.
- **2.4** `send_report.py` appends one row/day to **append-only**
  `data/scores_history.json` (guarded to real CI runs; idempotent; formula change
  bumps `FORMULA_VERSION`, never rewrites past rows).
- **2.5** UOA — see §3.

### Phase 3 — model calibration + single source of truth
- **3.0** ⭐ **Architecture change.** Chosen Option A. Three reversible stages:
  1. `send_report.py` made importable (side effects under `main()`);
     `scripts/build_daily_state.py` emits **`data/daily_state.json`** (scores,
     phase, risk-off, verdict, narrative).
  2. Browser (`overview-prod.js` `init`) overlays scores + verdict from
     `daily_state.json` (date-guarded, with full live JS fallback).
  3. JS scoring labeled **fallback**; `parity_test` JS-port is now informational,
     the **emitter check** is the gate.
  - **Net effect:** a formula change now lives in Python only and reaches the
    dashboard via `daily_state.json` with **no JS edit**.
- **3.1** Dynamic Flow weight: `wFlow = 0.35 × directionalShare`; freed weight
  re-normalizes to Tech + Breadth. Shown in the flow card.
- **3.1a Options-tab de-duplication.** The tab showed the SAME directional Flow
  score twice — the top card (official, feeds Combined) and the bottom "לאן הכסף
  הגדול נע" panel both rendered `scoreFromMetrics(today)`. Now **one number**: the
  bottom panel shows a **daily DIRECTION label** (`≥55 התקפי / 45-54 מאוזן / <45
  הגנתי`) + a reason (directional P/C premium) + **one daily-vs-monthly sentence**
  (today's read vs the 22-session smoothed average; "עקבי" or "יותר הגנתי/התקפי —
  יום N ברצף", streak counted in Python). New Python helpers
  `build_flow_direction` / `build_flow_compare` / `_flow_score_from_file` (scores
  historical flow CSVs on the identical formula); shipped via
  `daily_state.flow.{directionLabel, directionReason, smoothed, streak,
  compareLine, midPct}`. **Canonical Mid%:** one premium-based field
  (`daily_state.flow.midPct`) rendered everywhere (was 68% card vs 69% line).
  No `FORMULA_VERSION` bump — the scoring is unchanged; this is display only.
- **3.2** **Rotation light** + **VIX term structure** folded into the volatility
  light. `send_report` reads `live_ticker.json` for the ratio.
  - **Rotation v2 (review fix 2):** the light is now **true sectoral rotation** —
    per-sector relative strength vs `$SPX` on the 5- and 20-session windows
    (`compute_sector_rs`); a sector is **Leading** when RS > 0 on *both*. Green
    when ≥3 **cyclical** sectors (IT/FIN/CD/ENE/IND) lead, red when **defensives**
    (UTL/CS/HC) lead and cyclicals do not, yellow otherwise. The old
    EQ500‑minus‑SPX 20d spread was really a second *breadth* measure — it moved
    into the **Breadth** evidence card (`evidence.eqSpx20`). The **Action Zone**
    and **UOA confirmation** card now pick from the persistent Leading set
    (`daily_state.rotation.leadingSectors`) instead of "top-3 by today's move".
    All computed in Python → `daily_state.json` (`rotation.{leadingSectors,
    sectorRs, cyclicalLeading, defensiveLeading, series}`); JS only renders.
- **3.3** **Contradiction penalty:** Trend green + Breadth red (or vice-versa) →
  −10 on the combined score + "עלייה צרה — הציון נחתך" in the verdict.
- **3.4** `scripts/build_score_forward.py` → `data/score_forward.json` (actual 5d/20d
  SPX return per past score); KNN-tab table = 20d distribution by score band.

### Phase 4 — main screen: Verdict / Evidence / Action
- **4a** Regime score colored by tone; status **lights as circles**; fixed two
  latent bugs (undefined `c` blocking the score panel; lights invisible on white).
- **4a.1 Selling-pressure card redesign.** The old risk-off banner was an evidence
  pile (raw date list, mixed timeframes, generic advice). Now **exactly three
  fixed lines**, all built in Python (`build_pressure_state_line` /
  `_evidence_line` / `build_pressure_action` — a priority state-matrix, each
  action carries its own **exit condition**) and shipped via
  `daily_state.riskOff.{stateLine, evidenceLine, actionLine, tone, sellDaysMap}`.
  Line 2 adds a **25-dot bar** (LTR-in-RTL, gray/red, drop% in the dot tooltip);
  the full date list lives only there. Removed: the date text list, the live
  "23:00" strip (belongs to the top ticker), the grey footer, the green-close
  bullet. Acute day → the whole card goes red. **Same 3 lines in the email**
  (no dot bar). No `FORMULA_VERSION` bump — presentation of existing signals.
  - **Bug fixed alongside:** a null / Barchart derived-zero daily change no
    longer renders as a green `+0.00%`. Rule everywhere the index's daily change
    shows: `null → "טרם התעדכן"`, `|x|<0.005 → "ללא שינוי"` (neutral), else signed
    (`fmt_market_chg` in Python; inline in the EOD tile + banner in JS).
- **4b** **Evidence Zone** — 4 cards (Trend/Breadth/Volatility/Rotation), each with
  2–3 numbers **+ a decision threshold beside every number** and a Chart.js
  sparkline (from loaded history).
- **4c** **Action Zone** — up to 5 movers from the **persistent Leading sectors**
  (review fix 2: RS>0 vs $SPX on 5d+20d, from `daily_state.rotation`), with
  momentum + sector + UOA badge.
- **4.2** Email leads with the same verdict → lights → dashboard link.

### UOA (2.5 + 3.5)
- `scripts/build_uoa_daily.py` → `data/uoa_daily.json`: per S&P symbol, dominant
  direction (Call/Put by premium = `Latest×Volume×100`), max Vol/OI, total premium.
  Filters: **DTE ≥ 30, Vol/OI ≥ 3, symbol in `sectors.json`** (config
  `MIN_DTE`/`MIN_VOLOI` at the top of the script; 30 keeps directional
  positioning, drops weeklies/gamma noise per SPEC 2.5). `uoa_daily.json`
  records `"filters": {minDte, minVolOi}` so each day's basis is known.
- Action Zone badge (`UOA 📈/📉 ×VolOI`, green Call / red Put) from `metrics._uoa`.
- Real export columns handled: `Symbol, Price~, Exp Date, DTE, Type, Strike, Bid,
  Latest, Ask, Volume, Open Int, Vol/OI, Delta, Time` (no premium/IV columns).
- Template: `samples/uoa-stocks-example.csv`.

---

## 3. How to verify

```bash
# Score parity — the CI gate. Emitter (build_daily_state) must equal send_report.
python3 tests/parity_test.py            # → "EMITTER PARITY OK"

# KNN engines identical (JS vs Python)
python3 tests/knn_parity_test.py

# Single-source state — inspect the one file the dashboard renders
python3 scripts/build_daily_state.py && cat data/daily_state.json

# Derived data pipelines (run standalone)
python3 scripts/build_score_forward.py  # data/score_forward.json
python3 scripts/build_uoa_daily.py      # data/uoa_daily.json
python3 scripts/normalize_incoming.py --dry-run   # filename normalization preview

# Syntax
node --check v2/overview-prod.js && node --check v2/verdict.js
python3 -c "import ast,glob; [ast.parse(open(f,encoding='utf-8').read()) for f in glob.glob('scripts/*.py')+['.github/workflows/send_report.py']]"
```

**Live:** dashboard <https://nditzik.github.io/indexes-status/index-v3.html> — main tab
should show one verdict + 4 evidence cards + action stocks with **no scroll**
(the "3-second test").

---

## 4. New files (for the reviewer to read)

| File | Purpose |
|---|---|
| `v2/verdict.js` | The single verdict pipeline (finding 1) |
| `scripts/build_daily_state.py` | Emits `daily_state.json` (finding 5, the big one) |
| `scripts/normalize_incoming.py` | Filename normalization (finding 4) |
| `scripts/check_data_freshness.py` | Missing-day alert (finding 4) |
| `scripts/build_score_forward.py` | Score forward-tracking (finding 3) |
| `scripts/build_uoa_daily.py` | UOA ingestion (new data) |
| `.github/workflows/data-freshness-alert.yml` | Cron for the alert |
| `data/daily_state.json` | **The single source of truth the browser renders** |
| `data/scores_history.json`, `data/score_forward.json`, `data/uoa_daily.json` | Append-only history + derived data |

---

## 5. Known limitations / intentionally deferred

- **Finding 7 (Chart.js from CDN):** still loaded from jsDelivr with an SRI hash;
  a bundled local copy was deferred (low risk). Cache-busting is **manual** (`?v=`).
- **Full JS-scoring deletion:** the JS scoring survives as a labeled **fallback**
  (used only if `daily_state.json` is missing/stale). Deleting it (the ~60% file
  shrink) was deferred until the single-source path is proven in production.
- **`scores_history` / `score_forward` / distribution table are empty** until the
  history accumulates (they append one row per trading day; ~20 sessions to mature).
  The UI shows an honest "not enough history yet" state.
- **UOA `uoa_daily.json` is empty** until the user pushes a `uoa-stocks-*.csv`
  export to `data/` (pipeline built + tested; awaiting the daily file).
- **Data quality dependency:** Barchart occasionally leaves the `$SPX`/`$TNX`
  %Change blank; handled by deriving daily %change from price (see
  `02f638e`, `845c231`).

---

## 6. Guardrails going forward

- **One rule:** a scoring/verdict formula change goes in **Python only**
  (`send_report.py`) + bump `FORMULA_VERSION`; it flows to the dashboard via
  `daily_state.json`. Do **not** re-edit the JS scoring (it is fallback).
- `tests/parity_test.py` must stay green (emitter == source) before every push.
- Bump `?v=` on `index.html` + `index-v3.html` after any JS/CSS change.
