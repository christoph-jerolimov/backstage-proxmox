#!/usr/bin/env bash
# pmxcfs (pve-cluster) refuses to start when the hostname only resolves to a
# loopback address. Podman normally writes "<container-ip> pve" into
# /etc/hosts, but if it does not, add the entry ourselves.
set -eu

name=$(hostname)
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$ip" ] || exit 0

resolved=$(getent hosts "$name" | awk '{print $1}' | head -n1 || true)
case "$resolved" in
  "" | 127.* | ::1)
    printf '%s %s\n' "$ip" "$name" >> /etc/hosts
    ;;
esac
