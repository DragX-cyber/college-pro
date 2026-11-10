#!/usr/bin/env python3
"""
REDLINE — charter_add.py (operator tooling)

Add, remove or list targets in the platform's charter (lab/charter.yaml).
The AI agent can NEVER edit the charter: when the agent tried to widen its
own scope by running this script in its terminal, the guard refused the
command for exactly that reason. This script is for the operator only.

Usage:
    python charter_add.py add <host> [--detect]
    python charter_add.py remove <host>
    python charter_add.py list

Examples:
    python charter_add.py add pentest-ground.com --detect
    python charter_add.py add 178.79.134.182
    python charter_add.py remove google.com
"""
import argparse
import json
import os
import socket
import sys

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

CHARTER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lab", "charter.yaml")


def load():
    if not os.path.exists(CHARTER_PATH):
        sys.exit(f"charter not found at {CHARTER_PATH}")
    with open(CHARTER_PATH, "r", encoding="utf-8") as f:
        if HAS_YAML:
            return yaml.safe_load(f)
        sys.exit("PyYAML is required: pip install pyyaml")


def save(data):
    with open(CHARTER_PATH, "w", encoding="utf-8") as f:
        if HAS_YAML:
            yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
        else:
            json.dump(data, f, indent=2)


def norm(host: str) -> str:
    h = host.strip().lower()
    for sep in ("://",):
        if sep in h:
            h = h.split(sep, 1)[1]
    h = h.split("/")[0].split("?")[0]
    h = h.replace("[", "").replace("]", "")
    if ":" in h and not h.count(":") > 1:
        h = h.rsplit(":", 1)[0]
    return h


def resolve(host: str):
    try:
        infos = socket.getaddrinfo(host, None)
        return sorted({i[4][0] for i in infos})
    except Exception:
        return []


def tcp_probe(ip: str, port: int, timeout: float = 0.9) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except Exception:
        return False


def add(host: str, detect: bool):
    data = load()
    h = norm(host)
    if not h:
        sys.exit(f"'{host}' is not a valid host")
    hosts = data.setdefault("scope", {}).setdefault("hosts", [])
    if h in hosts:
        print(f"[=] {h} is already chartered")
    else:
        hosts.append(h)
        ips = resolve(h) if not _is_ip(h) else [h]
        if ips:
            data["scope"].setdefault("hosts_map", {})[h] = ips
            networks = data["scope"].setdefault("networks", [])
            for ip in ips:
                cidr = f"{ip}/128" if ":" in ip else f"{ip}/32"
                if cidr not in networks:
                    networks.append(cidr)
        save(data)
        print(f"[+] chartered host: {h}" + (f"  (resolves to {', '.join(ips)})" if ips else "  (no DNS — added without hosts_map)"))
        if not ips:
            print("    note: resolution failed. The two-sided check will refuse this host until")
            print("          you add its IP to scope.networks or scope.hosts_map.")

    if detect:
        ips = data.get("scope", {}).get("hosts_map", {}).get(h) or ([h] if _is_ip(h) else [])
        if not ips:
            print("[!] --detect: nothing to probe (no resolved IP)")
            return
        found = []
        for port in (22, 80, 443, 3306, 8080):
            if tcp_probe(ips[0], port):
                found.append(f"tcp/{port} open")
        print(f"[*] detect on {ips[0]}: " + (", ".join(found) if found else "no common ports open"))


def _is_ip(h: str) -> bool:
    try:
        socket.inet_pton(socket.AF_INET, h)
        return True
    except OSError:
        pass
    try:
        socket.inet_pton(socket.AF_INET6, h)
        return True
    except OSError:
        return False


def remove(host: str):
    data = load()
    h = norm(host)
    hosts = data.get("scope", {}).get("hosts", [])
    if h not in hosts:
        sys.exit(f"{h} is not in the charter")
    data["scope"]["hosts"] = [x for x in hosts if x != h]
    data["scope"].get("hosts_map", {}).pop(h, None)
    save(data)
    print(f"[-] removed {h} from charter")


def listing():
    data = load()
    scope = data.get("scope", {})
    print("CHARTER — lab/charter.yaml")
    print(f"  hosts:     {', '.join(scope.get('hosts', [])) or '(none)'}")
    print(f"  networks:  {', '.join(scope.get('networks', [])) or '(none)'}")
    hm = scope.get("hosts_map", {})
    if hm:
        print("  hosts_map:")
        for k, v in hm.items():
            print(f"    {k} -> {', '.join(v)}")
    roe = data.get("rules_of_engagement", {})
    print(f"  RoE: max_concurrent={roe.get('max_concurrent_actions')} "
          f"rate/min={roe.get('rate_limit_per_minute')} "
          f"destructive={roe.get('destructive_actions')}")


def main():
    p = argparse.ArgumentParser(description="REDLINE charter operator tooling")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add"); a.add_argument("host"); a.add_argument("--detect", action="store_true")
    r = sub.add_parser("remove"); r.add_argument("host")
    sub.add_parser("list")
    args = p.parse_args()
    if args.cmd == "add":
        add(args.host, args.detect)
    elif args.cmd == "remove":
        remove(args.host)
    else:
        listing()


if __name__ == "__main__":
    main()
