---
id: cleartext-credential-hunting-in-pcaps
source: seed
kind: planning
tool: 
title: "cleartext credential hunting in pcaps"
tags: ["planning", "sniff", "pcap", "creds", "tshark"]
---
In capture order: conversations table (who is anomalous) → http.authorization or POST bodies (basic auth is base64 = cleartext) → exported HTTP objects (droppers/exfil files) → follow the suspicious TCP streams. The sniff_* arsenal generators chain these steps.
