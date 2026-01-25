const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const dns = require('dns');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { SocksClient } = require('socks');
const httpProxy = require('http-proxy');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Set app name for macOS dock
app.setName('SlipStream GUI');

const HTTP_PROXY_PORT = 8080;
const SOCKS5_PORT = 5201;
const fs = require('fs');

// Default settings
let RESOLVER = '8.8.8.8:53';
let DOMAIN = 's.example.com';
let useTunMode = false; // Toggle between HTTP proxy and TUN mode
let verboseLogging = false; // Verbose logging toggle
let socks5AuthEnabled = false;
let socks5AuthUsername = '';
let socks5AuthPassword = '';
// System proxy lifecycle safety (only undo what THIS app enabled)
let systemProxyEnabledByApp = false;
let systemProxyServiceName = '';

// Settings storage:
// - Dev (`npm start`): can read/write local settings file
// - Packaged apps (GitHub releases): `__dirname` is inside app.asar (read-only)
// Therefore, always store settings in Electron's userData directory (writable).
const SETTINGS_FILE_BASENAME = 'settings.json';
let SETTINGS_FILE = null;
const LEGACY_SETTINGS_FILE = path.join(__dirname, SETTINGS_FILE_BASENAME);

function getSettingsFilePath() {
  try {
    const dir = app.getPath('userData');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
    return path.join(dir, SETTINGS_FILE_BASENAME);
  } catch (_) {
    // Extremely defensive fallback (shouldn't happen in normal Electron runtime).
    return path.join(__dirname, SETTINGS_FILE_BASENAME);
  }
}

function ensureSettingsFilePath() {
  if (!SETTINGS_FILE) SETTINGS_FILE = getSettingsFilePath();
  return SETTINGS_FILE;
}

