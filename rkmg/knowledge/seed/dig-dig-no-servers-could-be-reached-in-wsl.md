---
id: dig-dig-no-servers-could-be-reached-in-wsl
source: seed
kind: mistake
tool: dig
title: "dig no servers could be reached in WSL"
tags: ["dig", "dns", "wsl"]
---
WSL NAT resolvers sometimes fail. Retry with an explicit resolver: dig @1.1.1.1 <domain> +short. nslookup uses the same resolver — same fix.
