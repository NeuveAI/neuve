#!/bin/sh
# Installs a Neuve release from its GitHub repository: with the user's own GitHub sign-in (the GitHub
# CLI's, or a token in GH_TOKEN or GITHUB_TOKEN) while the repository is private, and without one once
# it is public. It checks the release against SHA256SUMS before anything is installed, and installs it
# into ~/.neuve by default. Run it with --help for the options.

main() {
set -eu

say() {
    # Bash retains failed printf bytes. Keep that buffer out of pathname readers.
    if (
        trap - EXIT
        if [ "$cleaning_up" = 0 ]; then trap 'exit 141' PIPE; fi
        printf '%s%s\n' "$say_prefix" "$*" 2>/dev/null || :
    ); then :
    else
        message_status=$?
        if [ "$message_status" = 141 ]; then handle_signal 141; else exit "$message_status"; fi
    fi
}
# Errors name the installer, since its output may be piped; progress sits under its header.
say_prefix='neuve install: '
fail() { say_prefix='neuve install: '; say "$*" >&2; exit 1; }
show_error() {
    say_prefix='neuve install: '
    while IFS= read -r line || [ -n "$line" ]; do say "$line" >&2; done <"$1"
}
# The one place the repository is named.
repo=${NEUVE_REPO:-NeuveAI/neuve}
# The release this copy of the installer came with. The release build writes it; a copy from the
# repository leaves it empty.
shipped_version=
api=${NEUVE_GITHUB_API:-https://api.github.com}
# Where a public repository's release files are served without a sign-in.
downloads=${NEUVE_GITHUB_DOWNLOADS:-https://github.com}
downloads=${downloads%/}
api=${api%/}
version=${NEUVE_VERSION:-}
version_option=NEUVE_VERSION
prefix=${NEUVE_INSTALL_DIR:-"$HOME/.neuve"}
no_path=${NEUVE_NO_MODIFY_PATH:-0}
no_skills=0
no_agent=${NEUVE_NO_AGENT:-0}
dry_run=0
force=0
uninstall=0
archive=
checksums=
temporary=
staging=
locked=0
critical=0
pending_signal=0
cleaning_up=0
handled_signals=
created_directories=
journal=
transaction=0
path_changed=0
path_existed=0
agent_created=0
agent_updated=0
agent_snapshot_kind=claim
agent_refusal_reported=0
agent_final_needed=0
linux_agent_changed=0
newline='
'
# The final DEL byte preserves the embedded newline in this constant.
control_bytes=$(printf '\001\002\003\004\005\006\007\010\011\012\013\014\015\016\017\020\021\022\023\024\025\026\027\030\031\032\033\034\035\036\037\177')
no_controls() {
    case "$1" in *["$control_bytes"]*) return 1 ;; *) return 0 ;; esac
}
# Preserve path bytes, removing only the command's one output terminator.
path_output() {
    # These two commands cannot introduce controls absent from their raw input.
    case "$1" in dirname|basename)
        if no_controls "$2"; then path_value=$("$@") || return 1; return 0; fi ;;
        physical)
            path_value=$("$@") || return 1
            path_value=${path_value%.}
            return 0 ;;
    esac
    path_value=$("$@" && printf '.') || return 1
    path_value=${path_value%.}
    path_value=${path_value%"$newline"}
}
handle_signal() {
    # upgrade also forwards a terminal's group signal. Mask the second delivery
    # before exit enters its trap, including while a critical command finishes.
    trap '' $handled_signals
    if [ "$critical" = 1 ]; then pending_signal=$1; else exit "$1"; fi
}
# Ignored dispositions survive exec, including a signal sent to the whole process group.
protected() ( trap '' $handled_signals; exec "$@"; )
finish_critical() {
    critical=0
    [ "$pending_signal" = 0 ] || exit "$pending_signal"
}
create_directory() {
    [ -d "$1" ] && return 0
    path_output dirname "$1"
    create_directory "$path_value"
    critical=1
    if protected mkdir "$1" 2>/dev/null; then
        created_directories="$1
$created_directories"
    else
        finish_critical
        fail "Can't create $1. Check that you can write to its parent folder."
    fi
    finish_critical
}
take_lock() {
    critical=1
    if protected mkdir "$prefix/.install.lock" 2>/dev/null; then locked=1; fi
    finish_critical
    if [ "$locked" != 1 ]; then
        if [ -e "$prefix/.install.lock" ] || [ -L "$prefix/.install.lock" ]; then fail "$lock_message"; fi
        fail "Can't create $prefix/.install.lock. Check that you can write to its parent folder."
    fi
}
rollback() {
    rollback_failed=0
    for entry in $journal; do
        kind=${entry%%:*}
        remainder=${entry#*:}
        previous=${remainder%%:*}
        component=${remainder#*:}
        destination=$prefix/$component
        backup=$staging/old/$component
        # A journal records our action, not ownership of a later replacement.
        if [ -e "$stage/$component" ] && { [ "$kind" != folder ] || [ ! -d "$backup" ]; }; then continue; fi
        if ! payload_unchanged; then
            printf '%s\n' "Left $destination in place instead of undoing it. Something else changed it during this install, or it is no longer safe to change." >&2
            rollback_failed=1
            continue
        fi
        if [ "$previous" = absent ]; then
            protected rm -rf "$destination" || rollback_failed=1
        elif [ "$kind" = folder ]; then
            # The journal precedes the rename. No backup means it never happened.
            if [ -d "$backup" ]; then
                protected rm -rf "$destination" && safe_parents "$destination" && [ ! -e "$destination" ] && [ ! -L "$destination" ] && protected mv "$backup" "$destination" || rollback_failed=1
            fi
        elif { [ "$kind" = file ] && [ ! -e "$stage/$component" ]; } || { [ "$kind" = removal ] && [ ! -e "$destination" ]; }; then
            protected mv -f "$backup" "$destination" || rollback_failed=1
        fi
    done
    [ "$rollback_failed" = 0 ]
}
cleanup() {
    [ -z "$handled_signals" ] || trap '' $handled_signals
    result=$1
    set +e
    cleaning_up=1
    if [ "$transaction" = 1 ]; then
        keep_payload=0
        if [ "$agent_created" = 1 ] || [ "$agent_updated" = 1 ]; then
            rollback_agent || { result=1; keep_payload=1; }
        fi
        if [ "$linux_agent_changed" = 1 ] || { [ -n "$temporary" ] && [ -f "$temporary/agent-installed" ]; }; then
            # The module rechecks bytes, ownership, loaded settings and filesystem
            # safety before every rollback step. A receipt alone grants no ownership.
            if [ "${NEUVE_AGENT_NO_LOAD:-0}" = 1 ]; then
                NEUVE_ROLLBACK_AGENT_ISOLATE=1 NEUVE_ROLLBACK_AGENT_RECEIPT=$temporary/agent-installed protected "$prefix/bin/neuve" worker uninstall-agent --no-load >"$temporary/agent-rollback" 2>&1
            else
                NEUVE_ROLLBACK_AGENT_ISOLATE=1 NEUVE_ROLLBACK_AGENT_RECEIPT=$temporary/agent-installed protected "$prefix/bin/neuve" worker uninstall-agent >"$temporary/agent-rollback" 2>&1
            fi
            if [ "$?" != 0 ]; then show_error "$temporary/agent-rollback"; result=1; keep_payload=1; fi
        fi
        if [ "$path_changed" = 1 ]; then
            if path_parents_unchanged && writable_file "$path_file" && plain_file "$path_file" && cmp -s "$temporary/path-written" "$path_file"; then
                path_destination=$path_parent/${path_file##*/}
                if [ "$path_existed" = 1 ]; then protected cp -p "$temporary/path-original" "$path_destination" || result=1; else protected rm -f "$path_destination" || result=1; fi
            else
                path_backup=
                if [ "$path_existed" = 1 ]; then
                    # Never follow a substituted parent or overwrite an existing backup.
                    if safe_parents "$path_parent/${path_file##*/}" &&
                        path_output protected mktemp "$path_parent/${path_file##*/}.neuve-backup.XXXXXXXX"; then
                        path_backup=$path_value
                        if ! safe_parents "$path_backup" || ! plain_file "$path_backup" ||
                            ! protected cp -p "$temporary/path-original" "$path_backup"; then
                            path_backup=
                        fi
                    fi
                    if [ -z "$path_backup" ]; then
                        # Unsafe parents cannot receive a backup. Keep its original location.
                        path_backup=$temporary/path-original
                        keep_temporary=1
                    fi
                    say "Left $path_file in place instead of undoing it. Something else changed it during this install, or it is no longer safe to change. Its contents from before this install are kept in $path_backup; don't delete that file." >&2
                else
                    say "Left $path_file in place instead of undoing it. Something else changed it during this install, or it is no longer safe to change." >&2
                fi
                result=1
            fi
        fi
        if [ "$keep_payload" = 1 ]; then
            if [ "$platform" = darwin ]; then
                say 'The launchd agent dev.neuve.worker could not be restored, so neuve and its files were kept. Fix what'\''s reported above, then run the installer again.' >&2
            else
            say "The background worker dev.neuve.worker could not be restored, so neuve and its files were kept. Fix what neuve reported above, run \"$shell_prefix/bin/neuve\" worker uninstall-agent, then run the installer again." >&2
            fi
        elif ! rollback 2>"$temporary/rollback-error"; then
            show_error "$temporary/rollback-error"
            say "Couldn't fully restore the previous version. Its files are kept in $staging/old; don't delete that folder." >&2
            staging=
            result=1
        fi
    fi
    if [ -n "$temporary" ] && [ "$agent_final_needed" = 1 ] && [ "${platform:-}" = darwin ]; then agent_final || result=1; fi
    [ -z "$staging" ] || protected rm -rf "$staging"
    [ -z "$temporary" ] || [ "${keep_temporary:-0}" = 1 ] || protected rm -rf "$temporary"
    if [ "$locked" = 1 ]; then
        protected rmdir "$prefix/.install.lock" 2>/dev/null || :
        if [ "$uninstall" = 1 ] && [ "$result" = 0 ]; then protected rmdir "$prefix" 2>/dev/null || :; fi
    fi
    if [ "$result" != 0 ]; then
        printf '%s' "$created_directories" | while IFS= read -r directory; do
            if [ "$agent_refusal_reported" = 1 ]; then
                case "$plist" in "$directory"/*) continue ;; esac
                case "$agent_log" in "$directory"/*) continue ;; esac
            fi
            protected rmdir "$directory" 2>/dev/null || :
        done
    fi
    trap - EXIT
    exit "$result"
}
trap 'cleanup "$?"' EXIT
# Leave job control and child/terminal notifications at their normal meanings.
# All other supported signals use the same transaction handler. KILL cannot be caught.
handle_signal_number() {
    case "$2" in
        ''|[0-9]*|*[!A-Z0-9+-]*|KILL|STOP|TSTP|TTIN|TTOU|CONT|CHLD|CLD|URG|WINCH|INFO) ;;
        *)
            trap "handle_signal $((128 + $1))" "$1"
            handled_signals="$handled_signals $1" ;;
    esac
}
# One `kill -l` lists every name in signal order (dash starts its list with 0). Asking for each
# number instead costs a subshell per signal, 64 per run; that stays only as the fallback for a
# shell whose list doesn't put TERM at 15.
register_signals() {
    [ "${1:-}" != 0 ] || shift
    [ "$#" -ge 15 ] && eval "[ \"\${15}\" = TERM ]" || return 1
    signal_number=1
    for signal_name in "$@"; do
        handle_signal_number "$signal_number" "$signal_name"
        signal_number=$((signal_number + 1))
    done
}
if ! register_signals $(kill -l 2>/dev/null); then
    handled_signals=
    signal_number=1
    while [ "$signal_number" -le 64 ]; do
        signal_name=$(kill -l "$signal_number" 2>/dev/null) || signal_name=
        handle_signal_number "$signal_number" "$signal_name"
        signal_number=$((signal_number + 1))
    done
fi
show_help() {
    if [ -n "$shipped_version" ]; then default_note="$shipped_version, the release this installer came with."
    else default_note="the newest release (this copy of the installer came with none)."; fi
    if [ -n "$shipped_version" ]; then start_tag=v$shipped_version; tag_note="This is the tag of the release this installer came with."
    else start_tag='v<version>'; tag_note="Replace v<version> with the release's tag on GitHub, such as v0.1.0-preview.1."; fi
    cat <<HELP
Usage: sh install.sh [--version <version>] [--prefix <folder>] [--no-modify-path] [--no-skills]
                     [--force] [--dry-run] [--uninstall] [--archive <file> --checksums <file>]

Installs Neuve from a release of the GitHub repository $repo. It checks the release against its
SHA256SUMS before anything is installed.

Once $repo is public, no sign-in is needed:
  curl -fsSL https://neuve.ai/install.sh | sh
Without a sign-in, latest means the newest release that isn't a preview.

While $repo is private, it downloads with your own GitHub sign-in.

With the GitHub CLI signed in (gh auth login):
  gh release download $start_tag --repo $repo --pattern install.sh
  sh install.sh
$tag_note A download without the tag finds no release while every release is a preview.

Without the GitHub CLI: download install.sh from the release's page on GitHub, set GH_TOKEN to a
GitHub token that can read $repo, then run sh install.sh. The token is sent only to GitHub, in a
request header. It never appears in a command line, a file or the output.

Options:
  --version <version>  The release to install, such as 0.1.0-preview.1, or latest for the newest
                       release, previews included. Default: $default_note
                       Also NEUVE_VERSION.
  --prefix <folder>    Where to install. Default: ~/.neuve. Also NEUVE_INSTALL_DIR.
  --no-modify-path     Don't add <prefix>/bin to PATH in your shell startup file.
  --no-skills          Don't offer the agent skills after installing.
  --no-agent           Don't set up the launchd agent or systemd timer that starts background
                       workers at login and every 5 minutes. Also NEUVE_NO_AGENT=1.
  --force              Install the same version again, or replace a copy built from source.
  --dry-run            Print what the install would do, and change nothing.
  --uninstall          Remove Neuve from the prefix. Records and settings are kept.
  --archive <file> --checksums <file>
                       Install from release files you already downloaded.
HELP
}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --version|--prefix|--archive|--checksums)
            [ "$#" -ge 2 ] || fail "$1 needs a value."
            case "$1" in
                --version) version=$2; version_option="The version" ;; --prefix) prefix=$2 ;;
                --archive) archive=$2 ;; --checksums) checksums=$2 ;;
            esac
            shift 2 ;;
        --no-modify-path) no_path=1; shift ;;
        --no-skills) no_skills=1; shift ;;
        --force) force=1; shift ;;
        --dry-run) dry_run=1; shift ;;
        --uninstall) uninstall=1; shift ;;
        --no-agent) no_agent=1; shift ;;
        --help|-h) show_help; exit 0 ;;
        *) fail "Unknown option: $1. Run with --help to see the options." ;;
    esac
done

startup_paths_valid=0
if no_controls "$HOME" && no_controls "${ZDOTDIR:-$HOME}" && no_controls "$PWD"; then startup_paths_valid=1; fi
no_controls "${TMPDIR:-/tmp}" || fail 'The temporary folder path contains a control character. Set TMPDIR to another folder.'

os=$(uname -s)
arch=$(uname -m)
case "$os" in
    Darwin)
        platform=darwin
        if [ "$arch" = x86_64 ]; then
            if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || :)" = 1 ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || :)" = 1 ]; then
                arch=arm64
            else
                fail "There's no release for Intel Macs. Releases cover Macs with Apple silicon, Linux with glibc, and Windows through WSL."
            fi
        fi ;;
    Linux)
        platform=linux
        glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'Linux releases need glibc, which wasn'\''t found here. musl isn'\''t supported.'
        # The Graph engine is built with cgo on Ubuntu 22.04 and needs glibc 2.34 or later.
        glibc=${glibc#glibc }
        glibc_major=${glibc%%.*}
        glibc_minor=${glibc#*.}
        glibc_minor=${glibc_minor%%.*}
        case "$glibc_major$glibc_minor" in ''|*[!0-9]*) fail "Linux releases need glibc 2.34 or later, and this machine's glibc version ($glibc) can't be read." ;; esac
        if [ "$glibc_major" -lt 2 ] || { [ "$glibc_major" = 2 ] && [ "$glibc_minor" -lt 34 ]; }; then
            fail "Linux releases need glibc 2.34 or later, and this machine has glibc $glibc. Ubuntu 22.04, Debian 12 and Fedora 35 or later have it."
        fi ;;
    *) fail "There's no release for $os/$arch. Releases cover Linux with glibc on x64 and arm64, and Macs with Apple silicon. On Windows, run this command in WSL." ;;
esac
case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail "There's no release for $os/$arch. Releases cover Linux with glibc on x64 and arm64, and Macs with Apple silicon. On Windows, run this command in WSL." ;; esac
target=$platform-$arch
os_name=$os
asset=neuve-$target.tar.gz

# Resolve existing ancestors without creating the prefix, including aliases of .local.
physical() (
    candidate=$1
    case "$candidate" in /*) ;; *) candidate=$PWD/$candidate ;; esac
    tail_path=
    hops=0
    while [ ! -d "$candidate" ]; do
        hops=$((hops + 1))
        [ "$hops" -lt 128 ] || return 1
        if [ -L "$candidate" ]; then
            path_output readlink "$candidate" || return 1
            dest=$path_value
            no_controls "$dest" || return 1
            case "$dest" in /*) candidate=$dest ;; *) path_output dirname "$candidate" || return 1; candidate=$path_value/$dest ;; esac
        else
            path_output basename "$candidate" || return 1
            tail_path=/$path_value$tail_path
            path_output dirname "$candidate" || return 1
            parent=$path_value
            [ "$parent" != "$candidate" ] || return 1
            candidate=$parent
        fi
    done
    cd -P "$candidate" 2>/dev/null || return 1
    printf '%s%s.' "$PWD" "$tail_path"
)
valid_prefix() {
    [ -n "$1" ] || fail '--prefix is empty. Give it a folder path.'
    case "$1" in *'"'*|*'\'*|*'|'*|*'&'*) fail 'The install folder path must not contain ", \, | or &. Choose another folder.' ;; esac
    case "$1" in *:*) fail 'The install folder path must not contain a colon (:). PATH uses colons to separate folders. Choose another folder.' ;; esac
    if ! no_controls "$1"; then fail 'The install folder path contains a control character. Choose another folder.'; fi
}
source_folder_message='This folder is kept for the copy that bun run install:cli builds from source. Choose another folder with --prefix.'
valid_prefix "$prefix"
path_output physical "$prefix" || fail 'Can'\''t resolve the install folder to a real path. Check its links and permissions.'
prefix=$path_value
valid_prefix "$prefix"
lock_message="Another install holds $prefix/.install.lock. If none is running, delete that empty folder. Then run the same command again with --force."
# Conservative refusal also covers a .local reached with a temporary HOME.
case "$prefix/" in */../*|*/./*) fail 'Write the install folder path without . or .. in it.' ;; esac
folded=$(printf '%s' "$prefix" | tr '[:upper:]' '[:lower:]')
case "$folded" in */.local|*/.local/*) fail "$source_folder_message" ;; esac
# Every folder an install writes into, below the prefix. lib/neuve/desk is the review desk, once a
# release carries it.
payload_folders=' /bin /lib /lib/neuve /lib/neuve/semantic /lib/neuve/desk /share /share/neuve /share/neuve/notices /share/neuve/skills'
refuse_shared_home() {
    path_output physical "$1/.local" || fail 'Can'\''t resolve the .local folder in your home, which the install must stay out of.'
    shared=$path_value
    destinations=
    for suffix in '' $payload_folders; do
        path_output physical "$prefix$suffix" || fail 'Can'\''t resolve the install folder to a real path. Check its links and permissions.'
        candidate_folder=$path_value
        valid_prefix "$candidate_folder"
        checked_shared=$shared
        candidate_folder=$(printf '%s' "$candidate_folder" | tr '[:upper:]' '[:lower:]')
        if no_controls "$checked_shared"; then checked_shared=$(printf '%s' "$checked_shared" | tr '[:upper:]' '[:lower:]'); fi
        case "$candidate_folder" in "$checked_shared"|"$checked_shared"/*) fail "$source_folder_message" ;; esac
        destinations="$destinations$candidate_folder
"
    done
    if [ "$os_name" = Darwin ]; then destinations=$(printf '%s' "$destinations" | tr '[:upper:]' '[:lower:]'); fi
    for suffix in '' /bin /lib /lib/neuve /lib/neuve/semantic; do
        path_output physical "$shared$suffix" || fail 'Can'\''t resolve the .local folder in your home, which the install must stay out of.'
        shared_folder=$path_value
        no_controls "$shared_folder" || continue
        shared_folder=$(printf '%s' "$shared_folder" | tr '[:upper:]' '[:lower:]')
        if printf '%s\n' "$destinations" | grep -F -x -e "$shared_folder" >/dev/null; then fail "$source_folder_message"; fi
    done
}
refuse_shared_home "$HOME"
account_name=$(id -un)
case "$account_name" in ''|*[!a-zA-Z0-9_.-]*) fail 'Can'\''t find your account'\''s home folder to keep the install out of its .local folder.' ;; esac
account_home=$(/bin/sh -c "printf '%s' ~$account_name" && printf '.')
account_home=${account_home%.}
no_controls "$account_home" || fail 'Can'\''t find your account'\''s home folder to keep the install out of its .local folder.'
case "$account_home" in /*) refuse_shared_home "$account_home" ;; *) fail 'Can'\''t find your account'\''s home folder to keep the install out of its .local folder.' ;; esac
[ "$prefix" != / ] || fail 'The install folder can'\''t be /. Choose another folder with --prefix.'
for path in "$prefix/bin" "$prefix/lib" "$prefix/lib/neuve" "$prefix/share" "$prefix/share/neuve"; do
    [ ! -L "$path" ] || fail "$path is a symbolic link, which the installer won't follow. Choose another install folder."
done
lib=$prefix/lib/neuve
share=$prefix/share/neuve
hash_tool=
if command -v shasum >/dev/null 2>&1; then hash_tool=shasum;
elif command -v sha256sum >/dev/null 2>&1; then hash_tool=sha256sum; fi
hash_file() {
    case "$hash_tool" in
        sha256sum) sha256sum "$1" 2>/dev/null ;;
        shasum) shasum -a 256 "$1" 2>/dev/null ;;
        *) return 1 ;;
    esac
}
# Check contention before ownership: KILL may have left the payload between metadata writes.
if [ -e "$prefix/.install.lock" ] || [ -L "$prefix/.install.lock" ]; then fail "$lock_message"; fi
json_string() { sed -n 's/^[[:space:]]*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"\\]*\)"[[:space:]]*,*[[:space:]]*$/\1/p' "$1"; }
valid_version() {
    # A record that names its version twice reads as two lines: not a version.
    case "$1" in *"$newline"*) return 1 ;; esac
    printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
}
# Semantic version precedence: prints -1, 0 or 1 for $1 against $2. Build metadata is ignored.
version_order() {
    LC_ALL=C awk -v a="$1" -v b="$2" '
        function part(x, y,   xn, yn) {
            xn = (x ~ /^[0-9]+$/); yn = (y ~ /^[0-9]+$/)
            if (xn && yn) {
                if (length(x) != length(y)) return length(x) < length(y) ? -1 : 1
                return ("" x) < ("" y) ? -1 : (("" x) > ("" y) ? 1 : 0)
            }
            if (xn) return -1
            if (yn) return 1
            return ("" x) < ("" y) ? -1 : (("" x) > ("" y) ? 1 : 0)
        }
        function order(a, b,   pa, pb, ca, cb, ma, mb, na, nb, i, c) {
            sub(/\+.*/, "", a); sub(/\+.*/, "", b)
            pa = ""; pb = ""
            if (index(a, "-")) { pa = substr(a, index(a, "-") + 1); a = substr(a, 1, index(a, "-") - 1) }
            if (index(b, "-")) { pb = substr(b, index(b, "-") + 1); b = substr(b, 1, index(b, "-") - 1) }
            split(a, ca, "."); split(b, cb, ".")
            for (i = 1; i <= 3; i++) { c = part(ca[i], cb[i]); if (c) return c }
            if (pa == "" && pb == "") return 0
            if (pa == "") return 1
            if (pb == "") return -1
            na = split(pa, ma, "."); nb = split(pb, mb, ".")
            for (i = 1; i <= na && i <= nb; i++) { c = part(ma[i], mb[i]); if (c) return c }
            return na < nb ? -1 : (na > nb ? 1 : 0)
        }
        BEGIN { print order(a, b) }'
}
refresh_ownership() {
    owned=0
    old_version=
    old_version_unreadable=0
    current_hash=absent
    if [ ! -L "$prefix/bin/neuve" ] && [ -f "$prefix/bin/neuve" ]; then
        current_hash=$(hash_file "$prefix/bin/neuve") || current_hash=
        current_hash=${current_hash%% *}
    elif [ -e "$prefix/bin/neuve" ] || [ -L "$prefix/bin/neuve" ]; then current_hash=; fi
    if [ ! -L "$lib/release.json" ] && [ -f "$lib/release.json" ] && grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*1[[:space:]]*,' "$lib/release.json"; then
        old_target=$(json_string "$lib/release.json" target)
        old_hash=$(json_string "$lib/release.json" cliSha256)
        if [ "$old_target" = "$target" ] && [ "${#old_hash}" = 64 ]; then
            if [ "$old_hash" = "$current_hash" ]; then owned=1;
            # Source installs always write the CLI. Only uninstall may resume without it.
            elif [ "$uninstall" = 1 ] && [ ! -e "$prefix/bin/neuve" ] && [ ! -L "$prefix/bin/neuve" ]; then owned=1; fi
        fi
        if [ "$owned" = 1 ]; then
            old_version=$(json_string "$lib/release.json" version)
            valid_version "$old_version" || { old_version=; old_version_unreadable=1; }
        fi
    fi
    if { [ -e "$lib/install.json" ] || [ -e "$lib/release.json" ]; } && [ "$owned" = 0 ] && [ "$force" = 0 ]; then
        fail 'This folder holds a copy built from source. Choose another folder with --prefix, or use --force to replace it.'
    fi
}
# Empty folders left before payload replacement contain no foreign files.
foreign_payload() {
    if [ -e "$prefix/bin/neuve" ] || [ -L "$prefix/bin/neuve" ]; then return 0; fi
    for folder in "$share/notices" "$share/skills"; do
        if [ -e "$folder" ] || [ -L "$folder" ]; then return 0; fi
    done
    [ -e "$lib" ] || return 1
    foreign_files=$(find "$lib" ! -type d -print 2>/dev/null) || return 0
    [ -n "$foreign_files" ]
}
refresh_ownership

plist=$HOME/Library/LaunchAgents/dev.neuve.worker.plist
agent_log=$HOME/Library/Logs/neuve-worker-sweep.log
agent_plist_location=$plist
agent_log_location=$agent_log
# Keep established directory aliases, but bind all later mutations to their
# original physical locations. Never resolve the plist or log leaf itself.
if path_output physical "${plist%/*}"; then plist=$path_value/dev.neuve.worker.plist; fi
if path_output physical "${agent_log%/*}"; then agent_log=$path_value/neuve-worker-sweep.log; fi
# Optional user files are never followed through links, including dangling ones.
plain_file() { [ ! -L "$1" ] && [ -f "$1" ]; }
available_file() { [ ! -L "$1" ] && { [ ! -e "$1" ] || [ -f "$1" ]; }; }
writable_parent() (
    path_output dirname "$1" || return 1
    parent=$path_value
    while [ ! -e "$parent" ] && [ ! -L "$parent" ]; do
        path_output dirname "$parent" || return 1
        parent=$path_value
    done
    [ -d "$parent" ] && [ -w "$parent" ]
)
writable_file() {
    available_file "$1" && writable_parent "$1" && { [ ! -e "$1" ] || [ -w "$1" ]; }
}
# Check each ancestor before inspecting a leaf. In particular, never inspect a
# rollback target through a newly substituted directory link.
safe_parents() (
    ancestor=${1%/*}
    [ -n "$ancestor" ] || ancestor=/
    while :; do
        [ ! -L "$ancestor" ] || return 1
        [ ! -e "$ancestor" ] || [ -d "$ancestor" ] || return 1
        if [ "$ancestor" = / ]; then
            writable_parent "$1" || return 1
            return 0
        fi
        ancestor=${ancestor%/*}
        [ -n "$ancestor" ] || ancestor=/
    done
)
payload_unchanged() {
    safe_parents "$destination" || return 1
    if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
        [ ! -e "$staging/written/$component" ] || { [ "$kind" = folder ] && [ -d "$stage/$component" ]; }
    elif [ "$kind" = folder ]; then
        [ ! -L "$destination" ] && [ -d "$destination" ] && [ -w "$destination" ] || return 1
        unsafe_entries=$(find "$destination" ! -type d ! -type f -print) || return 1
        [ -z "$unsafe_entries" ] && diff -r "$staging/written/$component" "$destination" >/dev/null 2>&1
    else
        plain_file "$destination" && [ -w "$destination" ] && cmp -s "$staging/written/$component" "$destination"
    fi
}
path_parents_unchanged() {
    path_output dirname "$path_file" && path_output physical "$path_value" && [ "$path_value" = "$path_parent" ] && safe_parents "$path_parent/${path_file##*/}"
}
agent_is_claim() {
    plain_file "$plist" && printf 'Neuve installer claim\n%s\n' "$prefix" | cmp -s - "$plist"
}
agent_owner() {
    plain_file "$plist" && [ -r "$plist" ] || return 1
    plist_string Label || return 1
    [ "$plist_value" = dev.neuve.worker ] || return 1
    if plutil -type Program "$plist" >/dev/null 2>&1; then
        plist_string Program || return 1
        owner_command=$plist_value
        if plutil -type ProgramArguments "$plist" >/dev/null 2>&1; then
            [ "$(plutil -type ProgramArguments "$plist" 2>/dev/null)" = array ] || return 1
            plist_string ProgramArguments.0 || return 1
            [ "$plist_value" = "$owner_command" ] || return 1
        fi
    else
        [ "$(plutil -type ProgramArguments "$plist" 2>/dev/null)" = array ] || return 1
        plist_string ProgramArguments.0 || return 1
        owner_command=$plist_value
    fi
    case "$owner_command" in /*/bin/neuve) agent_owner_prefix=${owner_command%/bin/neuve} ;; *) return 1 ;; esac
}
agent_is_ours() { agent_owner && [ "$owner_command" = "$prefix/bin/neuve" ]; }
agent_other_owner() {
    if agent_owner && [ "$owner_command" != "$prefix/bin/neuve" ]; then
        say "The launchd agent dev.neuve.worker belongs to the neuve install in $agent_owner_prefix, so it was left in place."
    else say 'The launchd agent runs another neuve, so the installer left it in place.'; fi
}
# The shell only accepts complete generated ExecStart forms. Everything it cannot
# prove belongs to another Neuve prefix remains a conservative uninstall refusal.
linux_safe_file() (
    safe_parents "$1" && writable_file "$1" || return 1
    target=$1
    parent=${target%/*}
    while [ ! -e "$parent" ]; do parent=${parent%/*}; done
    # Match safeFile's permission-bit check even when root's access check succeeds.
    for checked in "$parent" "$target"; do
        [ -e "$checked" ] || continue
        status=$(stat -c '%h %a' "$checked" 2>/dev/null) || status=$(stat -f '%l %Lp' "$checked" 2>/dev/null) || return 1
        set -- $status
        [ "$#" = 2 ] || return 1
        [ "$checked" != "$target" ] || { [ "$1" = 1 ] && [ -r "$checked" ]; } || return 1
        case "$2" in ''|*[!0-7]*) return 1 ;; esac
        [ "$((0$2 & 0222))" != 0 ] || return 1
    done
)

linux_no_dropins() (
    # The fallback cannot interpret arbitrary overrides. Refuse even benign ones.
    for folder in "$unit_folder" "$HOME/.config/systemd/user" /etc/systemd/user /run/systemd/user /usr/local/lib/systemd/user /usr/lib/systemd/user ${runtime_folder:+"$runtime_folder"}; do
        for unit in dev.neuve.worker.service dev.neuve.worker.timer service timer; do
            [ ! -e "$folder/$unit.d" ] && [ ! -L "$folder/$unit.d" ] || return 1
        done
    done
)
linux_loaded_owner() {
    [ "${NEUVE_AGENT_NO_LOAD:-0}" != 1 ] || return 0
    protected systemctl --user show -p FragmentPath,DropInPaths,ExecStart,KillMode,NeedDaemonReload dev.neuve.worker.service >"$temporary/service-show" 2>/dev/null &&
    protected systemctl --user show -p FragmentPath,DropInPaths,Triggers,NeedDaemonReload dev.neuve.worker.timer >"$temporary/timer-show" 2>/dev/null || return 1
    for shown in "$temporary/service-show" "$temporary/timer-show"; do
        LC_ALL=C tr -d '\000\015' <"$shown" | cmp -s - "$shown" || return 1
    done
    NEUVE_OWNER=$linux_owner_prefix NEUVE_UNITS=$unit_folder LC_ALL=C awk '
        BEGIN { command=ENVIRON["NEUVE_OWNER"] "/bin/neuve"; folder=ENVIRON["NEUVE_UNITS"] }
        {
            eq=index($0,"="); if (!eq) { bad=1; next }
            key=substr($0,1,eq-1); value=substr($0,eq+1)
            if (++seen[FILENAME,key]!=1) bad=1
            service=(FILENAME==ARGV[1])
            if (key=="FragmentPath") { if(value!=folder "/dev.neuve.worker." (service ? "service" : "timer")) bad=1; fragment++ }
            else if (key=="DropInPaths") { if(value!="") bad=1; dropins++ }
            else if (key=="NeedDaemonReload") { if(value!="no") bad=1; reload++ }
            else if (service && key=="KillMode") { if(value!="process") bad=1; mode++ }
            else if (!service && key=="Triggers") { if(value!="dev.neuve.worker.service") bad=1; target++ }
            else if (service && key=="ExecStart") {
                expected="{ path=" command " ; argv[]=" command " worker sweep ; ignore_errors=no ; "
                if(index(value,expected)!=1) bad=1
                tail=substr(value,length(expected)+1)
                if(tail !~ /^start_time=\[[^]]*\] ; stop_time=\[[^]]*\] ; pid=[0-9]+ ; code=([A-Za-z0-9_-]+|[(]null[)]) ; status=[A-Za-z0-9_\/-]+ }$/) bad=1
                start++
            } else bad=1
        }
        END { exit (bad || fragment!=2 || dropins!=2 || reload!=2 || mode!=1 || target!=1 || start!=1) }
    ' "$temporary/service-show" "$temporary/timer-show"
}
linux_owner() {
    linux_safe_file "$1" && plain_file "$1" || return 1
    LC_ALL=C tr -d '\000\015' <"$1" | cmp -s - "$1" || return 1
    linux_owner_prefix=$(LC_ALL=C awk '
        function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
        /\r/ { bad=1 }
        {
            line=trim($0)
            if (!line || line ~ /^[#;]/) next
            if (line ~ /\\$/) { bad=1; next }
            if (line ~ /^\[[^][]+\]$/) { section=line; next }
            eq=index(line, "=")
            key=trim(substr(line,1,eq-1)); value=trim(substr(line,eq+1))
            if (!eq || !section || key !~ /^[A-Za-z][A-Za-z0-9]*$/) { bad=1; next }
            if (key=="KillMode") { modes++; if(section!="[Service]" || value!="process") bad=1 }
            if (key=="ExecStart") {
                starts++; if(section!="[Service]") bad=1
                if (value !~ / worker sweep$/) { bad=1; next }
                command=substr(value,1,length(value)-13)
                if (substr(command,1,1)=="\"") {
                    if (substr(command,length(command),1)!="\"") bad=1
                    command=substr(command,2,length(command)-2)
                    if (command ~ /["\047\\]/) bad=1
                } else if (command ~ /[ \t"\047\\]/) bad=1
                decoded=command; gsub(/%%/, "", decoded)
                if (index(decoded,"%")) bad=1
                gsub(/%%/, "%", command)
                if (command !~ /^\/.*\/bin\/neuve$/) bad=1
            }
        }
        END { if (bad || starts!=1 || modes!=1) exit 1; sub(/\/bin\/neuve$/, "", command); print command }
    ' "$1") || return 1
    no_controls "$linux_owner_prefix" && [ -n "$linux_owner_prefix" ] || return 1
    # Do not mistake a lexical alias of this prefix for a different install.
    case "$linux_owner_prefix/" in */../*|*/./*|*'//'*) return 1 ;; esac
}
linux_timer_owned() {
    linux_safe_file "$1" || return 1
    [ -e "$1" ] || return 0
    [ -r "$1" ] || return 1
    LC_ALL=C tr -d '\000\015' <"$1" | cmp -s - "$1" || return 1
    LC_ALL=C awk '
        function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
        {
            line=trim($0)
            if (!line || line ~ /^[#;]/) next
            if (line ~ /\\$/) { bad=1; next }
            if (line ~ /^\[[^][]+\]$/) { section=line; next }
            eq=index(line,"="); key=trim(substr(line,1,eq-1)); value=trim(substr(line,eq+1))
            if (!eq || !section || key !~ /^[A-Za-z][A-Za-z0-9]*$/) bad=1
            if (key=="Unit") { targets++; if(section!="[Timer]" || value!="dev.neuve.worker.service") bad=1 }
            if (section=="[Timer]" && key ~ /^(OnActiveSec|OnBootSec|OnStartupSec|OnUnitActiveSec|OnUnitInactiveSec|OnCalendar)$/ && length(value)>0) scheduled=1
        }
        END { exit (bad || targets>1 || !scheduled) }
    ' "$1"
}
# launchctl print uses 113 for an unknown service, with this service-specific
# diagnostic. Other errors, including domain/manager failures, prove no absence.
agent_loaded() {
    agent_query_status=0
    protected launchctl print "gui/$(id -u)/dev.neuve.worker" >"$temporary/agent-query" 2>&1 || agent_query_status=$?
    [ "$agent_query_status" != 0 ] || return 0
    if [ "$agent_query_status" = 113 ] && LC_ALL=C grep -Eq '^Could not find service "dev[.]neuve[.]worker" in domain for user gui: [0-9]+$' "$temporary/agent-query"; then return 1; fi
    return 2
}
agent_unloaded() {
    if agent_loaded; then return 1; else [ "$?" = 1 ]; fi
}
agent_loaded_command() {
    loaded_command=$(LC_ALL=C awk '
        /^[ \t]*program = / { sub(/^[ \t]*program = /, ""); command=$0; count++ }
        END { if(count!=1) exit 1; print command }
    ' "$temporary/agent-query") || return 1
    no_controls "$loaded_command" || return 1
    case "$loaded_command" in /*) ;; *) return 1 ;; esac
    case "$loaded_command" in *'"'*|*'\'*) return 1 ;; esac
}
agent_unload_refused() {
    show_error "$temporary/agent-query"
    if [ "$uninstall" = 1 ]; then
        say "The launchd agent dev.neuve.worker may still be loaded, so the agent, neuve and its files were kept. Fix what's reported above or unload the agent, then run the uninstall again." >&2
    else
        say "The launchd agent dev.neuve.worker may still be loaded, so the agent's plist, neuve and its files were kept. Fix what's reported above or unload the agent, then run the installer again." >&2
    fi
    return 1
}
agent_unowned_unchanged() {
    path_output physical "${agent_plist_location%/*}" && [ "$path_value" = "${plist%/*}" ] &&
        safe_parents "$plist" || return 1
    if [ "$agent_unowned_kind" = missing ]; then
        [ ! -e "$plist" ] && [ ! -L "$plist" ]
    else
        plain_file "$plist" && cmp -s "$temporary/agent-unowned" "$plist"
    fi
}
agent_loaded_for_prefix() {
    if agent_loaded; then
        agent_loaded_command || { agent_unload_refused; return 2; }
        if [ "$loaded_command" != "$prefix/bin/neuve" ]; then
            if [ "$uninstall" = 1 ]; then again=uninstall; else again=installer; fi
            say "The loaded launchd agent dev.neuve.worker runs another command, so it was left in place, and the agent's plist, neuve and its files were kept. Check the loaded agent with launchctl print gui/$(id -u)/dev.neuve.worker, then run the $again again." >&2
            return 2
        fi
        return 0
    else
        [ "$?" = 1 ] && return 1
        agent_unload_refused
        return 2
    fi
}
agent_without_owned_plist() {
    [ "${NEUVE_AGENT_NO_LOAD:-0}" != 1 ] || return 0
    agent_unowned_kind=missing
    if [ -e "$plist" ]; then
        agent_unowned_kind=file
        protected cp -p "$plist" "$temporary/agent-unowned" 2>"$temporary/agent-query" || { agent_unload_refused; return 1; }
    fi
    if agent_loaded; then
        agent_loaded_command || { agent_unload_refused; return 1; }
        if [ "$loaded_command" != "$prefix/bin/neuve" ]; then
            say "The loaded launchd agent dev.neuve.worker runs another command, so it was left in place. The uninstall continues with the rest of this install. If you want to remove that agent as well, check it first with launchctl print gui/$(id -u)/dev.neuve.worker."
            return 0
        fi
        agent_unowned_unchanged && agent_parents_safe && available_file "$agent_log" && writable_file "$agent_log" || { agent_unload_refused; return 1; }
        protected launchctl bootout "gui/$(id -u)/dev.neuve.worker" >"$temporary/agent-output" 2>&1 || :
        agent_unowned_unchanged && agent_parents_safe && writable_file "$agent_log" && agent_unloaded || { agent_unload_refused; return 1; }
        agent_unowned_unchanged || { agent_unload_refused; return 1; }
        if [ "$agent_unowned_kind" = missing ]; then
            say 'Unloaded the launchd agent dev.neuve.worker for this install. Its plist was already gone.'
        else
            say "Unloaded the launchd agent dev.neuve.worker for this install. The plist at $plist isn't this install's, so it was kept. Check it before you set up the agent again."
        fi
    else
        [ "$?" = 1 ] || { agent_unload_refused; return 1; }
    fi
    agent_unowned_unchanged || { agent_unload_refused; return 1; }
}

agent_final_unchanged() {
    agent_parents_safe && writable_file "$plist" && writable_file "$agent_log" &&
        agent_is_ours && cmp -s "$temporary/agent-final" "$plist"
}
agent_final() {
    [ "$platform" = darwin ] || return 0
    [ "${NEUVE_AGENT_NO_LOAD:-0}" != 1 ] || return 0
    agent_parents_safe && writable_file "$plist" && writable_file "$agent_log" && plain_file "$plist" || return 0
    if ! agent_is_ours; then agent_other_owner; return 0; fi
    protected cp -p "$plist" "$temporary/agent-final" || return 1
    if agent_loaded; then
        agent_final_unchanged || { agent_other_owner; return 0; }
    else
        [ "$?" = 1 ] || { agent_unload_refused; return 1; }
        agent_final_unchanged || { agent_other_owner; return 0; }
        protected launchctl bootstrap "gui/$(id -u)" "$plist" >"$temporary/agent-final-output" 2>&1 || { show_error "$temporary/agent-final-output"; return 1; }
        agent_final_unchanged || { agent_other_owner; return 0; }
    fi
}
plist_string() {
    plist_value=$(plutil -extract "$1" raw -expect string -n -o - "$plist" 2>/dev/null && printf '.') || return 1
    plist_value=${plist_value%.}
    no_controls "$plist_value"
}
agent_parents_safe() {
    path_output physical "${agent_plist_location%/*}" && [ "$path_value" = "${plist%/*}" ] &&
        path_output physical "${agent_log_location%/*}" && [ "$path_value" = "${agent_log%/*}" ] &&
        safe_parents "$plist" && safe_parents "$agent_log"
}
agent_preflight() {
    if ! agent_parents_safe; then
        say "The folders holding $plist or $agent_log aren't safe to change, so the installer didn't set up the launchd agent."
    elif ! available_file "$plist"; then
        say "$plist isn't a plain file, so the installer didn't set up the launchd agent. Move it away and try again."
    elif ! available_file "$agent_log"; then
        say "$agent_log isn't a plain file, so the installer didn't set up the launchd agent. Move it away and try again."
    elif ! writable_file "$plist" || ! writable_file "$agent_log"; then
        say "Can't write to $plist or its log folder, so the installer didn't set up the launchd agent."
    else return 0; fi
    return 1
}
agent_unchanged() {
    agent_parents_safe &&
        plain_file "$plist" && writable_file "$plist" && writable_file "$agent_log" &&
        cmp -s "$temporary/agent-written" "$plist" || return 1
    if [ "$agent_snapshot_kind" = claim ]; then agent_is_claim || return 1; else agent_is_ours || return 1; fi
    # Ownership parsing is an external read too; compare current bytes last.
    agent_parents_safe &&
        plain_file "$plist" && writable_file "$plist" && writable_file "$agent_log" &&
        cmp -s "$temporary/agent-written" "$plist"
}
agent_rollback_refused() {
    if [ "$agent_refusal_reported" = 0 ]; then
        if agent_owner && [ "$owner_command" != "$prefix/bin/neuve" ]; then agent_other_owner; fi
        say 'Left the launchd agent dev.neuve.worker in place instead of undoing it. Its plist changed since this install registered it, or the plist is no longer safe to change.' >&2
        agent_refusal_reported=1
    fi
    return 1
}
rollback_agent() {
    agent_unchanged || { agent_rollback_refused; return 1; }
    if [ "${NEUVE_AGENT_NO_LOAD:-0}" != 1 ]; then
        if agent_loaded_for_prefix; then
            agent_unchanged || { agent_rollback_refused; return 1; }
            protected launchctl bootout "gui/$(id -u)/dev.neuve.worker" >"$temporary/agent-rollback" 2>&1 || :
            agent_unchanged || { agent_rollback_refused; return 1; }
            agent_unloaded || { agent_unload_refused; return 1; }
        else
            [ "$?" = 1 ] || return 1
        fi
    fi
    # launchctl is an external boundary: another prefix may own the file now.
    agent_unchanged || { agent_rollback_refused; return 1; }
    if [ "$agent_updated" = 1 ]; then
        protected mv -f "$temporary/agent-original" "$plist"
    else
        protected rm -f "$plist"
    fi
}
agent_command_failed() {
    while IFS= read -r line; do say "$line"; done <"$temporary/agent-output"
    if [ "$platform" = linux ] && [ "$1" = uninstall-agent ]; then
        fail 'The systemd timer dev.neuve.worker is still in place, so neuve and its files were kept. Fix what neuve reported above, then run the uninstall again.'
    fi
    fail "neuve worker $1 failed; its output is above."
}
agent_command() {
    if [ "$platform" = darwin ] && [ "$1" = install-agent ]; then
        # Save the written bytes before loading, including a failed bootstrap.
        critical=1
        agent_unchanged || { agent_rollback_refused; exit 1; }
        protected "$prefix/bin/neuve" worker install-agent --no-load >"$temporary/agent-output" 2>&1 || { show_error "$temporary/agent-output"; fail 'neuve worker install-agent failed; its output is above.'; }
        agent_parents_safe && plain_file "$plist" && agent_is_ours || { agent_rollback_refused; exit 1; }
        protected cp -p "$plist" "$temporary/agent-written"
        agent_snapshot_kind=plist
        if [ "${NEUVE_AGENT_NO_LOAD:-0}" != 1 ]; then
            agent_unchanged || { agent_rollback_refused; exit 1; }
            protected launchctl bootout "gui/$(id -u)/dev.neuve.worker" >"$temporary/agent-output" 2>&1 || :
            agent_unchanged || { agent_rollback_refused; exit 1; }
            protected launchctl bootstrap "gui/$(id -u)" "$plist" >"$temporary/agent-output" 2>&1 || { show_error "$temporary/agent-output"; fail 'neuve worker install-agent failed; its output is above.'; }
        fi
        finish_critical
    elif [ "${NEUVE_AGENT_NO_LOAD:-0}" = 1 ]; then
        protected "$prefix/bin/neuve" worker "$1" --no-load >"$temporary/agent-output" 2>&1 || agent_command_failed "$1"
    else
        protected "$prefix/bin/neuve" worker "$1" >"$temporary/agent-output" 2>&1 || agent_command_failed "$1"
    fi
}
reuse_agent() {
    if [ "${NEUVE_AGENT_NO_LOAD:-0}" = 1 ] || agent_loaded; then
        say 'The launchd agent already runs this install.'
    else
        [ "$?" = 1 ] || { agent_unload_refused; exit 1; }
        # An interrupted install may have written its plist without registering it.
        agent_preflight || return 0
        protected cp -p "$plist" "$temporary/agent-original"
        protected cp -p "$plist" "$temporary/agent-written"
        agent_snapshot_kind=plist
        agent_updated=1
        agent_command install-agent
        say 'Installed the launchd agent that starts background workers at login and every 5 minutes.'
    fi
}
startup_path() {
    case "$1" in '') return 0 ;; /*) startup=$1 ;; *) startup=$PWD/$1 ;; esac
    printf '%s\n' "$startup" | sed 's|//*|/|g;s|/$||'
}
startup_home=
startup_zdotdir=
if [ "$startup_paths_valid" = 1 ]; then
    startup_home=$(startup_path "$HOME")
    startup_zdotdir=$(startup_path "${ZDOTDIR:-$HOME}")
fi
path_file=
fish=0
case "${SHELL:-}" in
    */zsh) path_file=$startup_zdotdir/.zshrc ;;
    */bash) if [ "$platform" = darwin ]; then path_file=$startup_home/.bash_profile; else path_file=$startup_home/.bashrc; fi ;;
    */fish) path_file=$startup_home/.config/fish/conf.d/neuve.fish; fish=1 ;;
