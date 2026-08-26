#!/usr/bin/env bash
# Seeds this single-node Proxmox VE dev instance with test data:
#
#   * users, groups, custom roles and ACLs (different permission levels)
#   * API tokens with well-known secrets (exported to /seed-output/tokens.env)
#   * resource pools and storages
#   * QEMU VMs and LXC containers (config-only, they stay stopped)
#
# Runs once on first boot via pve-seed.service; a marker file in the
# persisted /var/lib/vz volume prevents re-seeding on restarts. The root
# password is (re-)applied on every boot.
set -uo pipefail

MARKER=/var/lib/vz/.pve-seed-done
OUT_DIR=/seed-output
API=https://127.0.0.1:8006/api2/json

# Well-known token secrets so README examples are copy-pasteable.
# DEV/TEST ONLY — never do this on a real Proxmox host.
SECRET_FULL_ACCESS="00000000-0000-4000-8000-000000000001"
SECRET_READONLY="00000000-0000-4000-8000-000000000002"
SECRET_VM_ADMIN="00000000-0000-4000-8000-000000000003"
SECRET_AUDITOR="00000000-0000-4000-8000-000000000004"

log() { echo "[pve-seed] $*"; }

# The container environment is only visible on PID 1; systemd services do
# not inherit it, so read it from there.
env_from_pid1() {
  tr '\0' '\n' </proc/1/environ 2>/dev/null | sed -n "s/^$1=//p" | head -n1
}

run() {
  log "+ $*"
  "$@" || log "WARN: command failed (continuing): $*"
}

log "waiting for the Proxmox VE API to come up ..."
for _ in $(seq 1 120); do
  pvesh get /version >/dev/null 2>&1 && break
  sleep 2
done
if ! pvesh get /version >/dev/null 2>&1; then
  log "ERROR: Proxmox API did not come up, aborting"
  exit 1
fi

# root@pam password (web UI + API login), re-applied on every boot because
# /etc/shadow is not persisted across container re-creation.
ROOT_PASSWORD=$(env_from_pid1 PVE_ROOT_PASSWORD)
ROOT_PASSWORD=${ROOT_PASSWORD:-proxmox}
echo "root:${ROOT_PASSWORD}" | chpasswd
log "root@pam password applied"

if [ -f "$MARKER" ]; then
  log "instance already seeded, nothing to do"
  exit 0
fi

NODE=$(hostname)
mkdir -p "$OUT_DIR"

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------
log "configuring storages ..."
LOCAL_CONTENT="iso,vztmpl,snippets,backup,images,rootdir"
if pvesm status --storage local >/dev/null 2>&1; then
  run pvesm set local --content "$LOCAL_CONTENT"
else
  run pvesm add dir local --path /var/lib/vz --content "$LOCAL_CONTENT"
fi
mkdir -p /srv/pve-backup
pvesm status --storage backup >/dev/null 2>&1 \
  || run pvesm add dir backup --path /srv/pve-backup --content backup \
       --prune-backups keep-last=3

# ---------------------------------------------------------------------------
# Roles, groups, users, ACLs
# ---------------------------------------------------------------------------
log "creating custom roles ..."
run pveum role add BackstageAuditor \
  --privs "VM.Audit,Sys.Audit,Datastore.Audit,Pool.Audit"
run pveum role add VMOperator \
  --privs "VM.Audit,VM.PowerMgmt,VM.Console"

log "creating groups ..."
run pveum group add admins --comment "Full administrators"
run pveum group add devops --comment "VM administrators (scoped to /vms)"
run pveum group add readonly --comment "Read-only auditors"

log "creating users ..."
run pveum user add alice@pve --password "alice12345" \
  --firstname Alice --lastname Admin --email alice@example.com \
  --groups admins --comment "Test user: full administrator"
run pveum user add bob@pve --password "bob1234567" \
  --firstname Bob --lastname Builder --email bob@example.com \
  --groups devops --comment "Test user: VM admin on /vms only"
run pveum user add carol@pve --password "carol12345" \
  --firstname Carol --lastname Reader --email carol@example.com \
  --groups readonly --comment "Test user: read-only auditor"
run pveum user add svc-backstage@pve \
  --comment "Service account for the Backstage Proxmox plugin (token-only, no password)"

log "assigning permissions (ACLs) ..."
run pveum acl modify / --groups admins --roles Administrator
run pveum acl modify / --groups readonly --roles PVEAuditor
run pveum acl modify /vms --groups devops --roles PVEVMAdmin
run pveum acl modify /vms --groups devops --roles VMOperator
run pveum acl modify /storage/local --groups devops --roles PVEDatastoreUser
run pveum acl modify / --users svc-backstage@pve --roles BackstageAuditor

# ---------------------------------------------------------------------------
# Pools
# ---------------------------------------------------------------------------
log "creating resource pools ..."
run pveum pool add pool-dev --comment "Development workloads"
run pveum pool add pool-prod --comment "Production-ish workloads"

