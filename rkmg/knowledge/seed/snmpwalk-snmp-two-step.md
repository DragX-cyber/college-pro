---
id: snmpwalk-snmp-two-step
source: seed
kind: command_syntax
tool: snmpwalk
title: "SNMP two-step"
tags: ["snmpwalk", "onesixtyone", "snmp"]
---
First onesixtyone <host> for community brute (public/private), then snmpwalk -v2c -c <community> <host> to dump OIDs. SNMP without a valid community returns nothing.
