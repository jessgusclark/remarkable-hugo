#!/usr/bin/env bash
# One-time droplet setup for remarkable-hugo. Run as root, safe to rerun:
#   sudo bash /tmp/setup-remarkable-hugo.sh /tmp/remarkable-hugo-deploy.pub
#
# Creates the app user, a per-app deploy user, /srv dirs, the env file stub,
# the restart-only sudoers line, the AllowUsers entry and an auditd watch.
# Does NOT install the systemd unit or nginx config (see deploy/README.md).
set -euo pipefail

APP=remarkable-hugo
APP_USER=remarkablehugo
DEPLOY_USER=deploy-remarkable-hugo
PUBKEY_FILE=${1:?usage: $0 /path/to/deploy-key.pub}

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
grep -q '^ssh-ed25519 ' "$PUBKEY_FILE" || { echo "$PUBKEY_FILE is not an ed25519 public key" >&2; exit 1; }
command -v git >/dev/null || apt-get install -y git

# --- users -------------------------------------------------------------------
if ! id "$APP_USER" &>/dev/null; then
  useradd --system --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$APP_USER"
fi
if ! id "$DEPLOY_USER" &>/dev/null; then
  # Needs a real shell: rsync and the activate script run through it.
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
passwd -l "$DEPLOY_USER" >/dev/null
# The deploy user must never be in the app group (it would read secrets).
if id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx "$APP_USER"; then
  echo "$DEPLOY_USER is in group $APP_USER; remove it" >&2; exit 1
fi

home=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
printf 'restrict %s\n' "$(cat "$PUBKEY_FILE")" > "$home/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"

# --- code dirs -----------------------------------------------------------------
# /srv/<app> is the boundary: deploy writes, app group reads, others nothing.
install -d -m 750 -o "$DEPLOY_USER" -g "$APP_USER" "/srv/$APP"
install -d -m 755 -o "$DEPLOY_USER" -g "$APP_USER" "/srv/$APP/releases"
# State (/var/lib/remarkable-hugo) is created by StateDirectory= in the unit.

# --- secrets stub --------------------------------------------------------------
env_file=/etc/apps/$APP.env
if [ ! -e "$env_file" ]; then
  install -d -m 755 /etc/apps
  cat > "$env_file" <<'EOF'
ANTHROPIC_API_KEY=
MAILGUN_SIGNING_KEY=
GITHUB_PAT=
ALLOWED_SENDER=
BLOG_REPO_URL=https://github.com/developerjesse/first-draft.git
BLOG_REPO_BRANCH=main
HOST=127.0.0.1
PORT=3002
REPO_DIR=/var/lib/remarkable-hugo/blog-repo
EOF
fi
chown "root:$APP_USER" "$env_file"
chmod 640 "$env_file"

# --- sudoers: restart only -----------------------------------------------------
sudoers=/etc/sudoers.d/$DEPLOY_USER
tmp=$(mktemp)
echo "$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $APP.service" > "$tmp"
visudo -cf "$tmp" >/dev/null
install -m 440 -o root -g root "$tmp" "$sudoers"
rm -f "$tmp"

# --- sshd AllowUsers -----------------------------------------------------------
sshd_conf=/etc/ssh/sshd_config.d/00-hardening.conf
if ! grep -Eq "^AllowUsers\b.*\s$DEPLOY_USER(\s|$)" "$sshd_conf"; then
  cp -p "$sshd_conf" "$sshd_conf.bak"
  sed -i -E "s/^(AllowUsers\b.*)$/\1 $DEPLOY_USER/" "$sshd_conf"
  mkdir -p /run/sshd
  if ! sshd -t; then
    mv "$sshd_conf.bak" "$sshd_conf"
    echo "sshd -t failed, restored $sshd_conf" >&2; exit 1
  fi
  systemctl reload ssh
fi
grep '^AllowUsers' "$sshd_conf"

# --- auditd --------------------------------------------------------------------
cat > "/etc/audit/rules.d/51-$DEPLOY_USER.rules" <<EOF
-w $home/.ssh/authorized_keys -p wa -k ssh_keys
EOF
augenrules --load >/dev/null

echo
echo "Done. Next: sudoedit $env_file"
ls -ld "/srv/$APP" "/srv/$APP/releases" "$env_file" "$sudoers"