function loadSettings() {
  try {
    const settingsPath = ensureSettingsFilePath();

    // One-time migration: if a legacy settings file exists but userData settings doesn't,
    // copy it to userData so packaged apps can persist changes.
    if (!fs.existsSync(settingsPath) && fs.existsSync(LEGACY_SETTINGS_FILE)) {
      try {
        const legacyData = fs.readFileSync(LEGACY_SETTINGS_FILE, 'utf8');
        fs.writeFileSync(settingsPath, legacyData);
      } catch (err) {
        // Non-fatal: we'll proceed without migration.
        console.warn('Settings migration skipped:', err?.message || err);
      }
    }

    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(data);
      if (settings.resolver) RESOLVER = settings.resolver;
      if (settings.domain) DOMAIN = settings.domain;
      if (settings.mode) useTunMode = (settings.mode === 'tun');
      if (settings.verbose !== undefined) verboseLogging = settings.verbose;
      if (settings.socks5AuthEnabled !== undefined) socks5AuthEnabled = !!settings.socks5AuthEnabled;
      if (typeof settings.socks5AuthUsername === 'string') socks5AuthUsername = settings.socks5AuthUsername;
      if (typeof settings.socks5AuthPassword === 'string') socks5AuthPassword = settings.socks5AuthPassword;
      if (settings.systemProxyEnabledByApp !== undefined) systemProxyEnabledByApp = !!settings.systemProxyEnabledByApp;
      if (typeof settings.systemProxyServiceName === 'string') systemProxyServiceName = settings.systemProxyServiceName;
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

function saveSettings(overrides = {}) {
  try {
    const settingsPath = ensureSettingsFilePath();
    const next = {
      resolver: overrides.resolver ?? RESOLVER,
      domain: overrides.domain ?? DOMAIN,
      mode: overrides.mode ?? (useTunMode ? 'tun' : 'proxy'),
      verbose: overrides.verbose ?? verboseLogging,
      socks5AuthEnabled: overrides.socks5AuthEnabled ?? socks5AuthEnabled,
      socks5AuthUsername: overrides.socks5AuthUsername ?? socks5AuthUsername,
      socks5AuthPassword: overrides.socks5AuthPassword ?? socks5AuthPassword,
      systemProxyEnabledByApp: overrides.systemProxyEnabledByApp ?? systemProxyEnabledByApp,
      systemProxyServiceName: overrides.systemProxyServiceName ?? systemProxyServiceName
    };

    // Update in-memory state first so UI actions take effect immediately,
    // even if the disk write fails for some reason.
    RESOLVER = next.resolver;
    DOMAIN = next.domain;
    useTunMode = next.mode === 'tun';
    verboseLogging = !!next.verbose;
    socks5AuthEnabled = !!next.socks5AuthEnabled;
    socks5AuthUsername = next.socks5AuthUsername || '';
    socks5AuthPassword = next.socks5AuthPassword || '';
    systemProxyEnabledByApp = !!next.systemProxyEnabledByApp;
    systemProxyServiceName = next.systemProxyServiceName || '';

    fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2));
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

let mainWindow;
let slipstreamProcess = null;
let httpProxyServer = null;
let isRunning = false;
let tunManager = null;
let systemProxyConfigured = false; // Track system proxy state
let cleanupInProgress = false;
let quitting = false;

function canSendToWindow() {
  return !!(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.webContents &&
    !mainWindow.webContents.isDestroyed()
  );
}

function safeSend(channel, payload) {
  try {
    if (!canSendToWindow()) return;
    mainWindow.webContents.send(channel, payload);
  } catch (_) {
    // Ignore: window is closing/destroyed.
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const windowOptions = {
    width: 1200,
    height: 800,
    resizable: true,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  };
  
  // Set icon if it exists
  try {
    if (fs.existsSync(iconPath)) {
      windowOptions.icon = iconPath;
      console.log('Using icon:', iconPath);
      
      // On macOS, also set the dock icon (works in development)
      if (process.platform === 'darwin' && app.dock) {
        app.dock.setIcon(iconPath);
      }
    } else {
      console.log('Icon not found at:', iconPath);
    }
  } catch (err) {
    console.error('Error setting icon:', err);
  }
  
  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile('index.html');

  // Avoid "Object has been destroyed" during shutdown.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  
  // Request admin privileges on macOS
  if (process.platform === 'darwin') {
    // Note: Electron doesn't automatically prompt for admin, but we can show a message
    // The networksetup commands will prompt for password when needed
  }
  
  // mainWindow.webContents.openDevTools(); // Uncomment for debugging
}

function getSlipstreamClientPath() {
  const platform = process.platform;
  // In packaged app, resources are in different location
  const resourcesPath = app.isPackaged 
    ? path.join(process.resourcesPath)
    : __dirname;
  
  if (platform === 'darwin') {
    const preferred =
      process.arch === 'arm64' ? 'slipstream-client-mac-arm64' : 'slipstream-client-mac-intel';
    const fallback =
      process.arch === 'arm64' ? 'slipstream-client-mac-intel' : 'slipstream-client-mac-arm64';
    const candidates = [
      // Preferred: packaged and dev both keep binaries under ./binaries/
      path.join(resourcesPath, 'binaries', preferred),
      // Back-compat: allow repo-root placement during transition
      path.join(resourcesPath, preferred),
      // Extra back-compat: legacy single mac binary name
      path.join(resourcesPath, 'binaries', 'slipstream-client-mac'),
      path.join(resourcesPath, 'slipstream-client-mac'),
      // If user runs under Rosetta, try the other arch too (if present)
      path.join(resourcesPath, 'binaries', fallback),
      path.join(resourcesPath, fallback)
    ];
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
  } else if (platform === 'win32') {
    const candidates = [
      path.join(resourcesPath, 'binaries', 'slipstream-client-win.exe'),
      path.join(resourcesPath, 'slipstream-client-win.exe')
    ];
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
  } else if (platform === 'linux') {
    const candidates = [
      path.join(resourcesPath, 'binaries', 'slipstream-client-linux'),
      path.join(resourcesPath, 'slipstream-client-linux')
    ];
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
  }
  return null;
}

function startSlipstreamClient(resolver, domain) {
  const clientPath = getSlipstreamClientPath();
  if (!clientPath) {
    throw new Error('Unsupported platform');
  }
  if (!fs.existsSync(clientPath)) {
    const where = app.isPackaged ? 'inside the app resources folder' : 'in the project folder';
    const baseMsg = `SlipStream client binary not found ${where}.`;
    const expectedMsg = `Expected at: ${clientPath}`;
    const hint =
      process.platform === 'win32'
        ? 'This usually means the installer was built without the Windows client binary, or it was quarantined/removed by antivirus. Reinstall, or whitelist the app folder, and ensure the build includes slipstream-client-win.exe.\n\nWindows Defender tip: open Windows Security → Virus & threat protection → Protection history, restore/allow "slipstream-client-win.exe" if quarantined, and add an Exclusion for the install folder.'
        : process.platform === 'darwin'
          ? 'Ensure the correct macOS slipstream client binary exists under ./binaries/ (slipstream-client-mac-arm64 or slipstream-client-mac-intel) and is executable.'
          : 'Ensure the correct slipstream client binary exists under ./binaries/ and is executable.';
    throw new Error(`${baseMsg}\n${expectedMsg}\n${hint}`);
  }

  // Ensure execute permissions on macOS and Linux (automatic, no user action needed)
  if ((process.platform === 'darwin' || process.platform === 'linux') && fs.existsSync(clientPath)) {
    try {
      // Check if file is executable, if not, make it executable
      fs.accessSync(clientPath, fs.constants.X_OK);
    } catch (err) {
      // File is not executable, set execute permission automatically
      fs.chmodSync(clientPath, 0o755);
      console.log(`Automatically set execute permissions on ${path.basename(clientPath)}`);
    }
  }

  const args = ['--resolver', resolver, '--domain', domain];
  
  slipstreamProcess = spawn(clientPath, args, {
    stdio: 'pipe',
    detached: false
  });

  slipstreamProcess.stdout.on('data', (data) => {
    console.log(`Slipstream: ${data}`);
    safeSend('slipstream-log', data.toString());
    sendStatusUpdate();
  });

  slipstreamProcess.stderr.on('data', (data) => {
    const errorStr = data.toString();
    console.error(`Slipstream Error: ${errorStr}`);
    
    // Check for port already in use error
    if (errorStr.includes('Address already in use') || errorStr.includes('EADDRINUSE')) {
      console.warn('Port 5201 is already in use. Trying to kill existing process...');
      const { exec } = require('child_process');
      exec('lsof -ti:5201 | xargs kill -9 2>/dev/null', (err) => {
        if (!err) {
          console.log('Killed process using port 5201. Please restart the VPN.');
          safeSend('slipstream-error', 'Port 5201 was in use. Killed existing process. Please restart the VPN.');
        }
      });
    }
    
    safeSend('slipstream-error', errorStr);
    sendStatusUpdate();
  });

  slipstreamProcess.on('close', (code) => {
    console.log(`Slipstream process exited with code ${code}`);
    slipstreamProcess = null;
    safeSend('slipstream-exit', code);
    sendStatusUpdate();
    if (isRunning) {
      // If SlipStream dies unexpectedly, ensure we also undo system proxy if we enabled it.
      void cleanupAndDisableProxyIfNeeded('slipstream-exit');
    }
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    // If spawn fails (e.g., ENOENT), reject instead of crashing/pretending success.
    slipstreamProcess.once('error', (err) => {
      const msg = `SlipStream failed to start: ${err.code || 'ERROR'} ${err.message || String(err)}`;
      console.error(msg);
      slipstreamProcess = null;
      safeSend('slipstream-error', msg);
      safeSend('slipstream-exit', -1);
      sendStatusUpdate();
      settle(reject, new Error(`Slipstream client failed to start: ${err.message || String(err)}`));
    });

    // Only start the readiness timer after the process actually spawned.
    slipstreamProcess.once('spawn', () => {
      setTimeout(() => {
        if (slipstreamProcess && !slipstreamProcess.killed) {
          sendStatusUpdate();
          settle(resolve);
        } else {
          settle(reject, new Error('Slipstream client failed to start'));
        }
      }, 2000);
    });
  });
}

function sendStatusUpdate() {
  const details = getStatusDetails();
  safeSend('status-update', details);
}

function startHttpProxy() {
  return new Promise((resolve, reject) => {
    function buildSocks5Url() {
      if (!socks5AuthEnabled) return `socks5://127.0.0.1:${SOCKS5_PORT}`;
      if (!socks5AuthUsername || !socks5AuthPassword) return `socks5://127.0.0.1:${SOCKS5_PORT}`;
      const u = encodeURIComponent(socks5AuthUsername);
      const p = encodeURIComponent(socks5AuthPassword);
      return `socks5://${u}:${p}@127.0.0.1:${SOCKS5_PORT}`;
    }

    // Create SOCKS5 agent (optionally with auth), and refresh if settings change
    let socksAgent = null;
    let socksAgentUrl = null;
    function getSocksAgent() {
      const url = buildSocks5Url();
      if (!socksAgent || socksAgentUrl !== url) {
        socksAgent = new SocksProxyAgent(url);
        socksAgentUrl = url;
      }
      return socksAgent;
    }
    const net = require('net');
    const https = require('https');
    const httpLib = require('http');
    
    // Create HTTP proxy server with custom CONNECT handling
    // Using 'connect' event for proper CONNECT method handling
    httpProxyServer = http.createServer();
    
    // Handle CONNECT requests separately (before they hit the request handler)
    httpProxyServer.on('connect', (req, clientSocket, head) => {
      const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      const logRequest = (message, isError = false, isVerbose = false) => {
        // Skip verbose messages if verbose logging is disabled
        if (isVerbose && !verboseLogging) return;
        
        const logMsg = `[${requestId}] ${message}`;
        console.log(logMsg);
        if (isError) safeSend('slipstream-error', logMsg);
        else safeSend('slipstream-log', logMsg);
      };
      
      const urlParts = req.url.split(':');
      const host = urlParts[0];
      const port = parseInt(urlParts[1] || '443');
      
      // CONNECT logs can be very noisy; show them only in verbose mode.
      logRequest(`🔒 CONNECT ${host}:${port} (HTTPS)`, false, true);
      
      // Connect through SOCKS5
      const socksProxy = {
        host: '127.0.0.1',
        port: SOCKS5_PORT,
        type: 5
      };
      if (socks5AuthEnabled && socks5AuthUsername && socks5AuthPassword) {
        socksProxy.userId = socks5AuthUsername;
        socksProxy.password = socks5AuthPassword;
      }

      SocksClient.createConnection({
        proxy: {
          ...socksProxy
        },
        command: 'connect',
        destination: {
          host: host,
          port: port
        }
      }).then((info) => {
        logRequest(`✅ SOCKS5 connected to ${host}:${port}`, false, true);
        
        const targetSocket = info.socket;
        
        // Send 200 response directly to client socket
        clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        logRequest(`📤 Sent 200 Connection established`, false, true);
        
        // If there's any head data, write it to target
        if (head && head.length > 0) {
          targetSocket.write(head);
        }
        
        // Configure sockets
        clientSocket.setNoDelay(true);
        targetSocket.setNoDelay(true);
        
        // Error handlers
        const ignoreCodes = ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ECANCELED', 'ETIMEDOUT'];
        clientSocket.on('error', (err) => {
          if (!ignoreCodes.includes(err.code)) {
            logRequest(`❌ Client error: ${err.code}`, true);
          }
        });
        
        targetSocket.on('error', (err) => {
          if (!ignoreCodes.includes(err.code)) {
            logRequest(`❌ Target error: ${err.code}`, true);
          }
        });
        
        // Close handlers
        clientSocket.on('close', () => {
          logRequest(`🔌 Client closed`, false, true);
          if (!targetSocket.destroyed) targetSocket.destroy();
        });
        
        targetSocket.on('close', () => {
          logRequest(`🔌 Target closed`, false, true);
          if (!clientSocket.destroyed) clientSocket.destroy();
        });
        
        // Pipe bidirectionally
        clientSocket.pipe(targetSocket, { end: false });
        targetSocket.pipe(clientSocket, { end: false });
        
        logRequest(`🔗 Tunnel active: ${host}:${port}`, false, true);
      }).catch((err) => {
        logRequest(`❌ CONNECT failed: ${err.message}`, true);
        clientSocket.write(`HTTP/1.1 500 Proxy Error\r\n\r\n${err.message}`);
        clientSocket.end();
      });
    });
    
    // Handle regular HTTP requests
    httpProxyServer.on('request', (req, res) => {
      // Debug logging
      const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      const logRequest = (message, isError = false, isVerbose = false) => {
        // Skip verbose messages if verbose logging is disabled
        if (isVerbose && !verboseLogging) return;
        
        const logMsg = `[${requestId}] ${message}`;
        console.log(logMsg);
        if (isError) safeSend('slipstream-error', logMsg);
        else safeSend('slipstream-log', logMsg);
      };
      
      logRequest(`→ ${req.method} ${req.url}`, false, true);
      
      // Set timeout
      req.setTimeout(30000, () => {
        logRequest(`⏱️ Request timeout`, true);
        if (!res.headersSent) {
          res.writeHead(408);
          res.end('Request Timeout');
        }
      });
      
      // Handle regular HTTP requests (CONNECT is handled by 'connect' event above)
      {
        // Handle HTTP requests
        const url = require('url');
        
        // For HTTP proxy, browsers send absolute URLs in req.url
        // Format: "http://example.com/path" or "https://example.com/path"
        let targetUrl = req.url;
        let parsedUrl;
        
        // Check if it's already an absolute URL
        if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
          parsedUrl = url.parse(targetUrl);
        } else {
          // Relative URL - use Host header
          const host = req.headers.host || 'localhost';
          targetUrl = `http://${host}${targetUrl.startsWith('/') ? targetUrl : '/' + targetUrl}`;
          parsedUrl = url.parse(targetUrl);
        }
        
        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : httpLib;
        
        // Build request options
        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.path || '/',
          method: req.method,
          headers: {}
        };
        
        // Copy headers but clean them up
        for (const key in req.headers) {
          const lowerKey = key.toLowerCase();
          // Skip proxy-specific headers and connection headers
          if (lowerKey === 'host' || 
              lowerKey === 'proxy-connection' || 
              lowerKey === 'proxy-authorization' ||
              lowerKey === 'connection' ||
              lowerKey === 'upgrade' ||
              lowerKey === 'keep-alive') {
            continue;
          }
          options.headers[key] = req.headers[key];
        }
        
        // Set proper host header
        options.headers.host = parsedUrl.hostname + (parsedUrl.port ? ':' + parsedUrl.port : '');
        
          // Don't set connection header - let it be handled automatically
          // options.headers.connection = 'close';
          
          // Use SOCKS5 agent
          options.agent = getSocksAgent();
          
          // Set timeout
          options.timeout = 30000;
        
        logRequest(`🌐 HTTP ${req.method} ${parsedUrl.hostname}${parsedUrl.path || '/'} via SOCKS5`, false, true);
        
        const proxyReq = client.request(options, (proxyRes) => {
          logRequest(`📥 Response ${proxyRes.statusCode} from ${parsedUrl.hostname}`, false, true);
          // Copy response headers but filter out problematic ones
          const responseHeaders = {};
          for (const key in proxyRes.headers) {
            const lowerKey = key.toLowerCase();
            // Skip headers that shouldn't be forwarded
            if (lowerKey !== 'connection' && 
                lowerKey !== 'transfer-encoding' &&
                lowerKey !== 'keep-alive') {
              responseHeaders[key] = proxyRes.headers[key];
            }
          }
          
          // Don't force connection: close - let it be handled naturally
          // responseHeaders.connection = 'close';
          
          try {
            if (!res.headersSent) {
              res.writeHead(proxyRes.statusCode, responseHeaders);
              proxyRes.pipe(res);
              logRequest(`📤 Sent response ${proxyRes.statusCode} to client`, false, true);
            } else {
              logRequest(`⚠️ Response headers already sent!`, true);
            }
          } catch (err) {
            logRequest(`❌ Error writing response: ${err.message}`, true);
          }
        });
        
        // Set timeout on proxy request
        proxyReq.setTimeout(30000, () => {
          logRequest(`⏱️ Proxy request timeout`, true);
          if (!res.headersSent) {
            res.writeHead(408);
            res.end('Request Timeout');
          }
          proxyReq.destroy();
        });
        
        proxyReq.on('error', (err) => {
          logRequest(`❌ Proxy request error: ${err.message}`, true);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(err.message);
          }
        });
        
        res.on('close', () => {
          logRequest(`🔌 Response closed`, false, true);
          if (!proxyReq.destroyed) {
            proxyReq.destroy();
          }
        });
        
        req.on('error', (err) => {
          logRequest(`❌ Request error: ${err.message}`, true);
          if (!proxyReq.destroyed) {
            proxyReq.destroy();
          }
          if (!res.headersSent) {
            res.writeHead(500);
            res.end('Request Error');
          }
        });
        
        res.on('error', (err) => {
          logRequest(`❌ Response error: ${err.message}`, true);
          if (!proxyReq.destroyed) {
            proxyReq.destroy();
          }
        });
        
        // Handle request body - pipe directly
        req.pipe(proxyReq);
      }
    });

    httpProxyServer.on('upgrade', (req, socket, head) => {
      // Handle WebSocket upgrades
      const urlParts = req.url.split(':');
      const host = urlParts[0];
      const port = parseInt(urlParts[1] || '80');
      
      const socksProxy = {
        host: '127.0.0.1',
        port: SOCKS5_PORT,
        type: 5
      };
      if (socks5AuthEnabled && socks5AuthUsername && socks5AuthPassword) {
        socksProxy.userId = socks5AuthUsername;
        socksProxy.password = socks5AuthPassword;
      }

      SocksClient.createConnection({
        proxy: {
          ...socksProxy
        },
        command: 'connect',
        destination: {
          host: host,
          port: port
        }
      }).then((info) => {
        info.socket.write(head);
        info.socket.pipe(socket);
        socket.pipe(info.socket);
      }).catch((err) => {
        socket.end();
      });
    });

    httpProxyServer.listen(HTTP_PROXY_PORT, '127.0.0.1', () => {
      console.log(`HTTP Proxy listening on port ${HTTP_PROXY_PORT}`);
      sendStatusUpdate();
      resolve();
    });

    httpProxyServer.on('error', (err) => {
      console.error('HTTP Proxy error:', err);
      reject(err);
    });
  });
}

