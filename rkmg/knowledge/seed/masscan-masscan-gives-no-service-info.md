---
id: masscan-masscan-gives-no-service-info
source: seed
kind: mistake
tool: masscan
title: "masscan gives no service info"
tags: ["masscan", "service_enum"]
---
masscan only finds OPEN ports — no banners or versions. Follow up with nmap -sV on the found ports; do not try to fingerprint with masscan.
