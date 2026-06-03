#!/bin/bash

# ================================================================
# PUSTAKABOT - AUTOMATED INSTALLATION FOR UBUNTU
# Tested on Ubuntu 22.04 LTS
#
# Usage:
#   bash install_ubuntu.sh
#
# DO NOT use: sh install_ubuntu.sh (will cause errors)
# ================================================================

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK] $1${NC}"; }
fail() { echo -e "${RED}[FAIL] $1${NC}"; }
warn() { echo -e "${YELLOW}[WARN] $1${NC}"; }
info() { echo -e "[INFO] $1"; }

# ==============================
# CHECK BASH
# ==============================
if [ -z "$BASH_VERSION" ]; then
    echo "ERROR: This script must be run with bash, not sh."
    echo "Usage: bash install_ubuntu.sh"
    exit 1
fi

# ==============================
# CHECK ROOT
# ==============================
if [ "$EUID" -eq 0 ]; then
    fail "Do not run as root. Run as regular user."
    exit 1
fi

echo "================================"
echo "  PUSTAKABOT UBUNTU INSTALLER"
echo "================================"
echo ""
info "This will install: Node.js, Chromium, PM2"
info "Skipping MySQL (database is on remote server)"
echo ""

# ==============================
# 1. SYSTEM UPDATE
# ==============================
info "Updating system..."
sudo apt update -y
sudo apt upgrade -y
ok "System updated"

# ==============================
# 2. INSTALL ESSENTIALS
# ==============================
info "Installing essential packages..."
sudo apt install -y curl wget git build-essential
ok "Essentials installed"

# ==============================
# 3. INSTALL NODE.JS VIA NVM
# ==============================
if command -v node &> /dev/null; then
    warn "Node.js already installed: $(node --version)"
else
    info "Installing NVM..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

    info "Installing Node.js LTS..."
    nvm install --lts
    nvm use --lts
    nvm alias default lts/*
    ok "Node.js installed: $(node --version)"
fi

# Make sure NVM is loaded for rest of script
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# ==============================
# 4. INSTALL CHROMIUM
# ==============================
info "Installing Chromium..."
sudo apt install -y chromium-browser
if command -v chromium-browser &> /dev/null; then
    ok "Chromium installed: $(which chromium-browser)"
else
    fail "Chromium installation failed"
fi

# ==============================
# 5. INSTALL PM2
# ==============================
if command -v pm2 &> /dev/null; then
    warn "PM2 already installed: $(pm2 --version)"
else
    info "Installing PM2..."
    npm install -g pm2
    ok "PM2 installed: $(pm2 --version)"
fi

# ==============================
# 6. SETUP PM2 STARTUP
# ==============================
info "Configuring PM2 startup..."
PM2_STARTUP=$(pm2 startup 2>&1 | grep "sudo env")
if [ ! -z "$PM2_STARTUP" ]; then
    eval "$PM2_STARTUP"
    ok "PM2 startup configured"
else
    warn "PM2 startup: run 'pm2 startup' manually if needed"
fi

# ==============================
# SUMMARY
# ==============================
echo ""
echo "================================"
echo "  INSTALLATION COMPLETE"
echo "================================"
echo ""
echo "Installed:"
echo "  Node.js: $(node --version 2>/dev/null || echo 'NOT INSTALLED')"
echo "  NPM:     $(npm --version 2>/dev/null || echo 'NOT INSTALLED')"
echo "  PM2:     $(pm2 --version 2>/dev/null || echo 'NOT INSTALLED')"
echo "  Chromium: $(which chromium-browser 2>/dev/null || echo 'NOT INSTALLED')"
echo ""
echo "Next steps:"
echo "  1. Clone/upload your project"
echo "  2. cd ~/library-chatbot"
echo "  3. npm install"
echo "  4. cp .env.example .env"
echo "  5. nano .env  (edit database credentials)"
echo "  6. pm2 start ecosystem.config.js"
echo "  7. pm2 logs"
echo ""
echo "IMPORTANT: Always run PM2 commands with bash loaded:"
echo "  export NVM_DIR=\"\$HOME/.nvm\""
echo "  [ -s \"\$NVM_DIR/nvm.sh\" ] && \\. \"\$NVM_DIR/nvm.sh\""
echo ""
ok "Done!"
