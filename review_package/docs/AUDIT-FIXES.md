# Audit fixes — reliability hardening pass

Implements the 8 priority fixes from the ChatGPT audit handoff.
Each entry references the code that changed.

---

## §audit-fix-1 — Date-aware file selection

**Problem:** `sorted(glob.glob('data/spx-options-flow-*.csv'))` lex-sorts
`MM-DD-YYYY` filenames, so `01-02-2026` sorts before `12-31-2025`.
"Latest" would point at the wrong file the first week of January.

**Fix:** parse the date out of each filename and sort by ISO key.

**Files:**
- [.github/workflows/update-data.yml](.github/workflows/update-data.yml) — rewrote the inline shell `ls | sort` + Python glob.
- [.github/workflows/send_report.py](.github/workflows/send_report.py) — added `_iso_key()` + `sorted_by_date()` helpers; switched both glob call sites.
- `scripts/update_forward_snapshots.py` was already date-aware (no change).
- JS already used `parseDateFromFilename` (no change).

---

## §audit-fix-2 — Data completeness indicators

**Problem:** Tech / Breadth / Flow scores normalize `parts/max*100`. If
half the inputs were missing the score still looks "100" without telling
the user the score is built on partial data.

**Fix:** every composite score now returns `{value, coverage, missing}`,
and the MCC card surfaces a yellow chip when coverage < 100% listing
which inputs were absent.

**Files:**
- `v2/overview-prod.js` — new `scoreTechFull` / `scoreBreadthFull`; `computeFlowAnalytics` returns `coverage`; `metrics` carries `techCoverage`, `breadthCoverage`, `flowCoverage`; MCC render shows `ov2_coverageChip`.
- `index.html` — new `<div id="ov2_coverageChip">` placeholder.
- `v2/overview-prod.css` — `.ov2-coverage-chip` styles.

---

## §audit-fix-3 — KNN missing-feature handling

**Problem:** `normalize()` substituted `0` for missing features. After
z-score normalization, 0 is the MEAN — so a row with missing data was
treated as if it had exactly-average values, which falsely IMPROVED its
distance to anything off-average. A row missing 4 of 9 features could
"win" the K=10 against a fully-observed close match.

