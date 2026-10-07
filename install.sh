#!/usr/bin/env bash
# ==============================================================================
# WebUSB-to-TCP ADB Bridge — Інсталятор "під ключ" для Debian 11/12
# ==============================================================================

set -e

# ANSI кольори для красивого виводу
COLOR_RESET="\033[0m"
COLOR_GREEN="\033[1;32m"
COLOR_CYAN="\033[1;36m"
COLOR_YELLOW="\033[1;33m"
COLOR_RED="\033[1;31m"
COLOR_BOLD="\033[1m"

log_info() {
    echo -e "${COLOR_CYAN}[INFO]${COLOR_RESET} $1"
}

log_success() {
    echo -e "${COLOR_GREEN}[OK]${COLOR_RESET} $1"
}

log_warn() {
    echo -e "${COLOR_YELLOW}[УВАГА]${COLOR_RESET} $1"
}

log_error() {
    echo -e "${COLOR_RED}[ПОМИЛКА]${COLOR_RESET} $1"
}

# 1. Перевірка прав root
if [ "$EUID" -ne 0 ]; then
    log_error "Цей скрипт повинен виконуватися з правами root!"
    echo "Будь ласка, запустіть: sudo bash install.sh"
    exit 1
fi

echo -e "${COLOR_GREEN}"
echo "============================================================"
echo "    WebUSB-to-TCP ADB Bridge — Інсталятор для Debian       "
echo "============================================================"
echo -e "${COLOR_RESET}"

# Отримуємо абсолютний шлях до директорії проєкту
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 2. Інтерактивний ввід даних
# Якщо запущено через пайп або tty доступний
INPUT_SRC="/dev/stdin"
if [ -t 0 ]; then
    INPUT_SRC="/dev/stdin"
elif [ -e /dev/tty ]; then
    INPUT_SRC="/dev/tty"
fi

echo -e "${COLOR_BOLD}Введіть необхідні параметри для налаштування веб-сервера:${COLOR_RESET}"
echo ""

read -r -p "👉 Введіть ваше доменне ім'я (наприклад, adb.mysite.com): " DOMAIN < "$INPUT_SRC"
while [ -z "$DOMAIN" ]; do
    echo -e "${COLOR_RED}Доменне ім'я не може бути порожнім!${COLOR_RESET}"
    read -r -p "👉 Введіть доменне ім'я: " DOMAIN < "$INPUT_SRC"
done

read -r -p "👉 Введіть ваш Email для сертифіката Let's Encrypt: " EMAIL < "$INPUT_SRC"
while [ -z "$EMAIL" ]; do
    echo -e "${COLOR_RED}Email не може бути порожнім!${COLOR_RESET}"
    read -r -p "👉 Введіть Email: " EMAIL < "$INPUT_SRC"
done

echo ""
log_info "Параметри встановлення:"
echo "   Домен: $DOMAIN"
echo "   Email: $EMAIL"
echo ""

# 3. Оновлення системи
log_info "Крок 1/8: Оновлення системних пакунків Debian (apt update && upgrade)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

# 4. Встановлення системних залежностей
log_info "Крок 2/8: Встановлення системних утиліт (curl, git, nginx, adb, tmux, certbot)..."
apt-get install -y curl git nginx adb tmux certbot python3-certbot-nginx build-essential

# Запуск adb сервера для перевірки
log_info "Перевірка працездатності Android Debug Bridge..."
adb version

# 5. Встановлення Node.js LTS (v20+) через NodeSource
log_info "Крок 3/8: Перевірка та встановлення Node.js LTS (v20+)..."
NODE_VERSION=""
if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
fi

if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 20 ]; then
    log_info "Встановлення NodeSource Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    log_success "Node.js вже встановлено: $(node -v)"
fi

NODE_BIN=$(command -v node)
NPM_BIN=$(command -v npm)
log_success "Використовується Node: $NODE_BIN ($($NODE_BIN -v)) та npm: $($NPM_BIN -v)"

# 6. Копіювання файлів проєкту та збірка бекенду
log_info "Крок 4/8: Розгортання та збірка бекенд-демона..."
INSTALL_DEST="/opt/adb-bridge"
mkdir -p "$INSTALL_DEST"

# Копіюємо вміст проєкту в /opt/adb-bridge
cp -r "$SCRIPT_DIR/server" "$INSTALL_DEST/"
cp -r "$SCRIPT_DIR/client" "$INSTALL_DEST/"

cd "$INSTALL_DEST/server"
log_info "Встановлення npm залежностей..."
npm install

log_info "Збірка TypeScript (npm run build)..."
npm run build

if [ ! -f "$INSTALL_DEST/server/dist/index.js" ]; then
    log_error "Збірка бекенду завершилася помилкою: файл dist/index.js не знайдено!"
    exit 1
fi
log_success "Бекенд успішно скомпільовано."

# 7. Створення systemd сервісу
log_info "Крок 5/8: Налаштування systemd-сервісу /etc/systemd/system/adb-bridge.service..."
cat <<EOF > /etc/systemd/system/adb-bridge.service
[Unit]
Description=WebUSB-to-TCP ADB Bridge Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/adb-bridge/server
ExecStart=$NODE_BIN /opt/adb-bridge/server/dist/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=TCP_PORT=5555
Environment=TCP_HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable adb-bridge.service
systemctl restart adb-bridge.service

