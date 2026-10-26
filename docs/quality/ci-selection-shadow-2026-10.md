# CI app selection: shadow comparison and runner measurements, October 2026

Evidence for [#259](https://github.com/neurodesk/webapps/issues/259): the dependency-aware app planner
(`scripts/lib/app-plan.mjs`, lockfile- and registry-aware since #273) replayed against an independent oracle on 57
merged pull requests, and what `ci` runs cost in runner minutes and queue time. Collected 2026-10-15 against main
`239b4193`.

## Summary

- **No misses.** On 57 merged pull requests (#240–#324) the current planner selected every app an independent oracle
  says a change affects: 0 misses. No app failed on main after a narrowed pull request had skipped it (0 candidates
  over 119 main runs, 2026-10-07 to 2026-10-15).
- **Narrowing applies to 32 of 57 pull requests**; 25 fall back to the full catalog. Over the sample the planner
  selects 1114 of 1767 `app-tests` jobs (63 %), 1141 of 1810 `browser-e2e` jobs and 222 of 342 macOS GPU jobs.
- **Root tooling still selects everything.** All four tooling-only cases named in the issue (#240–#243) change root
  `package.json` dependencies and fall back. Narrowing root tooling remains open.
- **A full-catalog pull request run costs about 4 times the Linux minutes of a narrowed one** and its jobs wait about
  6 times as long for a Linux runner, mostly behind its own jobs (see [Measurements](#measurements)).
- **The nightly backstop was being cancelled.** It shared a concurrency group with pushes to main; a push cancelled it
  on 3 of 4 nights since narrowing began (5 of 9 since 2026-10-07). This PR gives it its own group.
- **Most push runs on main are superseded.** 32 of the 57 merges had their own push run cancelled by the next push,
  so their apps were not tested on main until a full run finished. A follow-up makes a push diff from the head of
  the last successful main run (see [Cancellation on main](#cancellation-on-main)).

## Method

### Shadow replay

`node scripts/app-plan-shadow.mjs --last 50 --prs 240-247 --ci-history --json shadow.json --markdown shadow.md`

For each merged pull request the tool takes the merge commit's parents (main and the PR head) and diffs from their
merge base, the same diff `ci` computes. It extracts the head and merge-base trees with `git archive`, then runs
**today's** planner with the head's workspace graph and registry and the manifests (`package.json`, `pnpm-lock.yaml`,
`registry/apps.yml`, the offline asset lock) at both revisions. It compares the selection with:

1. **the full catalog**, giving job counts for both (browser shards and the macOS GPU lane included);
2. **an oracle** (`scripts/lib/app-plan-shadow.mjs`) that shares no code with the planner's workspace graph or
   `lockfile-impact.mjs`. It expects an app when a change touches
   - the app's directory or `models/<id>.manifest.json`;
   - a workspace package the app declares (`workspace:`, `link:`, `file:`), transitively, at the merge base or at
     head, so dependencies dropped at head still count;
   - its lockfile closure as pnpm itself lists it from each tree
     (`pnpm list --filter ./apps/<id> --lockfile-only --depth Infinity --parseable`, linked workspace packages'
     dependencies included), plus packages whose lockfile entry changed under the same key (a republished integrity);
   - its `registry/apps.yml` entry or its offline asset lock entries.

   A **miss** is an app the oracle expects and the planner did not select.

With `--ci-history` the tool also reads main's `ci` runs (push, schedule, dispatch), records each app's outcome over its
`app-tests`, `browser-e2e` and `browser-e2e-gpu` jobs, and for every pass-to-fail transition lists the pull requests
merged in between whose narrowed selection skipped that app. It also lists merges whose own push run was cancelled.
`--rows shadow.json` reuses an earlier replay and refreshes only the CI history.

### Runner measurements

`node scripts/ci-minutes-report.mjs --since 2026-10-13 --until 2026-10-15T18:30:00Z --json minutes.json --markdown minutes.md`

Every completed `ci` run in the window, from the Actions API: 163 runs (117 pull request, 43 push to main, 3 nightly).
Each run is classified by the planner's own summary line in the `app-plan` job log (`Selected N of 31 apps` or
`Full catalog and site selected`); runs from before that line existed (#273, 2026-10-14) are classified by their
number of `app-tests` jobs against main's catalog when the run was created (31 apps throughout this window) and
marked *inferred* in `minutes.md`. A run whose `app-plan` job did not succeed (mostly
cancelled by a newer push) is unclassified. The tables below merge the two. Per job:

- **queue** = `started_at − created_at`. A job is created once the jobs it `needs` finish, so this is time waiting for
  a runner, not for earlier jobs;
- **execution** = `completed_at − started_at`;
- **runner minutes** = execution rounded up to whole minutes per job, as GitHub bills them. The repository is public
  and not charged; the minutes measure load on the shared runner pool.

Jobs skipped by their `if` are not counted. Wall time and per-run minutes use finished runs (success or failure);
cancelled runs are counted separately but their minutes are in the totals, since they occupied runners.

## Shadow results

| | Pull requests |
| --- | --- |
| Replayed | 57 (#240–#324; #326 merged during the run and is excluded) |
| Narrowed (no fallback) | 32: 6 select no app, 10 one app, 7 all 31 through dependency reasons |
| Full-catalog fallback | 25 |
| Oracle misses | **0** |
| Main failures after a narrowed skip | **0** (10 pass-to-fail transitions on main since 2026-10-07; none follows one) |

Fallback reasons: root `package.json` dependency or field changes (5), `ci.yml` (5), `.gitattributes` (4), shared
`site/` shell files (5), `runtime-assets/manifest.json` (2), root importer lockfile changes (2), and root files the
per-app jobs run (`test-utils/hardware-gpu.mjs`, `scripts/lib/e2e-test-data.mjs`, 1 each).

Lockfile changes: 8 pull requests changed what pnpm lists for at least one app. Six fell back. In the other two the
planner selected every app the oracle expected: #302 (oracle synthseg; planner all 31) and #246 (oracle dicom2vid and
nesvor; planner 6 apps).

The issue's concrete cases:

| PR | Change | Planner today |
| --- | --- | --- |
| #240–#243 | Root tooling (unused-code report, coverage lint, mutation pilot, dependency boundaries) | Full catalog: root `package.json` dependencies changed |
| #244 | Remove unused app helpers | 3 apps (zarro, fireants, nesvor) |
| #245 | zarro promise handling | 16 apps: the `scripts/quality` lockfile importer changed and 15 apps reach it through their `lint` scripts |
| #246 | Dependency declarations and runtime cycles | 6 apps |
| #247 | Correctness findings | Full catalog: `site/theme.js` |

Per pull request (selected apps; apps the oracle expects; misses; the first reason or the fallback):

| PR | Selected | Oracle | Misses | Reason |
| --- | --- | --- | --- | --- |
| #324 | 0 | 0 | 0 | nothing app-facing changed |
| #323 | 31 (fallback) | 21 | 0 | site/app-shell.js: no rule classifies it |
| #320 | 3 | 3 | 0 | packages/brain-extraction/validation/web-reference.mjs (through packages/brain-extraction) |
| #319 | 31 (fallback) | 0 | 0 | site/landing.css: no rule classifies it |
| #317 | 31 (fallback) | 20 | 0 | .gitattributes: no rule classifies it |
| #315 | 1 | 1 | 0 | exes/fida/src/io/detect.rs (through exes/fida) |
| #314 | 31 | 3 | 0 | exes/synthseg/Cargo.lock (through exes/synthseg) |
| #313 | 31 (fallback) | 31 | 0 | .gitattributes: no rule classifies it |
| #312 | 31 (fallback) | 0 | 0 | .gitattributes: no rule classifies it |
| #311 | 31 | 0 | 0 | exes/synthseg/scripts/notarize_macos.sh (through exes/synthseg) |
| #310 | 31 (fallback) | 0 | 0 | .gitattributes: no rule classifies it |
| #309 | 0 | 0 | 0 | nothing app-facing changed |
| #308 | 9 | 5 | 0 | packages/synthsr/package.json (through packages/synthsr) |
| #307 | 1 | 1 | 0 | packages/deface/validation/cli-check.mjs (through packages/deface) |
| #306 | 14 | 5 | 0 | packages/synthsr/src/volume.js |
| #305 | 31 | 31 | 0 | apps/musclemap/CHANGELOG.md |
| #304 | 31 (fallback) | 1 | 0 | test-utils/hardware-gpu.mjs: ci.yml's per-app jobs run it |
| #303 | 1 | 1 | 0 | apps/browserqc/e2e/automation.spec.js |
| #302 | 31 | 1 | 0 | exes/synthseg/Cargo.lock (through exes/synthseg) |
| #301 | 31 (fallback) | 22 | 0 | runtime-assets/manifest.json: no rule classifies it |
| #300 | 31 (fallback) | 22 | 0 | pnpm-lock.yaml: importer . resolves changed packages |
| #299 | 1 | 1 | 0 | packages/deface/validation/cli-check.mjs (through packages/deface) |
| #298 | 1 | 1 | 0 | packages/deface/validation/cli-check.mjs (through packages/deface) |
| #297 | 31 (fallback) | 22 | 0 | pnpm-lock.yaml: importer . resolves changed packages |
| #296 | 31 (fallback) | 19 | 0 | package.json: no rule classifies it |
| #295 | 15 | 0 | 0 | scripts/quality/typed-projects.mjs |
| #294 | 31 (fallback) | 1 | 0 | scripts/lib/e2e-test-data.mjs: ci.yml's per-app jobs run it |
| #293 | 31 (fallback) | 31 | 0 | runtime-assets/manifest.json: no rule classifies it |
| #292 | 30 | 0 | 0 | registry/standalone.json |
| #291 | 0 | 0 | 0 | nothing app-facing changed |
| #290 | 1 | 1 | 0 | packages/lcmodel/src/basis-select.js (through packages/lcmodel) |
| #289 | 31 | 31 | 0 | exes/synthseg/Makefile (through exes/synthseg) |
| #278 | 31 (fallback) | 31 | 0 | site/app-shell.js: no rule classifies it |
| #277 | 1 | 1 | 0 | apps/lcmodel/e2e/tissue-invalidation.spec.js |
| #276 | 31 | 31 | 0 | apps/musclemap/web/js/app/labels.js |
| #275 | 16 | 1 | 0 | apps/deface/e2e/automation.spec.js |
| #274 | 0 | 0 | 0 | nothing app-facing changed |
| #273 | 0 | 0 | 0 | nothing app-facing changed |
| #271 | 1 | 1 | 0 | apps/lcmodel/CHANGELOG.md |
| #270 | 31 (fallback) | 31 | 0 | site/app-theme.css: no rule classifies it |
| #269 | 0 | 0 | 0 | nothing app-facing changed |
| #268 | 31 (fallback) | 4 | 0 | .github/workflows/ci.yml: no rule classifies it |
| #267 | 31 (fallback) | 1 | 0 | .github/workflows/ci.yml: no rule classifies it |
| #266 | 31 (fallback) | 0 | 0 | .github/workflows/ci.yml: no rule classifies it |
| #265 | 1 | 0 | 0 | exes/compute-server/src/runner/process.rs (through exes/compute-server) |
| #264 | 31 (fallback) | 10 | 0 | .github/workflows/ci.yml: no rule classifies it |
| #263 | 31 | 31 | 0 | apps/musclemap/CHANGELOG.md |
| #262 | 31 (fallback) | 0 | 0 | .github/workflows/ci.yml: no rule classifies it |
| #261 | 1 | 1 | 0 | apps/lcmodel/src/main.js |
| #247 | 31 (fallback) | 31 | 0 | site/theme.js: no rule classifies it |
| #246 | 6 | 5 | 0 | apps/dicompare/CHANGELOG.md |
| #245 | 16 | 1 | 0 | apps/zarro/CHANGELOG.md |
| #244 | 3 | 3 | 0 | apps/zarro/CHANGELOG.md |
| #243 | 31 (fallback) | 1 | 0 | package.json: no rule classifies it |
| #242 | 31 (fallback) | 0 | 0 | package.json: no rule classifies it |
| #241 | 31 (fallback) | 16 | 0 | package.json: no rule classifies it |
| #240 | 31 (fallback) | 0 | 0 | package.json: no rule classifies it |

### What the oracle does not see

- Root files (`scripts/`, `test-utils/`, `ci.yml`, root `package.json`) have no independent owner. The oracle lists
  them as unattributed and expects no app; the planner either falls back or follows its graph.
- Package tests and Markdown in a package reach an app only if the app reads them; the planner follows such reads,
  the oracle reports them as exempt. 279 app/path pairs were exempt on narrowed pull requests, all `test/` files,
  `README.md` or `CHANGELOG.md`; package tests run in `workspace-contracts` on every pull request.
- Text references (Vite configs, build scripts, `#[path]` includes) are the planner's own evidence. The oracle cannot
  confirm them, so it cannot find a miss only such a reference would reveal. On narrowed pull requests the planner
  selected 179 app entries beyond the oracle's 160; that is where these references widen the selection.
- `pnpm list --parseable` gives keys, not integrities; republished packages come from the lockfile's `packages`
  section. Runtime assets, toolchains and model files outside an app directory are not modelled.
- The CI-history check needs a passing and then a failing run of the same app on main. Main's per-app history is
  sparse (52 of 119 runs finished), so a regression main never ran stays invisible.
- The planner is replayed with today's code on each historical tree. CI at the time ran older planners (#262–#273):
  the rows say what the planner would select now, not what CI selected then.

### Over-selection, not changed here

Three narrowed pull requests (#302, #311, #314) select all 31 apps through `exes/synthseg` (`Cargo.lock`, notarisation
scripts) where the oracle expects 0–3, and #292 selects 30 through `registry/standalone.json`. Every app reaches both:

`scripts/lib/vite-app-config.mjs` → `scripts/lib/app-automation.mjs` → `packages/desktop/src/contracts.js` →
`packages/desktop/src/resource-limits.js` → `exes/synthseg`, and `scripts/lib/vite-app-config.mjs` →
`registry/standalone.json`.

Narrowing these needs proof that app builds do not read those files; this PR does not change them.

**Follow-up (comment edges).** The `exes/synthseg` edge came from a comment in `resource-limits.js` ("Preserve
exes/synthseg/src/nifti.rs arithmetic order"). The workspace graph now ignores whole `//` comment lines when it
scans root files. Block comments and `///` directives stay, because JSDoc `import()` types and triple-slash references are typecheck inputs. Six edges disappear:

- `resource-limits.js` → `exes/synthseg`;
- `vite-app-config.mjs` → `scripts/build-site.mjs` and `scripts/build-static.mjs`, from its header-policy comment. That
  comment had put the composite build's whole input set (the landing page, the runtime store, `scripts/lib/standalone.mjs`)
  into every app;
- `e2e-test-data.mjs` → `packages/lcmodel/validation/reference.mjs` and that file's two reads. lcmodel still reaches
  `packages/lcmodel`.

Every app now reaches `exes/synthseg` only through a real reference: 11 apps instead of all of them (32 since dicomview
was added). `registry/standalone.json` stays a real input. `theme-app-dist.mjs` copies it into every themed app, and the
dev shell links it.

Replayed over the last 70 merged pull requests plus #240–#247 (78 in all), with no `--overlay`:

- oracle misses: 0 before, 0 after;
- `app-tests` jobs: 1490 before, 1450 after; `browser-e2e`: 1532 before, 1492 after; macOS GPU: 296 before, 291 after;
- changed rows: #314 (31 → 11 apps, oracle 3), #311 (31 → 12, oracle 0) and #321 (30 → 29, oracle 1).

**Follow-up (`registry/standalone.json`).** The catalog is a real input of every themed app: `stageStandaloneAssets`
validates all of it and copies it into each dist. The shell, though, renders only the app's own entry
(`catalog.apps[metadata.id]`), and so does the shared dialog check. The planner now:

- runs the same validation (`validateStandalone`) on the head catalog, and selects every app if it fails;
- selects every app if any field other than `apps` and `suite` changed;
- otherwise selects the apps whose entries changed, plus the site build. The desktop `suite` reaches only the catalog
  page.

A contract lists every reader the per-app jobs reach. It also checks that the shell and the dialog helper read only
their own entry.

Replay over the 201 commits on main since 2026-10-01 that touched the file, most of them
`chore(standalone): publish …` pushes. It used today's workspace graph and each commit's own registry:

- app selections: 6391 before (the full catalog every time), 530 after;
- 180 commits select only the app whose downloads were published;
- 5 desktop-suite publishes select only the site build;
- 7 still fall back for other files.

**Follow-up (`.gitattributes`).** A root `.gitattributes` change used to select the full catalog. Now the planner asks
git which files' attributes differ between the merge base and head: `git check-attr -a --source=<rev>` for every file in
the head tree. Each such file counts as changed, so it goes through the ordinary rules, with `.gitattributes:` as the
prefix of each reason.

This uses git's own pattern matching, including nested `.gitattributes` files. A comment, or a rule that matches no
tracked file, selects nothing. When the comparison fails, the change selects the full catalog.

Per-app CI jobs never read `export-ignore` or other `git archive` attributes, so checkout content is the only input an
attribute can change.

Replay over every merged pull request since #206 that changed `.gitattributes` (#206, #237, #238, #310, #312, #313,
#317, #343):

- oracle misses: 0;
- full-catalog fallbacks: 8 before, 3 after. Those three fall back for other files;
- per-app jobs: 247 of 247 `app-tests` before, 157 after;
- #310 and #312 (SynthSeg norms fixtures) now select synthseg only, through `packages/synthseg/test`. The oracle
  expects none, because package tests are exempt;
- #237 selects one app (oracle 1);
- #317 and #343 still select all 31 apps, through their other files.

**Follow-up (runtime manifest and composite-only site files).** Both used to select the full catalog ("no rule
classifies it").

`runtime-assets/manifest.json` is read at plan time by:

- `scripts/fetch-app-runtime.mjs`, which stages pinned files into the apps that call it;
- `apps/seedseg` and `packages/seedseg` tests, inside apps that call the fetcher;
- the composite build (`scripts/lib/runtime-assets.mjs`, `scripts/audit-artifacts.mjs`,
  `test-utils/asyncify-runtime-startup.mjs`);
- Knip and the contract tests.

A change to the manifest now selects the apps that reach the fetcher (musclemap, vesselboost, spinalcordtoolbox,
calmar, seedseg, syncro and brain-extraction) and the site build. The composite site's catalog e2e covers the shared
store for every app. Without a workspace graph, the change stays shared.

`site/landing.css`, `landing.js`, `analytics.json`, `404.html` and `dicompare-routes.js` are copied only by the
composite build, so a change to one of them selects only the site build. The app shell, theme, fonts and logo still
select every app.

Two tests guard both lists. Each one greps every tracked file that names one of these files and fails on a reader it
has not classified; the runtime-manifest guard found `asyncify-runtime-startup.mjs`. The tests also check that no app
or per-app job reaches a listed composite reader.

Replay over every merged pull request since #186 that changed these files (#186, #238, #293, #301, #313, #319, #370,
#380):

- oracle misses: 0;
- full-catalog fallbacks: 8 before, 4 after; the other four fall back for other files;
- #319 (`landing.css`) and #370 (`404.html`) now select no app, matching an oracle of 0;
- #301 and #238 now narrow, selecting 31 and 30 apps through their other files.

## Root quality tools, 2026-10-17 follow-up

Root-only Knip and Stryker devDependencies now have independent ownership.
The root manifest comparison removes only `knip` and `@stryker-mutator/core`
from `devDependencies` before classifying changed scripts. Their commands still
run on every pull request through `unused-code.yml` and `mutation-quality.yml`.
A contract checks that neither tool appears in app, package, native or browser
inputs, so a new consumer requires revisiting this ownership.

Root manifest edits load the lockfile at both revisions even when it is unchanged.
The planner validates those closures before narrowing root manifest changes.
The lockfile analyzer validates both original root closures before excluding tools.
Every required snapshot must have matching package metadata and a nonempty resolution
mapping. Peer-qualified snapshots use the package key without the peer suffix.
Missing or malformed metadata on either side triggers a full-catalog fallback,
including when the tool or a transitive dependency disappears from the other side.
It then compares the root importer without those two devDependency roots.
Every other importer retains its complete base and head closure. A changed
transitive package shared with an app still selects that app. Another root
dependency using that package still selects the whole catalog. Missing or
unresolvable tool snapshots remain errors. Dependencies, optionalDependencies,
settings and unknown root tools retain conservative selection.

The five-case shadow replay covers #240, #242, #246, #273 and #302, with no
oracle misses. #240 and #242 now select no apps or site build. #246 retains
its six app consumers, #273 selects no apps, and #302 retains all 31 apps.
The replay selects 37 of 155 app-test jobs, 38 of 157 browser jobs and 8 of 30
GPU jobs. These are historical job counts, not measured runner-minute or queue
savings. The oracle's root-file and runtime-asset limits above still apply.

Rerun with `node scripts/app-plan-shadow.mjs --prs 240,242,246,273,302
--json shadow.json --markdown shadow.md`. Root ESLint and other tooling,
comment-derived graph edges, `.gitattributes`, native workflow inputs and
stacked-PR duplication remain separate work.

**ESLint follow-up.** `eslint`, `@eslint/js` and `globals` join the independent root tools. ESLint is loaded only by
`scripts/lint.mjs`, `eslint.config.js` and `test/lint-coverage.test.mjs`. Only workspace-contracts and `code-quality.yml`
run it, and both run on every pull request.

The apps' `lint` scripts run `scripts/check-app-js.mjs`, not ESLint. The per-app jobs run each app's `build`,
`test:e2e` and release test script, and none of those invokes ESLint.

A contract checks three things and fails when any of them changes:

- no other source file imports these packages;
- no per-app or composite-site step runs lint;
- no CI-run app script, including the scripts it calls, runs ESLint.

#241 is the only merged pull request that changed them, and it still falls back: it also adds the
`@neurodesk/code-quality` workspace devDependency and new root scripts. An ESLint-only bump now selects no app. #243
falls back because of its lockfile's `packageExtensionsChecksum` section.

## Measurements

Window: `ci` runs created 2026-10-13 00:00 to 2026-10-15 18:30 UTC.

### Pull requests (117 runs)

| Selection | Runs (finished / cancelled) | Wall min, median / p90 | Linux min per run, median / p90 | macOS min per run, median / p90 | Linux job queue s, median / p90 / max | macOS job queue s, median / p90 / max |
| --- | --- | --- | --- | --- | --- | --- |
| Full catalog | 70 (45 / 25) | 52.1 / 91.7 | 353 / 381 | 0 / 0 | 228 / 1576 / 3401 | – |
| Narrowed | 30 (25 / 5) | 32.4 / 64.9 | 94 / 344 | 0 / 61 | 37 / 782 / 1566 | 250 / 2073 / 4048 |
| No apps | 11 (10 / 1) | 5.7 / 12.1 | 11 / 23 | 0 / 0 | 3 / 43 / 153 | – |
| Unclassified (planner cancelled) | 6 (0 / 6) | – | – | – | – | – |

Totals: 29 733 Linux and 576 macOS runner minutes. Full-catalog runs are 70 of 117 runs and used 25 603 Linux minutes
(86 %). Full-catalog pull requests skip the macOS GPU lane by design (it runs after merge and nightly); narrowed ones
run it for the selected GPU apps, so narrowing adds the pull request's macOS minutes and macOS queue.

Reading the medians: a narrowed run uses about a quarter of a full run's Linux minutes (94 against 353) and a run that
selects no app about 3 %. The 41 narrowed and no-app runs used 4 118 Linux minutes in total, cancelled runs included;
the 35 that finished would have used about 12 300 at the full-catalog median. That is an estimate from medians, not a
replay.

### Pushes to main and nightly (46 runs)

| Selection | Runs (finished / cancelled) | Wall min, median / p90 | Linux min per run, median / p90 | macOS min per run, median / p90 | Linux job queue s, median / p90 / max | macOS job queue s, median / p90 / max |
| --- | --- | --- | --- | --- | --- | --- |
| Push, full catalog | 18 (9 / 9) | 53 / 67 | 391 / 420 | 75 / 83 | 49 / 879 / 1738 | 283 / 1493 / 4304 |
| Push, narrowed | 11 (5 / 6) | 27.5 / 46.4 | 56 / 220 | 0 / 62 | 2 / 455 / 646 | 186 / 1407 / 1748 |
| Push, no apps | 6 (3 / 3) | 16.1 / 31.6 | 26 / 30 | 0 / 0 | 2 / 202 / 422 | – |
| Push, unclassified (planner cancelled) | 8 (0 / 8) | – | – | – | – | – |
| Nightly | 3 (1 / 2) | 109.7 | 454 | 73 | 2 / 796 / 1243 | 10 / 795 / 983 |

Totals: pushes 7 410 Linux and 1 249 macOS minutes; nightly 1 611 Linux and 199 macOS minutes.

### Per job

| Job (runner) | Pull request jobs | Execution min, median / p90 | Queue s, median / p90 / max |
| --- | --- | --- | --- |
| app-plan (Linux) | 114 | 0.6 / 0.8 | 16 / 666 / 1653 |
| app-tests (Linux) | 2427 | 0.8 / 8 | 197 / 1471 / 3401 |
| browser-e2e (Linux) | 2502 | 3.9 / 16.9 | 237 / 1642 / 3378 |
| browser-e2e-gpu (macOS) | 62 | 6.5 / 22.8 | 207 / 1846 / 4048 |
| composite-site (Linux) | 105 | 16.4 / 28.7 | 7 / 743 / 2489 |
| homepage-easter-egg (Linux) | 114 | 4.9 / 5.4 | 24 / 754 / 1917 |
| workspace-contracts (Linux) | 114 | 4.2 / 5.6 | 12 / 683 / 1660 |

Queue and execution separate cleanly. A typical `app-tests` job runs for under a minute but waits about 3 minutes
for a runner, and up to 57 minutes. Linux queue is longest for jobs of full-catalog runs: medians are 228 s inside full runs,
37 s inside narrowed runs and 2 s in no-app runs. Each full run creates about 70 Linux jobs at once. The macOS lane
queues longest (p90 25–35 minutes, maximum 67–72 minutes) whatever the selection, since GPU jobs from pull
requests, pushes and the nightly run share a few macOS runners.

### Cancellation on main

`ci` used one concurrency group per ref with `cancel-in-progress`. On main this cancelled:

- **the nightly full run**, on 2026-10-07, -10, -12, -13 and -15 (5 of 9 nights; 3 of 4 since narrowing began on
  2026-10-12). This PR gives scheduled runs their own group, `ci-ci-nightly`, so a push no longer cancels the backstop;
  `test/independent-workflows.test.mjs` holds it.
- **push runs superseded by the next merge**: 32 of the 57 replayed merges, 15 of them selecting the full catalog,
  14 narrowed with at least one app and 3 selecting none (`supersededMerges` in `shadow.json`). The next push run diffs only from its own
  `before`, so the cancelled merge's apps go untested on main until a full run finishes. Each of these merges passed
  its own pull request checks, against an older main.

  Example: #323 (`site/app-shell.js`, full catalog) had its push run cancelled, #326's push run failed, and #328's
  push run diffed from #326's merge (`311a3fa5..2f840e6b`), selected no app and passed. Diffed from the last green
  run (`8cc92df6`), the same push selects all 31 apps.

  **Fixed after this report.** Pushes keep cancelling each other, which keeps main's queue short, but a push now
  diffs from the head of the last successful `ci` run on main (push, nightly or dispatch; pull request runs and
  other branches do not count), found through the Actions API by `scripts/lib/tested-base.mjs`. The selection is the
  union of every merge since main last went green, so it converges however many runs in a row are cancelled, and a
  failed run's apps are tested again by the next push. When no such run is among the newest 100 or its head is not an
  ancestor of the push (a rewritten history), or the API cannot be read, the push selects the full catalog.
  Not cancelling on main was the alternative; it would have kept every superseded run (32 of 57 merges, about 390
  Linux minutes per full-catalog push) on the shared runners.

## Rerunning

Both tools need an authenticated `gh`; the shadow replay needs main's history and `pnpm`. Pure logic is tested in
`test/app-plan-shadow.test.mjs` and `test/ci-minutes.test.mjs`. Job listings are fetched 30 per page: pages of 100
fail with a steady HTTP 502 on some full-catalog runs.

## 24 October update: observed costs and reporter corrections

The post-#528 sample shows substantial executed work in cancelled runs, but does **not** measure
counterfactual savings from narrower selection. It also exposes two defects in the existing timing
reporter: counting unassigned cancellation spans as execution, and turning invalid queue timestamps
into zero latency.

### Cohort and method

Read-only GitHub Actions API collection covers **112 `ci.yml` run IDs created from 21 October 02:00
UTC to 24 October 00:00 UTC (exclusive)**, after [#528 merged at 01:45:08
UTC](https://github.com/neurodesk/webapps/pull/528). Events: 82 pull requests, 27 pushes and 3
schedules. All were completed at the run-list snapshot, 24 October 18:21 UTC. There were 48
successful, 12 failed and 52 cancelled latest attempts. Planner logs classify 42 full, 46 narrowed,
9 no-app and 15 unknown selections; unknown is not treated as no-app.

Collection artifacts are retained outside the source checkout for review. Raw API responses and
planner logs are in `raw/`; `summary.json` uses the corrected repository timing helper.
`summary.before-fix.json` preserves the original calculation. `earlier-attempts/` retains all 18
earlier attempts of the 17 rerun IDs. No jobs are duplicated between these sets. `analysis.json`
contains the calculations.

Execution is `completed_at − started_at` for a job assigned to a runner. Queue delay is `started_at
− created_at` only when both timestamps are valid and ordered. Queue delay is not added to
execution. Raw minutes below are unweighted sums across parallel jobs; per-job ceiling minutes are a
separate load proxy, **not billing, money, CPU time or wall time**. Other workflows, including
native and portable producers, are outside this sample.

### Observed execution

| Latest-attempt outcome | Runs | Linux execution min | macOS execution min | Linux / macOS per-job rounded min |
| --- | ---: | ---: | ---: | ---: |
| Success | 48 | 11,621.7 | 1,105.8 | 12,488 / 1,156 |
| Failure | 12 | 2,265.9 | 125.1 | 2,444 / 129 |
| Cancelled | 52 | 11,068.4 | 822.2 | 12,129 / 866 |
| **Total** | **112** | **24,956.0** | **2,053.1** | **27,061 / 2,151** |

Cancelled latest attempts account for 44.0% of observed combined execution minutes. This is work
already executed before cancellation, not the cost of completing those runs and not measured savings
from cancellation.

The 18 earlier attempts comprise 5 failures and 13 `action_required` attempts with no executed jobs.
The failures add **1,621.0 Linux and 150.6 macOS execution minutes** (1,750 / 157 per-job rounded
minutes). Including all 130 attempts of this cohort gives **26,577.0 Linux and 2,203.7 macOS
execution minutes**. Latest-attempt-only reporting omits that earlier executed work.

### Observed runner queue

| Latest-attempt platform | Valid assigned-job pairs | Median / p90 / maximum, seconds | Invalid pairs excluded |
| --- | ---: | ---: | ---: |
| Linux | 4,719 | 59 / 755 / 3,083 | 323 |
| macOS | 191 | 297 / 2,191 / 4,367 | 13 |

These are per-job waits after the API says the job was created, not workflow dependency waits or
sums of elapsed workflow time. The invalid pairs are explicitly unknown; they are not zero waits.

### Reporter defects and exclusions

- **346 unassigned placeholders** have `runner_id = 0`, an empty runner name and no steps. Of these, 334 expose positive start-to-cancellation spans totaling 2,626.0 minutes. For example, [job 119320917040](https://github.com/neurodesk/webapps/actions/runs/39628635901/job/119320917040) was never assigned a runner, but its timestamps span 12m54s. The old helper counts that as 13 macOS runner minutes. Across this latest-attempt sample, it overcounts **1,756 Linux and 1,034 macOS rounded minutes**. Correcting accounting is not a performance improvement.
- **336 assigned jobs** have `started_at` earlier than `created_at`, by up to 21,256 seconds. For example, [job 119579388203](https://github.com/neurodesk/webapps/actions/runs/39610966218/job/119579388203) has 358 valid execution seconds, but its reported creation is 4,125 seconds after its start. Keep the execution and exclude its queue value. The old helper silently clamps it to zero.
- **77 skipped jobs** and **1 assigned job with incomplete execution timestamps** are excluded from execution, with separate counts. Valid execution of assigned cancelled jobs remains included.
- At the snapshot, [push 40115192000](https://github.com/neurodesk/webapps/actions/runs/40115192000) and [dispatch 40110808461](https://github.com/neurodesk/webapps/actions/runs/40110808461) were ongoing, created outside this closed cohort; dispatch is also outside its event scope. Neither is treated as completed or included in these totals.

### Interpretation and limits

No equivalent full-catalog executions of the same narrowed inputs were measured. This sample cannot
establish minutes saved by #528 or other planner changes. There are no standalone-publish pushes in
the sample, so it does not directly measure the publication case of #528. Workload, cache state,
catalogue size, failure timing and runner availability also prevent a causal comparison with the
earlier October report.

Historical figures above retain their original collection and helper attribution; they have not been
silently recalculated using this correction. No CI selection or scientific validation change is
proposed.

### Reproducing the latest-attempt table

```sh
node scripts/ci-minutes-report.mjs \
  --since 2026-10-21T02:00:00Z --until 2026-10-24T00:00:00Z \
  --json minutes.json --markdown minutes.md
```

The CLI reports ongoing/limit exclusions, latest-attempt scope, invalid timestamps and unassigned
jobs. Earlier attempts require the Actions API endpoints `actions/runs/{run_id}/attempts/{attempt}`
and `actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=30` (paginate jobs). A later rerun can
change the API latest-attempt view.