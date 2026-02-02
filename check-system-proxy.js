// Helper function to check if system proxy is configured
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function checkSystemProxyStatus() {
  const platform = process.platform;
  
  try {
    if (platform === 'darwin') {
      // macOS: Check if proxy is enabled on any interface
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
              if (proxyStatus.includes('Enabled: Yes') && proxyStatus.includes('127.0.0.1') && proxyStatus.includes('8080')) {
                return true;
              }
            } catch (err) {
              continue;
            }
          }
        }
        
        // Check first available interface
        if (services.length > 0) {
          try {
            const iface = services[0].trim();
            const { stdout: proxyStatus } = await execAsync(`networksetup -getwebproxy "${iface}"`);
            if (proxyStatus.includes('Enabled: Yes') && proxyStatus.includes('127.0.0.1') && proxyStatus.includes('8080')) {
              return true;
            }
          } catch (err) {
            // Ignore
          }
        }
      } catch (err) {
        return false;
      }
    } else if (platform === 'win32') {
      // Windows: Check both WinHTTP (netsh) and WinINET (HKCU Internet Settings)
      try {
        const { stdout } = await execAsync('netsh winhttp show proxy');
        if (stdout.includes('127.0.0.1:8080') || stdout.includes('127.0.0.1') && stdout.includes('8080')) {
          return true;
        }
      } catch (err) {
        // ignore and fall through to WinINET check
      }

      try {
        const { stdout } = await execAsync(
          `powershell -NoProfile -Command "$p='HKCU:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Internet Settings'; ` +
          `$v=Get-ItemProperty -Path $p -ErrorAction Stop; ` +
          `$o=[PSCustomObject]@{ProxyEnable=$v.ProxyEnable;ProxyServer=$v.ProxyServer}; $o|ConvertTo-Json -Compress"`
        );
        const cur = JSON.parse(String(stdout || '').trim() || '{}');
        const curServer = typeof cur.ProxyServer === 'string' ? cur.ProxyServer : '';
        const enabled = cur.ProxyEnable === 1;
        if (enabled && (curServer.includes('127.0.0.1:8080') || (curServer.includes('127.0.0.1') && curServer.includes('8080')))) {
          return true;
        }
      } catch (err) {
        // ignore
      }
    }
    
    return false;
  } catch (err) {
    return false;
  }
}

module.exports = { checkSystemProxyStatus };
