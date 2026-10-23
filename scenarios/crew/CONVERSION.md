# Crew: conversion

Written by `node tools/replay/convert.mjs crew` from `0c7d9c47c1^` of the layerfs repository (`dsh/scenarios/crew/`). Rerun it to rewrite this folder; do not edit by hand.

| | count |
| --- | ---: |
| recorded steps (bash) | 1549 |
| steps kept | 533 |
| coordination steps (subagent, send_message, reply) | 613 |
| turns left with no call, kept by one `echo` | 84 |
| commands recorded | 304 |
| removed: identical re-run on an unchanged Branch | 0 |
| removed: verification off | 254 |
| commands kept | 50 |
| recorded seconds of the commands kept | 250.6 |
| recorded seconds of all commands | 2860.9 |
| Workspace mounts kept / recorded | 50 / 304 |
| Workspace Commits kept / recorded | 50 / 304 |
| recorded Committed Commits this replay does not make | 43 (0 not optional in the recorded history) |
| writes (fs.apply) | 219 |

Commands removed as identical re-runs (step: same as step):

- none

Commands kept that repeat an earlier kept command on the same Branch, and why they run again:

- none

Verification commands kept (install, or a Branch's last build or test):

- lead-013 L0: fresh Branch build syntax and four package tests (l0-verify; build, test; 2.7 s)
- lead-023 L0: published-main fresh-fork verification and source baseline (l0-main-check; build, test; 2.7 s)
- P1-0051 006 P-M1 final build and prepare tests exec (people.1; build; 1.6 s)
- P1-0063 009 P-M1 final affected tests and LOC exec (people.1; test; 3.3 s)
- lead-045 P-M1: integration install census build syntax and package tests (int-people-m1; install, build, test; 6.6 s)
- lead-061 L0: lifecycle integration install build tests and clean-stop proof (int-tools-shutdown; install, build, test; 6.9 s)
- W1-0037 004 W-M1 prepare syntax and build exec (work.2; build; 2.3 s)
- W1-0045 006 W-M1 combined all package tests exec (work.2; test; 4.8 s)
- lead-067 W-M1: integration install census build syntax and all package tests (int-work-m1; install, build, test; 8.2 s)
- W1-0081 013 W-M2 complete issue syntax bundle HTTP shared web CLI checks exec (work.3; build, test; 5.0 s)
- lead-082 W-M2: integration install census build syntax and all package tests (int-work-m2; install, build, test; 9.5 s)
- W1-0087 015 W-M3 actual HTTP CLI smoke and clean process restart proof exec (work.3; build; 4.1 s)
- W2-0109 W-M3 final complete package regression and frozen LOC (work.4; build, test; 10.5 s)
- P1b-0075 P1b 007 P-M2 actual HTTP smoke and process restart exec (people.2; build; 3.7 s)
- W2-0123 W-M3 final changed web regression and frozen production census (work.4; test; 0.4 s)
- P1b-0092 P1b 013 P-M3 current generation build and syntax exec (people.3; build; 3.1 s)
- P1c-010 P-04: build and syntax before changed verification execute (people.4; build; 3.2 s)
- I1-058 I-M3 shared HTTP web and actual token CLI search-filter proofs (insight.2; build, test; 6.8 s)
- I2-074 changed M2 actual CLI proof (insight.2; test; 2.1 s)
- I2-134 approved preview flag changed actual streamed import CLI proof (insight.3; build, test; 6.8 s)
- I2-145 final changed transfer date proof acceptance audit and source census (insight.3; test; 6.9 s)
- W1b-148 W-07: focused Markdown command selection and serialization proof (work.5; build, test; 5.4 s)
- W1b-166 W-07: final owned source hash ceiling and process custody after Markdown scopes (work.5; build; 0.4 s)
- P1d-161 P-05: 030 P-05 final cookie build and syntax exec (people.5; build; 5.5 s)
- P1d-173 P-05: 033 P-05 final source CLI package proof exec (people.5; test; 6.8 s)
- I2c-050 I-09: digest targeted due HTTP CLI proof (insight.4; test; 7.7 s)
- W1c-045 W09/W10: build and prepare hierarchy syntax before tests (work.6; build; 5.8 s)
- W1c-061 W09/W10: prepare and corrected pure and same-timestamp HTTP field resolution proofs (work.6; test; 6.5 s)
- I2c-083 I-09: final source counter physical and live-process census (insight.4; build; 0.4 s)
- P1e-059 P1e targeted HTTP and canonical work revision regression exec (people.6; test; 9.8 s)
- lead-327 L0: changed A13 census tooling proof and diagnostic current runtime smoke; formal acceptance remains open (lead-acceptance-review.1; build; 11.3 s)
- P1e-095 P1e final build and syntax exec (people.6; build; 6.1 s)
- I1c-045 I-11 I-12 product build and syntax before tests exec (insight.6; build; 6.2 s)
- I1d-087 I-13: build and prepare saved-filter view tests exec (insight.7; build; 6.7 s)
- I1d-091 I-13: focused canonical view and actual ownership CLI proof exec (insight.7; test; 4.3 s)
- P1f-028 people action lifetime: sandbox.exec (people-action-lifecycle-p1f.1; build; 6.7 s)
- lead-438 A01 reinstall: frozen acceptance command (acceptance; install; 1.6 s)
- lead-442 A02 build: frozen acceptance command (acceptance; build; 0.5 s)
- lead-450 A04 shared tests: frozen acceptance command (acceptance; test; 0.3 s)
- lead-492 A01 reinstall: frozen acceptance command (acceptance.2; install; 1.5 s)
- lead-496 A02 build: frozen acceptance command (acceptance.2; build; 0.5 s)
- lead-504 A04 shared tests: frozen acceptance command (acceptance.2; test; 0.3 s)
- lead-525 A01 reinstall: frozen acceptance command (acceptance.3; install; 1.7 s)
- lead-529 A02 build: frozen acceptance command (acceptance.3; build; 0.6 s)
- lead-537 A04 shared tests: frozen acceptance command (acceptance.3; test; 0.4 s)

