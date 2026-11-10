---
id: listener-before-payload-always
source: seed
kind: planning
tool: 
title: "listener BEFORE payload, always"
tags: ["planning", "payload", "revshell", "listener", "handler"]
---
Start the handler (nc -lvnp PORT / msf multi/handler / socat) BEFORE firing any reverse shell, or the connection dies instantly and you burn the attempt. The generate_payload action returns the matching HANDLER line — run it first.
