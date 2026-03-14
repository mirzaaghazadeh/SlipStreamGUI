# Simple English Guide

<div align="center">
  <strong>SlipStream GUI User Guide</strong><br>
  A simple GUI for connecting to SlipStream VPN
</div>

---

## 👀 Quick Tour

- **Download & install** the app from the Releases page
- **Set your server** (`Domain`) and **DNS Resolver** (if needed)
- **DNS Checker (optional)**: run it, and click **"Use"** on any **OK** row to set your `DNS Resolver`
- **FindNS Scanner (advanced)**: use the **FindNS** button in the header to scan public DNS resolvers for tunnels and apply the best result as your `DNS Resolver`
- **Save as Preset**: save your configuration as a named preset for quick switching later
- **Start VPN** with the **"Start VPN"** button and make sure statuses show **Running**
- **Verify** with **"Test Proxy Connection"** and check Logs if needed
- **Switch theme**: toggle between light and dark mode with the theme button in the header
- **Optional**: Share your VPN over Wi‑Fi to your phone using the built-in HTTP proxy (`8080`)

---

## 📥 Install & Setup

### Download & Install

1. Go to the latest release on GitHub:
   - [Releases (latest)](https://github.com/mirzaaghazadeh/SlipStreamGUI/releases/latest)
2. Direct downloads (latest release):

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | [SlipStream-GUI-macOS-ARM64.dmg](https://github.com/mirzaaghazadeh/SlipStreamGUI/releases/latest/download/SlipStream-GUI-macOS-ARM64.dmg) |
| macOS (Intel) | [SlipStream-GUI-macOS-Intel.dmg](https://github.com/mirzaaghazadeh/SlipStreamGUI/releases/latest/download/SlipStream-GUI-macOS-Intel.dmg) |
| Windows (64-bit) | [SlipStream-GUI-Windows-x64.exe](https://github.com/mirzaaghazadeh/SlipStreamGUI/releases/latest/download/SlipStream-GUI-Windows-x64.exe) |
| Windows (32-bit) | [SlipStream-GUI-Windows-x86.exe](https://github.com/mirzaaghazadeh/SlipStreamGUI/releases/latest/download/SlipStream-GUI-Windows-x86.exe) |
| Linux (x86_64) AppImage | [SlipStream-GUI-Linux-x64.AppImage](https://github.com/mirzaaghazadeh/SlipStreamGUI/releases/latest/download/SlipStream-GUI-Linux-x64.AppImage) |
| Linux (x86_64) DEB | [SlipStream-GUI-Linux-x64.deb](https://github.com/mirzaaghazadeh/SlipStreamGUI/releases/latest/download/SlipStream-GUI-Linux-x64.deb) |

If a direct download fails, use the [Releases page](https://github.com/mirzaaghazadeh/SlipStreamGUI/releases/latest).

### First Run

1. Open **SlipStream GUI**
2. (Optional) Configure:
   - **Connection Type**: keep **SlipStream** (default) for normal mode, or choose **SlipNet (NoizDNS)** if your server gives you a `slipnet://...` URL
   - **DNS Resolver**: your DNS server (default: `8.8.8.8:53`)
   - **Domain**: your SlipStream server domain (default: `s.example.com`)
   - **System Proxy**: enable auto system proxy configuration (recommended)
3. Click **"Start VPN"**
4. Wait until statuses show **Running**
5. Your internet traffic is now routed through SlipStream.

### 🔎 DNS Checker (optional)

If you’re not sure which DNS Resolver to use (or DNS hasn’t fully propagated yet), use **DNS Checker**:

1. Click **"DNS Checker"**
2. Enter a **test domain** (example: `google.com`)
3. Enter one or more **DNS server IPs** to test
4. Read the results:
   - **OK means OK** (no action needed)
   - The **"Use"** button is enabled only for **OK** rows
5. Click **"Use"** to auto-set your **DNS Resolver** (the app forces port `53`)

---

## 🛰️ NoizDNS / SlipNet Mode (Optional)

If your server admin gives you a `slipnet://...` URL (from NoizDNS / SlipNet), you can use the alternative **SlipNet (NoizDNS)** connection mode:

1. In **Configuration → Connection Type**, choose **SlipNet (NoizDNS)** instead of **SlipStream**
2. Paste your `slipnet://BASE64...` URL into **SlipNet URL**
3. (Optional) Set **DNS Server** for SlipNet lookups (for example a tunnel‑friendly resolver)
4. Click **Start VPN** – the rest of the flow is the same as normal mode

If you are not sure what NoizDNS/SlipNet is, just leave **Connection Type** on **SlipStream**.

---

## 🔍 FindNS Scanner (Advanced)

**FindNS** is a built‑in scanner that helps you find good DNS resolvers for tunnels. It fetches resolver lists automatically from `SamNet-dev/findns`, so manual resolver downloads are not required:

1. Click **FindNS** in the header
2. (Optional) Enter a **Tunnel Domain** (for example `t.example.com`) to enable tunnel/EDNS/e2e checks
3. Choose options:
   - **Include local resolvers**: add a large public resolver list
   - **DoH mode**: test DNS‑over‑HTTPS resolvers
   - **Skip ping** / **Skip NXDOMAIN check** if needed
4. Click **Scan** and wait for results
5. In the results table, click **Use** on any row to set that resolver as your `DNS Resolver` in the main screen

---

## 🖥️ SlipStream Server Setup

To use SlipStream GUI, you need a SlipStream server. You can deploy your own server or use an existing one.

### Simple server install (one command)

```bash
bash <(curl -Ls https://raw.githubusercontent.com/AliRezaBeigy/slipstream-rust-deploy/master/slipstream-rust-deploy.sh)
```

### Server prerequisites

- A Linux server (Fedora, Rocky, CentOS, Debian, or Ubuntu)
- A domain name with DNS access
- Root or sudo access on the server

### After server setup

1. Configure your DNS records (see [slipstream-rust-deploy](https://github.com/AliRezaBeigy/slipstream-rust-deploy))
2. Wait for DNS propagation (can take up to 24 hours)
3. In SlipStream GUI, enter your domain (example: `s.example.com`)
4. Enter your DNS resolver (example: `YOUR_SERVER_IP:53`)
5. Click **"Start VPN"**

---

## 📱 Share PC Internet to Mobile (Same Wi‑Fi)

If your PC and phone are on the same Wi‑Fi network, you can configure your phone to use your PC’s internet (including the VPN) via the built-in HTTP proxy.

### Prerequisites

- PC and phone must be on the same Wi‑Fi network
- SlipStream GUI must be running with VPN started
- You need your PC’s local IP address

### Find your PC’s local IP

**macOS/Linux:**

```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
# or
ip addr show
```

**Windows:**

```cmd
ipconfig
```

Your IP will usually look like `192.168.1.XXX` or `10.0.0.XXX`.

### iOS (iPhone/iPad)

1. **Settings** → **Wi‑Fi**
2. Tap **(i)** next to your connected network
3. Scroll to **HTTP Proxy**
4. Select **Manual**
5. Set **Server** = your PC IP (example: `192.168.1.100`)
6. Set **Port** = `8080`
7. Leave **Authentication** off
8. Tap **Save**

To disable later: set **HTTP Proxy** back to **Off**.

### Android

1. **Settings** → **Wi‑Fi**
2. Long-press your connected network
3. Select **Modify network** / **Network details**
4. Open **Advanced options**
5. Set **Proxy** = **Manual**
6. **Proxy hostname** = your PC IP (example: `192.168.1.100`)
7. **Proxy port** = `8080`
8. Tap **Save**

To disable later: set Proxy back to **None**.

### ⚠️ Important notes

- Ensure your firewall allows inbound connections on port `8080`
- This only works while both devices are on the same network
- If your PC IP changes, update the phone proxy settings
- Some apps may ignore system proxy settings and need per-app configuration

---

## 🎨 New: Redesigned Interface

The app features a modern, professional redesign:

- **Light & Dark Theme**: switch between light and dark mode using the theme toggle button in the header. Your preference is saved automatically.
- **Presets (Workspaces)**: save multiple configurations (resolver, domain, bypass list) as named presets. Quickly switch between them with a single click. Create, rename, and delete presets from the preset bar above the action buttons.
- **Polished UI**: sidebar-style layout, status cards with animated indicators, SVG icons on buttons, and smooth transitions throughout.

### Using Presets

1. Click the **"+"** button in the Presets bar
2. Enter a name for your preset (e.g., "Home", "Work", "Cafe")
3. The current settings (resolver, domain, bypass list) are saved to the preset
4. Click any preset tab to switch configurations instantly
5. Use the pencil icon to rename or the trash icon to delete the active preset
6. Changes to settings are auto-saved to the active preset

---

## 🎯 Using the VPN

### Status panel

- Watch live connection status
- Check the 3 indicators:
  - **SlipStream Client**
  - **HTTP Proxy**
  - **System Proxy**

### Logs panel

- View connection activity and debug info
- Enable **Verbose Logging** for more details

### Test connection

- Use **"Test Proxy Connection"** to verify the proxy is working

### Stop VPN

- Click **"Stop VPN"** to disconnect
- System proxy should be disabled automatically

---

## ❓ FAQ

### macOS: app shows “damaged”

This is usually Gatekeeper quarantine. Fix:

```bash
xattr -cr /Applications/SlipStream\ GUI.app
```

### VPN won’t start

- Check ports `8080` and `5201` are not in use
- Verify `DNS Resolver` and `Domain`
- Check Logs for errors
- On Windows, run as Administrator

### System proxy not working

- Make sure “Configure System Proxy” is enabled
- On macOS, you may be asked for admin password
- On Windows, run as Administrator
- Some apps may bypass system proxy

---

<div align="center">
  <strong>Made for those we remember</strong>
</div>