esac
shell_prefix=$(printf '%s' "$prefix" | sed 's/[`$]/\\&/g')
path_line="export PATH=\"$shell_prefix/bin:\$PATH\""
if [ "$fish" = 1 ]; then path_line="set -gx PATH \"$shell_prefix/bin\" \$PATH"; fi
has_path_block() {
    NEUVE_PATH_LINE=$2 awk '
        previous == "# Added by the Neuve installer" && $0 == ENVIRON["NEUVE_PATH_LINE"] { found=1 }
        { previous=$0 }
        END { exit !found }
    ' "$1"
}
export_line="export PATH=\"$shell_prefix/bin:\$PATH\""
fish_line="set -gx PATH \"$shell_prefix/bin\" \$PATH"
valid_path_entry() {
    [ "$startup_paths_valid" = 1 ] || return 1
    case "$1" in /*) ;; *) return 1 ;; esac
    case "$1/" in */../*|*/./*|*'//'*) return 1 ;; esac
    no_controls "$1" || return 1
    case "$1" in
        "$startup_home/.bashrc"|"$startup_home/.bash_profile"|*/.zshrc) [ "$2" = "$export_line" ] ;;
        "$startup_home/.config/fish/conf.d/neuve.fish") [ "$2" = "$fish_line" ] ;;
        *) return 1 ;;
    esac
}
remove_path_block() {
    recorded_file=$1
    recorded_line=$2
    if ! valid_path_entry "$recorded_file" "$recorded_line"; then
        say "An entry in the installer's list of the startup files it changed is invalid, so the installer left that file alone. Check your shell startup files and delete any line that adds $prefix/bin to PATH."
        return 0
    fi
    if ! available_file "$recorded_file"; then
        say "$recorded_file isn't a plain file, so the installer left it alone."
        return 0
    fi
    [ -f "$recorded_file" ] || return 0
    if ! writable_file "$recorded_file"; then
        say "Can't write to $recorded_file, so the installer left it alone."
        return 0
    fi
    has_path_block "$recorded_file" "$recorded_line" || return 0
    # Only remove our marker followed by this prefix's exact PATH line.
    NEUVE_PATH_LINE=$recorded_line awk '
      BEGIN { line=ENVIRON["NEUVE_PATH_LINE"] }
      pending { if ($0 == line) { pending=0; next }; print "# Added by the Neuve installer"; pending=0 }
      $0 == "# Added by the Neuve installer" { pending=1; next }
      { print }
      END { if (pending) print "# Added by the Neuve installer" }
    ' "$recorded_file" >"$temporary/path-file"
    protected cat "$temporary/path-file" >"$recorded_file"
}
if [ "$uninstall" = 1 ]; then
    completed_uninstall=0
    # An already completed uninstall is safe to retry, including before empty-folder cleanup.
    if [ "$force" = 0 ] && [ ! -e "$lib/release.json" ] && [ ! -L "$lib/release.json" ] && [ ! -e "$lib/install.json" ] && [ ! -L "$lib/install.json" ] && [ ! -e "$prefix/bin/neuve" ] && [ ! -L "$prefix/bin/neuve" ]; then
        completed_uninstall=1
        [ -d "$prefix" ] || exit 0
    fi
    [ "$owned" = 1 ] || [ "$force" = 1 ] || [ "$completed_uninstall" = 1 ] || fail 'This folder has no Neuve release, so nothing was removed. Check the --prefix folder, or use --force to remove its Neuve files anyway.'
    [ -d "$prefix" ] || fail 'The install folder doesn'\''t exist, so there'\''s nothing to remove.'
    if [ "$dry_run" = 1 ]; then
        say "Dry run: nothing is removed or changed."
        say "Would remove Neuve from $prefix (bin/neuve, lib/neuve, share/neuve/notices, share/neuve/skills), and the line the installer added to PATH."
        say 'Would keep Records in each repository'\''s .git/neuve/ folder, and settings in your user data folder.'
        exit 0
    fi
    critical=1
    temporary=$(trap '' $handled_signals; exec mktemp -d "${TMPDIR:-/tmp}/neuve-install.XXXXXXXX")
    finish_critical
    take_lock
    if [ "$completed_uninstall" = 1 ]; then
        if [ -e "$lib/release.json" ] || [ -L "$lib/release.json" ] || [ -e "$lib/install.json" ] || [ -L "$lib/install.json" ] || [ -e "$prefix/bin/neuve" ] || [ -L "$prefix/bin/neuve" ]; then
            fail "Another install changed $prefix after the uninstall checked it, so nothing was removed. Run the uninstall command again."
        fi
        refresh_ownership
        protected rmdir "$lib" "$prefix/bin" "$prefix/lib" "$share" "$prefix/share" 2>/dev/null || :
        exit 0
    fi
    refresh_ownership
    [ "$owned" = 1 ] || [ "$force" = 1 ] || fail 'This folder has no Neuve release, so nothing was removed. Check the --prefix folder, or use --force to remove its Neuve files anyway.'
    critical=1
    if [ "$platform" = darwin ]; then
        agent_final_needed=1
        if ! available_file "$plist"; then
            fail "The launchd agent dev.neuve.worker isn't safe to remove, so the agent's plist, neuve and its files were kept. Check $plist and its log folder, then run the uninstall again."
        elif agent_is_ours; then
            if ! agent_parents_safe || ! available_file "$agent_log"; then
                fail "The launchd agent dev.neuve.worker isn't safe to remove, so the agent's plist, neuve and its files were kept. Check $plist and its log folder, then run the uninstall again."
            fi
            if ! writable_file "$plist" || ! writable_file "$agent_log"; then
                fail "The plist or log file of the launchd agent dev.neuve.worker isn't writable, so the agent's plist, neuve and its files were kept. Check the permissions on $plist and its log file, then run the uninstall again."
            fi
            protected cp -p "$plist" "$temporary/agent-written"
            agent_snapshot_kind=plist
            agent_unchanged || { agent_other_owner; fail 'The launchd agent dev.neuve.worker changed while uninstall was removing it, so neuve and its files were kept. Run the uninstall again.'; }
            if [ "${NEUVE_AGENT_NO_LOAD:-0}" != 1 ]; then
                agent_unchanged || { agent_other_owner; fail 'The launchd agent dev.neuve.worker changed while uninstall was removing it, so neuve and its files were kept. Run the uninstall again.'; }
                if agent_loaded_for_prefix; then
                    agent_unchanged || { agent_other_owner; fail 'The launchd agent dev.neuve.worker changed while uninstall was removing it, so neuve and its files were kept. Run the uninstall again.'; }
                    protected launchctl bootout "gui/$(id -u)/dev.neuve.worker" >"$temporary/agent-output" 2>&1 || :
                    agent_unchanged || { agent_other_owner; fail 'The launchd agent dev.neuve.worker changed while uninstall was removing it, so neuve and its files were kept. Run the uninstall again.'; }
                    if ! agent_unloaded; then
                        show_error "$temporary/agent-output"
                        fail "The launchd agent dev.neuve.worker is still loaded, so the agent's plist, neuve and its files were kept. Fix what launchctl reported above or unload the agent, then run the uninstall again."
                    fi
                else
                    [ "$?" = 1 ] || exit 1
                fi
            fi
            agent_unchanged || { agent_other_owner; fail 'The launchd agent dev.neuve.worker changed while uninstall was removing it, so neuve and its files were kept. Run the uninstall again.'; }
            protected rm -f "$plist" || fail "The launchd agent dev.neuve.worker was unloaded, but its plist could not be removed, so neuve and its files were kept. Check the permissions on $plist, then run the uninstall again."
            say 'Removed the launchd agent for this install.'
        else
            if [ -e "$plist" ]; then agent_other_owner; fi
            agent_without_owned_plist || exit 1
        fi
    fi
    if [ "$platform" = linux ] && [ ! -x "$prefix/bin/neuve" ]; then
        # XDG base directories count only as nonempty absolute paths.
        config_folder=$HOME/.config
        case ${XDG_CONFIG_HOME-} in /*) config_folder=$XDG_CONFIG_HOME ;; esac
        runtime_folder=
        case ${XDG_RUNTIME_DIR-} in /*) runtime_folder=$XDG_RUNTIME_DIR/systemd/user ;; esac
        checked_unit_folder=
        for unit_folder in "$config_folder/systemd/user" "$HOME/.config/systemd/user" ${runtime_folder:+"$runtime_folder"}; do
            [ "$unit_folder" != "$checked_unit_folder" ] || continue
            checked_unit_folder=$unit_folder
            if [ -e "$unit_folder/dev.neuve.worker.service" ] || [ -L "$unit_folder/dev.neuve.worker.service" ] || [ -e "$unit_folder/dev.neuve.worker.timer" ] || [ -L "$unit_folder/dev.neuve.worker.timer" ]; then
                if linux_no_dropins && linux_owner "$unit_folder/dev.neuve.worker.service" && linux_timer_owned "$unit_folder/dev.neuve.worker.timer" && [ "$linux_owner_prefix" != "$prefix" ] && linux_loaded_owner && linux_no_dropins && linux_owner "$unit_folder/dev.neuve.worker.service" && linux_timer_owned "$unit_folder/dev.neuve.worker.timer"; then
                    say "The systemd timer dev.neuve.worker belongs to the neuve install in $linux_owner_prefix, so it was left in place."
                else
                    fail 'This install has no executable neuve to remove the systemd timer dev.neuve.worker, so nothing was removed. Reinstall neuve into the same prefix, run neuve worker uninstall-agent, then run the uninstall again.'
                fi
            fi
        done
    fi
    if [ "$platform" = linux ] && [ -x "$prefix/bin/neuve" ]; then
        agent_command uninstall-agent
        while IFS= read -r line; do say "$line"; done <"$temporary/agent-output"
    fi
    if ! available_file "$lib/path-file"; then
        say "$lib/path-file isn't a plain file, so the installer left it alone."
    elif [ -s "$lib/path-file" ]; then
        while IFS= read -r recorded_file || [ -n "$recorded_file" ]; do
            if ! IFS= read -r recorded_line; then
                say "An entry in the installer's list of the startup files it changed is invalid, so the installer left that file alone. Check your shell startup files and delete any line that adds $prefix/bin to PATH."
                break
            fi
            remove_path_block "$recorded_file" "$recorded_line"
        done <"$lib/path-file"
    else
        # Without a record, only the current shell's block can be identified.
        [ -z "$path_file" ] || remove_path_block "$path_file" "$path_line"
    fi
    # A startup file the installer created, and that holds nothing now, goes too; no other file.
    if [ -s "$lib/path-created" ] && plain_file "$lib/path-created"; then
        while IFS= read -r created_file || [ -n "$created_file" ]; do
            valid_path_entry "$created_file" "$export_line" || valid_path_entry "$created_file" "$fish_line" || continue
            if plain_file "$created_file" && [ ! -s "$created_file" ] && writable_file "$created_file"; then
                protected rm -f "$created_file" && say "Removed $created_file, which the installer created and which is now empty."
            fi
        done <"$lib/path-created"
    fi
    # Preserve an unsafe PATH record itself as well as any target outside the prefix.
    for entry in "$lib"/* "$lib"/.[!.]* "$lib"/..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        [ "$entry" != "$lib/release.json" ] || continue
        [ "$entry" != "$lib/path-file" ] || available_file "$entry" || continue
        protected rm -rf "$entry"
    done
    for folder in "$share/notices" "$share/skills"; do
        if [ -d "$folder" ] && [ ! -L "$folder" ]; then protected rm -rf "$folder"; fi
    done
    protected rm -f "$prefix/bin/neuve"
    # Keep the release marker until every payload file has been removed.
    protected rm -f "$lib/release.json"
    protected rmdir "$lib" 2>/dev/null || :
    protected rmdir "$prefix/bin" "$prefix/lib" "$share" "$prefix/share" 2>/dev/null || :
    finish_critical
    say "Removed Neuve from $prefix."
    say 'Kept Records in each repository'\''s .git/neuve/ folder, and settings in your user data folder.'
    say 'Hooks that neuve setup hooks added stay in each repository and agent'\''s settings; remove them by hand if you no longer want them.'
    exit 0
fi

# The release to install: a tag such as v0.1.0-preview.1, or the newest release.
# The release this installer came with, unless --version (or NEUVE_VERSION) names another, or latest.
if [ -z "$version" ]; then
    if [ -n "$shipped_version" ]; then version=$shipped_version; version_option="This installer's own release"; else version=latest; fi
fi
case "$version" in
    latest) tag= ;;
    v*) tag=$version ;;
    *) tag=v$version ;;
esac
if [ -n "$tag" ] && ! valid_version "${tag#v}"; then fail "$version_option must be latest or a release version such as 0.1.0-preview.1."; fi
[ -z "$archive" ] && [ -z "$checksums" ] || { [ -n "$archive" ] && [ -n "$checksums" ]; } || fail 'Use --archive and --checksums together.'
critical=1
temporary=$(trap '' $handled_signals; exec mktemp -d "${TMPDIR:-/tmp}/neuve-install.XXXXXXXX")
finish_critical

# The installed release against the one about to be installed: never older, and the same one only with --force.
compare_installed() {
    [ "$owned" = 1 ] || return 0
    if [ "$old_version_unreadable" = 1 ]; then
        [ "$force" = 1 ] && return 0
        fail "The release.json in $lib names no version this installer can read, so it can't tell whether $1 is older than what is installed. To replace it anyway, add --force."
    fi
    [ -n "$old_version" ] || return 0
    order=$(version_order "$1" "$old_version")
    if [ "$order" = -1 ]; then
        fail "neuve $old_version is installed in $prefix, which is newer than $1. The installer never replaces a release with an older one. To install $1, uninstall first with --uninstall."
    fi
    # The same version again installs in place when the background agent is set up: that run is
    # also how a half-finished agent is repaired. Without the agent there is nothing to repair.
    if [ "$order" = 0 ] && [ "$force" = 0 ] && [ "$no_agent" = 1 ]; then
        say "neuve $old_version is already installed at $prefix/bin/neuve, so nothing changed. To install it again, add --force."
        exit 0
    fi
}

# The archive against SHA256SUMS, before anything reads or unpacks it.
verify_archive() {
    [ -f "$archive" ] && [ -f "$checksums" ] || fail 'Can'\''t find the archive or SHA256SUMS file. Check the --archive and --checksums paths.'
    expected=$(awk -v name="$asset" '$2 == name && length($1) == 64 && $1 !~ /[^0-9a-f]/ {print $1}' "$checksums")
    [ "${#expected}" = 64 ] || fail "SHA256SUMS doesn't list $asset exactly once, so it can't be checked."
    [ -n "$hash_tool" ] || fail 'Install shasum or sha256sum to verify the release.'
    actual=$(hash_file "$archive") || fail 'Can'\''t read the release archive.'
    actual=${actual%% *}
    [ "$actual" = "$expected" ] || fail "$asset doesn't match SHA256SUMS, so nothing was installed."
}
route=
token=
json_value() {
    json_value=$(plutil -extract "$2" raw -n -o - "$1" 2>/dev/null && printf '.') || return 1
    json_value=${json_value%.}
}
github_error() {
    case "$1" in
        401) fail "GitHub refused the token (HTTP 401). Check that GH_TOKEN or GITHUB_TOKEN holds a valid token." ;;
        403) fail "GitHub refused the request (HTTP 403). Check that the token can read $repo; if you made many requests, wait a while and try again." ;;
        404) fail "Couldn't find $2 in $repo (HTTP 404). Check the version, and that your GitHub account can read $repo." ;;
        000) show_error "$temporary/curl-error"; fail "Couldn't reach GitHub. Check your network." ;;
        *) fail "GitHub answered HTTP $1 for $2 in $repo." ;;
    esac
}
# GET from the GitHub API with the token. The token travels in curl's config on stdin, so it
# never appears in a process's arguments, a file or the output.
api_get() {
    api_status=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | protected curl -q --config - -sS \
        -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
        -o "$2" -w '%{http_code}' "$api$1" 2>"$temporary/curl-error") || api_status=000
}
api_asset() {
    asset_result=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | protected curl -q --config - -sS \
        -H 'Accept: application/octet-stream' -H 'X-GitHub-Api-Version: 2022-11-28' \
        -o "$2" -w '%{http_code} %{redirect_url}' "$api/repos/$repo/releases/assets/$1" 2>"$temporary/curl-error") || asset_result=000
    asset_status=${asset_result%% *}
    location=${asset_result#"$asset_status"}
    location=${location# }
    case "$asset_status" in
        200) ;;
        301|302|303|307|308)
            # GitHub sends the file from another host. Follow it without the token.
            case "$location" in
                https://*) ;;
                http://127.0.0.1:*|http://localhost:*) case "$api" in http://127.0.0.1:*|http://localhost:*) ;; *) fail "GitHub sent $3 from an address this installer won't use." ;; esac ;;
                *) fail "GitHub sent $3 from an address this installer won't use." ;;
            esac
            protected curl -q -fsSL --proto-redir '=https' -o "$2" "$location" 2>"$temporary/curl-error" || { show_error "$temporary/curl-error"; fail "Couldn't download $3 from $repo. Check your network, and try again."; } ;;
        *) github_error "$asset_status" "$3" ;;
    esac
}
choose_route() {
    if [ -n "$archive" ]; then route=archive; return 0; fi
    if command -v gh >/dev/null 2>&1 && protected gh auth status --hostname github.com >/dev/null 2>&1; then route=gh; return 0; fi
    token=${GH_TOKEN:-${GITHUB_TOKEN:-}}
    # The token route reads GitHub's answers with plutil, which only macOS has. Elsewhere a token in
    # the environment (every Codespace sets GITHUB_TOKEN) mustn't stop the public download (NEU-375).
    if [ -n "$token" ] && ! command -v plutil >/dev/null 2>&1 && [ "$platform" != darwin ]; then token=; fi
    if [ -n "$token" ]; then
        case "$token" in *[!A-Za-z0-9_.-]*) fail 'GH_TOKEN or GITHUB_TOKEN holds characters a GitHub token never has. Check its value.' ;; esac
        case "$api" in
            https://*|http://127.0.0.1:*|http://localhost:*) ;;
            *) fail 'NEUVE_GITHUB_API must be an https address.' ;;
        esac
        command -v curl >/dev/null 2>&1 || fail 'Install curl to download the release with a token.'
        command -v plutil >/dev/null 2>&1 || fail "Can't find plutil, which macOS includes, to read GitHub's answers."
        route=token
        return 0
    fi
    # Without a sign-in, a public repository's releases download over plain HTTPS.
    if command -v curl >/dev/null 2>&1; then
        case "$downloads" in
            https://*|http://127.0.0.1:*|http://localhost:*) ;;
            *) fail 'NEUVE_GITHUB_DOWNLOADS must be an https address.' ;;
        esac
        route=public
        return 0
    fi
    route=none
}
signin_message="Can't download from $repo without curl or a GitHub sign-in. Install curl, or sign in with the GitHub CLI (gh auth login), then run this again."
resolve_tag() {
    [ -z "$tag" ] || return 0
    # GitHub's latest/download names the newest release that isn't a preview; the archive's own
    # release.json then gives its version.
    [ "$route" != public ] || return 0
    if [ "$route" = gh ]; then
        tag=$(protected gh api "repos/$repo/releases?per_page=30" --jq '[.[] | select(.draft | not)][0].tag_name // ""' 2>"$temporary/gh-error") || { show_error "$temporary/gh-error"; fail "Couldn't list the releases of $repo. Check that your GitHub account can read it."; }
    else
        api_get "/repos/$repo/releases?per_page=30" "$temporary/releases.json"
        [ "$api_status" = 200 ] || github_error "$api_status" "the releases"
        index=0
        tag=
        while json_value "$temporary/releases.json" "$index.tag_name"; do
            json_value "$temporary/releases.json" "$index.draft" || json_value=false
            if [ "$json_value" != true ]; then json_value "$temporary/releases.json" "$index.tag_name"; tag=$json_value; break; fi
            index=$((index + 1))
        done
    fi
    [ -n "$tag" ] || fail "$repo has no release yet."
    case "$tag" in v*) valid_version "${tag#v}" || fail "The newest release, $tag, has no version this installer understands." ;; *) fail "The newest release, $tag, has no version this installer understands." ;; esac
    latest_note=" (the newest release)"
}
# A release can ship without a build for some systems (v0.1.0 had Macs only). When its SHA256SUMS,
# read from $1, lists archives but not this machine's, say plainly that there's no build here yet
# and which systems have one. Returns when the list can't say that.
no_build_here() {
    [ -f "$1" ] || return 0
    awk -v name="$asset" '$2 == name { found = 1 } END { exit found ? 0 : 1 }' "$1" && return 0
    listed_builds=$(awk '$2 ~ /^neuve-.*\.tar\.gz$/ { name = $2; sub(/^neuve-/, "", name); sub(/\.tar\.gz$/, "", name)
        if (name == "darwin-arm64") name = "Macs with Apple silicon"; else if (name == "linux-x64") name = "Linux on x64"; else if (name == "linux-arm64") name = "Linux on arm64"
        list = list (list == "" ? "" : ", ") name } END { print list }' "$1")
    [ -n "$listed_builds" ] || return 0
    if [ -n "$tag" ]; then listed_what="The release $tag of $repo"; else listed_what="The newest release of $repo"; fi
    if [ "$platform" = linux ]; then listed_system=Linux; else listed_system=macOS; fi
    fail "$listed_what has no $listed_system build for this machine yet ($asset), so nothing was installed. It has builds for $listed_builds only."
}
public_get() {
    public_status=$(protected curl -q -sSL --proto '=https,http' --proto-redir '=https' -o "$2" -w '%{http_code}' "$1" 2>"$temporary/curl-error") || public_status=000
    case "$public_status" in
        200) ;;
        404)
            # A missing archive in a release that is there: check its SHA256SUMS before suggesting a sign-in.
            if [ "$3" = "$asset" ]; then
                listed_status=$(protected curl -q -sSL --proto '=https,http' --proto-redir '=https' -o "$temporary/listed-sums" -w '%{http_code}' "${1%/*}/SHA256SUMS" 2>/dev/null) || listed_status=000
                [ "$listed_status" != 200 ] || no_build_here "$temporary/listed-sums"
                rm -f "$temporary/listed-sums"
            fi
            if [ -n "$tag" ]; then what="the release $tag"; else what="a release that isn't a preview"; fi
            if [ "$platform" = darwin ]; then signin="sign in with the GitHub CLI (gh auth login), or set GH_TOKEN to a GitHub token that can read $repo"
            else signin="sign in with the GitHub CLI (gh auth login)"; fi
            fail "Can't find $3 for $what in $repo. If the repository is private, $signin. Otherwise check the version, and run this again." ;;
        000) show_error "$temporary/curl-error"; fail "Couldn't download $3 from $repo. Check your network, and try again." ;;
        *) fail "GitHub answered $public_status for $3 from $repo. Try again later." ;;
    esac
}
download_release() {
    download=$temporary/download
    mkdir "$download"
    archive=$download/$asset
    checksums=$download/SHA256SUMS
    if [ "$route" = public ]; then
        if [ -n "$tag" ]; then location=download/$tag; else location=latest/download; fi
        public_get "$downloads/$repo/releases/$location/$asset" "$archive" "$asset"
        public_get "$downloads/$repo/releases/$location/SHA256SUMS" "$checksums" SHA256SUMS
    elif [ "$route" = gh ]; then
        protected gh release download "$tag" --repo "$repo" --pattern "$asset" --pattern SHA256SUMS --dir "$download" 2>"$temporary/gh-error" || { [ -f "$archive" ] || no_build_here "$checksums"; show_error "$temporary/gh-error"; fail "Couldn't download $tag from $repo. Check the version, and that your GitHub account can read $repo."; }
    else
        api_get "/repos/$repo/releases/tags/$tag" "$temporary/release.json"
        [ "$api_status" = 200 ] || github_error "$api_status" "the release $tag"
        archive_id=
        sums_id=
        index=0
        while json_value "$temporary/release.json" "assets.$index.name"; do
            name=$json_value
            json_value "$temporary/release.json" "assets.$index.id" || json_value=
            case "$json_value" in ''|*[!0-9]*) json_value= ;; esac
            if [ "$name" = "$asset" ]; then archive_id=$json_value; fi
            if [ "$name" = SHA256SUMS ]; then sums_id=$json_value; fi
            index=$((index + 1))
        done
        [ -n "$archive_id" ] && [ -n "$sums_id" ] || fail "The release $tag in $repo has no $asset or SHA256SUMS."
        api_asset "$archive_id" "$archive" "$asset"
        api_asset "$sums_id" "$checksums" SHA256SUMS
    fi
    [ -f "$archive" ] || no_build_here "$checksums"
    [ -f "$archive" ] && [ -f "$checksums" ] || fail "The download of $tag from $repo is missing $asset or SHA256SUMS."
}

latest_note=
choose_route
if [ "$dry_run" = 0 ]; then say_prefix=; say 'Neuve installer'; else say_prefix=; say 'Neuve installer (dry run: nothing is downloaded, installed or changed)'; fi
say_prefix='  '
if [ "$route" = none ]; then
    [ "$dry_run" = 0 ] || fail "A real install would stop here: $signin_message"
    fail "$signin_message"
fi
if [ "$route" != archive ]; then
    resolve_tag
    [ -z "$tag" ] || compare_installed "${tag#v}"
fi
if [ "$dry_run" = 1 ]; then
    if [ "$route" = archive ]; then
        verify_archive
        protected tar -xOzf "$archive" "neuve-$target/lib/neuve/release.json" >"$temporary/release-record" 2>/dev/null || fail 'The archive has no release.json.'
        archive_version=$(json_string "$temporary/release-record" version)
        valid_version "$archive_version" || fail 'The release has no valid version.'
        if [ -n "$tag" ] && [ "v$archive_version" != "$tag" ]; then
            if [ "$version_option" = "This installer's own release" ]; then fail "This installer installs neuve $shipped_version, the release it came with, but the archive holds neuve $archive_version. To install that one, add --version $archive_version."; fi
            fail 'The release doesn'\''t match the version you asked for.'
        fi
        compare_installed "$archive_version"
        say "Release: neuve $archive_version from $archive, checked against $checksums."
        if xattr -p com.apple.quarantine "$archive" >/dev/null 2>&1; then say "A real install would stop here: macOS marks $archive as downloaded from the internet. To clear the mark, run: xattr -d com.apple.quarantine \"$archive\"."; fi
    else
        case "$route" in
            gh) how="downloaded with the GitHub CLI's sign-in" ;;
            token) how="downloaded with the token in GH_TOKEN or GITHUB_TOKEN, sent only to GitHub" ;;
            *) how="downloaded without a sign-in, from $downloads" ;;
        esac
        if [ -n "$tag" ]; then release_label="$tag$latest_note of $repo"; else release_label="the newest release of $repo that isn't a preview"; fi
        say "Release: $release_label, $how; checked against SHA256SUMS before anything is installed."
    fi
    if [ "$owned" = 1 ] && [ -n "$old_version" ]; then installed_note="replacing neuve $old_version"; else installed_note="a new install"; fi
    say "Would install into $prefix ($installed_note)."
    case ":$PATH:" in
        *":$prefix/bin:"*) say "PATH: $prefix/bin is already on PATH." ;;
        *)
            if [ "$no_path" = 1 ] || [ -z "$path_file" ]; then say "PATH: would leave startup files alone. Add this line to yours: $path_line"
            else say "PATH: would add this line to $path_file, after the comment # Added by the Neuve installer: $path_line"; fi ;;
    esac
    if [ "$no_skills" = 1 ]; then say "Agent skills: not offered (--no-skills)."
    else say "Agent skills: would be offered; nothing is written without your yes."; fi
    winner=$(command -v neuve || :)
    if [ -n "$winner" ] && [ "$winner" != "$prefix/bin/neuve" ]; then say "In this terminal, the neuve command runs $winner."; fi
    if [ "$owned" = 1 ]; then say 'Setup: would run neuve setup upgrade for what this version adds.'; fi
    say_prefix=
    say ''
    if [ "$owned" = 1 ]; then say 'Then, in a repository already set up: neuve doctor'
    else say 'Then, in your repository: neuve setup'; fi
    exit 0
fi
[ "$route" = archive ] || download_release
# The token is needed only for the download.
unset GH_TOKEN GITHUB_TOKEN 2>/dev/null || :
token=
verify_archive
# A file downloaded through a browser carries macOS's quarantine mark, which tar passes to every file
# it unpacks. macOS then holds the unsigned neuve at its first run, so stop before running anything.
quarantine_message="macOS marks $archive as downloaded from the internet (com.apple.quarantine), so it would stop neuve from running. Nothing was installed. To clear the mark, run: xattr -d com.apple.quarantine \"$archive\". Then run the same command again."
if xattr -p com.apple.quarantine "$archive" >/dev/null 2>&1; then fail "$quarantine_message"; fi
# Reject traversal and links before extracting anything under the prefix.
protected tar -tzf "$archive" >"$temporary/members" 2>"$temporary/tar-error" || { show_error "$temporary/tar-error"; fail 'Can'\''t read the release archive.'; }
while IFS= read -r member; do
    case "$member" in "neuve-$target/"*) ;; *) fail 'The archive has an unexpected top-level folder.' ;; esac
    case "/$member" in */../*|*/./*|*'//'*) fail 'The archive contains an unsafe path.' ;; esac
done <"$temporary/members"
protected tar -tvzf "$archive" >"$temporary/modes" 2>"$temporary/tar-error" || { show_error "$temporary/tar-error"; fail 'Can'\''t inspect the release archive.'; }
if LC_ALL=C grep -Eq '^[^d-]' "$temporary/modes"; then fail 'The archive contains a link or special file.'; fi
# The release's own record decides the version, before anything under the prefix changes.
protected tar -xOzf "$archive" "neuve-$target/lib/neuve/release.json" >"$temporary/release-record" 2>"$temporary/tar-error" || { show_error "$temporary/tar-error"; fail 'The archive has no release.json.'; }
[ "$(json_string "$temporary/release-record" target)" = "$target" ] || fail 'This release is built for another platform.'
installed_version=$(json_string "$temporary/release-record" version)
valid_version "$installed_version" || fail 'The release has no valid version.'
if [ -n "$tag" ] && [ "v$installed_version" != "$tag" ]; then
    if [ "$version_option" = "This installer's own release" ]; then fail "This installer installs neuve $shipped_version, the release it came with, but the archive holds neuve $installed_version. To install that one, add --version $installed_version."; fi
    fail 'The release doesn'\''t match the version you asked for.'
fi
compare_installed "$installed_version"
if [ "$owned" = 0 ] && [ "$force" = 0 ] && foreign_payload; then fail 'This folder already has a bin/neuve, lib/neuve or share/neuve that this installer didn'\''t write. Choose another folder with --prefix, or use --force to replace it.'; fi
create_directory "$prefix"
take_lock
refresh_ownership
compare_installed "$installed_version"
if [ "$owned" = 0 ] && [ "$force" = 0 ] && foreign_payload; then fail 'This folder already has a bin/neuve, lib/neuve or share/neuve that this installer didn'\''t write. Choose another folder with --prefix, or use --force to replace it.'; fi
stage_candidate=$prefix/.staging.$$
critical=1
if protected mkdir "$stage_candidate" 2>/dev/null; then
    staging=$stage_candidate
else
    finish_critical
    fail "Can't create $stage_candidate to unpack the release."
fi
finish_critical
protected tar -xzf "$archive" -C "$staging" 2>"$temporary/tar-error" || { show_error "$temporary/tar-error"; fail 'Can'\''t unpack the release archive.'; }
stage=$staging/neuve-$target
if xattr -r -l "$stage" 2>/dev/null | grep -q 'com\.apple\.quarantine'; then fail "$quarantine_message"; fi
release=$stage/lib/neuve/release.json
[ -f "$release" ] || fail 'The archive has no release.json.'
cmp -s "$release" "$temporary/release-record" || fail 'The archive changed while it was being installed, so nothing was replaced.'
reported=$("$stage/bin/neuve" --version 2>"$temporary/version-error") || { show_error "$temporary/version-error"; fail 'The downloaded neuve doesn'\''t run on this machine, so nothing was replaced.'; }
[ "$reported" = "neuve $installed_version" ] || fail 'The downloaded neuve reports a different version from its release.json, so nothing was replaced.'
staged_hash=$(hash_file "$stage/bin/neuve")
[ "$(json_string "$release" cliSha256)" = "${staged_hash%% *}" ] || fail 'The downloaded neuve doesn'\''t match its release.json, so nothing was replaced.'
[ -f "$stage/lib/neuve/install.json.in" ] || fail 'The archive has no install.json.in.'
[ -x "$stage/lib/neuve/entire-graph" ] || fail 'The archive'\''s Neuve Graph engine is missing or not executable.'
"$stage/lib/neuve/entire-graph" version >/dev/null 2>"$temporary/graph-error" || { show_error "$temporary/graph-error"; fail 'The downloaded Neuve Graph engine doesn'\''t run on this machine, so nothing was replaced.'; }
installed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
sed -e "s|@NEUVE_INSTALLED_AT@|$installed_at|g" -e "s|@NEUVE_PREFIX@|$prefix|g" "$stage/lib/neuve/install.json.in" >"$stage/lib/neuve/install.json"
protected rm "$stage/lib/neuve/install.json.in"
for file in "$prefix/bin/neuve" "$lib/entire-graph" "$lib/install.json" "$lib/release.json"; do
    if [ -L "$file" ] || { [ -e "$file" ] && [ ! -f "$file" ]; }; then fail "$file isn't a plain file, so the installer won't replace it. Move it away and try again."; fi
done
for folder in "$lib/semantic" "$lib/desk" "$share/notices" "$share/skills"; do
    if [ -L "$folder" ] || { [ -e "$folder" ] && [ ! -d "$folder" ]; }; then fail "$folder isn't a real folder, so the installer won't replace it. Move it away and try again."; fi
done
create_directory "$prefix/bin"
create_directory "$lib"
create_directory "$share"
protected mkdir -p "$staging/old/bin" "$staging/old/lib/neuve" "$staging/old/share/neuve"
protected mkdir -p "$staging/written/bin" "$staging/written/lib/neuve" "$staging/written/share/neuve"
replace_component() {
    kind=$1
    component=$2
    source=$stage/$component
    destination=$prefix/$component
    backup=$staging/old/$component
    if [ -e "$source" ]; then
        protected cp -Rp "$source" "$staging/written/$component"
    fi
    previous=absent
    if [ -e "$destination" ]; then
        previous=present
        # Files stay at their stable paths until the new file is renamed over them.
        if [ "$kind" = file ]; then
            protected cp -p "$destination" "$backup" 2>"$temporary/move-error" || { show_error "$temporary/move-error"; fail "Can't replace $destination."; }
        fi
    fi
    # Prepending records reverse order, including a signal just after a rename.
    operation=$kind
    if [ "$kind" = file ] && [ ! -e "$source" ]; then operation=removal; fi
    journal="$operation:$previous:$component $journal"
    if [ "$kind" = folder ] && [ "$previous" = present ]; then
        protected mv "$destination" "$backup" 2>"$temporary/move-error" || { show_error "$temporary/move-error"; fail "Can't replace $destination."; }
    fi
    if [ -e "$source" ]; then
        protected mv -f "$source" "$destination" 2>"$temporary/move-error" || { show_error "$temporary/move-error"; fail "Can't replace $destination."; }
    elif [ "$kind" = file ]; then protected rm -f "$destination"; fi
}
transaction=1
for name in lib/neuve/semantic lib/neuve/desk share/neuve/notices share/neuve/skills; do
    if [ -d "$stage/$name" ] || [ "$owned" = 1 ]; then replace_component folder "$name"; fi
done
replace_component file lib/neuve/entire-graph
replace_component file bin/neuve
# Preserve the record across upgrades; the build never writes this installer state.
path_record=1
if ! available_file "$lib/path-file"; then
    path_record=0
    say "$lib/path-file isn't a plain file, so the installer left it alone."
elif ! writable_file "$lib/path-file"; then
    path_record=0
    say "Can't write to $lib/path-file, so the installer left it alone."
else
    if [ -f "$lib/path-file" ]; then protected cp -p "$lib/path-file" "$stage/lib/neuve/path-file";
    else : >"$stage/lib/neuve/path-file"; fi
    replace_component file lib/neuve/path-file
    # The startup files this installer created, which an uninstall may remove once they are empty.
    if [ -f "$lib/path-created" ] && plain_file "$lib/path-created"; then protected cp -p "$lib/path-created" "$stage/lib/neuve/path-created";
    else : >"$stage/lib/neuve/path-created"; fi
    replace_component file lib/neuve/path-created
fi
# Metadata only describes the new version after every executable and folder is in place.
replace_component file lib/neuve/release.json
replace_component file lib/neuve/install.json
append_path_record() {
    critical=1
    command printf '%s\n%s\n' "$1" "$2" >>"$staging/written/lib/neuve/path-file"
    printf '%s\n%s\n' "$1" "$2" >>"$lib/path-file"
    finish_critical
}
record_path_file() {
    [ "$path_record" = 1 ] && valid_path_entry "$1" "$2" && plain_file "$1" || return 0
    if has_path_block "$1" "$2"; then
        if ! NEUVE_PATH_FILE=$1 NEUVE_PATH_LINE=$2 awk '
            NR % 2 { file=$0; next }
            file == ENVIRON["NEUVE_PATH_FILE"] && $0 == ENVIRON["NEUVE_PATH_LINE"] { found=1 }
            END { exit !found }
        ' "$lib/path-file"; then
            append_path_record "$1" "$2"
        fi
    fi
}
# Recover missing records from the supported shells, including after a shell change.
for startup_file in "$path_file" "$startup_zdotdir/.zshrc" "$startup_home/.bashrc" "$startup_home/.bash_profile" "$startup_home/.config/fish/conf.d/neuve.fish"; do
    record_path_file "$startup_file" "$export_line"
    record_path_file "$startup_file" "$fish_line"
done
on_path=0
case ":$PATH:" in *":$prefix/bin:"*) on_path=1 ;;
    *)
        if [ "$no_path" = 0 ] && [ -n "$path_file" ]; then
            if ! valid_path_entry "$path_file" "$path_line"; then
                say "Add this line to your shell startup file: $path_line"
            elif ! available_file "$path_file" || [ "$path_record" = 0 ]; then
                if [ -L "$path_file" ] && [ ! -e "$path_file" ]; then
                    say "$path_file links to a file that doesn't exist, so the installer left it alone."
                elif ! available_file "$path_file"; then
                    say "$path_file isn't a plain file, so the installer left it alone."
                fi
                say "Add this line to your shell startup file: $path_line"
            elif ! writable_file "$path_file"; then
                say "Can't write to $path_file, so the installer left it alone."
                say "Add this line to your shell startup file: $path_line"
            elif [ ! -f "$path_file" ] || ! grep -F -x "$path_line" "$path_file" >/dev/null; then
                path_output dirname "$path_file"
                create_directory "$path_value"
                if [ -e "$path_file" ]; then
                    protected cp -p "$path_file" "$temporary/path-original"
                    path_existed=1
                fi
                path_output dirname "$path_file"
                path_output physical "$path_value"
                path_parent=$path_value
                if [ "$path_existed" = 1 ]; then protected cp -p "$temporary/path-original" "$temporary/path-written"; else : >"$temporary/path-written"; fi
                append_path_record "$path_file" "$path_line"
                if [ "$path_existed" = 0 ]; then
                    critical=1
                    command printf '%s\n' "$path_file" >>"$staging/written/lib/neuve/path-created"
                    printf '%s\n' "$path_file" >>"$lib/path-created"
                    finish_critical
                fi
                critical=1
                path_changed=1
                # Add a separator only when the existing last line has no newline.
                if [ -s "$path_file" ] && [ -n "$(tail -c 1 "$path_file")" ]; then command printf '\n' >>"$temporary/path-written"; printf '\n' >>"$path_file"; fi
                command printf '# Added by the Neuve installer\n%s\n' "$path_line" >>"$temporary/path-written"
                printf '# Added by the Neuve installer\n%s\n' "$path_line" >>"$path_file"
                finish_critical
                say "Added $prefix/bin to PATH in $path_file."
            fi
        else say "Add this line to your shell startup file: $path_line"; fi ;;
esac
if [ "$platform" = darwin ] && [ "$no_agent" != 1 ]; then
    agent_final_needed=1
    if ! available_file "$plist"; then
        say "$plist isn't a plain file, so the installer didn't set up the launchd agent. Move it away and try again."
    elif [ ! -e "$plist" ] || agent_is_claim; then
        if agent_preflight; then
            path_output dirname "$plist"
            create_directory "$path_value"
            create_directory "${agent_log%/*}"
            # Noclobber uses O_EXCL across prefixes. Only this prefix may reclaim its marker.
            critical=1
            command printf 'Neuve installer claim\n%s\n' "$prefix" >"$temporary/agent-written"
            if agent_is_claim || (trap '' $handled_signals; set -C; printf 'Neuve installer claim\n%s\n' "$prefix" >"$plist") 2>/dev/null; then
                agent_created=1
            fi
            finish_critical
            if [ "$agent_created" = 1 ]; then
                agent_command install-agent
                say 'Installed the launchd agent that starts background workers at login and every 5 minutes.'
            elif ! available_file "$plist"; then
                say "$plist isn't a plain file, so the installer didn't set up the launchd agent. Move it away and try again."
            elif agent_is_ours; then reuse_agent
            else agent_other_owner; fi
        fi
    elif agent_is_ours; then reuse_agent
    else agent_other_owner; fi
fi
if [ "$platform" = linux ] && [ "$no_agent" != 1 ]; then
    critical=1
    NEUVE_INSTALL_AGENT_RECEIPT=$temporary/agent-installed agent_command install-agent
    # The registration receipt is separate from the user-facing text.
    if [ -f "$temporary/agent-installed" ]; then linux_agent_changed=1; fi
    finish_critical
    while IFS= read -r line; do say "$line"; done <"$temporary/agent-output"
fi
# Every file is in place. This line is the transaction's last step: an interruption here still
# rolls back, and from the next line on nothing is.
say "Installed neuve $installed_version at $prefix/bin/neuve."
transaction=0
if [ "$owned" = 1 ]; then say 'Workers already running keep the old version until they stop: neuve worker stop'; fi
# macOS refuses to run files marked as downloaded from the internet until the mark is cleared.
quarantined=0
for path in "$prefix/bin/neuve" "$lib" "$share"; do
    # Plain files only: xattr -r reads every entry it finds, so a FIFO here would block it for ever.
    if find "$path" -type f -exec xattr -p com.apple.quarantine {} + 2>/dev/null | grep -q .; then quarantined=1; fi
done
if [ "$quarantined" = 1 ]; then
    say "macOS marks some of the installed files as downloaded from the internet (com.apple.quarantine), so it may refuse to run them. To clear the mark, run:"
    say "  xattr -dr com.apple.quarantine \"$prefix\""
fi
# Which neuve a terminal runs: this install, or another copy earlier on PATH.
winner=$(command -v neuve || :)
if [ -n "$winner" ] && [ "$winner" != "$prefix/bin/neuve" ]; then
    if [ "$path_changed" = 1 ]; then
        say "In this terminal, the neuve command still runs $winner. New terminals run $prefix/bin/neuve, because the line added to $path_file puts $prefix/bin first on PATH."
    elif [ "$on_path" = 1 ]; then
        say "The neuve command runs $winner, which comes before $prefix/bin on PATH. To run this install, put $prefix/bin first on PATH, or run $prefix/bin/neuve."
    else
        say "The neuve command runs $winner. To run this install, put $prefix/bin first on PATH, or run $prefix/bin/neuve."
    fi
fi
# The agent skills: offered by neuve itself, which lists the files and asks first. The installer
# never writes any agent's configuration.
if [ "$no_skills" = 0 ]; then
    if "$prefix/bin/neuve" skills --help >/dev/null 2>&1; then
        if (exec </dev/tty) 2>/dev/null; then
            "$prefix/bin/neuve" skills install --offer </dev/tty || say "The agent skills weren't added. To add them later, run neuve skills install."
        else
            say "To add the agent skills, run neuve skills install."
        fi
    else
        say "Agent skills can be added later, once a release includes them."
    fi
fi
# After an upgrade, the new CLI's setup runs the steps this version adds, on this machine and in
# each repository set up here, and undoes those it drops; one that needs an answer waits for a
# terminal. A release whose setup has no such command is left to neuve setup in each repository.
if [ "$owned" = 1 ]; then
    skip_skills=
    if [ "$no_skills" = 1 ]; then skip_skills=1; fi
    if "$prefix/bin/neuve" setup --help 2>/dev/null | grep -q 'neuve setup upgrade'; then
        if (exec </dev/tty) 2>/dev/null; then
            "$prefix/bin/neuve" setup upgrade ${skip_skills:+--no-skills} </dev/tty || say "Setup's steps for this version didn't all run. To finish them, run neuve setup upgrade."
        else
            "$prefix/bin/neuve" setup upgrade ${skip_skills:+--no-skills} </dev/null || say "Setup's steps for this version didn't all run. To finish them, run neuve setup upgrade."
        fi
    fi
fi
# One summary with the next command. An upgrade leaves each repository's setup and records where
# they are; the new CLI opens them.
say_prefix=
say ''
say 'Neuve is installed.'
if [ "$path_changed" = 1 ]; then say '  Open a new terminal, or run: exec $SHELL'; fi
if [ "$owned" = 1 ]; then say '  Next, in a repository already set up: neuve doctor'
else say '  Next, in your repository: neuve setup'; fi
}

main "$@"
