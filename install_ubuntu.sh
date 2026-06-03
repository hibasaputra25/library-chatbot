#!/bin/bash

################################################################################
# AUTOMATED INSTALLATION SCRIPT FOR UBUNTU SERVER
# PustakaBot - Universitas Mercu Buana
# 
# This script automates the installation of all dependencies needed to run
# the chatbot on Ubuntu 20.04 LTS or newer.
#
# Usage:
#   chmod +x install_ubuntu.sh
#   ./install_ubuntu.sh
################################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_header() {
    echo -e "\n${BLUE}================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}================================${NC}\n"
}

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
    print_error "Do not run this script as root. Run as regular user with sudo privileges."
    exit 1
fi

# Check Ubuntu version
if [ -f /etc/os-release ]; then
    . /etc/os-release
    if [[ "$ID" != "ubuntu" ]]; then
        print_warning "This script is designed for Ubuntu. Your OS: $ID"
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
fi

print_header "PUSTAKABOT UBUNTU INSTALLATION"
print_info "This script will install:"
echo "  - Node.js (LTS)"
echo "  - MySQL Server"
echo "  - Chromium & dependencies (for WhatsApp Web.js)"
echo "  - PM2 Process Manager"
echo "  - Nginx Web Server"
echo ""
read -p "Continue with installation? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_info "Installation cancelled."
    exit 0
fi

################################################################################
# 1. SYSTEM UPDATE
################################################################################
print_header "Step 1: System Update"

print_info "Updating package lists..."
sudo apt update

print_info "Upgrading installed packages..."
sudo apt upgrade -y

print_success "System updated"

################################################################################
# 2. INSTALL ESSENTIAL TOOLS
################################################################################
print_header "Step 2: Essential Tools"

print_info "Installing essential build tools..."
sudo apt install -y \
    curl \
    wget \
    git \
    build-essential \
    software-properties-common \
    apt-transport-https \
    ca-certificates \
    gnupg \
    lsb-release

print_success "Essential tools installed"

################################################################################
# 3. INSTALL NODE.JS
################################################################################
print_header "Step 3: Node.js Installation"

if command -v node &> /dev/null; then
    CURRENT_NODE_VERSION=$(node --version)
    print_info "Node.js already installed: $CURRENT_NODE_VERSION"
    read -p "Reinstall Node.js? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Skipping Node.js installation"
    else
        INSTALL_NODE=true
    fi
else
    INSTALL_NODE=true
fi

