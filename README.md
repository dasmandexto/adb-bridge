# 📱 WebUSB-to-TCP ADB Bridge

> **Повноцінний комплекс віддаленого доступу до Android:**  
> Windows Chrome WebUSB ↔ WebSocket ↔ Debian TCP ADB (127.0.0.1:5555)

Цей проєкт дозволяє керувати Android-смартфоном, підключеним через звичайний USB-кабель до клієнтського Windows-ПК, напряму з консолі сервера на **Debian 11/12** за допомогою штатної утиліти `adb shell`. Клієнту на Windows не потрібно встановлювати сторонні програми або відкривати порти на роутері — достатньо відкрити веб-сторінку у браузері на базі Chromium (Google Chrome, Microsoft Edge, Opera, Brave).

---

## 🏛️ Архітектура рішення

```text
┌─────────────────────────────────┐
│   Windows PC (Клієнт)           │
│   ┌───────────────────────────┐ │
│   │ Android Телефон (USB)     │ │
│   │ [bInterfaceClass: 0xFF]   │ │
│   └─────────────▲─────────────┘ │
│                 │ WebUSB        │
│   ┌─────────────▼─────────────┐ │
│   │ Google Chrome / Edge      │ │
│   │ adb-webusb-bridge.js      │ │
│   └─────────────▲─────────────┘ │
└─────────────────┼───────────────┘
                  │
                  │ WSS (WebSocket Secure, 443 /adb-bridge)
                  │
┌─────────────────┼────────────────────────────────────────┐
│ Debian Сервер   │                                        │
│   ┌─────────────▼─────────────┐                          │
│   │ Nginx (SSL / WSS Reverse) │                          │
│   └─────────────▲─────────────┘                          │
│                 │ HTTP Upgrade (127.0.0.1:3001)          │
│   ┌─────────────▼─────────────┐                          │
│   │ Node.js Bridge Daemon     │                          │
│   │ (server/dist/index.js)    │                          │
│   └─────────────▲─────────────┘                          │
│                 │ TCP Raw Stream (127.0.0.1:5555)        │
│   ┌─────────────▼─────────────┐                          │
│   │ Debian ADB Client         │ ───► adb shell           │
│   │ (adb connect 127.0.0.1)   │ ───► adb install app.apk │
│   └───────────────────────────┘ ───► adb logcat          │
└──────────────────────────────────────────────────────────┘
```

---

## 🚀 Швидке встановлення на Debian 11/12

1. Клонуйте репозиторій або завантажте файли на сервер Debian:
   ```bash
   git clone https://github.com/your-username/adb-bridge.git /tmp/adb-bridge-repo
   cd /tmp/adb-bridge-repo
   ```

2. Запустіть автоматичний інтерактивний інсталятор:
   ```bash
   sudo bash install.sh
   ```

3. Інсталятор запитає:
   - **Доменне ім'я** (наприклад, `adb.mysite.com`, попередньо направлене A-записом на IP вашого сервера).
   - **Email** для автоматичної реєстрації безкоштовного SSL-сертифіката Let's Encrypt.

4. **Що скрипт виконує автоматично:**
   - Оновлює систему (`apt update && apt upgrade -y`).
   - Встановлює необхідні утиліти (`curl`, `git`, `nginx`, `adb`, `tmux`, `certbot`, `python3-certbot-nginx`).
   - Встановлює **Node.js v20 LTS** через офіційний репозиторій NodeSource.
   - Компілює TypeScript-сервіс у директорії `/opt/adb-bridge/server`.
   - Створює та запускає systemd-службу `/etc/systemd/system/adb-bridge.service` (`Restart=always`).
   - Налаштовує сайт у Nginx із роздачею клієнтських файлів (`/var/www/adb-bridge`) та проксуванням WebSocket (`/adb-bridge` ➡️ `127.0.0.1:3001`).
   - Отримує та налаштовує SSL-сертифікат через Certbot.
   - Додає зручний аліас `adb-go` у ваш `~/.bashrc`.

---

## 💻 1. Як вбудувати віджет на будь-який сторонній сайт

Ви можете вбудувати кнопку підключення Android у будь-який власний веб-сайт або внутрішню панель керування всього у 3 прості кроки.

### Крок 1. Додайте заголовок у `<head>`
Обов'язковий дозвіл для роботи WebUSB у браузері:
```html
<meta http-equiv="Permissions-Policy" content="usb=(self)">
```
> *Примітка:* Якщо ваш сайт відкриває сторінку у `<iframe>`, додайте у тег фрейму атрибут `allow="usb"`:
> ```html
> <iframe src="https://<ТВІЙ_ДОМЕН>/" allow="usb"></iframe>
> ```

