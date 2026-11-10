---
id: hydra-hydra-usage
source: seed
kind: command_syntax
tool: hydra
title: "hydra usage"
tags: ["hydra", "creds", "brute"]
---
hydra -l <user> -P <wordlist> <service>://<host> — cap threads with -t 4-8. One protocol per run; check the service is actually exposed first.
