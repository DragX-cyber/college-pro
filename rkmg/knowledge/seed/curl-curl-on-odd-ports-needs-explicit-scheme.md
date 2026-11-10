---
id: curl-curl-on-odd-ports-needs-explicit-scheme
source: seed
kind: mistake
tool: curl
title: "curl on odd ports needs explicit scheme"
tags: ["curl", "tls"]
---
Use http://host:port or https://host:port explicitly. On https with self-signed certs add -k or you get certificate errors instead of content.
