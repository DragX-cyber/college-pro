---
id: tshark-beacon-c2-periodicity-hunt
source: seed
kind: tool_usage
tool: tshark
title: "beacon/C2 periodicity hunt"
tags: ["tshark", "beacon", "c2", "detection", "sniff"]
---
Hunt implant beacons with inter-arrival analysis: tshark -r f.pcap -T fields -e frame.time_epoch -e ip.src -e ip.dst | awk (aggregate per src->dst; n>5 packets with near-constant 1-120s intervals = PERIODIC). Then follow,tcp that pair. The generate_payload action (kind sniff_beacon_hunt) renders the full pipeline.