### Крок 2. Вставте HTML-віджет у тіло сторінки (`<body>`)
```html
<div class="adb-bridge-widget">
  <button id="adb-connect-btn">⚡ Підключити Android</button>
  <span id="adb-status">Очікування...</span>
  <!-- Опціональний блок для виводу логів (якщо не потрібен — можна видалити) -->
  <div id="adb-log-container" style="height: 120px; overflow-y: auto; background: #000; color: #00ff66; font-family: monospace; font-size: 12px; padding: 8px; border-radius: 6px; margin-top: 10px;"></div>
</div>
```

### Крок 3. Вставте скрипти перед закриваючим тегом `</body>` (Одним суцільним шматком!)
Скопіюйте та вставте весь цей блок безпосередньо перед `</body>`:

```html
<!-- ================= ПОЧАТОК БЛОКУ ADB МОСТУ ================= -->
<script src="https://<ТВІЙ_ДОМЕН>/adb-webusb-bridge.js"></script>
<script>
  const bridge = new WebUsbAdbBridge({
    // Обов'язкові параметри:
    wsUrl: 'wss://<ТВІЙ_ДОМЕН>/adb-bridge', // WSS-адреса вашого Debian-сервера
    btnId: 'adb-connect-btn',               // ID кнопки підключення
    statusId: 'adb-status',                 // ID блоку статусу

    // Опціональні параметри (можна видалити, якщо не потрібні):
    logId: 'adb-log-container',             // ID контейнера логів у браузері
    onStatusChange: (status, text) => {
      console.log('Статус мосту змінився:', status, text);
    },
    onStats: ({ bytesSent, bytesReceived }) => {
      console.log(`Трафік: ⬆️ ${bytesSent} байт | ⬇️ ${bytesReceived} байт`);
    },
    onError: (error, friendlyMessage) => {
      console.error('Помилка підключення:', friendlyMessage);
    }
  });
</script>
<!-- ================= КІНЕЦЬ БЛОКУ ADB МОСТУ =================== -->
```

---

### 📄 Готовий повний шаблон сторінки (Copy-Paste Ready)

Якщо вам потрібна окрема робоча сторінка з нуля, збережіть цей код в `index.html`:

```html
<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- Обов'язкова політика дозволу WebUSB -->
  <meta http-equiv="Permissions-Policy" content="usb=(self)">
  <title>Керування Android через WebUSB ADB Bridge</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #e6edf3; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 28px; width: 100%; max-width: 500px; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
    h2 { margin-top: 0; font-size: 20px; }
    button { background: #238636; color: white; border: none; border-radius: 8px; padding: 12px 24px; font-size: 16px; font-weight: 600; cursor: pointer; transition: 0.2s; margin-bottom: 14px; }
    button:hover { background: #2ea043; }
    button.connected { background: #da3633; }
    .status { display: block; font-size: 14px; color: #8b949e; margin-bottom: 14px; }
    #adb-log-container { height: 120px; overflow-y: auto; background: #090d13; border: 1px solid #30363d; border-radius: 6px; padding: 10px; font-family: monospace; font-size: 11px; text-align: left; color: #7ee787; }
  </style>
</head>
<body>

  <div class="card">
    <h2>📱 WebUSB ADB Bridge</h2>
    <p style="font-size: 13px; color: #8b949e; margin-bottom: 20px;">Підключіть Android по USB та увімкніть налагодження по USB</p>

    <!-- Віджет -->
    <button id="adb-connect-btn">⚡ Підключити Android</button>
    <span id="adb-status" class="status">Очікування...</span>
    <div id="adb-log-container"></div>
  </div>

  <!-- ЄДИНИЙ БЛОК СКРИПТІВ ПЕРЕД ЗАКРИТТЯМ BODY -->
  <script src="https://<ТВІЙ_ДОМЕН>/adb-webusb-bridge.js"></script>
  <script>
    const bridge = new WebUsbAdbBridge({
      wsUrl: 'wss://<ТВІЙ_ДОМЕН>/adb-bridge',
      btnId: 'adb-connect-btn',
      statusId: 'adb-status',
      logId: 'adb-log-container',
      onStatusChange: (status, text) => {
        console.log('Статус:', status, text);
      },
      onStats: ({ bytesSent, bytesReceived }) => {
        console.log(`Трафік: ⬆️ ${bytesSent} B | ⬇️ ${bytesReceived} B`);
      },
      onError: (err, msg) => {
        alert(msg);
      }
    });
  </script>
</body>
</html>
```

