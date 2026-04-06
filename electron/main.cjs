const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');
const { fork } = require('child_process');

let mainWindow;
let serverProcess;

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

function startServer() {
  const fs = require('fs');
  // Start the Express server as a background process
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

function createWindow() {
  const fs = require('fs');
  const iconPath = path.join(app.getAppPath(), 'public', 'icon.png');
  const iconOptions = fs.existsSync(iconPath) ? { icon: iconPath } : {};

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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers for window controls
ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
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

app.on('ready', () => {
  startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (serverProcess) serverProcess.kill();
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
