---
id: pipeline-sweep-feeds-enum
source: seed
kind: planning
tool: 
title: "pipeline: sweep feeds enum"
tags: ["planning", "port_scan", "service_enum", "pipeline"]
---
masscan/rustscan find open ports fast; nmap -sV -p <ports> deep-enums them. Running nmap on all ports OR skipping deep enum after a sweep are both mistakes.
