#!/bin/bash
# get-phi.sh: install phi and everything it needs, from nothing.
#
# curl -fsSL https://raw.githubusercontent.com/rcrdortiz/phi/master/get-phi.sh | bash
#
# Installs Ollama, pi, and phi as a pi package, raises the GPU wired limit, and
# sets up the login agent that exports Ollama's env before the app starts.
# Models are NOT here: run /model-install inside pi, which knows which variants
# are preconfigured and needs no checkout.
#
# Idempotent: safe to re-run, skips anything already in place.
#
#   | bash                 everything
#   | bash -s -- --yes     don't ask
#   | bash -s -- --skip-sysctl   leave the GPU memory limit alone (no sudo)
set -euo pipefail

PHI_REPO="${PHI_REPO:-https://github.com/rcrdortiz/phi}"
# phi gets its own agent directory, so `pi` stays exactly as it was. pi keeps
# settings, installed packages and sessions all under one directory, and
# PI_CODING_AGENT_DIR picks which: two directories are two installs sharing one
# binary. Everything below that configures phi therefore targets this, never
# ~/.pi.
# PI_CODING_AGENT_DIR is the agent directory ITSELF, not its parent. Unset, pi
# uses ~/.pi/agent, so settings live at <agentdir>/settings.json and cloned
# packages at <agentdir>/git. Adding an "agent/" underneath PHI_HOME writes a
# settings file pi never reads and hides the clone one level too deep.
PHI_HOME="${PHI_HOME:-$HOME/.phi}"
SKIP_SYSCTL=0; ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --skip-sysctl) SKIP_SYSCTL=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $a"; exit 1 ;;
  esac
done

b=$(tput bold 2>/dev/null || true); d=$(tput dim 2>/dev/null || true)
r=$(tput sgr0 2>/dev/null || true); gn=$(tput setaf 2 2>/dev/null || true)
yl=$(tput setaf 3 2>/dev/null || true); rd=$(tput setaf 1 2>/dev/null || true)

step() { echo; echo "${b}==> $*${r}"; }
ok()   { echo "  ${gn}✓${r} $*"; }
warn() { echo "  ${yl}!${r} $*"; }
die()  { echo "  ${rd}✗${r} $*"; exit 1; }
# Read from the terminal explicitly. Under `curl | bash` stdin is the script
# itself, so a plain `read` consumes the script's own remaining lines and the
# answer is whatever bash was about to execute next.
ask()  {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  [[ -r /dev/tty ]] || { warn "no terminal to ask on; assuming no. Re-run with --yes to accept."; return 1; }
  read -r -p "  $1 [y/N] " a < /dev/tty
  [[ "$a" =~ ^[Yy] ]]
}

# GPU memory ceiling. macOS defaults to ~75% of RAM. We take ~83%, leaving
# ~8GB for the OS on a 48GB machine, and scale it rather than hardcoding: on a
# 32GB Mac, 40GB would be nonsense.
TOTAL_MB=$(( $(sysctl -n hw.memsize) / 1048576 ))
WIRED_LIMIT_MB=$(( TOTAL_MB * 83 / 100 ))
(( WIRED_LIMIT_MB > TOTAL_MB - 8192 )) && WIRED_LIMIT_MB=$(( TOTAL_MB - 8192 ))

# Cache slots, scaled to what the wired limit can actually hold.
#
# Two slots stop concurrent sessions evicting each other, but each one costs a
# full KV cache: about 111 KB per token, so 7.3 GB at the roster's 65536 window,
# on top of 18.5 GB of weights. That is 33 GB for two slots and 26 GB for one.
# Asking for two on a machine that cannot hold them trades one kind of eviction
# for a worse one, so a smaller machine gets a single slot and the warning that
# comes with it.
NEED_2_SLOTS_MB=33792
if (( WIRED_LIMIT_MB >= NEED_2_SLOTS_MB )); then
  OLLAMA_SLOTS=2
else
  OLLAMA_SLOTS=1
fi
GPU_PLIST=/Library/LaunchDaemons/local.iogpu-wired-limit.plist
ENV_PLIST="$HOME/Library/LaunchAgents/local.ollama-env.plist"

# ---------------------------------------------------------------- preflight

step "Checking the machine"
[[ "$(uname -s)" == "Darwin" ]] || die "macOS only."
[[ "$(uname -m)" == "arm64" ]] || die "Apple Silicon only (Intel Macs have no unified memory to speak of)."
command -v brew >/dev/null || die "Homebrew required: https://brew.sh"
ok "$(sw_vers -productName) $(sw_vers -productVersion) on $(sysctl -n machdep.cpu.brand_string)"

