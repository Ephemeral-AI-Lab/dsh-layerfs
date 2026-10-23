# Shop: conversion

Written by `node tools/replay/convert.mjs shop` from `0c7d9c47c1^` of the layerfs repository (`dsh/scenarios/shop/`). Rerun it to rewrite this folder; do not edit by hand.

Form `cli`: every bash step is plain `layerfs` lines. Each step that runs a command creates its own Sandbox from the recorded runtime image (`image`), mounts a new Workspace, runs, Commits, unmounts and closes the Sandbox. The recorded outcome codes are each step's `expect`, checked live; the record id is each step's `note`.

| | count |
| --- | ---: |
| recorded steps (bash) | 18 |
| bash steps kept | 17 |
| coordination steps (subagent, send_message, reply) | 0 |
| steps in all | 17 |
| turns left with no call: the reply alone, no echo | 0 |
| commands recorded | 12 |
| dropped: identical re-run on an unchanged Branch | 0 |
| dropped: verification off (not applied) | 0 |
| dropped: date-dependent | 0 |
| commands kept | 12 |
| recorded seconds of the commands kept | 21.6 |
| recorded seconds of all commands | 21.6 |
| Workspace mounts now / recorded | 12 / 12 |
| Workspace Commits kept / recorded | 12 / 12 |
| Sandbox creates now / recorded | 11 / 1 (+10) |
| recorded Committed Commits this scenario does not make | 0 (0 not optional in the recorded history) |
| writes (fs.apply) | 10 |
| forks from a recorded Commit: own id / a reply's id / Branch head | 0 / 0 / 0 |
| forks from a Layer of main (now main's head) | 0 |

Forks from a recorded Commit or Layer:

- none

Workspaces the record had mounted on one Branch at once, kept together in one step:

- catalog /workspaces/3 and catalog /workspaces/4: records 010

Commands dropped as identical re-runs (step: same as step):

- none

Commands dropped as date-dependent:

- none

Commands kept that repeat an earlier kept command on the same Branch, and why they run again:

- none

