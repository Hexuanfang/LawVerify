#!/bin/bash
set -u
umask 077

job_dir=$1
target=$2
staged=$3
backup=$4
old_pid=$5
job_id=$6
exit_timeout=${7:-120}
startup_timeout=${8:-120}
replaced=0

status() {
  printf '%s\n' "$1" > "$job_dir/status.tmp"
  mv -f "$job_dir/status.tmp" "$job_dir/status"
}

alive() { kill -0 "$1" 2>/dev/null; }

rollback() {
  trap - HUP INT TERM
  if [ "$replaced" -eq 1 ]; then
    if [ -f "$job_dir/new-pid" ]; then
      new_pid=$(cat "$job_dir/new-pid")
      case "$new_pid" in ''|*[!0-9]*) status failed; exit 1;; esac
      if [ "$new_pid" -le 1 ] || [ "$new_pid" = "$old_pid" ]; then status failed; exit 1; fi
      if alive "$new_pid"; then
        kill -TERM "$new_pid" 2>/dev/null || true
        attempts=0
        while alive "$new_pid"; do
          attempts=$((attempts + 1))
          if [ "$attempts" -ge 15 ]; then status failed; exit 1; fi
          sleep 1
        done
      fi
    fi
    if [ -e "$target" ]; then
      mv "$target" "$staged" || { status failed; exit 1; }
    fi
    mv "$backup" "$target" || { status failed; exit 1; }
    status rolled-back
    open -n "$target" || true
  else
    status cancelled
  fi
  exit 1
}

trap rollback HUP INT TERM
status waiting
printf '%s\n' "$job_id" > "$job_dir/helper-ready"
attempts=0
while alive "$old_pid"; do
  if [ -f "$job_dir/cancel-request" ]; then status cancelled; exit 1; fi
  attempts=$((attempts + 1))
  if [ "$attempts" -ge "$exit_timeout" ]; then status cancelled; exit 1; fi
  sleep 1
done
if [ -f "$job_dir/cancel-request" ]; then status cancelled; exit 1; fi

status installing
# All three bundles live in the same directory: rename never copies partial data.
mv "$target" "$backup" || { status failed; exit 1; }
replaced=1
mv "$staged" "$target" || rollback
status restarting
open -n "$target" --args "--lawverify-update-job=$job_id" || rollback
attempts=0
while [ ! -f "$job_dir/startup-ok" ] || [ "$(cat "$job_dir/startup-ok")" != "$job_id" ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge "$startup_timeout" ]; then rollback; fi
  sleep 1
done
status complete
# Keep the last good bundle for recovery; never delete userData or case files.
exit 0