---

## 🐧 2. Інструкція для адміністратора на Debian (Робота через tmux)

Для комфортної роботи рекомендується використовувати термінальний мультиплексор `tmux`. Це дозволяє одночасно бачити лог підключень у реальному часі та працювати у консолі смартфона.

### Крок 1. Запуск нової сесії tmux
Підключіться до вашого Debian-сервера через SSH та запустіть сесію:
```bash
tmux new -s adb
```

### Крок 2. Розділення екрана на дві панелі
Натисніть комбінацію клавіш:
```text
Ctrl + B, потім відпустіть і натисніть %
```
> *Екран розділиться вертикально на дві половини (ліву і праву).*

### Крок 3. Налаштування панелей
- **У лівій панелі (Панель 1):** запустіть моніторинг логів сервісу:
  ```bash
  journalctl -u adb-bridge -f
  ```
  Тут ви бачитимете, коли клієнт натискає кнопку на сайті, коли створюється TCP-сервер та скільки байт передається.

- **Перемкніться на праву панель:**
  ```text
  Ctrl + B, потім стрілка вправо (→)
  ```

- **У правій панелі (Панель 2):** запустіть команду автоматичного підключення:
  ```bash
  adb-go
  ```
  > Ця команда перебуває у режимі очікування клієнта:
  > ```text
  > Очікую клієнта на сайті...
  > connected to 127.0.0.1:5555
  > client:/ $
  > ```
  > Як тільки користувач натисне кнопку на сайті та вибере телефон, ви миттєво опинитеся у шеллі підключеного смартфона!

### Альтернативне підключення вручну
Якщо ви не використовуєте аліас:
```bash
adb connect 127.0.0.1:5555 && adb -s 127.0.0.1:5555 shell
```

### Крок 4. Як безпечно згорнути сесію і повернутися до неї пізніше
- **Згорнути сесію (Detach):**
  ```text
  Ctrl + B, потім натисніть D
  ```
  *(Сесія продовжить працювати у фоновому режимі, навіть якщо ви закриєте SSH-клієнт).*

- **Повернутися назад до сесії:**
  ```bash
  tmux attach -t adb
  ```

- **Корисні навігаційні команди tmux:**
  - `Ctrl + B` потім `←` або `→` — перемикання між панелями.
  - `Ctrl + B` потім `[` — увімкнути режим скролу журналу (вихід — клавіша `q`).
  - `exit` — закрити поточну панель.

---

## 🛠️ Вимоги та вирішення типових проблем

### Для клієнта на Windows:
1. **Браузер:** Тільки Chromium-сумісні браузери (Google Chrome, Microsoft Edge, Brave, Opera). Firefox і Safari **не підтримують** WebUSB.
2. **Протокол:** WebUSB API доступний **виключно через HTTPS** (або `http://localhost`). Саме тому інсталятор автоматично генерує валідний SSL через Let's Encrypt.
3. **Налаштування Android:**
   - Увімкніть режим розробника (*Налаштування ➡️ Про телефон ➡️ 7 разів натиснути на «Номер збірки»*).
   - Увімкніть **«Налагодження по USB»** (*USB Debugging*).
   - При першому підключенні на екрані телефона з'явиться вікно:  
     *«Дозволити налагодження по USB?»* — поставте галочку та натисніть **«Дозволити»**.
4. **Конфлікт із локальним `adb` на Windows (`SecurityError: Unable to claim interface`):**
   - Якщо на Windows працює локальний `adb.exe` (або Android Studio / Vysor), він блокує USB-інтерфейс, і браузер не може його захопити.
   - **Вирішення:** Відкрийте PowerShell/CMD на Windows і виконайте:
     ```powershell
     adb kill-server
     ```
     Після цього знову натисніть кнопку підключення у браузері.
5. **Драйвер пристрою:** У системі Windows для пристрою має бути встановлений драйвер WinUSB або Google USB Driver. Зазвичай він встановлюється автоматично під час першого підключення Android у режимі налагодження.

---

## ⚙️ Керування сервісом на Debian

- Перевірити поточний статус:
  ```bash
  systemctl status adb-bridge.service
  ```
- Переглянути логи в реальному часі:
  ```bash
  journalctl -u adb-bridge -f
  ```
- Перезапустити сервіс:
  ```bash
  sudo systemctl restart adb-bridge.service
  ```
- Зупинити сервіс:
  ```bash
  sudo systemctl stop adb-bridge.service
  ```

---

## 📄 Ліцензія
MIT License. Вільно для некомерційного та комерційного використання.
