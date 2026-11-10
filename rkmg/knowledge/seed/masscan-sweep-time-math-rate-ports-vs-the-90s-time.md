---
id: masscan-sweep-time-math-rate-ports-vs-the-90s-time
source: seed
kind: command_syntax
tool: masscan
title: "sweep time math: rate × ports vs the 90s timeout"
tags: ["masscan", "timeout", "port_scan", "sweep"]
---
Full 65535-port sweep at --rate=500 needs ≥131s — the default command timeout is 90s, so it WILL be killed. Fix: raise the rate (--rate=2000 → ~35s), narrow the port list (-p 1-1000), or pass "timeoutMs":240000 on the shell action. Timed-out output still lists ports found so far — parse it, never re-run the identical sweep.
