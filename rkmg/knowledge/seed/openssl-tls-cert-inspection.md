---
id: openssl-tls-cert-inspection
source: seed
kind: tool_usage
tool: openssl
title: "TLS cert inspection"
tags: ["openssl", "tls", "recon"]
---
openssl s_client -connect host:443 -brief </dev/null — shows cert chain, issuer, expiry. Useful for recon and finding internal names in SANs.
