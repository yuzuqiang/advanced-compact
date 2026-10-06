# 0.1.23 CPU performance experiment

Baseline: `e656a68b2ea1c189d72b8997fa9b59b85397d248` (GitHub main, 0.1.22). Experiments ran in a cloud Linux workspace on 2026-10-06, Node 24.19.0, AMD EPYC 9V74. No user computer, private fixtures, or live model calls were used.

## Scope and decision rule

This release proposes six measured CPU hot-path improvements. It preserves tested outputs and configurations; it does not claim fewer tokens, better model quality, or a measured full-compaction latency reduction. A composed 250-message checkpoint workload showed no significant overall gain (+0.6% and -2.7% paired wall time across two processes). These function-level results must not be marketed as end-to-end speedups.

Each numbered round had one independent hypothesis, the last accepted candidate as its baseline, fixed generated inputs, a correctness gate, and two fresh benchmark processes. Each process warms up, calibrates repetitions, then executes 11 alternating baseline/candidate pairs. Reported percentages are median paired wall-time ratios, not a ratio of two unpaired medians. CPU usage is measured alongside wall time. The unchanged-code control varied by approximately 2%.

Adoption requires at least one target workload to improve by at least 5% in both fresh processes, at least 9/11 wins in both, corroborating CPU improvement, exact correctness, and no control workload with more than 5% median regression. Otherwise classify as rejected (clear regression) or inconclusive (no reproducible improvement above the gate), and restore the previous accepted source. This is a bounded synthetic CPU evaluation, not a universal statistical guarantee.

## Ten-round ledger

| Round | Hypothesis | Paired time change: process A / B | Decision |
|---|---|---|---|
| 1 | Forward range sum without slice | range-large: -17.1% / -17.5%; range-small: -8.4% / -14.5% | accept |
| 2 | Reuse normalized open labels | reconcile-wide: -22.6% / -20.8%; reconcile-small: +1.6% / +4.7% | accept |
| 3 | Single text-block fast path | coalesced-single: -86.7% / -86.5%; coalesced-mixed: -0.6% / -1.8%; coalesced-multi: -1.8% / -0.5% | accept |
| 4 | Stable anchor-priority buckets | anchor-mixed: -8.8% / -4.8%; anchor-small: -1.0% / -0.8% | inconclusive |
| 5 | Parse each deliverable label once | unresolved-wide: -50.2% / -50.1%; unresolved-small: -45.9% / -47.9% | accept |
| 6 | Memoize repeated source-quote checks | ground-repeated: -90.8% / -91.4%; ground-unique: +12.6% / +12.0%; ground-small: -51.7% / -49.0% | reject |
| 7 | Bounded-suffix payload marker scan | payload-repeated: -0.6% / +3.3%; payload-unique: +4.2% / +0.6%; payload-small: -0.2% / -0.2% | inconclusive |
| 8 | Delay repeat-marker allocation | fold-unique: -1.3% / -5.7%; fold-repeated: +0.8% / -0.4%; fold-small: -9.5% / -2.2% | inconclusive |
| 9 | Emit nested wire text directly | wire-nested: -18.5% / -18.4%; wire-flat: +1.6% / +0.8% | accept |
| 10 | Direct canonical UTF-8 hashing | hash-large: -14.8% / -11.9%; hash-small: -7.1% / -8.8% | accept |

Round 1 was refined before its final measurements to preserve sparse/inherited-array slot behavior. The first draft timings are superseded by the final round-1 measurements above. Round 6 is rejected despite a large repeated-quote benefit because unique quotes regress by about 12%. No rejected/inconclusive implementation is in the runtime payload.

## Research reset after rounds 6–8

The third consecutive no-gain decision occurred at 2026-10-06 11:11:37 UTC. New browsing at approximately 11:12 UTC preceded round 9. Prior context-management sources and V8 implementation work were reconsidered; without live quality/cost evidence, content-policy changes stayed out of scope. The direction changed from prompt scan/caching experiments to eliminating intermediate protocol representations.