async function configureSystemProxy() {
  const platform = process.platform;
  let configured = false;
  
  try {
    if (platform === 'darwin') {
      // macOS: Get list of all network services
      try {
        const { stdout } = await execAsync('networksetup -listallnetworkservices');
        const services = stdout.split('\n').filter(line => line.trim() && !line.includes('*') && !line.includes('An asterisk'));
        
        // Try common interface names first
        const preferredInterfaces = ['Wi-Fi', 'Ethernet', 'USB 10/100/1000 LAN', 'Thunderbolt Bridge'];
        
        for (const preferred of preferredInterfaces) {
          const matching = services.find(s => s.includes(preferred) || s.toLowerCase().includes(preferred.toLowerCase()));
          if (matching) {
            try {
              const iface = matching.trim();
              await execAsync(`networksetup -setwebproxy "${iface}" 127.0.0.1 ${HTTP_PROXY_PORT}`);
              await execAsync(`networksetup -setsecurewebproxy "${iface}" 127.0.0.1 ${HTTP_PROXY_PORT}`);
              // Enable the proxy
              await execAsync(`networksetup -setwebproxystate "${iface}" on`);
              await execAsync(`networksetup -setsecurewebproxystate "${iface}" on`);
              console.log(`System proxy configured and enabled via networksetup on ${iface}`);
              systemProxyEnabledByApp = true;
              systemProxyServiceName = iface;
              saveSettings({ systemProxyEnabledByApp, systemProxyServiceName });
              configured = true;
              break;
            } catch (err) {
              console.error(`Failed to configure proxy on ${matching}:`, err.message);
              continue;
            }
          }
        }
        
        // If still not configured, try the first available service
        if (!configured && services.length > 0) {
          const iface = services[0].trim();
          try {
            await execAsync(`networksetup -setwebproxy "${iface}" 127.0.0.1 ${HTTP_PROXY_PORT}`);
            await execAsync(`networksetup -setsecurewebproxy "${iface}" 127.0.0.1 ${HTTP_PROXY_PORT}`);
            // Enable the proxy
            await execAsync(`networksetup -setwebproxystate "${iface}" on`);
            await execAsync(`networksetup -setsecurewebproxystate "${iface}" on`);
            console.log(`System proxy configured and enabled via networksetup on ${iface}`);
            systemProxyEnabledByApp = true;
            systemProxyServiceName = iface;
            saveSettings({ systemProxyEnabledByApp, systemProxyServiceName });
            configured = true;
          } catch (err) {
            console.error(`Failed to configure proxy on ${iface}:`, err.message);
          }
        }
      } catch (err) {
        console.error('Failed to list network services:', err.message);
      }
    } else if (platform === 'win32') {
      // Windows: netsh
      try {
        await execAsync(`netsh winhttp set proxy proxy-server="127.0.0.1:${HTTP_PROXY_PORT}"`);
        console.log('System proxy configured via netsh');
        systemProxyEnabledByApp = true;
        systemProxyServiceName = 'winhttp';
        saveSettings({ systemProxyEnabledByApp, systemProxyServiceName });
        configured = true;
      } catch (err) {
        console.error('Failed to configure proxy via netsh:', err.message);
      }
    } else if (platform === 'linux') {
      // Linux: gsettings (GNOME) or environment variables
      try {
        // Try GNOME settings first
        await execAsync(`gsettings set org.gnome.system.proxy mode 'manual'`);
        await execAsync(`gsettings set org.gnome.system.proxy.http host '127.0.0.1'`);
        await execAsync(`gsettings set org.gnome.system.proxy.http port ${HTTP_PROXY_PORT}`);
        await execAsync(`gsettings set org.gnome.system.proxy.https host '127.0.0.1'`);
        await execAsync(`gsettings set org.gnome.system.proxy.https port ${HTTP_PROXY_PORT}`);
        console.log('System proxy configured via gsettings');
        systemProxyEnabledByApp = true;
        systemProxyServiceName = 'gsettings';
        saveSettings({ systemProxyEnabledByApp, systemProxyServiceName });
        configured = true;
      } catch (err) {
        console.error('Failed to configure proxy via gsettings:', err.message);
        console.log('Note: System proxy configuration may require manual setup on Linux');
      }
    } else {
      console.error('Unsupported platform for proxy configuration');
    }
    
    // Verify proxy is actually enabled
    if (configured && platform === 'darwin') {
      try {
        const { stdout } = await execAsync('networksetup -listallnetworkservices');
        const services = stdout.split('\n').filter(line => line.trim() && !line.includes('*') && !line.includes('An asterisk'));
        const preferredInterfaces = ['Wi-Fi', 'Ethernet', 'USB 10/100/1000 LAN', 'Thunderbolt Bridge'];
        
        for (const preferred of preferredInterfaces) {
          const matching = services.find(s => s.includes(preferred) || s.toLowerCase().includes(preferred.toLowerCase()));
          if (matching) {
            try {
              const iface = matching.trim();
              const { stdout: proxyStatus } = await execAsync(`networksetup -getwebproxy "${iface}"`);
              if (proxyStatus.includes('Enabled: Yes')) {
                systemProxyConfigured = true;
                break;
              }
            } catch (err) {
              // Continue checking
            }
          }
        }
      } catch (err) {
        // If verification fails, assume it's configured if the command succeeded
        systemProxyConfigured = configured;
      }
    } else {
      systemProxyConfigured = configured;
    }
    
    if (systemProxyConfigured) {
      sendStatusUpdate();
      safeSend('slipstream-log', `System proxy configured and enabled successfully`);
    } else {
      safeSend('slipstream-error', `System proxy configuration failed. You may need admin privileges or configure manually: 127.0.0.1:${HTTP_PROXY_PORT}`);
    }
    return systemProxyConfigured;
  } catch (err) {
    console.error('Failed to configure system proxy:', err);
    systemProxyConfigured = false;
    return false;
  }
}

