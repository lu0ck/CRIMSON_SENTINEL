const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');
const { fork } = require('child_process');
const fs = require('fs');

let mainWindow;
let serverProcess;
let tray = null;
let isQuitting = false;

const safeLog = (msg) => {
  try {
    if (process.stdout && typeof process.stdout.write === 'function' && process.stdout.writable && !process.stdout.destroyed) {
      try {
        process.stdout.write((typeof msg === 'string' ? msg : JSON.stringify(msg)) + '\n');
      } catch (writeErr) {
        // Silently ignore write errors like EPIPE
      }
    }
  } catch (e) {
    // Ignore any other logging errors
  }
};

function getTrayIcon() {
  const iconPath = path.join(app.getAppPath(), 'public', 'icon.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  }
  // Fallback: generate a simple 16x16 red circle icon
  return nativeImage.createEmpty();
}

function startServer() {
  const serverPath = path.join(app.getAppPath(), 'server.ts');
  const tsxPath = path.join(app.getAppPath(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  
  safeLog('Starting server from: ' + serverPath);
  safeLog('Using tsx from: ' + tsxPath);

  if (!fs.existsSync(serverPath)) {
    safeLog('CRITICAL: server.ts not found at ' + serverPath);
    return;
  }

  if (!fs.existsSync(tsxPath)) {
    safeLog('CRITICAL: tsx not found at ' + tsxPath);
  }

  try {
    serverProcess = fork(
      tsxPath,
      [serverPath],
      {
        env: { 
          ...process.env, 
          NODE_ENV: (app.isPackaged || !isDev) ? 'production' : 'development',
          APP_PATH: app.getAppPath(),
          USER_DATA_PATH: app.getPath('userData')
        },
        silent: false
      }
    );

    serverProcess.on('error', (err) => {
      safeLog('CRITICAL: Failed to start server process: ' + err);
    });

    serverProcess.on('exit', (code) => {
      safeLog('Server process exited with code: ' + code);
    });
  } catch (err) {
    safeLog('CRITICAL: Error during server fork: ' + err);
  }

  serverProcess.on('message', (msg) => {
    safeLog('Server message: ' + msg);
  });
}

function createTray() {
  const icon = getTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Crimson Sentinel');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: 'Sair', click: () => { isQuitting = true; app.quit(); } }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  const iconPath = path.join(app.getAppPath(), 'public', 'icon.png');
  const iconSvgPath = path.join(app.getAppPath(), 'public', 'icon.svg');
  const icon = fs.existsSync(iconPath) ? iconPath : (fs.existsSync(iconSvgPath) ? iconSvgPath : undefined);
  const iconOptions = icon ? { icon } : {};

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    show: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(app.getAppPath(), 'electron', 'preload.cjs'),
    },
    ...iconOptions
  });

  const loadURL = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    safeLog('Attempting to load URL...');
    mainWindow.loadURL('http://localhost:3000').then(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      safeLog('URL loaded successfully');
      mainWindow.show();
    }).catch((err) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      safeLog('Server not ready (ERR_CONNECTION_REFUSED), retrying in 1.5s...');
      setTimeout(loadURL, 1500);
    });
  };

  loadURL();

  // Close button = minimize to tray (keep running in background)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers for window controls
ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

// Auto-start on login
ipcMain.handle('get-auto-start', () => {
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.on('set-auto-start', (event, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: app.getPath('exe'),
  });
  safeLog(`[auto-start] set to ${enabled}`);
});

app.on('ready', () => {
  startServer();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // Don't quit on window close — keep running in tray
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverProcess) serverProcess.kill();
});
