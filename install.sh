#!/bin/bash
# install.sh — set up local-model coding on an Apple Silicon Mac.
#
# Installs Ollama, pulls the base models, builds the tuned variants, installs
# pi and these extensions, and raises the GPU memory limit. Idempotent: safe to
# re-run, skips anything already in place.
#
#   ./install.sh                 everything
#   ./install.sh --skip-models   config only (no ~67GB of downloads)
#   ./install.sh --skip-sysctl   don't touch the GPU memory limit (no sudo)
#   ./install.sh --yes           don't ask before large downloads
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_MODELS=0; SKIP_SYSCTL=0; ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --skip-models) SKIP_MODELS=1 ;;
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
ask()  { [[ $ASSUME_YES -eq 1 ]] && return 0; read -r -p "  $1 [y/N] " a; [[ "$a" =~ ^[Yy] ]]; }

# GPU memory ceiling. macOS defaults to ~75% of RAM. We take ~83%, leaving
# ~8GB for the OS on a 48GB machine, and scale it rather than hardcoding: on a
# 32GB Mac, 40GB would be nonsense.
TOTAL_MB=$(( $(sysctl -n hw.memsize) / 1048576 ))
WIRED_LIMIT_MB=$(( TOTAL_MB * 83 / 100 ))
(( WIRED_LIMIT_MB > TOTAL_MB - 8192 )) && WIRED_LIMIT_MB=$(( TOTAL_MB - 8192 ))
GPU_PLIST=/Library/LaunchDaemons/local.iogpu-wired-limit.plist
ENV_PLIST="$HOME/Library/LaunchAgents/local.ollama-env.plist"

BASE_MODELS=(
  "qwen3-coder:30b"     # 18GB MoE, 3B active — fastest generation
  "qwen3.8:27b-mlx"     # 18GB 4-bit MLX     — base for -fast and -medium
  "qwen3.8:27b-mxfp8"   # 31GB 8-bit MLX     — base for -reasoning
)

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
elif (( TOTAL_GB < 48 )); then
  warn "Under 48GB: qwen3.8-8MLX (31GB weights) will be a tight fit."
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

# Flash attention and a quantised KV cache: measured ~2.3x generation speed at
# long context. OLLAMA_KEEP_ALIVE matters as much: the default is 5 minutes, and
# a per-request keep_alive does not stick because the next request without one
# resets it — so a 20GB model unloads during any pause and the next message pays
# a full reload. The brew service plist sets the first two; Ollama.app sets
# none, so it needs a login agent that exports them before the app starts.
# OLLAMA_MAX_LOADED_MODELS=1 is a memory guard: the default lets Ollama keep
# several models resident, and two 18GB models plus their caches do not fit in
# 48GB. Combined with a 2h keep-alive, the default is actively dangerous.
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
    <string>launchctl setenv OLLAMA_FLASH_ATTENTION 1; launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0; launchctl setenv OLLAMA_KEEP_ALIVE 2h; launchctl setenv OLLAMA_MAX_LOADED_MODELS 1</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
  launchctl unload "$ENV_PLIST" 2>/dev/null || true
  launchctl load -w "$ENV_PLIST" 2>/dev/null || true
  launchctl setenv OLLAMA_FLASH_ATTENTION 1
  launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0
  launchctl setenv OLLAMA_KEEP_ALIVE 2h
  launchctl setenv OLLAMA_MAX_LOADED_MODELS 1
  ok "login agent installed (restart Ollama.app for it to take effect)"
else
  launchctl setenv OLLAMA_KEEP_ALIVE 2h 2>/dev/null || true
  launchctl setenv OLLAMA_MAX_LOADED_MODELS 1 2>/dev/null || true
  ok "brew service exports the performance vars; keep-alive set to 2h"
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

# ---------------------------------------------------------------- models

step "Models"
if [[ $SKIP_MODELS -eq 1 ]]; then
  warn "skipped (--skip-models)"
else
  MISSING=()
  for m in "${BASE_MODELS[@]}"; do
    ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$m" && ok "$m present" || MISSING+=("$m")
  done
  if (( ${#MISSING[@]} )); then
    echo "  To download: ${MISSING[*]}"
    echo "  ${d}That is roughly 67 GB in total and will take a while.${r}"
    if ask "Download now?"; then
      for m in "${MISSING[@]}"; do
        echo "  pulling $m"
        ollama pull "$m" || die "failed to pull $m"
      done
    else
      warn "skipped — the variants below will fail until the base models exist"
    fi
  fi

  # Variants: same weights, different context and sampling. Cheap to build —
  # they share the base model's blobs, so no extra disk.
  for mf in "$HERE"/modelfiles/*.modelfile; do
    name=$(basename "$mf" .modelfile)
    if ollama create "$name" -f "$mf" >/dev/null 2>&1; then
      ok "built $name"
    else
      warn "could not build $name (base model missing?)"
    fi
  done
fi

# ---------------------------------------------------------------- pi

step "pi"
if command -v pi >/dev/null; then
  ok "already installed (v$(pi --version 2>/dev/null | head -1))"
else
  npm i -g @earendil-works/pi-coding-agent >/dev/null && ok "installed"
fi

step "Extensions"
for ext in "$HERE"/extensions/*.ts; do
  if pi install "$ext" >/dev/null 2>&1; then
    ok "$(basename "$ext")"
  else
    warn "failed to register $(basename "$ext")"
  fi
done

# ---------------------------------------------------------------- verify

step "Verifying"
if curl -sf --max-time 3 http://localhost:11434/api/version >/dev/null; then
  ok "Ollama reachable"
else
  warn "Ollama not responding — start Ollama.app or run: brew services start ollama"
fi

if pi --list-models 2>/dev/null | grep -q ollama-local; then
  ok "models registered with pi:"
  pi --list-models 2>/dev/null | grep ollama-local | sed 's/^/    /'
else
  warn "no ollama-local models in pi — check the extension registered"
fi

echo
echo "${b}Done.${r} Start with:  ${b}pi --provider ollama-local --model qwen3-coder:30b${r}"
echo "${d}Low on memory? The guard offers models that fit. Quitting Chrome frees the most.${r}"