TOTAL_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
ok "${TOTAL_GB} GB unified memory"
if (( TOTAL_GB < 32 )); then
  warn "Under 32GB: the 27B models will not fit. Expect to use smaller ones."
fi

command -v node >/dev/null || die "node required (brew install node)"
ok "node $(node -v)"

# ---------------------------------------------------------------- ollama

step "Ollama"
if command -v ollama >/dev/null; then
  ok "already installed ($(ollama --version 2>/dev/null | head -1))"
else
  brew install ollama >/dev/null && ok "installed via brew"
fi

APP_RUNNING=0
pgrep -f "Ollama.app" >/dev/null 2>&1 && APP_RUNNING=1

if curl -sf --max-time 2 http://localhost:11434/api/version >/dev/null; then
  ok "server responding on :11434"
elif [[ $APP_RUNNING -eq 1 ]]; then
  ok "Ollama.app is starting"
else
  brew services start ollama >/dev/null 2>&1 && ok "started as a brew service"
  for _ in $(seq 1 15); do
    curl -sf --max-time 2 http://localhost:11434/api/version >/dev/null && break
    sleep 1
  done
fi

# OLLAMA_KEEP_ALIVE is the one that matters: the default is 5 minutes, and a
# per-request keep_alive does not stick because the next request without one
# resets it, so an 18GB model unloads during any pause and the next message
# pays a full reload. OLLAMA_MAX_LOADED_MODELS=1 is a memory guard.
#
# OLLAMA_NUM_PARALLEL=2 buys a second prefix-cache slot. Ollama defaults to one,
# and one slot holds one conversation: two agent sessions talking to the same
# Ollama evict each other's cache on every turn, so both re-read their whole
# history. Measured 2026-08-22, that produced 8 evictions in 30 minutes with
# 16 GB of headroom spare, each costing a full re-prefill of 27-31K tokens at
# 190-220 seconds. It looks exactly like a memory problem and is not one:
# lowering num_ctx changed nothing. Two slots cost KV cache (roughly 111 KB per
# token per slot) and are worth it. `/doctor` reports the slot count and any
# evictions.
#
# OLLAMA_FLASH_ATTENTION and OLLAMA_KV_CACHE_TYPE are deliberately NOT set.
# They are llama.cpp runner options and the MLX runner ignores them: measured
# 2026-08-20, qwen3.8-4MLX costs 136.5 KB/token at q8_0 and 136.5 at q4_0, with
# the flag confirmed in the server's own process environment. They applied only
# to the GGUF model that used to be in this roster.
#
# The brew service plist sets nothing relevant; Ollama.app sets none of these,
# so it needs a login agent that exports them before the app starts.
step "Ollama performance settings"
if [[ $APP_RUNNING -eq 1 ]]; then
  mkdir -p "$(dirname "$ENV_PLIST")"
  cat > "$ENV_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.ollama-env</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>launchctl setenv OLLAMA_KEEP_ALIVE 2h; launchctl setenv OLLAMA_MAX_LOADED_MODELS 1; launchctl setenv OLLAMA_NUM_PARALLEL ${OLLAMA_SLOTS}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
  launchctl unload "$ENV_PLIST" 2>/dev/null || true
  launchctl load -w "$ENV_PLIST" 2>/dev/null || true
  launchctl setenv OLLAMA_KEEP_ALIVE 2h
  launchctl setenv OLLAMA_MAX_LOADED_MODELS 1
  launchctl setenv OLLAMA_NUM_PARALLEL "$OLLAMA_SLOTS"
  ok "login agent installed ($OLLAMA_SLOTS cache slot(s))"
  if (( OLLAMA_SLOTS < 2 )); then
    warn "only one cache slot: this machine cannot hold two at the roster window."
    echo "      Running two agent sessions at once will make them evict each other."
  fi
  # Quitting Ollama.app from the menu bar is not always enough: the Electron
  # process can survive and respawn the server with its old environment, so the
  # new values look applied (launchctl getenv agrees) while the server still
  # runs on the old ones. Check the server's own view, not the shell's.
  warn "restart Ollama.app fully for this to take effect, then confirm with:"
  echo "      grep 'server config' ~/.ollama/logs/server.log | tail -1 | grep -o 'OLLAMA_NUM_PARALLEL:[0-9]*'"
else
  launchctl setenv OLLAMA_KEEP_ALIVE 2h 2>/dev/null || true
  launchctl setenv OLLAMA_MAX_LOADED_MODELS 1 2>/dev/null || true
  launchctl setenv OLLAMA_NUM_PARALLEL "$OLLAMA_SLOTS" 2>/dev/null || true
  ok "keep-alive 2h, $OLLAMA_SLOTS cache slot(s)"
