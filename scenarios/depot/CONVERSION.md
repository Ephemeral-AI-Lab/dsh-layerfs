# Depot: conversion

Written by `node tools/replay/convert.mjs depot` from `0c7d9c47c1^` of the layerfs repository (`dsh/scenarios/depot/`). Rerun it to rewrite this folder; do not edit by hand.

| | count |
| --- | ---: |
| recorded steps (bash) | 102 |
| steps kept | 102 |
| coordination steps (subagent, send_message, reply) | 0 |
| turns left with no call, kept by one `echo` | 0 |
| commands recorded | 82 |
| removed: identical re-run on an unchanged Branch | 0 |
| removed: verification off (not applied) | 0 |
| commands kept | 82 |
| recorded seconds of the commands kept | 351.7 |
| recorded seconds of all commands | 351.7 |
| Workspace mounts kept / recorded | 12 / 12 |
| Workspace Commits kept / recorded | 82 / 82 |
| recorded Committed Commits this replay does not make | 0 (0 not optional in the recorded history) |
| writes (fs.apply) | 9 |

Commands removed as identical re-runs (step: same as step):

- none

Commands kept that repeat an earlier kept command on the same Branch, and why they run again:

- 010-m1-unchanged-build: same as 009-m1-cli-first-build; the Branch changed since (a write or a Commit recorded as Committed)
- 019-m3-server-build: same as 008-m1-server-first-build; the Branch changed since (a write or a Commit recorded as Committed)
- 020-m3-cli-build: same as 010-m1-unchanged-build; the Branch changed since (a write or a Commit recorded as Committed)
- 044-m6-candidate: same as 034-m5-merged-rebuild; the Branch changed since (a write or a Commit recorded as Committed)
- 068-m6-candidate: same as 036-m5-chromium-browser; the Branch changed since (a write or a Commit recorded as Committed)