async function unconfigureSystemProxy() {
  const platform = process.platform;
  
  try {
    if (platform === 'darwin') {
      // macOS: Only disable proxies that match our 127.0.0.1:8080 config
      async function disableIfMatches(iface) {
        try {
          const [{ stdout: web }, { stdout: sec }] = await Promise.all([
            execAsync(`networksetup -getwebproxy "${iface}"`).catch(() => ({ stdout: '' })),
            execAsync(`networksetup -getsecurewebproxy "${iface}"`).catch(() => ({ stdout: '' }))
          ]);

          const matches =
            (web.includes('Enabled: Yes') && web.includes('127.0.0.1') && web.includes(String(HTTP_PROXY_PORT))) ||
            (sec.includes('Enabled: Yes') && sec.includes('127.0.0.1') && sec.includes(String(HTTP_PROXY_PORT)));

          if (!matches) return false;

          await execAsync(`networksetup -setwebproxystate "${iface}" off`).catch(() => {});
          await execAsync(`networksetup -setsecurewebproxystate "${iface}" off`).catch(() => {});
          console.log(`System proxy unconfigured via networksetup on ${iface}`);
          return true;
        } catch (_) {
          return false;
        }
      }

      let changed = false;
      // Prefer the service we configured earlier (safer)
      if (systemProxyServiceName) {
        changed = await disableIfMatches(systemProxyServiceName);
      }

      if (!changed) {
        // Fallback: scan services and disable only those matching our config
        try {
          const { stdout } = await execAsync('networksetup -listallnetworkservices');
          const services = stdout.split('\n').filter(line => line.trim() && !line.includes('*') && !line.includes('An asterisk'));
          for (const s of services) {
            const iface = s.trim();
            if (!iface) continue;
            const did = await disableIfMatches(iface);
            if (did) changed = true;
          }
        } catch (_) {
          // ignore
        }
      }

      systemProxyConfigured = false;
      if (changed) {
        systemProxyEnabledByApp = false;
        systemProxyServiceName = '';
        saveSettings({ systemProxyEnabledByApp, systemProxyServiceName });
      }
      sendStatusUpdate();
      return changed;
    } else if (platform === 'win32') {
      // Windows: netsh
      // Best-effort: only reset if it matches our localhost:8080 proxy
      try {
        const { stdout } = await execAsync('netsh winhttp show proxy');
        const matches =
          (stdout.includes('127.0.0.1:8080')) ||
          (stdout.includes('127.0.0.1') && stdout.includes(String(HTTP_PROXY_PORT)));
        if (!matches) {
          systemProxyConfigured = false;
          sendStatusUpdate();
          return false;
        }
      } catch (_) {
        // If we can't read status, but we think we enabled it, proceed.
        if (!systemProxyEnabledByApp) {
          systemProxyConfigured = false;
          sendStatusUpdate();
          return false;
        }
      }

      await execAsync('netsh winhttp reset proxy');
      console.log('System proxy unconfigured via netsh');
      systemProxyConfigured = false;
      systemProxyEnabledByApp = false;
      systemProxyServiceName = '';
      saveSettings({ systemProxyEnabledByApp, systemProxyServiceName });
      sendStatusUpdate();
      return true;
    } else if (platform === 'linux') {
      // Linux: gsettings (GNOME)
      try {
        // Best-effort: only disable if it matches our localhost:8080 proxy
        let matches = false;
        try {
          const [{ stdout: mode }, { stdout: httpHost }, { stdout: httpPort }, { stdout: httpsHost }, { stdout: httpsPort }] =
            await Promise.all([
              execAsync(`gsettings get org.gnome.system.proxy mode`).catch(() => ({ stdout: '' })),
              execAsync(`gsettings get org.gnome.system.proxy.http host`).catch(() => ({ stdout: '' })),
              execAsync(`gsettings get org.gnome.system.proxy.http port`).catch(() => ({ stdout: '' })),
              execAsync(`gsettings get org.gnome.system.proxy.https host`).catch(() => ({ stdout: '' })),
              execAsync(`gsettings get org.gnome.system.proxy.https port`).catch(() => ({ stdout: '' }))
            ]);

          const m = String(mode || '');
          const hh = String(httpHost || '');
          const hp = String(httpPort || '');
          const sh = String(httpsHost || '');
          const sp = String(httpsPort || '');

          const portStr = String(HTTP_PROXY_PORT);
          matches =
            m.includes('manual') &&
            (
              (hh.includes('127.0.0.1') && hp.includes(portStr)) ||
              (sh.includes('127.0.0.1') && sp.includes(portStr))
            );
        } catch (_) {
          matches = false;
        }

        if (!matches && !systemProxyEnabledByApp) {
          systemProxyConfigured = false;
          sendStatusUpdate();
          return false;
        }

        await execAsync(`gsettings set org.gnome.system.proxy mode 'none'`);
        console.log('System proxy unconfigured via gsettings');
        systemProxyConfigured = false;
        systemProxyEnabledByApp = false;
        systemProxyServiceName = '';
        saveSettings({ systemProxyEnabledByApp, systemProxyServiceName });
        sendStatusUpdate();
        return true;
      } catch (err) {
        console.error('Failed to unconfigure proxy via gsettings:', err);
        systemProxyConfigured = false;
        sendStatusUpdate();
        return false;
      }
    } else {
      console.error('Unsupported platform for proxy configuration');
      systemProxyConfigured = false;
      sendStatusUpdate();
      return false;
    }
  } catch (err) {
    console.error('Failed to unconfigure system proxy:', err);
    systemProxyConfigured = false;
    sendStatusUpdate();
    return false;
  }
}

