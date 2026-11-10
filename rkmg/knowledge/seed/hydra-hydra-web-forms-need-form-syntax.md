---
id: hydra-hydra-web-forms-need-form-syntax
source: seed
kind: mistake
tool: hydra
title: "hydra web forms need form syntax"
tags: ["hydra", "web", "creds"]
---
HTTP form brute needs: hydra -L users -P pass host http-post-form "/login:user=^USER^&pass=^PASS^:F=failed-text". Without the failure string it reports everything as success.
