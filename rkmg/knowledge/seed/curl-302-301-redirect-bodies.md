---
id: curl-302-301-redirect-bodies
source: seed
kind: command_syntax
tool: curl
title: "302/301 redirect bodies"
tags: ["curl", "redirect", "http", "302"]
---
A short "302 Moved Temporarily" body means the real page is behind a redirect — do not re-try headers, just add -L (follow redirects): curl -sL --max-time 10 <url>. One -L request replaces three guessing attempts.