async function startService(resolver, domain, tunMode = false) {
  if (isRunning) {
    return { success: false, message: 'Service is already running' };
  }

  // Always use HTTP Proxy mode - TUN mode removed for simplicity
  useTunMode = false;

  try {
    // Save settings
    if (resolver && domain) {
      saveSettings({ resolver, domain, mode: useTunMode ? 'tun' : 'proxy' });
    } else {
      resolver = RESOLVER;
      domain = DOMAIN;
    }

    // Start Slipstream client (always needed)
    await startSlipstreamClient(resolver, domain);
    
    if (useTunMode) {
      // TUN mode - true system-wide VPN
      try {
        tunManager = require('./tun-manager');
        const tunResult = await tunManager.startTunMode();
        
        if (!tunResult.success) {
          throw new Error(tunResult.message);
        }
        
        isRunning = true;
        sendStatusUpdate();
        
        safeSend('slipstream-log', 'TUN mode: HTTP Proxy is not used (TUN provides system-wide tunneling)');
        
        return {
          success: true,
          message: tunResult.message,
          details: {
            slipstreamRunning: slipstreamProcess !== null && !slipstreamProcess.killed,
            tunRunning: true,
            proxyRunning: false,
            systemProxyConfigured: false,
            mode: 'TUN'
          }
        };
      } catch (err) {
        console.error('TUN mode failed:', err);
        safeSend('slipstream-error', `TUN mode failed: ${err.message}. Falling back to HTTP Proxy mode.`);
        // Fallback to HTTP proxy mode
        useTunMode = false;
        // Stop Slipstream if it was started
        if (slipstreamProcess) {
          slipstreamProcess.kill();
          slipstreamProcess = null;
        }
        return await startService(resolver, domain, false);
      }
    } else {
      // HTTP proxy mode
      await startHttpProxy();
      
      // HTTP proxy is listening - system proxy configuration is optional
      // Check if user wants system proxy configured (from settings or toggle)
      
      safeSend('slipstream-log', 'HTTP Proxy mode: TUN Interface is not used (only needed for TUN mode)');
      
      isRunning = true;
      sendStatusUpdate();
      
      return { 
        success: true, 
        message: 'Service started successfully. HTTP proxy is listening on 127.0.0.1:8080',
        details: {
          slipstreamRunning: slipstreamProcess !== null && !slipstreamProcess.killed,
          proxyRunning: true,
          tunRunning: false,
          systemProxyConfigured: systemProxyConfigured,
          mode: 'HTTP Proxy'
        }
      };
    }
  } catch (err) {
    stopService();
    return { success: false, message: err.message, details: getStatusDetails() };
  }
}

