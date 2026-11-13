#!/bin/sh
# Count shim for perf tests (docs/specs/backend-e2e-tests.md §3.1): appends one
# line `<pid> <epoch-ns> <args>` to $LFS_COUNT_FILE per CLI process, then execs
# the real CLI ($LFS_REAL_CLI) with the same arguments, stdin and environment.
# macOS date has no %N: nanoseconds come from perl's Time::HiRes (microsecond
# resolution), else whole seconds.
now=$(perl -MTime::HiRes=gettimeofday -e '($s,$u)=gettimeofday; printf "%d%06d000", $s, $u' 2>/dev/null) || now="$(date +%s)000000000"
if [ -n "$LFS_COUNT_FILE" ]; then
  printf '%s %s %s\n' "$$" "$now" "$*" >> "$LFS_COUNT_FILE"
fi
exec "$LFS_REAL_CLI" "$@"
