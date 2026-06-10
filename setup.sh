#!/usr/bin/env bash
# Setup script for the agentic video editor.
# Detects required tooling, prompts before installing anything, and reports a clear
# checklist at the end so you know exactly what's still missing.

set -u
set -o pipefail
IFS=$'\n\t'

# ────────────────────────────── pretty output ──────────────────────────────

# Disable colour if the terminal can't render it.
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ $(tput colors 2>/dev/null || echo 0) -ge 8 ]]; then
  C_BOLD=$(tput bold); C_DIM=$(tput dim); C_RST=$(tput sgr0)
  C_GREEN=$(tput setaf 2); C_RED=$(tput setaf 1); C_YEL=$(tput setaf 3); C_BLUE=$(tput setaf 6)
else
  C_BOLD=""; C_DIM=""; C_RST=""; C_GREEN=""; C_RED=""; C_YEL=""; C_BLUE=""
fi

ok()      { printf "  %s✓%s %s\n"      "$C_GREEN" "$C_RST" "$1"; }
miss()    { printf "  %s✗%s %s\n"      "$C_RED"   "$C_RST" "$1"; }
warn()    { printf "  %s!%s %s\n"      "$C_YEL"   "$C_RST" "$1"; }
info()    { printf "  %s·%s %s\n"      "$C_DIM"   "$C_RST" "$1"; }
section() { printf "\n%s%s%s\n"        "$C_BOLD"  "$1"     "$C_RST"; }
hint()    { printf "    %s%s%s\n"      "$C_DIM"   "$1"     "$C_RST"; }

ask_yes() {
  local prompt="$1"
  if [[ "${ASSUME_YES:-0}" == "1" ]]; then return 0; fi
  if [[ ! -t 0 ]]; then return 1; fi
  read -r -p "    $prompt [y/N] " ans
  [[ $ans =~ ^[Yy]$ ]]
}

# Track unmet requirements so we can fail cleanly at the end.
MISSING=()

# ────────────────────────────── helpers ──────────────────────────────

# Compare semver-ish version strings: returns 0 if $1 >= $2.
ver_ge() {
  # Pad both to 3 components, compare numerically.
  local a b
  a="$(printf '%s.0.0.0' "$1" | cut -d. -f1-3)"
  b="$(printf '%s.0.0.0' "$2" | cut -d. -f1-3)"
  [[ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -1)" == "$b" ]]
}

# ────────────────────────────── environment ──────────────────────────────

section "Environment"

OS="$(uname -s)"
ARCH="$(uname -m)"
info "Platform: $OS $ARCH"

case "$OS" in
  Darwin) PLATFORM="mac" ;;
  Linux)  PLATFORM="linux" ;;
  *)      PLATFORM="other" ;;
esac

if [[ "$PLATFORM" == "other" ]]; then
  warn "Unsupported OS for automatic install — you'll need to install dependencies manually."
fi

# Resolve the project directory (script lives at the repo root).
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
info "Project dir: $PROJECT_DIR"

# ────────────────────────────── Homebrew ──────────────────────────────

section "Homebrew"

if [[ "$PLATFORM" == "mac" ]]; then
  if command -v brew >/dev/null 2>&1; then
    ok "brew $(brew --version | head -1 | awk '{print $2}')"
  else
    miss "Homebrew not found"
    hint "Install from https://brew.sh — required for installing ffmpeg / yt-dlp."
    MISSING+=("brew")
  fi
elif [[ "$PLATFORM" == "linux" ]]; then
  if command -v apt-get >/dev/null 2>&1; then
    ok "apt-get available"
    LINUX_PKG="apt-get"
  elif command -v dnf >/dev/null 2>&1; then
    ok "dnf available"
    LINUX_PKG="dnf"
  else
    warn "No supported package manager (apt-get / dnf) — install dependencies manually."
    LINUX_PKG=""
  fi
fi

# ────────────────────────────── Node.js ──────────────────────────────

section "Node.js (>= 20.9)"

if command -v node >/dev/null 2>&1; then
  NODE_V="$(node --version | sed 's/^v//')"
  if ver_ge "$NODE_V" "20.9.0"; then
    ok "node v$NODE_V"
  else
    miss "node v$NODE_V is too old; Next.js 16 needs >= 20.9.0"
    hint "Upgrade with: brew install node  (or nvm install 22)"
    MISSING+=("node")
  fi
else
  miss "node not found"
  hint "Install with: brew install node  (or nvm install 22)"
  MISSING+=("node")
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm --version)"
else
  miss "npm not found"
  MISSING+=("npm")
fi

# ────────────────────────────── ffmpeg ──────────────────────────────

section "ffmpeg / ffprobe"

install_ffmpeg() {
  if [[ "$PLATFORM" == "mac" ]] && command -v brew >/dev/null 2>&1; then
    brew install ffmpeg
  elif [[ "$PLATFORM" == "linux" && -n "${LINUX_PKG:-}" ]]; then
    sudo "$LINUX_PKG" install -y ffmpeg
  else
    return 1
  fi
}

if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  FFMPEG_V="$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
  ok "ffmpeg $FFMPEG_V"
  info "ffprobe $(ffprobe -version 2>/dev/null | head -1 | awk '{print $3}')"
else
  miss "ffmpeg or ffprobe not found"
  if ask_yes "Install ffmpeg now?"; then
    if install_ffmpeg; then
      ok "ffmpeg installed"
    else
      miss "Couldn't install automatically — install ffmpeg manually."
      MISSING+=("ffmpeg")
    fi
  else
    MISSING+=("ffmpeg")
  fi