function getStatusDetails() {
  let tunStatus = { tunRunning: false };
  if (tunManager) {
    try {
      tunStatus = tunManager.getTunStatus();
    } catch (err) {
      console.error('Error getting TUN status:', err);
    }
  }
  
  const currentMode = useTunMode ? 'TUN' : 'HTTP Proxy';
  
  return {
    slipstreamRunning: slipstreamProcess !== null && !slipstreamProcess.killed,
    proxyRunning: httpProxyServer !== null,
    tunRunning: tunStatus.tunRunning || false,
    systemProxyConfigured: systemProxyConfigured,
    mode: currentMode
  };
}

function stopService() {
  isRunning = false;
  
  // Stop TUN mode if active
  if (useTunMode && tunManager) {
    try {
      tunManager.stopTunMode();
    } catch (err) {
      console.error('Error stopping TUN mode:', err);
    }
    tunManager = null;
  }
  
  // Stop HTTP proxy
  if (httpProxyServer) {
    httpProxyServer.close();
    httpProxyServer = null;
  }
  
  // Stop Slipstream client
  if (slipstreamProcess) {
    slipstreamProcess.kill();
    slipstreamProcess = null;
  }
  
  // Note: We don't auto-configure system proxy, so no need to unconfigure
  // If user manually configured it, they can manually unconfigure it
  
  useTunMode = false;
  sendStatusUpdate();
  
  return { 
    success: true, 
    message: 'Service stopped',
    details: getStatusDetails()
  };
}

