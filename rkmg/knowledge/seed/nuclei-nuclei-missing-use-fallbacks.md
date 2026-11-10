---
id: nuclei-nuclei-missing-use-fallbacks
source: seed
kind: mistake
tool: nuclei
title: "nuclei missing — use fallbacks"
tags: ["nuclei", "vuln_scan", "fallback"]
---
If the strategy board names nuclei but it is not installed, do NOT give up: use nmap --script vuln <host>, searchsploit <software> <version> after service enum, and manual checks (curl -I, version-vs-CVE reasoning). Say which fallback you chose in your thought.