fi

# ────────────────────────────── yt-dlp ──────────────────────────────

section "yt-dlp"

install_ytdlp() {
  if [[ "$PLATFORM" == "mac" ]] && command -v brew >/dev/null 2>&1; then
    brew install yt-dlp
  elif [[ "$PLATFORM" == "linux" && -n "${LINUX_PKG:-}" ]]; then
    sudo "$LINUX_PKG" install -y yt-dlp || {
      warn "Package manager doesn't have yt-dlp; downloading standalone binary"
      curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
        && sudo chmod +x /usr/local/bin/yt-dlp
    }
  else
    return 1
  fi
}

if command -v yt-dlp >/dev/null 2>&1; then
  ok "yt-dlp $(yt-dlp --version 2>/dev/null | head -1)"
else
  miss "yt-dlp not found"
  hint "Used to download YouTube reference videos. Optional if you only upload files."
  if ask_yes "Install yt-dlp now?"; then
    if install_ytdlp; then
      ok "yt-dlp installed"
    else
      miss "Couldn't install automatically."
      MISSING+=("yt-dlp")
    fi
  else
    info "Skipping — YouTube reference URLs won't work until you install yt-dlp."
  fi
fi

# ────────────────────────────── Claude Code CLI ──────────────────────────────

section "Claude Code CLI"

CLAUDE_BIN=""
if command -v claude >/dev/null 2>&1; then
  CLAUDE_BIN="$(command -v claude)"
  CLAUDE_V="$(claude --version 2>/dev/null | head -1 || echo "unknown")"
  ok "claude found at $CLAUDE_BIN ($CLAUDE_V)"
else
  miss "claude CLI not found"
  hint "The Claude Agent SDK uses the local 'claude' CLI to authenticate."
  hint "Install with: npm install -g @anthropic-ai/claude-code"
  if ask_yes "Install @anthropic-ai/claude-code globally now?"; then
    if npm install -g @anthropic-ai/claude-code; then
      CLAUDE_BIN="$(command -v claude || true)"
      [[ -n "$CLAUDE_BIN" ]] && ok "claude installed at $CLAUDE_BIN" || warn "Install reported success but 'claude' not on PATH."
    else
      miss "npm install failed."
      MISSING+=("claude")
    fi
  else
    MISSING+=("claude")
  fi
fi

# Auth check: claude stores OAuth in the OS keychain on macOS, so we can't read it.
# Best we can do is verify the credentials directory exists; the SDK will fail
# loudly at first agent run if auth is actually broken.
if [[ -n "$CLAUDE_BIN" ]]; then
  if [[ -d "$HOME/.claude" ]] && [[ -f "$HOME/.claude/settings.json" || -d "$HOME/.claude/sessions" ]]; then
    ok "~/.claude exists — looks like you've signed in before."
  else
    warn "Couldn't find ~/.claude — you probably haven't signed in yet."
    hint "Run 'claude' once interactively and complete the OAuth flow."
    hint "The Agent SDK reuses that auth (no API key needed)."
  fi
fi

# ────────────────────────────── npm packages ──────────────────────────────

section "Project dependencies"

if [[ -d node_modules ]] && [[ -f node_modules/.package-lock.json || -d node_modules/.bin ]]; then
  ok "node_modules present"
  if ask_yes "Run 'npm install' to refresh?"; then
    npm install
  fi
else
  miss "node_modules missing"
  if ask_yes "Run 'npm install' now?"; then
    if npm install; then
      ok "Dependencies installed"
    else
      miss "npm install failed"
      MISSING+=("npm install")
    fi
  else
    MISSING+=("npm install")
  fi
fi

# ────────────────────────────── Next.js typegen ──────────────────────────────

section "Next.js type generation"

if [[ -f .next/types/routes.d.ts || -f .next/dev/types/routes.d.ts ]]; then
  ok "Next.js types already generated"
else
  if [[ -d node_modules/next ]]; then
    info "Running 'npx next typegen' to generate RouteContext / PageProps helpers"
    if npx next typegen >/dev/null 2>&1; then
      ok "Types generated"
    else
      warn "next typegen didn't succeed; will regenerate on first 'npm run dev'."
    fi
  else
    info "Skipping (no Next.js installed yet)"
  fi
fi

# ────────────────────────────── workspace ──────────────────────────────

section "Workspace"

mkdir -p workspaces
ok "workspaces/ ready"

# ────────────────────────────── summary ──────────────────────────────

section "Summary"

if [[ ${#MISSING[@]} -eq 0 ]]; then
  ok "Everything is in place."
  printf "\n%s%s%s\n" "$C_BOLD" "Next steps:" "$C_RST"
  printf "  1. %sclaude%s          # if you haven't signed in yet (one-time OAuth)\n" "$C_BLUE" "$C_RST"
  printf "  2. %snpm run dev%s     # start the editor\n" "$C_BLUE" "$C_RST"
  printf "  3. open http://localhost:3000\n\n"
  printf "  %sFirst Remotion render downloads ~150MB of headless Chromium.%s\n" "$C_DIM" "$C_RST"
  exit 0
else
  miss "Missing: $(printf '%s, ' "${MISSING[@]}" | sed 's/, $//')"
  printf "\nResolve the items above and re-run %s./setup.sh%s.\n\n" "$C_BLUE" "$C_RST"
  exit 1
fi
