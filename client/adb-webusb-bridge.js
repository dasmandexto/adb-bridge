/**
 * WebUSB-to-TCP ADB Bridge Client
 * Standalone browser bridge connecting Android WebUSB to a remote WebSocket server.
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WebUsbAdbBridge = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Android ADB USB Class Codes
  const ADB_CLASS = 0xff;
  const ADB_SUBCLASS = 0x42;
  const ADB_PROTOCOL = 0x01;

  class WebUsbAdbBridge {
    /**
     * @param {Object} options
     * @param {string} [options.wsUrl] - WebSocket URL (e.g. wss://domain/adb-bridge)
     * @param {string} [options.btnId] - HTML button element ID
     * @param {string} [options.statusId] - HTML status element ID
     * @param {string} [options.logId] - HTML log container element ID
     * @param {Function} [options.onStatusChange] - Callback (status, text)
     * @param {Function} [options.onLog] - Callback (level, text)
     * @param {Function} [options.onError] - Callback (err, userFriendlyMessage)
     * @param {Function} [options.onStats] - Callback ({ bytesSent, bytesReceived })
     */
    constructor(options = {}) {
      this.options = options;

      // Resolve WebSocket URL
      this.wsUrl = this.resolveWsUrl(options.wsUrl);

      // WebUSB state
      this.device = null;
      this.endpointIn = null;
      this.endpointOut = null;
      this.interfaceNumber = null;

      // WebSocket state
      this.ws = null;

      // Control loop flags
      this.running = false;
      this.isWriting = false;
      this.outQueue = [];

      // Statistics
      this.bytesSent = 0;
      this.bytesReceived = 0;

      // Bind UI elements if provided
      this.btn = options.btnId ? document.getElementById(options.btnId) : null;
      this.statusEl = options.statusId ? document.getElementById(options.statusId) : null;
      this.logEl = options.logId ? document.getElementById(options.logId) : null;

      if (this.btn) {
        this.btn.addEventListener('click', () => {
          if (this.running) {
            this.stop('Зупинено користувачем');
          } else {
            this.start().catch((err) => {
              console.error('Bridge start error:', err);
            });
          }
        });
      }

      // Listen for USB disconnect event
      if (typeof navigator !== 'undefined' && navigator.usb) {
        navigator.usb.addEventListener('disconnect', (event) => {
          if (this.device && event.device === this.device) {
            this.log('warn', 'USB-кабель пристрою було від\'єднано');
            this.stop('USB-пристрій від\'єднано');
          }
        });
      }

      this.setStatus('idle', 'Очікування...');
    }

    /**
     * Resolve WebSocket URL, handling relative paths and domain placeholders
     */
    resolveWsUrl(rawUrl) {
      if (!rawUrl || rawUrl.includes('<ТВІЙ_ДОМЕН>') || rawUrl.includes('<YOUR_DOMAIN>')) {
        if (typeof window !== 'undefined' && window.location) {
          const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          return `${proto}//${window.location.host}/adb-bridge`;
        }
        return 'ws://127.0.0.1:3001/adb-bridge';
      }

      // If relative URL like '/adb-bridge'
      if (rawUrl.startsWith('/')) {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${window.location.host}${rawUrl}`;
      }

      return rawUrl;
    }

    /**
     * Update status and notify callbacks/UI
     */
    setStatus(status, text) {
      this.status = status;
      if (this.statusEl) {
        this.statusEl.textContent = text;
        this.statusEl.setAttribute('data-status', status);
      }
      if (this.btn) {
        if (status === 'connected' || status === 'bridging') {
          this.btn.textContent = '❌ Відключити';
          this.btn.classList.add('connected');
        } else if (status === 'connecting') {
          this.btn.textContent = '⏳ Підключення...';
          this.btn.disabled = true;
          this.btn.classList.remove('connected');
        } else {
          this.btn.textContent = '⚡ Підключити Android';
          this.btn.disabled = false;
          this.btn.classList.remove('connected');
        }
      }
      if (typeof this.options.onStatusChange === 'function') {
        this.options.onStatusChange(status, text);
      }
    }

    /**
     * Internal logger
     */
    log(level, text) {
      const time = new Date().toLocaleTimeString();
      const formatted = `[${time}] ${text}`;
      console.log(`[WebUSB-ADB] ${formatted}`);

      if (this.logEl) {
        const item = document.createElement('div');
        item.className = `log-line log-${level}`;
        item.textContent = formatted;
        this.logEl.appendChild(item);
        this.logEl.scrollTop = this.logEl.scrollHeight;
      }

      if (typeof this.options.onLog === 'function') {
        this.options.onLog(level, text);
      }
    }

    /**
     * Handle errors with clear instructions
     */
    handleError(err) {
      let friendlyMessage = err.message || String(err);

      // Check for common WebUSB lock issues (adb.exe running on Windows)
      const errStr = (err.name || '') + ' ' + (err.message || '');
      if (
        errStr.includes('SecurityError') ||
        errStr.includes('claim') ||
        errStr.includes('Access denied') ||
        errStr.includes('NetworkError') ||
        errStr.includes('transfer')
      ) {
        friendlyMessage =
          '⚠️ Помилка доступу до USB-інтерфейсу!\n' +
          'Можливо, на вашому Windows-ПК уже запущено локальний adb.\n' +
          'Відкрийте PowerShell / CMD і виконайте:\n' +
          '   adb kill-server\n' +
          'Також закрийте програми, що використовують телефон (Android Studio, Vysor тощо).';
      }

      this.log('error', friendlyMessage);
      this.setStatus('error', 'Помилка з\'єднання');

      if (typeof this.options.onError === 'function') {
        this.options.onError(err, friendlyMessage);
      } else {
        alert(friendlyMessage);
      }
    }

    /**
     * Start the WebUSB-to-WebSocket ADB Bridge
     */
    async start() {
      if (this.running) return;

      // 1. Verify WebUSB support
      if (!navigator.usb) {
        const msg =
          'Ваш браузер не підтримує WebUSB.\n' +
          'Будь ласка, відкрийте сторінку в Google Chrome, Microsoft Edge, Opera або Brave через захищене з\'єднання (HTTPS).';
        alert(msg);
        return;
      }

      try {
        this.setStatus('connecting', 'Вибір USB-пристрою...');
        this.log('info', 'Запит доступу до USB-пристрою Android...');

        // 2. Request Android ADB device
        this.device = await navigator.usb.requestDevice({
          filters: [
            {
              classCode: ADB_CLASS,
              subclassCode: ADB_SUBCLASS,
              protocolCode: ADB_PROTOCOL
            }
          ]
        });

        this.log('info', `Знайдено пристрій: ${this.device.productName || 'Android'} (${this.device.vendorId.toString(16)}:${this.device.productId.toString(16)})`);

        // 3. Open USB Device
        await this.device.open();

        if (this.device.configuration === null) {
          await this.device.selectConfiguration(1);
        }

        // 4. Find ADB Interface and Bulk Endpoints
        let adbInterface = null;
        let ifaceNumber = null;
        let altSettingNumber = 0;

        for (const iface of this.device.configuration.interfaces) {
          for (const alt of iface.alternates) {
            if (
              alt.interfaceClass === ADB_CLASS &&
              alt.interfaceSubclass === ADB_SUBCLASS &&
              alt.interfaceProtocol === ADB_PROTOCOL
            ) {
              adbInterface = alt;
              ifaceNumber = iface.interfaceNumber;
              altSettingNumber = alt.alternateSetting;
              break;
            }
          }
          if (adbInterface) break;
        }

        if (!adbInterface || ifaceNumber === null) {
          throw new Error('Не знайдено інтерфейс ADB (class 0xFF, subclass 0x42, proto 0x01) на цьому пристрої.');
        }

        this.interfaceNumber = ifaceNumber;

        // Find bulk endpoints
        this.endpointIn = null;
        this.endpointOut = null;

        for (const ep of adbInterface.endpoints) {
          if (ep.type === 'bulk') {
            if (ep.direction === 'in') {
              this.endpointIn = ep.endpointNumber;
            } else if (ep.direction === 'out') {
              this.endpointOut = ep.endpointNumber;
            }
          }
        }

        if (this.endpointIn === null || this.endpointOut === null) {
          throw new Error('Не вдалося знайти Bulk IN / OUT кінцеві точки ADB.');
        }

        this.log('info', `Захоплення USB-інтерфейсу #${this.interfaceNumber}...`);
        await this.device.claimInterface(this.interfaceNumber);

        if (altSettingNumber !== 0) {
          await this.device.selectAlternateInterface(this.interfaceNumber, altSettingNumber);
        }

        this.log('info', `USB-інтерфейс успішно захоплено. IN: #${this.endpointIn}, OUT: #${this.endpointOut}`);

        // 5. Connect to WebSocket Server
        this.setStatus('connecting', 'Підключення до сервера...');
        this.log('info', `З'єднання з сервером через WebSocket: ${this.wsUrl}`);

        await this.connectWebSocket();

        // 6. Mark running and start transparent bridge
        this.running = true;
        this.bytesSent = 0;
        this.bytesReceived = 0;
        this.setStatus('bridging', 'Міст активний! Очікую adb connect на Debian');
        this.log('info', 'Міст активовано! Тепер на сервері Debian запустіть adb connect 127.0.0.1:5555');

        // Start reading loop from USB device
        this.readFromUsbLoop();

      } catch (err) {
        if (err.name === 'NotFoundError') {
          this.log('warn', 'Користувач скасував вибір USB-пристрою.');
          this.setStatus('idle', 'Скасовано користувачем');
          return;
        }
        this.handleError(err);
        await this.stop('Помилка ініціалізації');
      }
    }

    /**
     * Connect WebSocket with binary arraybuffer support
     */
    connectWebSocket() {
      return new Promise((resolve, reject) => {
        try {
          this.ws = new WebSocket(this.wsUrl);
          this.ws.binaryType = 'arraybuffer';

          this.ws.onopen = () => {
            this.log('info', 'WebSocket з\'єднання успішно встановлено.');
            resolve();
          };

          this.ws.onmessage = async (event) => {
            let data = event.data;
            if (data instanceof Blob) {
              data = await data.arrayBuffer();
            }
            this.queueUsbWrite(new Uint8Array(data));
          };

          this.ws.onerror = (err) => {
            this.log('error', 'Помилка WebSocket з\'єднання.');
            reject(new Error('Не вдалося встановити WebSocket з\'єднання із сервером.'));
          };

          this.ws.onclose = (event) => {
            this.log('warn', `WebSocket закрито (код: ${event.code})`);
            if (this.running) {
              this.stop('Сервер розірвав з\'єднання');
            }
          };
        } catch (e) {
          reject(e);
        }
      });
    }

    /**
     * Infinite loop reading ADB packets from Phone via Bulk IN endpoint
     */
    async readFromUsbLoop() {
      while (this.running && this.device && this.device.opened) {
        try {
          // Read up to 16KB chunk
          const result = await this.device.transferIn(this.endpointIn, 16384);

          if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
            const buffer = result.data.buffer;
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(buffer);
              this.bytesSent += result.data.byteLength;
              this.emitStats();
            }
          } else if (result.status === 'stall') {
            this.log('warn', 'USB Endpoint IN заблоковано (stalled). Скидання halt...');
            await this.device.clearHalt('in', this.endpointIn);
          }
        } catch (err) {
          if (!this.running) break;
          this.log('error', `Помилка читання з USB: ${err.message}`);
          this.handleError(err);
          await this.stop('Помилка читання з USB');
          break;
        }
      }
    }

    /**
     * Queue outgoing write to USB Bulk OUT endpoint to avoid overlapping transfers
     */
    queueUsbWrite(uint8ArrayData) {
      this.outQueue.push(uint8ArrayData);
      if (this.isWriting) return;
      this.processOutQueue();
    }

    /**
     * Process FIFO queue of USB writes
     */
    async processOutQueue() {
      this.isWriting = true;
      while (this.outQueue.length > 0 && this.running && this.device && this.device.opened) {
        const chunk = this.outQueue.shift();
        try {
          const result = await this.device.transferOut(this.endpointOut, chunk);
          if (result.status === 'stall') {
            this.log('warn', 'USB Endpoint OUT заблоковано (stalled). Скидання halt...');
            await this.device.clearHalt('out', this.endpointOut);
          }
          this.bytesReceived += chunk.byteLength;
          this.emitStats();
        } catch (err) {
          if (!this.running) break;
          this.log('error', `Помилка запису в USB: ${err.message}`);
          this.handleError(err);
          await this.stop('Помилка запису в USB');
          break;
        }
      }
      this.isWriting = false;
    }

    /**
     * Emit traffic stats
     */
    emitStats() {
      if (typeof this.options.onStats === 'function') {
        this.options.onStats({
          bytesSent: this.bytesSent,
          bytesReceived: this.bytesReceived
        });
      }
    }

    /**
     * Stop the bridge and cleanly release resources
     */
    async stop(reason = 'Зупинено') {
      this.running = false;
      this.outQueue = [];
      this.isWriting = false;

      // Close WebSocket
      if (this.ws) {
        try {
          this.ws.onclose = null;
          this.ws.onerror = null;
          this.ws.close();
        } catch (e) {
          // ignore
        }
        this.ws = null;
      }

      // Close USB Device
      if (this.device) {
        try {
          if (this.device.opened && this.interfaceNumber !== null) {
            await this.device.releaseInterface(this.interfaceNumber);
          }
          if (this.device.opened) {
            await this.device.close();
          }
        } catch (e) {
          // ignore
        }
        this.device = null;
      }

      this.setStatus('idle', reason);
      this.log('info', `Міст зупинено: ${reason}`);
    }
  }

  return WebUsbAdbBridge;
});
