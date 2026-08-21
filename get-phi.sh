#!/bin/bash
# get-phi.sh — install phi and everything it needs, from nothing.
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
# resets it — so an 18GB model unloads during any pause and the next message
# pays a full reload. OLLAMA_MAX_LOADED_MODELS=1 is a memory guard.
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
    <string>launchctl setenv OLLAMA_KEEP_ALIVE 2h; launchctl setenv OLLAMA_MAX_LOADED_MODELS 1</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
  launchctl unload "$ENV_PLIST" 2>/dev/null || true
  launchctl load -w "$ENV_PLIST" 2>/dev/null || true
  launchctl setenv OLLAMA_KEEP_ALIVE 2h
  launchctl setenv OLLAMA_MAX_LOADED_MODELS 1
  ok "login agent installed (restart Ollama.app for it to take effect)"
else
  launchctl setenv OLLAMA_KEEP_ALIVE 2h 2>/dev/null || true
  launchctl setenv OLLAMA_MAX_LOADED_MODELS 1 2>/dev/null || true
  ok "keep-alive set to 2h"
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
    warn "skipped — deep-context sessions may fall back to the CPU"
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
# one is selected, which is why an established machine needs no flags — but a
# fresh one has nothing to persist yet, and without this the first `pi` opens
# on whatever provider it can find rather than the local roster.
# Only fills in what is missing: an existing choice is the user's, not ours.
step "phi"
export PI_CODING_AGENT_DIR="$PHI_HOME"
mkdir -p "$PHI_HOME/agent"
if pi list 2>/dev/null | grep -q "$PHI_REPO"; then
  ok "already installed in $PHI_HOME; updating"
  pi update "$PHI_REPO" >/dev/null 2>&1 && ok "up to date" || warn "could not update (offline?)"
else
  pi install "$PHI_REPO" >/dev/null 2>&1 && ok "installed into $PHI_HOME" || die "pi install $PHI_REPO failed"
fi

step "Defaults"
SETTINGS="$PHI_HOME/agent/settings.json"
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
for k, v in (("defaultProvider", "ollama-local"), ("defaultModel", "qwen3.8-4MLX"),
             ("theme", "phi-purple"), ("tuiMode", "fullscreen"), ("quietStartup", True)):
    if not s.get(k):
        s[k] = v; changed = True
if changed:
    with open(p, "w") as f: json.dump(s, f, indent=2)
print("set" if changed else "kept")
PY
then
  ok "defaults in place: local roster, purple theme, fullscreen TUI, quiet startup"
else
  warn "could not write $SETTINGS"
fi

step "The phi command"
WRAPPER="$PHI_HOME/agent/git/github.com/rcrdortiz/phi/bin/phi"
if [ ! -f "$WRAPPER" ]; then
  warn "launcher not found at $WRAPPER; run phi with: PI_CODING_AGENT_DIR=$PHI_HOME pi"
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
  ln -sf "$WRAPPER" "$BINDIR/phi"
  ok "phi -> $BINDIR/phi  (pi is untouched and stays vanilla)"
fi

# ---------------------------------------------------------------- verify

step "Verifying"
if curl -sf --max-time 3 http://localhost:11434/api/version >/dev/null; then
  ok "Ollama reachable"
else
  warn "Ollama not responding — start Ollama.app or run: brew services start ollama"
fi

if pi list 2>/dev/null | grep -q "$PHI_REPO"; then
  ok "phi is installed as a pi package"
else
  warn "phi is not installed, re-run this script"
fi
if command -v phi >/dev/null 2>&1; then
  ok "the phi command is on your PATH"
else
  warn "the phi command is not on your PATH yet; open a new shell"
fi

echo
echo "${b}Done.${r} Run  ${b}phi${r}  then  ${b}/model-install${r}  to pull and build a model."
echo "${d}phi is this setup; pi keeps working exactly as it did.${r}"
echo "${d}The provider and model defaults are set, and pi remembers whatever you pick with /model.${r}"
echo "${d}Low on memory? The guard offers models that fit. Quitting Chrome frees the most.${r}"