# ---------------------------------------------------------------------------
# Guests (config-only; they are never started inside this container)
# ---------------------------------------------------------------------------
log "creating QEMU VMs ..."
run qm create 101 --name web-01 --memory 2048 --cores 2 --sockets 1 \
  --ostype l26 --net0 virtio,bridge=vmbr0 --tags "web;dev" \
  --pool pool-dev --description "Seeded test VM (dev web server)"
run qm create 102 --name db-01 --memory 4096 --cores 4 --sockets 1 \
  --ostype l26 --net0 virtio,bridge=vmbr0 --tags "db;prod" \
  --pool pool-prod --description "Seeded test VM (prod database)"

log "creating LXC container configs ..."
make_ct() {
  local vmid="$1" name="$2" memory="$3" tags="$4" mac="$5"
  cat > "/etc/pve/lxc/${vmid}.conf" <<EOF
arch: amd64
cores: 1
hostname: ${name}
memory: ${memory}
net0: name=eth0,bridge=vmbr0,ip=dhcp,hwaddr=${mac},type=veth
ostype: debian
rootfs: local:${vmid}/vm-${vmid}-disk-0.raw,size=4G
swap: 256
tags: ${tags}
unprivileged: 1
EOF
}
make_ct 201 cache-01 512 "cache;dev" "BC:24:11:00:02:01"
make_ct 202 proxy-01 1024 "proxy;prod" "BC:24:11:00:02:02"
run pvesh set /pools/pool-dev --vms 201
run pvesh set /pools/pool-prod --vms 202

# ---------------------------------------------------------------------------
# API tokens
# ---------------------------------------------------------------------------
# pveum generates a random secret. For a copy-pasteable dev setup we then
# overwrite it in /etc/pve/priv/token.cfg with a well-known value and verify
# it against the live API; if pinning fails we fall back to the generated
# secret. The effective secrets are exported to /seed-output/tokens.env.
TOKENS_ENV="$OUT_DIR/tokens.env"
: > "$TOKENS_ENV"
{
  echo "# Proxmox VE dev instance — API tokens (seeded $(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "# Usage: source seed-output/tokens.env"
  echo "PVE_URL=https://localhost:8006/api2/json"
} >> "$TOKENS_ENV"

token_verify() {
  curl -kfs --max-time 10 \
    -H "Authorization: PVEAPIToken=$1=$2" "$API/version" >/dev/null 2>&1
}

make_token() {
  local user="$1" name="$2" privsep="$3" comment="$4" wanted="$5" envvar="$6"
  local tid="${user}!${name}" generated="" secret=""

  log "creating API token ${tid} (privsep=${privsep}) ..."
  generated=$(pveum user token add "$user" "$name" \
      --privsep "$privsep" --comment "$comment" \
      --output-format json 2>/dev/null | jq -r '.value // empty')

  # Pin the well-known secret in the (plaintext) token secret store.
  if [ -f /etc/pve/priv/token.cfg ]; then
    awk -v tid="$tid" -v s="$wanted" '$1 == tid { $2 = s } { print }' \
        /etc/pve/priv/token.cfg > /tmp/token.cfg.new \
      && cat /tmp/token.cfg.new > /etc/pve/priv/token.cfg
    rm -f /tmp/token.cfg.new
  fi

  for candidate in "$wanted" "$generated"; do
    [ -n "$candidate" ] || continue
    if token_verify "$tid" "$candidate"; then
      secret="$candidate"
      break
    fi
  done

  if [ -n "$secret" ]; then
    echo "${envvar}='PVEAPIToken=${tid}=${secret}'" >> "$TOKENS_ENV"
    log "token ${tid} ready (secret ${secret})"
  else
    log "WARN: token ${tid} could not be verified against the API"
  fi
}

# privsep=0: token inherits all permissions of its user.
# privsep=1: token only gets permissions granted to the token itself.
make_token root@pam full-access 0 "Full access (inherits root)" \
  "$SECRET_FULL_ACCESS" PVE_TOKEN_FULL_ACCESS
make_token svc-backstage@pve readonly 1 "Backstage read-only token" \
  "$SECRET_READONLY" PVE_TOKEN_READONLY
make_token bob@pve vm-admin 1 "VM admin on /vms only" \
  "$SECRET_VM_ADMIN" PVE_TOKEN_VM_ADMIN
make_token carol@pve auditor 0 "Read-only (inherits carol)" \
  "$SECRET_AUDITOR" PVE_TOKEN_AUDITOR

# Privilege-separated tokens need their own ACLs.
run pveum acl modify / --tokens "svc-backstage@pve!readonly" --roles BackstageAuditor
run pveum acl modify /vms --tokens "bob@pve!vm-admin" --roles PVEVMAdmin

touch "$MARKER"
log "seeding finished — tokens exported to ${TOKENS_ENV}"
log "web UI: https://localhost:8006 (root / \$PVE_ROOT_PASSWORD)"
