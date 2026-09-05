#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Cài pancake-dashboard lên VPS Ubuntu (systemd + Caddy tự-SSL).
# Chạy: sudo bash deploy/setup.sh <domain>
#   vd: sudo bash deploy/setup.sh baocao.ylg.vn
# Điều kiện: đã git clone repo vào /opt/pancake-dashboard và tạo .env.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR=/opt/pancake-dashboard
DOMAIN="${1:-baocao.ylg.vn}"

echo "==> [1/6] Cài Node.js 20"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> [2/6] Cài Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update && apt-get install -y caddy
fi

echo "==> [3/6] Kiểm tra .env"
if [ ! -f "$APP_DIR/.env" ]; then
  echo "!! Chưa có $APP_DIR/.env — chép: cp deploy/env.example .env  rồi điền secret, chạy lại."
  exit 1
fi

echo "==> [4/6] npm install + tạo thư mục data"
cd "$APP_DIR"
npm install --omit=dev
mkdir -p "$APP_DIR/data"
chown -R www-data:www-data "$APP_DIR"

echo "==> [5/6] Cài & bật systemd service"
cp deploy/pancake-dashboard.service /etc/systemd/system/pancake-dashboard.service
systemctl daemon-reload
systemctl enable --now pancake-dashboard

echo "==> [6/6] Cấu hình Caddy cho $DOMAIN"
sed "s/baocao\.ylg\.vn/$DOMAIN/g" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy

echo ""
echo "==> XONG. App: $(systemctl is-active pancake-dashboard) | Caddy: $(systemctl is-active caddy)"
echo "    Log app : journalctl -u pancake-dashboard -f"
echo "    Mở      : https://$DOMAIN  (sau khi DNS trỏ về IP VPS này)"