**Fix:** missing features now stay `NaN`; the distance function skips
any dimension missing in either vector and SCALES the partial sum back
to full-D scale (sklearn's `nan_euclidean` approach). This makes partial-
data candidates correctly *less* attractive, not more.

**Files:**
- `scripts/update_forward_snapshots.py` — new `pair_distance()`; `normalize` returns NaN for missing; `find_matches` consumes the new tuple; each match record carries `dimsUsed`.
- `v2/patterns.js` — same fix applied to the live KNN engine; `Patterns.analyze` returns `dimsUsed` per match.

**Validation:** see `tests/parity_test.py` and the unit tests embedded
in the patch commit. With 1 of 5 dims missing, old distance was 2.000
(falsely improved); new distance is 2.236 (correctly de-favored).

---

## §audit-fix-4 — JS/Python parity test

**Problem:** Dashboard formulas (JS) and email formulas (Python) lived
in two files. The Flow Score 67/80 incident proved they could drift
silently.

**Fix:** [tests/parity_test.py](tests/parity_test.py) loads `data/data.txt`
and the latest options CSV, computes Tech / Breadth / Flow / Combined
via a Python port of the JS formulas, runs `send_report.py` end-to-end
(with email send patched out), and asserts the 4 scores match within
±1. Exits non-zero if any score drifts — CI can wire it in.

**Run:** `python3 tests/parity_test.py`

**Current status:** ✓ all 4 scores match exactly on 2026-06-05 data.

---

## §audit-fix-5 — KNN language

**Problem:** "צפי" / "תחזית" / "forecast" / "prediction" overstate what
the KNN does. The model surfaces a *conditional distribution* over
historical analogs — never a prediction.

**Fix:** renamed across `index.html`, `v2/overview-prod.js`,
`v2/forward-tracking.js`, and `.github/workflows/send_report.py`:
- "צפי 5d" / "צפי 20d" → "אינדיקציה 5d" / "אינדיקציה 20d"
- "לבסס תחזית" → "להציע אינדיקציה היסטורית"
- "לא מציגים תחזית" → "לא מציגים אינדיקציה"
- Added emphasis: "זו לא תחזית — זו התפלגות מותנית של מקרים דומים בעבר"

The matured-table headline now reads "**אינדיקציה היסטורית ל-Day 20**"
instead of "צפי ל-Day 20".

---

## §audit-fix-6 — Flow confidence / Mid-dominance tiers

**Problem:** the Flow Score is computed from directional premium only
(Mid excluded). When Mid is 80% of total premium, the score reflects
just 20% of the day's flow but appears with the same confidence as a
normal day. The existing chip fired only at ≥70%.

**Fix:** three-tier confidence note:
- ≥80% Mid → "⛔ ביטחון נמוך בציון" (red)
- 70-80% Mid → "⚠ ביטחון מוגבל" (orange)
- 50-70% Mid → "⚠ Mid (בלוקים/דילרים)" (amber)

**Files:**
- `v2/overview-prod.js` — Flow card `sideEl` lines now use the tiered
  notes.
- `.github/workflows/send_report.py` — `flow` dict carries
  `confidence_tier` and `confidence_note` for the email narrative.

The MCC coverage chip (Fix 2) also surfaces high Mid as a flow-coverage
warning at the score-summary level.

---

## §audit-fix-7 — Email recipients to config

**Problem:** subscriber emails hardcoded inside `send_report.py`.
Adding or removing a subscriber required a code edit + PR. Sensitive
list (PII) was committed inline.

**Fix:** three-tier resolution in `_load_recipients()`:
1. `TEST_RECIPIENTS` env var (manual test workflow — unchanged)
2. `EMAIL_SUBSCRIBERS` env var (set via GitHub Secret — JSON array or
   comma-separated; takes precedence over the file)
3. `data/email_subscribers.json` (committed config; can be removed
   if using the secret-only path)
4. Error if none configured — no silent fallback to a stale list.

**Files:**
- `.github/workflows/send_report.py` — `_load_recipients()` replaces
  inline list.
- `.github/workflows/update-data.yml` — passes
  `EMAIL_SUBSCRIBERS: ${{ secrets.EMAIL_SUBSCRIBERS }}` to the script.
- `data/email_subscribers.json` — new, current list (was inline).
- `data/email_subscribers.example.json` — committed template.

**Setup options:**
- **Quickest (current state):** keep `data/email_subscribers.json` in
  the repo. Edit + commit to add/remove.
- **Most private:** create a GitHub Secret `EMAIL_SUBSCRIBERS` with a
  JSON array, then delete `data/email_subscribers.json`. The script
  prefers the secret when both exist.

---

## §audit-fix-8 — CDN SRI + proxy fallback chain

**Problems:**
- Chart.js loaded from jsdelivr without Subresource Integrity. A
  compromised CDN could inject JS into every dashboard load.
- `r.jina.ai` was the only CORS proxy. If it rate-limits or shuts
  down, the live ticker and SPX backfill silently break.

**Fixes:**
- `index.html`: pinned Chart.js to 4.4.0 with `integrity="sha384-..."`
  and `crossorigin="anonymous"`. If the hash check fails the browser
  refuses to execute the script — dashboard renders without charts
  rather than running malicious code.
- `v2/overview-prod.js`: new `PROXY_CHAIN` array. `proxyFetchJSON()`
  tries each proxy in order, returning the first parseable response.
  Currently Jina is primary, allorigins.win is fallback. Adding a
  self-hosted Cloudflare Worker URL to the front of the chain takes
  precedence — see [DEPLOY-WORKER.md](DEPLOY-WORKER.md).
- `fetchLiveIndices()`: every successful fetch caches in `localStorage`.
  When ALL proxies fail, the ticker hydrates from cache and the
  "updated at" stamp shows "⚠ HH:MM · cached" with a warn-color
  styling so the user knows the data isn't live.

---

## Running the parity test in CI

Add a step to `.github/workflows/update-data.yml`:

```yaml
- name: Run parity test
  run: python3 tests/parity_test.py
```

It should run before "Send email" so a parity failure prevents an
incorrect email from being sent.