- [Keiser and Lemire, On-Demand JSON](https://arxiv.org/abs/2312.17149), submitted 2023-12-28, revised 2024-08-01: lazy materialization as an engineering idea
- [simdjson On-Demand design](https://github.com/simdjson/simdjson/blob/master/doc/ondemand_design.md): mature implementation and explicit order/validation tradeoffs
- [Mison, VLDB 2017](https://www.microsoft.com/en-us/research/publication/mison-fast-json-parser-data-analytics/): avoiding unnecessary representation work
- [V8 JSON.stringify engineering](https://v8.dev/blog/json-stringify), 2025-08-04: optimized native primitives make handwritten replacements workload-dependent
- [Node 24 Hash.update](https://nodejs.org/docs/latest-v24.x/api/crypto.html#hashupdatedata-inputencoding): direct UTF-8 string input is supported

Only the narrow materialization idea is transferred; these papers/libraries are not integrated and their reported speedups are not attributed to this plugin. Round 9 preserves every emitted text byte, separator, tool ID and error marker. Round 10 preserves the canonical UTF-8 hash.

## Final combined candidate versus main

| Workload | Baseline median µs A / B | Candidate median µs A / B | Median paired change A / B | Wins A / B |
|---|---:|---:|---:|---:|
| range-large | 5.836 / 6.078 | 5.174 / 5.638 | -11.8% / -13.4% | 11/11 / 10/11 |
| range-small | 0.131 / 0.139 | 0.121 / 0.117 | -7.7% / -14.0% | 10/11 / 11/11 |
| reconcile-wide | 998.412 / 1026.707 | 706.700 / 702.914 | -27.2% / -32.0% | 11/11 / 11/11 |
| reconcile-small | 9.676 / 9.762 | 9.030 / 8.856 | -8.1% / -9.6% | 11/11 / 11/11 |
| coalesced-single | 0.096 / 0.106 | 0.012 / 0.014 | -86.9% / -87.2% | 11/11 / 11/11 |
| coalesced-mixed | 41.466 / 43.568 | 40.603 / 45.280 | -0.3% / +3.2% | 7/11 / 3/11 |
| coalesced-multi | 2.355 / 2.428 | 2.432 / 2.473 | +2.0% / +0.1% | 4/11 / 5/11 |
| unresolved-wide | 370.131 / 365.778 | 186.304 / 181.877 | -48.7% / -51.1% | 11/11 / 11/11 |
| unresolved-small | 2.341 / 2.146 | 1.254 / 1.086 | -46.9% / -49.5% | 11/11 / 11/11 |
| wire-nested | 32.781 / 29.445 | 27.422 / 25.408 | -15.7% / -13.7% | 10/11 / 11/11 |
| wire-flat | 1.336 / 1.175 | 1.263 / 1.178 | -5.3% / +0.6% | 8/11 / 4/11 |
| hash-large | 1125.409 / 1085.620 | 969.211 / 917.035 | -14.3% / -13.0% | 10/11 / 11/11 |
| hash-small | 1.949 / 1.739 | 1.844 / 1.662 | -5.4% / -4.8% | 10/11 / 10/11 |

The very large percentage for the single-block helper is a small absolute saving (roughly 0.08 µs per call). Benefits depend on workload frequency. Sidecar serialization gains apply when that path is used; they do not imply the default native path gets that benefit.

## Correctness and verification boundaries

- 1,676 deterministic baseline/candidate cases per early round; 1,678 after adding the two hash workloads. The final composed diagnostic adds one further case
- 1,178 independent adversarial differential cases passed, covering split markers, nested blocks, first-occurrence identity, normalized label collisions, chronology, sparse/numeric inputs, Unicode and public priority-array mutation
- Public CI runs 5 unit tests, including the frozen 1,678-case output digest. It intentionally mocks only the DSH checkpoint predicate and pairing boundary seam; this is not native integration coverage
- The cloud differential runs used the actual installed DSH 0.2.0-rc.2 modules
- The original three cancellation tests fail at fixture-format assertions on both unchanged main and the candidate in this cloud DSH installation. Their fixture assumed nested tool-result messages; this installation emits role=tool and a compact-checkpoint source marker
- A separate, format-compatible cancellation suite passes all 3 cases on baseline and candidate: before start, during summary, and before commit even if the mock adapter ignores abort. It preserves the original rollback assertions and is shipped as checks/native-cancellation.test.mjs
- The private full 54-test suite was not run. Its fixtures and frozen inventory are not public. Existing test files remain byte-for-byte unchanged; the runner resolves the inherited 0.1.22 fixture inventory for the new payload
- No live model call, production replay, remote sidecar exchange, token-cost comparison, or task-quality evaluation was performed. No new universal losslessness claim is made for model-written summaries

## Reproduce

Public dependency-free checks:

```sh
npm run check:packaging
npm run check:publication
npm run check:harness
npm run check:performance
```

CPU reproduction with an installed compatible DSH dependency tree available to Node (the release itself has no development dependencies):

```sh
mkdir -p results/cpu-baseline
git archive e656a68b2ea1c189d72b8997fa9b59b85397d248 packaging/adaptive-compact | tar -x -C results/cpu-baseline
npm run bench:cpu -- results/cpu-baseline/packaging/adaptive-compact packaging/adaptive-compact reconcile results/reconcile.json
npm run check:native-cancellation
```

Run each affected group (`range`, `reconcile`, `coalesced`, `unresolved`, `wire`, `hashing`) in two fresh processes on an idle machine. The public unit seam can be opted into for dependency-free microbenchmarks with `node --import ./checks/performance-seams.mjs scripts/bench-cpu.mjs ...`; those seam timings are not the real-DSH results reported above. Raw local timing records stay under ignored results/.

## Packaging and review

0.1.23 is generated from the reviewed loose sources and the unchanged bundled artifact-store. The two historical 0.1.22 archives are retained unchanged and pinned by digest. Schema-2 integrity records preserve their provenance and list each new changed file with before/after hashes. The strict verifier checks inventory, syntax, package operational fields, archive paths and reproducible packaging. Packaging used Python 3.12.14 and zlib 1.3.2; exact gzip reproduction can require a matching compression toolchain. CI also exercises archive/provenance negatives and exact commit-identity checks. The author must retain a user GitHub noreply address. Only the committer slot additionally accepts GitHub’s exact server no-reply identity, with the name GitHub; lookalike addresses/names, author-slot use, personal emails and personal content remain rejected. A passed hash check is not a passed correctness or code review.

The PR must receive an explicit completed Codex review for its latest commit, have no unresolved review findings, pass all required checks, and have no conflicts before merge. Silence, reaction-only acknowledgment, an old review, and these offline checks are insufficient.
