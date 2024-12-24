#!/usr/bin/env bash
#
# Setup script for a brand new Ubuntu 24 VPS to run question.sh on port 22
# while keeping the main system SSH daemon on port 2345.
#
# USAGE:
#   1) Upload this script to your VPS (e.g., scp setup-question-sh.sh user@vps:/tmp/)
#   2) Run it as root: sudo bash /tmp/setup-question-sh.sh
#   3) Adjust firewall settings as needed.
#
# NOTES:
#   - This script modifies the default OpenSSH config to listen on port 2345 (for admin).
#   - question.sh will replace port 22 for the public "ssh question.sh".
#   - Installs PostgreSQL and creates a DB + user for question.sh.
#   - Please adjust DB credentials (username/password) as you prefer.

set -e  # Exit immediately on error

#######################################
# 1. System Updates & Install Packages
#######################################
echo "Updating system packages..."
apt-get update -y
apt-get upgrade -y

echo "Installing required packages (git, cron, openssh-server, postgresql)..."
apt-get install -y git cron openssh-server unzip postgresql postgresql-contrib

#######################################
# 2. Configure Main SSH Server on Port 2345
#######################################
echo "Configuring existing OpenSSH to run on port 2345 for admin use..."
sed -i 's/^#*Port .*/Port 2345/' /etc/ssh/sshd_config
systemctl restart ssh
echo "Main SSH server is now on port 2345. You can connect via: ssh -p 2345 your-admin-user@your-server"

#######################################
# 3. Install Bun (for running question.sh)
#######################################
echo "Installing Bun..."
curl -fsSL https://bun.sh/install | bash
echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.bashrc
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bashrc
source /root/.bashrc

#######################################
# 4. Setup PostgreSQL (user + database)
#######################################
DB_USER="questionsh_user"
DB_PASSWORD="questionsh_password"
DB_NAME="questionsh_db"

echo "Creating PostgreSQL user and database..."
sudo -u postgres psql <<EOF
CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
CREATE DATABASE $DB_NAME;
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
EOF

#######################################
# 5. Clone question.sh Repository
#######################################
REPO_URL="https://github.com/vincelwt/questionsh.git"
APP_DIR="/opt/question-sh"

echo "Fetching question.sh from $REPO_URL into $APP_DIR..."
if [ -d "$APP_DIR" ]; then
  echo "Directory $APP_DIR already exists, pulling latest..."
  cd "$APP_DIR"
  git pull
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

#######################################
# 6. Create .env File for DB Access
#######################################
echo "Creating .env file with DATABASE_URL..."
cat <<EOF > .env
DATABASE_URL=postgres://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME
NODE_ENV=production
PORT=22
EOF

#######################################
# 7. Generate SSH Host Keys
#######################################
echo "Generating SSH host keys..."
mkdir -p $APP_DIR/storage
ssh-keygen -t rsa -f $APP_DIR/storage/host.key -N ""
chmod 600 $APP_DIR/storage/host.key

#######################################
# 8. Install Dependencies
#######################################
echo "Installing dependencies with Bun..."
bun install

#######################################
# 9. Create a Systemd Service for question.sh on Port 22
#######################################
SERVICE_FILE="/etc/systemd/system/question-sh.service"
echo "Creating systemd service file at $SERVICE_FILE..."
cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=Question.sh SSH server on port 22
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/root/.bun/bin/bun run index.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

echo "Reloading systemd, enabling, and starting question-sh service..."
systemctl daemon-reload
systemctl enable question-sh
systemctl start question-sh

#######################################
# 10. Open Firewall (UFW) for ports 22 & 2345
#######################################
if command -v ufw >/dev/null 2>&1; then
  echo "Configuring UFW..."
  ufw allow 22
  ufw allow 2345
  ufw --force enable
else
  echo "UFW not found or not installed. Skipping firewall setup..."
fi

#######################################
# 11. Final Status
#######################################
echo "
Setup complete!
Main SSH for admin is listening on port 2345.
question.sh is now running on port 22.

You should be able to connect publicly with:
  ssh question.sh
  
Admin access:
  ssh -p 2345 root@your-server-domain

To see question.sh logs:
  journalctl -u question-sh -f

To stop:
  systemctl stop question-sh
To restart:
  systemctl restart question-sh
"