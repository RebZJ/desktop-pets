# Synthetic 60-minute meeting validation — 13 November 2026

The paced workload completed on the real packaged Tauri debug host and its release-built native worker: **240 of 240 chunks processed over 3,600.013 actual seconds**, with **zero core runtime errors**. The complete recording subsequently passed through Whisper, Nemotron diarization and hierarchical notes on the same worker. The initial final notes failed a completeness check. A separately timed notes-only regeneration on the unchanged transcript now passes all nine factual/format checks; the original failure remains preserved below.

## Workload and timing

A 35.283-second, four-turn macOS synthesized-voice fixture was repeated to one hour and delivered as 15-second PCM16 mono 16 kHz WAV chunks, one chunk per 15 wall-clock seconds. This used the application's real chunk handler, local models, database and finalizer through its token-protected loopback test bridge. No live microphone or meeting application was recorded. `caffeinate -i` prevented idle system sleep without waking the display.

| Observation | Result |
| --- | --- |
| Paced input | 3,600.013 seconds; 240/240 chunks processed |
| Chunk latency | Median 2.894 s; p95 7.865 s; maximum 44.021 s |
| Largest transient backlog | Three pending chunks; drained before finalization |
| Largest submission lateness | 165.476 ms |
| Real LLM tip attempts | 58 |
| Visible tips returned | Four; other attempts could remain quiet |
| Core host / native worker | Same observed PIDs 79549 / 79642 throughout the run |
| Final transcript | 444 segments; 54,525 characters; 0.24–3,599.58 s |

Paced recording ran from **2026-11-12 16:23:15.640 UTC** (03:23 Melbourne) to approximately 17:23:15 UTC. Finalization began at **17:23:21.370 UTC**. Its completion was observed between **17:39:04.169 and 17:39:34.340 UTC**: approximately **942.799–972.970 seconds after the original finalization request**. The backend does not store an exact completion timestamp; this is a polling bound, not a precise per-stage benchmark.

## Observer transport recovery

The original observer's `fetch` wait failed about five minutes into finalization. Node's bundled undici defaulted to a 300,000 ms response-header timeout despite the longer AbortSignal budget. The native job continued. Read-only polling recovered the result without restarting the host, repeating ASR, or rerunning the one-hour input.

The harness now uses Node's built-in `http.request`, explicit byte Content-Length, the requested socket timeout and a 16 MB response cap. Delayed-success and timeout checks passed; a separate **310.043-second** Unicode response also passed a 330-second budget. This observer error remains preserved separately from the zero observed core runtime errors. This was not an uninterrupted pass of the original observer implementation.

## Approximate synthetic speaker assessment

Assessment uses the repeated turn truth and final ASR/DTW transcript intervals. It excludes inter-turn truth gaps, forms union interval coverage, fits the best one-to-one anonymous-label mapping, and gives no correct credit to ambiguous or unassigned spans.

| Descriptive measure | Result |
| --- | --- |
| Truth turns | 409 |
| Truth-turn duration | 3,436.800 s |
| Transcript interval coverage within truth turns | 97.65% |
| Best-mapped label agreement on covered intervals | 97.96% |
| Correctly mapped coverage of all truth-turn intervals | 95.66% |
| Dominant label agreement per recognized turn | 100% |
| Within-turn label switches | 299 switches across 289 turns |
| Labels / ambiguous overlap | Two labels; 0.120 s of ambiguous overlap |

The label mapping was Speaker 1→reference voice 1 and Speaker 2→reference voice 2. Small boundary errors remain frequent even when a turn's dominant label is correct.

**These are not standard DER, word accuracy, or isolated diarizer accuracy.** The truth contains synthesized turns with internal pauses/padding; predictions derive from ASR/DTW words merged after diarization. This simple, repeated, noise-free, non-overlapping fixture cannot establish accuracy for real human meetings or compare models.

## Initial note-quality failure

The first hierarchical summary accumulated repeated timestamp citations and hit its 600-token output limit. Its summary paragraph retained the three expected tasks, but the tracked-action section contained only two tasks, ended mid-citation and omitted the Open questions heading. The initial output is preserved in `recovered-meeting.json`; it is **not counted as a complete note-quality pass**. Corrected summarization of the preserved full transcript is a separate follow-up check.

## Corrected notes-only follow-up

The coordinator corrected citation growth/completeness handling and calibrated task-first rules with a Mandarin field template. The updated actual host then regenerated notes on the **same 444-segment transcript**, without repeating paced input, ASR or diarization. Regeneration ran from **2026-11-12 18:22:51.641 to 18:28:55.295 UTC** and took **363.632 seconds**. This is a separate repair duration, not part of the original 942.799–972.970-second finalization bound.

All nine actual-host checks passed: four complete sections, Amina's release notes due Friday, Daniel's installer test due Friday, tutorial without an invented deadline, separate task rows, Monday launch decision, unresolved sound question, unchanged transcript and bounded citations. The repaired tracked actions are:

- Prepare release notes by Friday — Amina.
- Test the Mac installer by Friday — Daniel.
- Write the tutorial — Amina; no deadline agreed.

The unchanged transcript SHA-256 is `752c3e96c7953db559b012bfc8e662eccfbd2e7da0830d77c1e705326c194366`, independently verified against the original recorded result. The host/native processes were rebuilt and restarted for repair; the original PID-stability observation applies only to the original hour and initial finalization.

Actual-host Mandarin, Japanese and Spanish note fixtures also passed after calibration. Each kept its report/Friday task separate from its tutorial/no-agreed-deadline task and retained the Monday project decision. Their observed calls took **5.992 s**, **5.168 s** and **3.927 s**, respectively. These short configured-language checks do not establish full-hour or real-meeting accuracy in those languages.

`results.json` now records `releaseQualityPassed: true` and a separate `notesRepair` provenance object. It retains the initial `qualityErrors` and `initialQualityErrors`; `currentQualityErrors` is empty. The original first-generation notes, observer error and initial timing history remain unchanged. Evidence is `notes-repair.json`, `results-before-notes-repair.json` and `artifacts/runtime/notes-languages.json`.

## Machine context and evidence

This ran on an Apple M1 Pro Mac with 16 GB unified memory. Other applications and background services were active; a two-job release build also ran during the validation session. System swap was already reported as 18,786 MiB at startup and peaked at 20,386 MiB during the captured samples. Process RSS excludes important Metal/unified-memory allocations. These measurements cannot establish isolated application RAM requirements or absence of memory leaks. Resource collection has an observer-recovery gap during finalization.

This test does not validate live microphone/system capture, human voice quality, overlapping-speaker accuracy, cross-app Accessibility, physical shortcuts, third-party screen-share exclusion, or thermal behavior.

Local ignored evidence is under `artifacts/runtime/soak`: `results.json` separates core, observer and quality errors; `results-http-timeout.json` preserves the original failed observer; `events.jsonl`, `recovery-events.jsonl`, `recovery-completion.json`, `recovered-meeting.json`, and `speaker-assessment.json` retain the underlying observations. `artifacts/runtime/soak-quick` preserves the post-fix locked-screen tip regression. The stopped overlay attempt and the earlier timing-unit regression are separately archived and do not count toward the one-hour result.

Reproduce on an isolated running debug host after explicit model installation:

```sh
PACE_SOAK_SECONDS=3600 caffeinate -i node scripts/soak.mjs
```
