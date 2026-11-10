---
id: ffuf-ffuf-directory-content-brute
source: seed
kind: tool_usage
tool: ffuf
title: "ffuf directory/content brute"
tags: ["ffuf", "web", "directories"]
---
ffuf -u <url>/FUZZ -w <wordlist> -mc 200,301,302 -t 20 — filter noise with -mc/-fc. Common mistake: no -fc 404 drowning output in misses.
