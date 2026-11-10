---
id: parallel-recon-with-shell_batch
source: seed
kind: planning
tool: 
title: "parallel recon with shell_batch"
tags: ["planning", "parallel", "recon", "shell_batch", "batch"]
---
Fan out INDEPENDENT recon commands in one step: {"tool":"shell_batch","commands":["dig +short <host>","whois <host>","whatweb http://<ip>"]}. Results arrive together. Only independent commands — anything needing another command's output goes in a sequential shell step. Cap = charter max_concurrent_actions.
