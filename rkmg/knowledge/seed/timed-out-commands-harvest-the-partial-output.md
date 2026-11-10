---
id: timed-out-commands-harvest-the-partial-output
source: seed
kind: planning
tool: 
title: "timed-out commands: harvest the partial output"
tags: ["planning", "timeout", "timeouts", "output"]
---
When a command is killed at the timeout, its captured output so far is still returned. Streaming scanners (masscan/nmap) report findings as they go — extract what was found and CONTINUE (e.g. nmap -sV on those ports). Re-running the identical long command wastes the whole timeout again.