fi

# ---------------------------------------------------------------- gpu limit

step "GPU memory limit"
CURRENT=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)
if [[ $SKIP_SYSCTL -eq 1 ]]; then
  warn "skipped (--skip-sysctl); currently ${CURRENT} MB (0 = system default)"
elif [[ "$CURRENT" == "$WIRED_LIMIT_MB" ]] && [[ -f "$GPU_PLIST" ]]; then
  ok "already ${WIRED_LIMIT_MB} MB and persistent"
else
  echo "  Raising the GPU wired limit to $((WIRED_LIMIT_MB / 1024)) GB so a large model can"
  echo "  hold its context on the GPU. This needs sudo and survives reboots."
  if ask "Set it?"; then
    sudo tee "$GPU_PLIST" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.iogpu-wired-limit</string>
  <key>ProgramArguments</key><array>
    <string>/usr/sbin/sysctl</string><string>iogpu.wired_limit_mb=${WIRED_LIMIT_MB}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
    sudo chown root:wheel "$GPU_PLIST"; sudo chmod 644 "$GPU_PLIST"
    sudo launchctl load -w "$GPU_PLIST" 2>/dev/null || true
    sudo sysctl iogpu.wired_limit_mb=${WIRED_LIMIT_MB} >/dev/null
    ok "set to ${WIRED_LIMIT_MB} MB, and reapplied at every boot"
  else
    warn "skipped; deep-context sessions may fall back to the CPU"
  fi
fi

step "pi"
if command -v pi >/dev/null; then
  ok "already installed (v$(pi --version 2>/dev/null | head -1))"
else
  npm i -g @earendil-works/pi-coding-agent >/dev/null && ok "installed"
fi

# Seed the provider/model defaults so a bare `pi` works straight after install.
# pi persists a model choice itself (setDefaultModelAndProvider) the first time
# one is selected, which is why an established machine needs no flags, but a
# fresh one has nothing to persist yet, and without this the first `pi` opens
# on whatever provider it can find rather than the local roster.
# Only fills in what is missing: an existing choice is the user's, not ours.
step "phi"
export PI_CODING_AGENT_DIR="$PHI_HOME"
mkdir -p "$PHI_HOME"
if pi list 2>/dev/null | grep -q "$PHI_REPO"; then
  ok "already installed in $PHI_HOME; updating"
  pi update "$PHI_REPO" >/dev/null 2>&1 && ok "up to date" || warn "could not update (offline?)"
else
  pi install "$PHI_REPO" >/dev/null 2>&1 && ok "installed into $PHI_HOME" || die "pi install $PHI_REPO failed"
fi

step "Defaults"
SETTINGS="$PHI_HOME/settings.json"
if python3 - "$SETTINGS" <<'PY'
import json, os, sys
p = sys.argv[1]
os.makedirs(os.path.dirname(p), exist_ok=True)
try:
    with open(p) as f: s = json.load(f)
except Exception:
    s = {}
changed = False
# quietStartup suppresses pi's [Skills]/[Extensions]/[Themes] listing. What is
# loaded is not news every single launch, and the boot box already says the
# things that change: which model, and whether anything is out of date.
# "medium". A sweep of off/low/medium/high on a bug-hunt task scored 18-20 out of
# 23 at every level, inside a noise floor of +-2 measured from identical control
# runs, and output tokens did not correlate with the level at all (r = +0.17,
# n = 11). That sweep never distinguished them, but it ran on a task short enough
# never to compact, so it says little about a real session. "low" was the cheap
# default that followed from it; "medium" is the deliberate one, because the
# failures worth caring about have been judgement rather than knowledge and
# deliberation is the lever most likely to move those. Shift+Tab lowers it live
# when a task does not warrant it.
# fullscreenExitOutput defaults to "transcript", which prints the entire session
# into the scrollback on the way out: the boot box, every tool call, every
# banner. Quitting should hand the terminal back the way it was found, so this
# is "resume-hint" instead.
# compaction.keepRecentTokens is how much recent conversation pi carries past a
# compaction. Its default is 20000, sized for a 128K+ window, and on a 64K
# window that is most of the 28,000 trigger: compacting reclaims almost nothing.
# Measured live, a compaction at 31,126 tokens left about 29,500, so the session
# stayed above the trigger, asked to compact on every turn, and handed the next
# cache miss 26,000 tokens to re-prefill. 9800 is 35% of the trigger.
# httpIdleTimeoutMs is 300000 by default, and 5 min is the largest value pi's
# own settings picker offers, but the setting itself takes any millisecond
# count. It matters because a prefix-cache miss re-prefills the whole context,
# and past the ceiling the turn comes back "Request timed out" rather than
# slowly.
#
# Re-measured 2026-08-23 against Ollama's own prompt_eval timings on a prompt it
# had never seen: 214.8 tok/s, with mlx-lm giving 218.8 on the same hardware.
# The earlier ~120 figure was taken while the prefix cache was thrashing, before
# we knew two sessions were sharing one cache slot, so it measured a fault
# rather than the machine. At the real rate a miss covers roughly 64,000 tokens
# inside 300s and 107,000 inside 500s.
#
# So the ceiling is no longer what limits working depth; the 45,000 safe depth
# is. 500s is kept anyway, because it costs nothing when nothing goes wrong and
# it is the difference between a slow turn and a lost one on a machine that is
# busy with something else. The cost is that a genuinely hung request takes 3
# minutes longer to admit it.
for k, v in (("defaultProvider", "ollama-local"), ("defaultModel", "qwen3.8-4MLX"),
             ("theme", "phi-purple"), ("tuiMode", "fullscreen"), ("quietStartup", True),
             ("fullscreenExitOutput", "resume-hint"),
             ("httpIdleTimeoutMs", 500000),
             ("compaction", {"keepRecentTokens": 9800, "reserveTokens": 16384}),
             ("defaultThinkingLevel", "medium")):
    if not s.get(k):
        s[k] = v; changed = True
