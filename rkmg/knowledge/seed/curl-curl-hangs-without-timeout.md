---
id: curl-curl-hangs-without-timeout
source: seed
kind: mistake
tool: curl
title: "curl hangs without timeout"
tags: ["curl", "timeouts"]
---
A curl without --max-time can hang until the command budget kills it and you lose the output. Always add --max-time (5-15s).
