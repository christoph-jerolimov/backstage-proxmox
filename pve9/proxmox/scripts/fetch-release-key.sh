#!/bin/sh
# Download the Proxmox VE apt repository signing key and install it as a
# keyring for use with "signed-by=" in the apt sources list.
#
# Usage: fetch-release-key.sh <debian-suite> <output-keyring>
#
# Why not just "curl https://download.proxmox.com/debian/proxmox-release-<suite>.gpg"?
# download.proxmox.com does not present a TLS certificate that covers that
# hostname, so curl aborts the build with
#
#   curl: (60) SSL: no alternative certificate subject name matches target
#   host name 'download.proxmox.com'
#
# Proxmox publishes the same key over working HTTPS on enterprise.proxmox.com
# (that is the host the Proxmox VE admin guide tells you to wget it from), so
# that is tried first. The file name also differs between releases: Proxmox VE
# 9 / trixie ships it as proxmox-archive-keyring-<suite>.gpg, older releases as
# proxmox-release-<suite>.gpg — both spellings are tried.
#
# Set PROXMOX_KEY_URL to fetch the key from somewhere else entirely (internal
# mirror, air-gapped build host, ...); it is tried before everything else.

set -eu

suite="${1:?usage: fetch-release-key.sh <debian-suite> <output-keyring>}"
out="${2:?usage: fetch-release-key.sh <debian-suite> <output-keyring>}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for url in \
  ${PROXMOX_KEY_URL:-} \
  "https://enterprise.proxmox.com/debian/proxmox-release-${suite}.gpg" \
  "https://enterprise.proxmox.com/debian/proxmox-archive-keyring-${suite}.gpg" \
  "https://download.proxmox.com/debian/proxmox-release-${suite}.gpg" \
  "https://download.proxmox.com/debian/proxmox-archive-keyring-${suite}.gpg"
do
  echo "Fetching Proxmox release key: ${url}"
  if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 60 "${url}" -o "${tmp}"; then
    echo "  -> download failed, trying next source" >&2
    continue
  fi
  # Make sure we got an OpenPGP key and not an error page or a redirect.
  if ! gpg --show-keys --with-colons "${tmp}" >/dev/null 2>&1; then
    echo "  -> not a valid OpenPGP key, trying next source" >&2
    continue
  fi
  install -D -m 0644 "${tmp}" "${out}"
  echo "Installed ${out}:"
  gpg --show-keys --with-fingerprint "${out}"
  exit 0
done

cat >&2 <<ERR
Could not download the Proxmox release key for Debian suite '${suite}'.

If this build runs behind a TLS-intercepting proxy, add the proxy CA to the
image (or the build environment) instead of disabling verification, or point
PROXMOX_KEY_URL at a reachable copy of the key, e.g.

  podman compose build --build-arg PROXMOX_KEY_URL=https://mirror.example.com/proxmox-release-${suite}.gpg
ERR
exit 1