async function cleanupAndDisableProxyIfNeeded(reason = 'shutdown') {
  if (cleanupInProgress) return;
  cleanupInProgress = true;

  try {
    // Always stop local services first (best effort, sync)
    try { stopService(); } catch (_) {}

    // If THIS app enabled the system proxy, disable it on exit/crash.
    if (systemProxyEnabledByApp) {
      const timeoutMs = 8000;
      const started = Date.now();
      try {
        await Promise.race([
          unconfigureSystemProxy(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup timeout')), timeoutMs))
        ]);
      } catch (err) {
        console.error(`Cleanup: failed to unconfigure system proxy (${reason}) after ${Date.now() - started}ms:`, err?.message || err);
      }
    }
  } finally {
    cleanupInProgress = false;
  }
}

app.whenReady().then(async () => {
  // Load settings after Electron is ready. On some platforms (notably Windows),
  // calling app.getPath('userData') too early can fail and cause settings to not persist.
  try {
    ensureSettingsFilePath();
    loadSettings();
  } catch (err) {
    console.error('Failed to initialize settings on ready:', err);
  }

  // Crash-recovery: if we previously enabled system proxy and the app died,
  // attempt to restore the user's system on next start.
  if (systemProxyEnabledByApp) {
    try {
      await cleanupAndDisableProxyIfNeeded('startup-recovery');
    } catch (_) {}
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Ensure system proxy is turned off if we enabled it.
    cleanupAndDisableProxyIfNeeded('window-all-closed').finally(() => {
      quitting = true;
      app.quit();
    });
  }
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  cleanupAndDisableProxyIfNeeded('before-quit').finally(() => {
    quitting = true;
    app.quit();
  });
});

// IPC handlers
ipcMain.handle('start-service', async (event, settings) => {
  return await startService(settings?.resolver, settings?.domain, settings?.tunMode || false);
});

ipcMain.handle('stop-service', async () => {
  // Stop VPN and also turn off system proxy if we enabled it.
  await cleanupAndDisableProxyIfNeeded('user-stop');
  return { success: true, message: 'Service stopped', details: getStatusDetails() };
});

ipcMain.handle('get-status', () => {
  return { 
    isRunning,
    details: getStatusDetails()
  };
});

ipcMain.handle('get-settings', () => {
  return {
    resolver: RESOLVER,
    domain: DOMAIN,
    mode: useTunMode ? 'tun' : 'proxy',
    verbose: verboseLogging,
    socks5AuthEnabled,
    socks5AuthUsername,
    socks5AuthPassword,
    systemProxyEnabledByApp,
    systemProxyServiceName
  };
});

ipcMain.handle('set-resolver', (event, payload) => {
  try {
    const parsed = parseDnsServer(payload?.resolver);
    if (!parsed) {
      return { success: false, error: 'Invalid DNS resolver. Use IPv4:port (e.g. 1.1.1.1:53).' };
    }

    // Force port 53 (DNS Checker "Use" button behavior)
    const normalized = `${parsed.ip}:53`;
    saveSettings({ resolver: normalized });
    return { success: true, resolver: normalized };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('get-version', () => {
  const packageJson = require('./package.json');
  return packageJson.version;
});

ipcMain.handle('check-update', async () => {
  try {
    const https = require('https');
    const packageJson = require('./package.json');
    const currentVersion = packageJson.version;
    
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: '/repos/mirzaaghazadeh/SlipStreamGUI/releases/latest',
        method: 'GET',
        headers: {
          'User-Agent': 'SlipStream-GUI',
          'Accept': 'application/vnd.github.v3+json'
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const release = JSON.parse(data);
              const latestVersion = release.tag_name.replace(/^v/, ''); // Remove 'v' prefix if present
              
              // Compare versions (simple string comparison works for semantic versioning)
              const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
              
              resolve({
                success: true,
                hasUpdate: hasUpdate,
                currentVersion: currentVersion,
                latestVersion: latestVersion,
                releaseUrl: release.html_url,
                releaseNotes: release.body || ''
              });
            } else {
              resolve({
                success: false,
                error: `GitHub API returned status ${res.statusCode}`
              });
            }
          } catch (err) {
            resolve({
              success: false,
              error: `Failed to parse response: ${err.message}`
            });
          }
        });
      });
      
      req.on('error', (err) => {
        resolve({
          success: false,
          error: err.message
        });
      });
      
      req.setTimeout(10000, () => {
        req.destroy();
        resolve({
          success: false,
          error: 'Request timeout'
        });
      });
      
      req.end();
    });
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
});

// SemVer-ish comparison that safely handles prerelease strings like "1.0.52-beta".
// Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
function compareVersions(v1, v2) {
  function normalize(v) {
    const raw = String(v || '').trim().replace(/^v/i, '');
    // Drop build metadata
    const noBuild = raw.split('+')[0];
    const [core, prereleaseRaw] = noBuild.split('-', 2);
    const nums = core
      .split('.')
      .slice(0, 3)
      .map((p) => {
        // Take numeric prefix (e.g. "52-beta" -> 52). NaN becomes 0.
        const m = String(p || '').match(/^(\d+)/);
        return m ? Number(m[1]) : 0;
      });
    while (nums.length < 3) nums.push(0);
    const prerelease = prereleaseRaw ? prereleaseRaw.split('.').filter(Boolean) : null;
    return { nums, prerelease };
  }

  function compareIdentifiers(a, b) {
    const an = /^\d+$/.test(a);
    const bn = /^\d+$/.test(b);
    if (an && bn) {
      const ai = Number(a);
      const bi = Number(b);
      if (ai > bi) return 1;
      if (ai < bi) return -1;
      return 0;
    }
    // Numeric identifiers have lower precedence than non-numeric
    if (an && !bn) return -1;
    if (!an && bn) return 1;
    // Both non-numeric: lexicographic
    if (a > b) return 1;
    if (a < b) return -1;
    return 0;
  }

  const A = normalize(v1);
  const B = normalize(v2);

  for (let i = 0; i < 3; i++) {
    if (A.nums[i] > B.nums[i]) return 1;
    if (A.nums[i] < B.nums[i]) return -1;
  }

  // If core is equal: release > prerelease
  if (!A.prerelease && !B.prerelease) return 0;
  if (!A.prerelease && B.prerelease) return 1;
  if (A.prerelease && !B.prerelease) return -1;

  // Both prerelease: compare identifiers
  const len = Math.max(A.prerelease.length, B.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = A.prerelease[i];
    const bi = B.prerelease[i];
    if (ai === undefined) return -1; // shorter prerelease has lower precedence
    if (bi === undefined) return 1;
    const c = compareIdentifiers(ai, bi);
    if (c !== 0) return c;
  }
  return 0;
}

ipcMain.handle('set-verbose', (event, verbose) => {
  verboseLogging = verbose;
  saveSettings({ verbose });
  return { success: true, verbose: verboseLogging };
});

ipcMain.handle('set-socks5-auth', (event, auth) => {
  const enabled = !!auth?.enabled;
  const username = typeof auth?.username === 'string' ? auth.username : socks5AuthUsername;
  const password = typeof auth?.password === 'string' ? auth.password : socks5AuthPassword;

  saveSettings({
    socks5AuthEnabled: enabled,
    socks5AuthUsername: username,
    socks5AuthPassword: password
  });

  return {
    success: true,
    socks5AuthEnabled,
    socks5AuthUsername,
    socks5AuthPassword
  };
});

