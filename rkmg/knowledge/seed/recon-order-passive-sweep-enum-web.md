---
id: recon-order-passive-sweep-enum-web
source: seed
kind: planning
tool: 
title: "recon order: passive -> sweep -> enum -> web"
tags: ["planning", "recon", "methodology"]
---
Correct order: passive (whois/dig/cert) → port sweep (masscan/rustscan) → service enum (nmap -sV on open ports) → web fingerprint (whatweb) → targeted checks. Never start with loud tools.
