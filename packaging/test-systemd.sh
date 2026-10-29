#!/bin/bash
# Run only on disposable GitHub-hosted Linux runners, with a real systemd PID 1.
set -euo pipefail
cleanup() {
  result=$?
  if (( result != 0 )); then sudo journalctl -u doublemusic.service -n 80 --no-pager; fi
  sudo systemctl stop doublemusic.service || true
  exit "$result"
}
trap cleanup EXIT
sudo apt-get update
sudo apt-get install -y ./dist/*.deb
if systemctl is-active --quiet doublemusic.service; then
  echo 'Initial package installation unexpectedly started the service.' >&2
  exit 1
fi
printf '%s\n' systemd-test-password-only | sudo -u doublemusic doublemusic-user add systemdtest --admin --password-stdin
ready() {
  for attempt in $(seq 1 60); do
    if sudo -u doublemusic doublemusic-server --healthcheck >/dev/null 2>&1; then return; fi
    sleep 1
  done
  return 1
}
sudo systemctl start doublemusic.service
ready
old_pid=$(systemctl show --property MainPID --value doublemusic.service)
sudo dpkg --force-confold -i ./dist/*.deb
ready
new_pid=$(systemctl show --property MainPID --value doublemusic.service)
test "$old_pid" != "$new_pid"
test "$(systemctl show --property User --value doublemusic.service)" = doublemusic
sudo systemctl stop doublemusic.service
sudo apt-get remove -y doublemusic
sudo test -s /var/lib/doublemusic/core.sqlite
echo 'Real systemd service: unprivileged startup, upgrade restart, shutdown and retained state passed.'