ipcMain.handle('check-system-proxy', async () => {
  const { checkSystemProxyStatus } = require('./check-system-proxy');
  const isConfigured = await checkSystemProxyStatus();
  systemProxyConfigured = isConfigured;
  return { configured: isConfigured };
});

ipcMain.handle('toggle-system-proxy', async (event, enable) => {
  if (enable) {
    const configured = await configureSystemProxy();
    // Update status after configuration
    sendStatusUpdate();
    return { success: configured, configured: systemProxyConfigured };
  } else {
    const unconfigured = await unconfigureSystemProxy();
    // Update status after unconfiguration
    sendStatusUpdate();
    return { success: unconfigured, configured: systemProxyConfigured };
  }
});

// Best-effort cleanup for crashes/termination signals.
function installProcessExitHandlers() {
  const doExit = async (code, reason) => {
    try { await cleanupAndDisableProxyIfNeeded(reason); } catch (_) {}
    try { process.exit(code); } catch (_) {}
  };

  process.on('SIGINT', () => { void doExit(130, 'SIGINT'); });
  process.on('SIGTERM', () => { void doExit(143, 'SIGTERM'); });
  process.on('SIGHUP', () => { void doExit(129, 'SIGHUP'); });

  process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err);
    void doExit(1, 'uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason);
    void doExit(1, 'unhandledRejection');
  });
}

installProcessExitHandlers();

ipcMain.handle('open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    console.error('Failed to open external URL:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('test-proxy', async () => {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const http = require('http');

    const options = {
      hostname: '127.0.0.1',
      port: HTTP_PROXY_PORT,
      path: 'http://httpbin.org/ip',
      method: 'GET',
      headers: {
        'Host': 'httpbin.org'
      },
      timeout: 10000
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        const responseTime = Date.now() - startTime;
        const status = Number(res.statusCode) || 0;

        if (status < 200 || status >= 300) {
          resolve({
            success: false,
            error: `Proxy returned HTTP ${status}${data ? `: ${String(data).slice(0, 200)}` : ''}`,
            responseTime
          });
          return;
        }

        try {
          const json = JSON.parse(data);
          resolve({
            success: true,
            ip: json.origin || 'Unknown',
            responseTime
          });
        } catch (err) {
          resolve({
            success: false,
            error: `Invalid response from proxy (not JSON). ${String(err?.message || err)}`,
            responseTime,
            raw: String(data).slice(0, 200)
          });
        }
      });
    });
    
    req.on('error', (err) => {
      resolve({
        success: false,
        error: err.message
      });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        error: 'Request timeout'
      });
    });
    
    req.end();
  });
});

function parseDnsServer(server) {
  const raw = String(server || '').trim();
  if (!raw) return null;

  // Accept IPv4 with optional port (e.g. "1.1.1.1" or "1.1.1.1:53")
  const m = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/);
  if (!m) return null;

  const ip = m[1];
  const port = m[2] ? Number(m[2]) : 53;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;

  return { ip, port, serverForNode: `${ip}:${port}` };
}

async function pingHost(ip, timeoutMs = 2000) {
  const platform = process.platform;
  const timeout = Math.max(250, Number(timeoutMs) || 2000);

  let args = [];
  if (platform === 'win32') {
    // ping -n 1 -w <ms>
    args = ['-n', '1', '-w', String(timeout), ip];
  } else if (platform === 'darwin') {
    // ping -c 1 -W <ms>
    args = ['-c', '1', '-W', String(timeout), ip];
  } else {
    // linux: ping -c 1 -W <seconds>
    args = ['-c', '1', '-W', String(Math.ceil(timeout / 1000)), ip];
  }

  const start = Date.now();
  return await new Promise((resolve) => {
    const child = spawn('ping', args, { stdio: 'ignore' });
    let settled = false;

    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ ok, timeMs: Date.now() - start });
    };

    const killTimer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      done(false);
    }, timeout + 1500);

    child.on('error', () => {
      clearTimeout(killTimer);
      done(false);
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      done(code === 0);
    });
  });
}

function withTimeout(promise, timeoutMs, errorMessage) {
  const timeout = Math.max(250, Number(timeoutMs) || 2500);
  let t = null;
  const timeoutPromise = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(errorMessage || 'Timeout')), timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (t) clearTimeout(t);
  });
}

async function dnsResolveWithServer(serverForNode, domain, timeoutMs = 2500) {
  const resolver = new dns.promises.Resolver();
  resolver.setServers([serverForNode]);

  const start = Date.now();
  try {
    const answers = await withTimeout(
      resolver.resolve4(domain),
      timeoutMs,
      'DNS resolve timeout'
    );
    return { ok: true, timeMs: Date.now() - start, answers };
  } catch (err) {
    // Try AAAA as fallback (some domains may be IPv6-only)
    try {
      const answers = await withTimeout(
        resolver.resolve6(domain),
        timeoutMs,
        'DNS resolve timeout'
      );
      return { ok: true, timeMs: Date.now() - start, answers };
    } catch (err2) {
      return { ok: false, timeMs: Date.now() - start, answers: [], error: err2?.message || String(err2) };
    }
  }
}

ipcMain.handle('dns-check-single', async (event, payload) => {
  try {
    const serverParsed = parseDnsServer(payload?.server);
    const domain = String(payload?.domain || '').trim();
    const pingTimeoutMs = Number(payload?.pingTimeoutMs) || 2000;
    const dnsTimeoutMs = Number(payload?.dnsTimeoutMs) || 2500;

    if (!serverParsed) {
      return { ok: false, error: 'Invalid DNS server. Use IPv4 or IPv4:port (e.g. 1.1.1.1 or 1.1.1.1:53).' };
    }
    if (!domain) {
      return { ok: false, error: 'Test domain is required (e.g. google.com).' };
    }

    const ping = await pingHost(serverParsed.ip, pingTimeoutMs);
    const dnsRes = ping.ok
      ? await dnsResolveWithServer(serverParsed.serverForNode, domain, dnsTimeoutMs)
      : { ok: false, timeMs: 0, answers: [], error: 'Ping failed' };

    let status = 'Unreachable';
    if (ping.ok && dnsRes.ok) status = 'OK';
    else if (ping.ok) status = 'Ping Only';

    return {
      ok: true,
      server: serverParsed.serverForNode,
      ip: serverParsed.ip,
      port: serverParsed.port,
      domain,
      ping,
      dns: dnsRes,
      status
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
