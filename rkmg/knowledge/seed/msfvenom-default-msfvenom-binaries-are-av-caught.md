---
id: msfvenom-default-msfvenom-binaries-are-av-caught
source: seed
kind: mistake
tool: msfvenom
title: "default msfvenom binaries are AV-caught"
tags: ["msfvenom", "payload", "av", "detection"]
---
Plain msfvenom EXEs match every AV signature. For detection testing in authorized labs use -x <legit binary> template, custom shellcode runners, or stageless powershell. Never assume a default payload lands — test detection first.