if [ "$INSTALL_NODE" = true ]; then
    print_info "Installing NVM (Node Version Manager)..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

    # Load NVM
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

    print_info "Installing Node.js LTS..."
    nvm install --lts
    nvm use --lts
    nvm alias default lts/*

    NODE_VERSION=$(node --version)
    NPM_VERSION=$(npm --version)
    print_success "Node.js installed: $NODE_VERSION"
    print_success "NPM installed: $NPM_VERSION"
fi

################################################################################
# 4. INSTALL MYSQL
################################################################################
print_header "Step 4: MySQL Server Installation"

if command -v mysql &> /dev/null; then
    print_info "MySQL already installed"
    read -p "Reinstall MySQL? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Skipping MySQL installation"
    else
        INSTALL_MYSQL=true
    fi
else
    INSTALL_MYSQL=true
fi

if [ "$INSTALL_MYSQL" = true ]; then
    print_info "Installing MySQL Server..."
    sudo apt install -y mysql-server

    print_info "Starting MySQL service..."
    sudo systemctl start mysql
    sudo systemctl enable mysql

    print_success "MySQL installed and started"
    
    print_warning "IMPORTANT: Run 'sudo mysql_secure_installation' after this script completes!"
    echo "Press any key to continue..."
    read -n 1 -s
fi

################################################################################
# 5. INSTALL CHROMIUM & DEPENDENCIES
################################################################################
print_header "Step 5: Chromium & Dependencies (for WhatsApp Web.js)"

print_info "Installing Chromium and required dependencies..."
sudo apt install -y \
    gconf-service \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    fonts-liberation \
    libappindicator1 \
    libnss3 \
    lsb-release \
    xdg-utils \
    wget \
    chromium-browser

print_success "Chromium and dependencies installed"

################################################################################
# 6. INSTALL PM2
################################################################################
print_header "Step 6: PM2 Process Manager"

if command -v pm2 &> /dev/null; then
    PM2_VERSION=$(pm2 --version)
    print_info "PM2 already installed: $PM2_VERSION"
    read -p "Reinstall PM2? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Skipping PM2 installation"
    else
        INSTALL_PM2=true
    fi
else
    INSTALL_PM2=true
fi

if [ "$INSTALL_PM2" = true ]; then
    print_info "Installing PM2 globally..."
    npm install -g pm2

    PM2_VERSION=$(pm2 --version)
    print_success "PM2 installed: $PM2_VERSION"

    print_info "Setting up PM2 startup script..."
    pm2 startup > /tmp/pm2_startup_cmd.txt
    STARTUP_CMD=$(grep -oP '(?<=sudo ).*' /tmp/pm2_startup_cmd.txt | head -1)
    
    if [ ! -z "$STARTUP_CMD" ]; then
        print_info "Executing: sudo $STARTUP_CMD"
        sudo bash -c "$STARTUP_CMD"
        print_success "PM2 startup configured"
    else
        print_warning "Could not auto-configure PM2 startup. Run 'pm2 startup' manually."
    fi
    
    rm /tmp/pm2_startup_cmd.txt
fi

################################################################################
# 7. INSTALL NGINX
################################################################################
print_header "Step 7: Nginx Web Server"

if command -v nginx &> /dev/null; then
    NGINX_VERSION=$(nginx -v 2>&1 | grep -oP '\d+\.\d+\.\d+')
    print_info "Nginx already installed: $NGINX_VERSION"
    read -p "Reinstall Nginx? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Skipping Nginx installation"
    else
        INSTALL_NGINX=true
    fi
else
    INSTALL_NGINX=true
fi

if [ "$INSTALL_NGINX" = true ]; then
    print_info "Installing Nginx..."
    sudo apt install -y nginx

    print_info "Starting Nginx service..."
    sudo systemctl start nginx
    sudo systemctl enable nginx

    NGINX_VERSION=$(nginx -v 2>&1 | grep -oP '\d+\.\d+\.\d+')
    print_success "Nginx installed: $NGINX_VERSION"
fi

################################################################################
# 8. INSTALL CERTBOT (Optional - for SSL)
################################################################################
print_header "Step 8: Certbot (SSL Certificate)"

read -p "Install Certbot for SSL certificates? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_info "Installing Certbot..."
    sudo apt install -y certbot python3-certbot-nginx
    
    print_success "Certbot installed"
    print_info "Run 'sudo certbot --nginx -d your-domain.com' to obtain SSL certificate"
else
    print_info "Skipping Certbot installation"
fi

################################################################################
# 9. INSTALL FAIL2BAN (Optional - for security)
################################################################################
print_header "Step 9: Fail2Ban (Brute Force Protection)"

read -p "Install Fail2Ban for security? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_info "Installing Fail2Ban..."
    sudo apt install -y fail2ban
    
    sudo systemctl start fail2ban
    sudo systemctl enable fail2ban
    
    print_success "Fail2Ban installed and started"
else
    print_info "Skipping Fail2Ban installation"
fi

################################################################################
# 10. SETUP FIREWALL (UFW)
################################################################################
print_header "Step 10: Firewall Configuration"

read -p "Configure UFW firewall? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_info "Configuring UFW..."
    
    # Allow SSH (CRITICAL!)
    sudo ufw allow 22/tcp
    print_success "SSH allowed (port 22)"
    
    # Allow HTTP & HTTPS
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    print_success "HTTP/HTTPS allowed (ports 80, 443)"
    
    # Deny Node.js ports (only accessible via Nginx)
    sudo ufw deny 3001/tcp
    sudo ufw deny 3002/tcp
    print_success "Node.js ports blocked from external access"
    
    # Enable firewall
    print_warning "About to enable firewall. Make sure SSH (port 22) is allowed!"
    read -p "Enable UFW now? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        sudo ufw --force enable
        print_success "Firewall enabled"
        sudo ufw status
    else
        print_info "Firewall not enabled. Run 'sudo ufw enable' manually."
    fi
else
    print_info "Skipping firewall configuration"
fi

################################################################################
# 11. CREATE DIRECTORY STRUCTURE
################################################################################
print_header "Step 11: Directory Structure"

print_info "Creating application directories..."
mkdir -p ~/apps
mkdir -p ~/backups
mkdir -p ~/logs

print_success "Directories created:"
echo "  - ~/apps (for application code)"
echo "  - ~/backups (for database backups)"
echo "  - ~/logs (for log files)"

################################################################################
# 12. SUMMARY
################################################################################
print_header "Installation Summary"

print_success "Installation completed successfully!"
echo ""
echo "Installed components:"
echo "  ✓ Node.js $(node --version 2>/dev/null || echo 'N/A')"
echo "  ✓ NPM $(npm --version 2>/dev/null || echo 'N/A')"
echo "  ✓ MySQL $(mysql --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo 'N/A')"
echo "  ✓ Chromium"
echo "  ✓ PM2 $(pm2 --version 2>/dev/null || echo 'N/A')"
echo "  ✓ Nginx $(nginx -v 2>&1 | grep -oP '\d+\.\d+\.\d+' || echo 'N/A')"

if command -v certbot &> /dev/null; then
    echo "  ✓ Certbot $(certbot --version 2>&1 | grep -oP '\d+\.\d+\.\d+' || echo 'installed')"
fi

if command -v fail2ban-server &> /dev/null; then
    echo "  ✓ Fail2Ban installed"
fi

echo ""
print_header "Next Steps"
echo "1. Secure MySQL:"
echo "   sudo mysql_secure_installation"
echo ""
echo "2. Create MySQL database and user:"
echo "   sudo mysql"
echo "   > CREATE DATABASE lib1;"
echo "   > CREATE USER 'biroperpustakaan'@'localhost' IDENTIFIED BY 'your-password';"
echo "   > GRANT ALL PRIVILEGES ON lib1.* TO 'biroperpustakaan'@'localhost';"
echo "   > FLUSH PRIVILEGES;"
echo "   > EXIT;"
echo ""
echo "3. Clone/Upload your application:"
echo "   cd ~/apps"
echo "   git clone <your-repo-url> server_chatbot"
echo "   # Or upload via SCP/SFTP"
echo ""
echo "4. Install application dependencies:"
echo "   cd ~/apps/server_chatbot"
echo "   npm install"
echo ""
echo "5. Configure environment:"
echo "   cp .env.example .env"
echo "   nano .env"
echo "   # Update all values for production"
echo ""
echo "6. Start application with PM2:"
echo "   pm2 start ecosystem.config.js"
echo "   pm2 save"
echo ""
echo "7. Configure Nginx:"
echo "   sudo nano /etc/nginx/sites-available/chatbot"
echo "   # Add your nginx configuration"
echo "   sudo ln -s /etc/nginx/sites-available/chatbot /etc/nginx/sites-enabled/"
echo "   sudo nginx -t"
echo "   sudo systemctl reload nginx"
echo ""
echo "8. Obtain SSL certificate (if domain configured):"
echo "   sudo certbot --nginx -d your-domain.com"
echo ""
echo "9. Test your application:"
echo "   curl http://localhost:3001/api/status"
echo "   curl http://your-server-ip/admin"
echo ""

print_success "Installation script completed!"
print_info "For detailed deployment guide, see: DEPLOYMENT_UBUNTU.md"
echo ""
