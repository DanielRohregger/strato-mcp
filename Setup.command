#!/usr/bin/env bash
#
# Install stratomcp locally and launch its guided setup

set -euo pipefail

readonly SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly INSTALL_DIR="${HOME}/Library/Application Support/stratomcp/app"

fail() {
  printf "ERROR: %s\n" "$1" >&2
  printf "\nPress Return to close this window."
  read -r
  exit 1
}

check_node() {
  if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
    open "https://nodejs.org/en/download"
    fail "Node.js is required. Install the current LTS release, then run Setup.command again."
  fi
  if ! node -e \
    'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
    open "https://nodejs.org/en/download"
    fail "Node.js 22.13 or newer is required. Install the current LTS release, then run Setup.command again."
  fi
}

install_application() {
  if [[ "${SOURCE_DIR}" == "${INSTALL_DIR}" ]]; then
    return
  fi
  mkdir -p "${INSTALL_DIR}"
  rsync -a --delete \
    --exclude ".git" \
    --exclude "node_modules" \
    --exclude ".DS_Store" \
    "${SOURCE_DIR}/" "${INSTALL_DIR}/"
}

main() {
  check_node
  install_application
  cd "${INSTALL_DIR}"
  npm ci --omit=dev
  exec node src/setup.js
}

main "$@"
