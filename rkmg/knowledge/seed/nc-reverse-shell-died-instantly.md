---
id: nc-reverse-shell-died-instantly
source: seed
kind: mistake
tool: nc
title: "reverse shell died instantly"
tags: ["nc", "revshell", "listener", "mistake"]
---
A reverse shell that connects and immediately dies = no listener was ready, or the shell crashed without a pty. Fix order: start nc -lvnp PORT first, fire payload, then TTY-upgrade immediately (python3 pty.spawn). If openbsd nc: no -e support — use the mkfifo method.
