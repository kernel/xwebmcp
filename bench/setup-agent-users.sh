#!/bin/sh
# Creates the OS users agents run as, xwebmcp-bench-1 to xwebmcp-bench-<count>, lets <bench user>
# run commands as them without a password, and removes other users' access to this checkout and
# to <bench user>'s home, so agents cannot read intents, results or keys. Linux only.
# Usage: sudo bench/setup-agent-users.sh <bench user> <count>
set -eu
[ $# -eq 2 ] || { echo "usage: sudo $0 <bench user> <count>" >&2; exit 2; }
bench_user=$1
count=$2
bench_home=$(getent passwd "$bench_user" | cut -d: -f6)
[ -n "$bench_home" ] || { echo "no user $bench_user" >&2; exit 1; }
checkout=$(cd "$(dirname "$0")/.." && pwd)

mkdir -p /var/lib/xwebmcp-bench
users=
for i in $(seq 1 "$count"); do
  name=xwebmcp-bench-$i
  home=/var/lib/xwebmcp-bench/$i
  id -u "$name" >/dev/null 2>&1 || useradd --system --home-dir "$home" --create-home --shell /usr/sbin/nologin "$name"
  chmod 700 "$home"
  users=${users:+$users,}$name
done

rule=$(mktemp)
# sudo would log the agents' environment, API keys included.
printf 'Defaults>%s !log_allowed\n%s ALL=(%s) NOPASSWD:SETENV: ALL\n' "$users" "$bench_user" "$users" > "$rule"
visudo -cqf "$rule"
install -m 440 "$rule" /etc/sudoers.d/xwebmcp-bench
rm -f "$rule"

chmod o-rwx "$checkout" "$bench_home"
echo "agent users: $users; $checkout and $bench_home are closed to other users"
