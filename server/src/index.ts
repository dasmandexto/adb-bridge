import net from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

// Configuration
const WS_PORT = parseInt(process.env.PORT || '3001', 10);
const WS_PATH = process.env.WS_PATH || '/adb-bridge';
const TCP_PORT = parseInt(process.env.TCP_PORT || '5555', 10);
const TCP_HOST = process.env.TCP_HOST || '127.0.0.1';

/**
 * Formatted timestamp logger for journalctl / terminal
 */
function log(level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', message: string): void {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const prefix = {
    INFO: '[INFO]',
    WARN: '[WARN]',
    ERROR: '[ERROR]',
    SUCCESS: '[OK]'
  }[level];
  console.log(`${now} ${prefix} ${message}`);
}

// Global state
let activeWs: (WebSocket & { isAlive?: boolean }) | null = null;
let activeTcpServer: net.Server | null = null;
let activeTcpSocket: net.Socket | null = null;
let bytesFromAdb = 0;
let bytesToAdb = 0;

// Create WebSocket server
const wss = new WebSocketServer({
  port: WS_PORT,
  path: WS_PATH
});

log('INFO', `=====================================================`);
log('INFO', `WebUSB-to-TCP ADB Bridge Daemon`);
log('INFO', `WebSocket Server: ws://0.0.0.0:${WS_PORT}${WS_PATH}`);
log('INFO', `Target ADB TCP:   ${TCP_HOST}:${TCP_PORT}`);
log('INFO', `=====================================================`);
log('INFO', `Очікую підключення браузера клієнта через WebSocket...`);

/**
 * Cleanly teardown any active TCP server and sockets
 */
function cleanupTcpBridge(): void {
  if (activeTcpSocket) {
    log('INFO', `[TCP] Закриття локального TCP-сокета ADB...`);
    try {
      activeTcpSocket.destroy();
    } catch (e) {
      // ignore
    }
    activeTcpSocket = null;
  }

  if (activeTcpServer) {
    log('INFO', `[TCP] Зупинка TCP-сервера на ${TCP_HOST}:${TCP_PORT}...`);
    try {
      activeTcpServer.close();
    } catch (e) {
      // ignore
    }
    activeTcpServer = null;
  }

  bytesFromAdb = 0;
  bytesToAdb = 0;
}

// Handle WebSocket client connections
wss.on('connection', (ws: WebSocket & { isAlive?: boolean }, req) => {
  const clientIp = req.socket.remoteAddress || 'unknown';
  log('SUCCESS', `[WS] Новий клієнт підключився з ${clientIp}`);

  // If there was an existing client, cleanly close it
  if (activeWs && activeWs !== ws) {
    log('WARN', `[WS] Закриття попереднього WebSocket з'єднання...`);
    try {
      activeWs.close(1000, 'Заміщено новим підключенням');
    } catch (e) {
      // ignore
    }
  }

  // Cleanup old TCP bridge if still present
  cleanupTcpBridge();

  activeWs = ws;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Create TCP server listening on 127.0.0.1:5555 for Debian adb
  const tcpServer = net.createServer((socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    log('SUCCESS', `[TCP] Локальний ADB клієнт підключився: ${remote}`);

    if (activeTcpSocket && !activeTcpSocket.destroyed) {
      log('WARN', `[TCP] Закриття старого сокета ADB через нове з'єднання`);
      try {
        activeTcpSocket.destroy();
      } catch (e) {
        // ignore
      }
    }

    activeTcpSocket = socket;

    // TCP -> WebSocket (Data from Debian adb -> WebUSB Phone)
    socket.on('data', (chunk: Buffer) => {
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(chunk, { binary: true }, (err) => {
          if (err) {
            log('ERROR', `[WS] Помилка надсилання у WebSocket: ${err.message}`);
          }
        });
        bytesFromAdb += chunk.length;
      } else {
        log('WARN', `[TCP] Отримано ${chunk.length} байт від ADB, але WebSocket не готовий`);
      }
    });

    socket.on('error', (err) => {
      log('WARN', `[TCP] Помилка локального сокета ADB: ${err.message}`);
    });

    socket.on('close', (hadError) => {
      log('INFO', `[TCP] Локальний ADB сокет закрито (помилка: ${hadError}). Передано ADB->WS: ${formatBytes(bytesFromAdb)}, WS->ADB: ${formatBytes(bytesToAdb)}`);
      if (activeTcpSocket === socket) {
        activeTcpSocket = null;
      }
    });
  });

  tcpServer.on('error', (err: NodeJS.ErrnoException) => {
    log('ERROR', `[TCP] Помилка TCP-сервера: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      log('ERROR', `[TCP] Порт ${TCP_PORT} вже зайнятий! Зупиніть попередній процес або виконайте fuser -k ${TCP_PORT}/tcp`);
    }
  });

  tcpServer.listen(TCP_PORT, TCP_HOST, () => {
    activeTcpServer = tcpServer;
    log('SUCCESS', `[TCP] Сервер успішно запущено на ${TCP_HOST}:${TCP_PORT}`);
    log('INFO', `👉 Тепер на сервері Debian запустіть: adb connect ${TCP_HOST}:${TCP_PORT} (або команду 'adb-go')`);
  });

  // WebSocket -> TCP (Data from WebUSB Phone -> Debian adb)
  ws.on('message', (data: RawData) => {
    if (activeTcpSocket && !activeTcpSocket.destroyed) {
      if (Buffer.isBuffer(data)) {
        activeTcpSocket.write(data);
        bytesToAdb += data.length;
      } else if (Array.isArray(data)) {
        const combined = Buffer.concat(data);
        activeTcpSocket.write(combined);
        bytesToAdb += combined.length;
      } else if (data instanceof ArrayBuffer) {
        const buf = Buffer.from(data);
        activeTcpSocket.write(buf);
        bytesToAdb += buf.length;
      } else {
        const buf = Buffer.from(data as any);
        activeTcpSocket.write(buf);
        bytesToAdb += buf.length;
      }
    } else {
      // Buffer / ignore if ADB has not connected yet
    }
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason.toString() || 'не вказано';
    log('WARN', `[WS] Клієнт від'єднався (код: ${code}, причина: ${reasonStr})`);
    if (activeWs === ws) {
      activeWs = null;
      cleanupTcpBridge();
      log('INFO', `[STATE] Стан скинуто. Очікую нове підключення клієнта через WebSocket...`);
    }
  });

  ws.on('error', (err) => {
    log('ERROR', `[WS] Помилка клієнта: ${err.message}`);
    if (activeWs === ws) {
      activeWs = null;
      cleanupTcpBridge();
    }
  });
});

// Periodic ping to keep WebSocket connections alive through NAT / reverse proxy
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const extWs = ws as WebSocket & { isAlive?: boolean };
    if (extWs.isAlive === false) {
      log('WARN', `[WS] Клієнт не відповів на ping, примусове відключення`);
      return extWs.terminate();
    }
    extWs.isAlive = false;
    extWs.ping();
  });
}, 25000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Graceful process shutdown
function handleShutdown(signal: string): void {
  log('INFO', `Отримано сигнал ${signal}. Завершення роботи...`);
  cleanupTcpBridge();
  clearInterval(heartbeatInterval);
  wss.close(() => {
    log('INFO', 'WebSocket сервер зупинено. Вихід.');
    process.exit(0);
  });
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

/**
 * Format bytes helper
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