# Перевірка запуску сервісу
sleep 2
if systemctl is-active --quiet adb-bridge.service; then
    log_success "Служба adb-bridge.service активна і працює в фоні."
else
    log_error "Помилка запуску adb-bridge.service! Перевірте journalctl -u adb-bridge -e"
fi

# 8. Розгортання клієнтської статики
log_info "Крок 6/8: Розгортання клієнтських статичних файлів у /var/www/adb-bridge..."
WWW_DIR="/var/www/adb-bridge"
mkdir -p "$WWW_DIR"
cp -r "$INSTALL_DEST/client/"* "$WWW_DIR/"
chown -R www-data:www-data "$WWW_DIR"
chmod -R 755 "$WWW_DIR"
log_success "Клієнтські файли розгорнуто в $WWW_DIR"

# 9. Налаштування віртуального хосту Nginx
log_info "Крок 7/8: Конфігурація Nginx віртуального хосту із проксуванням WebSocket..."
NGINX_CONF="/etc/nginx/sites-available/adb-bridge"

cat <<EOF > "$NGINX_CONF"
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    root /var/www/adb-bridge;
    index index.html;

    # Дозволяємо WebUSB для поточного сайту
    add_header Permissions-Policy "usb=(self)" always;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Проксування WebSocket-мосту
    location /adb-bridge {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Запобігаємо тайм-аутам під час очікування ADB з'єднання
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF

# Активація сайту в sites-enabled
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/adb-bridge

# Відключення дефолтної сторінки Nginx, якщо вона є
if [ -f /etc/nginx/sites-enabled/default ]; then
    rm -f /etc/nginx/sites-enabled/default
fi

# Перевірка синтаксису Nginx
nginx -t
systemctl reload nginx
log_success "Nginx успішно налаштовано."

# 10. Отримання SSL сертифіката Let's Encrypt через Certbot
log_info "Крок 8/8: Отримання та прив'язка безкоштовного SSL-сертифіката Let's Encrypt..."
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
    log_success "SSL-сертифікат успішно отримано та прив'язано до Nginx!"
else
    log_warn "Не вдалося автоматично отримати сертифікат Certbot (можливо, DNS ще не оновився)."
    log_warn "Після направлення A-запису домену на цей IP виконайте:"
    log_warn "  certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL --redirect"
fi

# 11. Додавання аліасу adb-go у ~/.bashrc
log_info "Додавання аліасу 'adb-go' у конфігурацію bash..."
ALIAS_LINE="alias adb-go='until adb connect 127.0.0.1:5555 | grep -q \"connected\"; do echo \"Очікую клієнта на сайті...\"; sleep 2; done; adb -s 127.0.0.1:5555 shell'"

add_alias_if_missing() {
    local bashrc_file="$1"
    if [ -f "$bashrc_file" ]; then
        if ! grep -Fq "alias adb-go=" "$bashrc_file"; then
            echo "" >> "$bashrc_file"
            echo "# WebUSB ADB Bridge quick connect" >> "$bashrc_file"
            echo "$ALIAS_LINE" >> "$bashrc_file"
            log_success "Аліас adb-go додано в $bashrc_file"
        fi
    fi
}

add_alias_if_missing "/root/.bashrc"

# Якщо запускалося через sudo звичайного користувача, додаємо і йому
if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
    USER_HOME=$(eval echo "~$SUDO_USER")
    add_alias_if_missing "$USER_HOME/.bashrc"
    chown "$SUDO_USER:$SUDO_USER" "$USER_HOME/.bashrc" 2>/dev/null || true
fi

echo ""
echo -e "${COLOR_GREEN}============================================================${COLOR_RESET}"
echo -e "${COLOR_GREEN}         🎉 ВСТАНОВЛЕННЯ УСПІШНО ЗАВЕРШЕНО!                ${COLOR_RESET}"
echo -e "${COLOR_GREEN}============================================================${COLOR_RESET}"
echo ""
echo -e " Веб-сторінка мосту доступна за адресою:"
echo -e "   ${COLOR_CYAN}https://${DOMAIN}${COLOR_RESET}"
echo ""
echo -e " Для початку роботи в консолі Debian:"
echo -e "   1. Застосуйте аліаси:      ${COLOR_YELLOW}source ~/.bashrc${COLOR_RESET}"
echo -e "   2. Запустіть сесію tmux:   ${COLOR_YELLOW}tmux new -s adb${COLOR_RESET}"
echo -e "   3. Моніторинг логів:       ${COLOR_YELLOW}journalctl -u adb-bridge -f${COLOR_RESET}"
echo -e "   4. Підключення до телефона: ${COLOR_YELLOW}adb-go${COLOR_RESET}"
echo ""
echo -e " Статус демона: ${COLOR_CYAN}systemctl status adb-bridge.service${COLOR_RESET}"
echo -e "${COLOR_GREEN}============================================================${COLOR_RESET}"
