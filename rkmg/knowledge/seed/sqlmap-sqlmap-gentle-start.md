---
id: sqlmap-sqlmap-gentle-start
source: seed
kind: command_syntax
tool: sqlmap
title: "sqlmap gentle start"
tags: ["sqlmap", "web", "sqli"]
---
sqlmap -u "<url with param>" --batch --level=1 --risk=1 — start low; escalate level/risk only if nothing found and you are authorized. Never against params outside charter.