if changed:
    with open(p, "w") as f: json.dump(s, f, indent=2)
print("set" if changed else "kept")
PY
then
  ok "defaults in place: local roster, purple theme, fullscreen TUI, quiet start and exit"
else
  warn "could not write $SETTINGS"
fi

step "The phi command"
# Ask pi where it put the package rather than reconstructing the path. The
# layout is pi's to change, and guessing it wrong is what shipped last time:
# the launcher step looked one directory too deep, warned, and the warning was
# lost in the install output. `pi list` prints the real location.
WRAPPER="$(pi list 2>/dev/null | awk -v repo="$PHI_REPO" '
  $0 ~ repo { found = 1; next }
  found && $1 ~ /^\// { print $1 "/bin/phi"; exit }
')"
[ -n "$WRAPPER" ] || WRAPPER="$PHI_HOME/git/github.com/rcrdortiz/phi/bin/phi"

if [ ! -f "$WRAPPER" ]; then
  warn "launcher not found at $WRAPPER"
  warn "phi will not be on your PATH. Run it with: PI_CODING_AGENT_DIR=$PHI_HOME pi"
else
  BINDIR=""
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    if [ -d "$d" ] && [ -w "$d" ]; then BINDIR="$d"; break; fi
  done
  if [ -z "$BINDIR" ]; then
    BINDIR="$HOME/.local/bin"
    mkdir -p "$BINDIR"
    case ":$PATH:" in
      *":$BINDIR:"*) ;;
      *) warn "$BINDIR is not on your PATH; add it to use the phi command" ;;
    esac
  fi
  if ln -sf "$WRAPPER" "$BINDIR/phi" 2>/dev/null && [ -x "$BINDIR/phi" ]; then
    ok "phi -> $BINDIR/phi  (pi is untouched and stays vanilla)"
  else
    warn "could not link $BINDIR/phi; run phi with: PI_CODING_AGENT_DIR=$PHI_HOME pi"
  fi
fi

# ---------------------------------------------------------------- verify

step "Verifying"
if curl -sf --max-time 3 http://localhost:11434/api/version >/dev/null; then
  ok "Ollama reachable"
else
  warn "Ollama not responding. Start Ollama.app or run: brew services start ollama"
fi

if pi list 2>/dev/null | grep -q "$PHI_REPO"; then
  ok "phi is installed as a pi package"
else
  warn "phi is not installed, re-run this script"
fi
hash -r 2>/dev/null || true   # shells cache command locations; a new link is invisible without this
if command -v phi >/dev/null 2>&1; then
  ok "the phi command is on your PATH"
elif [ -x "${BINDIR:-}/phi" ]; then
  ok "phi installed at $BINDIR/phi"
  warn "$BINDIR is not on your PATH. Add it, or run: $BINDIR/phi"
else
  warn "the phi command was not installed. Re-run this script and read the 'The phi command' step."
fi

echo
echo "${b}Done.${r} Run  ${b}phi${r}  then  ${b}/model-install${r}  to pull and build a model."
echo "${d}phi is this setup; pi keeps working exactly as it did.${r}"
echo "${d}The provider and model defaults are set, and pi remembers whatever you pick with /model.${r}"
echo "${d}Low on memory? The guard offers models that fit. Quitting Chrome frees the most.${r}"
