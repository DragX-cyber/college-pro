---
id: masscan-masscan-no-results-in-wsl
source: seed
kind: mistake
tool: masscan
title: "masscan no results in WSL"
tags: ["masscan", "wsl"]
---
If masscan returns nothing from WSL, the raw socket/interface may have failed. Verify with rustscan or nmap on a few known ports; try --rate 500 and a specific -p list.
