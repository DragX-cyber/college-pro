---
id: reverse-shell-selection-guide
source: seed
kind: planning
tool: 
title: "reverse shell selection guide"
tags: ["planning", "payload", "revshell", "selection"]
---
bash /dev/tcp when no tools; python3 one-liner (with pty.spawn) as default on Linux; powershell TCP client on Windows (deliver via -enc base64); nc -e only with traditional netcat (openbsd nc has no -e — use the mkfifo pipe fallback). After landing: TTY upgrade (python3 pty.spawn + stty raw -echo; fg).
