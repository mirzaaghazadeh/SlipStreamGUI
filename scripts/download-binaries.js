#!/usr/bin/env node
/**
 * Download latest SlipStream client binaries from:
 *   https://github.com/mirzaaghazadeh/slipstream-rust-deploy/releases/latest
 *
 * Usage:
 *   node scripts/download-binaries.js
 *   node scripts/download-binaries.js --platform mac --arch arm64
 *   node scripts/download-binaries.js --platform mac --arch x64
 *   node scripts/download-binaries.js --platform win
 *   node scripts/download-binaries.js --platform linux
 *
 * Notes:
 * - Writes into ./binaries/
 * - Overwrites existing files
 * - Uses GitHub API; optionally set GH_TOKEN to avoid rate limits
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const UPSTREAM_REPO = 'mirzaaghazadeh/slipstream-rust-deploy';
const API_LATEST = `https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`;

const SLIPNET_REPO = 'mirzaaghazadeh/SlipNet';
const SLIPNET_API_LATEST = `https://api.github.com/repos/${SLIPNET_REPO}/releases/latest`;

function parseArgs(argv) {
  const args = { platform: 'all', arch: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform' && argv[i + 1]) {
      args.platform = String(argv[i + 1]).toLowerCase();
      i++;
    } else if (a === '--arch' && argv[i + 1]) {
      args.arch = String(argv[i + 1]).toLowerCase();
      i++;
    }
  }
  return args;
}

function headers() {
  const h = {
    'User-Agent': 'SlipStreamGUI-binary-downloader',
    Accept: 'application/vnd.github+json'
  };
  if (process.env.GH_TOKEN) h.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  return h;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
  return await res.json();
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url, {
    headers: {
      ...headers(),
      // Some GH endpoints respond better with a generic accept here.
      Accept: 'application/octet-stream'
    },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  if (!res.body) throw new Error(`No response body for ${url}`);

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  const tmp = `${destPath}.tmp`;
  const fileStream = fs.createWriteStream(tmp);
  await pipeline(Readable.fromWeb(res.body), fileStream);
  await fs.promises.rename(tmp, destPath);
}

function wantTargets(platform, arch) {
  const p = platform || 'all';
  const a = (arch || '').toLowerCase();

  const targets = [];
  if (p === 'mac') {
    if (a === 'arm64' || a === 'aarch64') targets.push('mac-arm64');
    else if (a === 'x64' || a === 'amd64' || a === 'intel' || a === 'x86_64') targets.push('mac-intel');
    else targets.push('mac-arm64', 'mac-intel');
  } else if (p === 'win') targets.push('win');
  else if (p === 'linux') targets.push('linux');
  else if (p === 'all') targets.push('mac-arm64', 'mac-intel', 'linux', 'win');
  else throw new Error(`Unknown --platform value: ${String(platform)}`);

  return targets;
}

function mappingForTarget(t) {
  switch (t) {
    case 'mac-arm64':
      return { assetName: 'slipstream-client-darwin-arm64', outName: 'slipstream-client-mac-arm64' };
    case 'mac-intel':
      return { assetName: 'slipstream-client-darwin-amd64', outName: 'slipstream-client-mac-intel' };
    case 'linux':
      return { assetName: 'slipstream-client-linux-amd64', outName: 'slipstream-client-linux' };
    case 'win':
      return { assetName: 'slipstream-client-windows-amd64.exe', outName: 'slipstream-client-win.exe' };
    default:
      throw new Error(`Unknown target: ${t}`);
  }
}

async function main() {
  const { platform, arch } = parseArgs(process.argv);
  const release = await fetchJson(API_LATEST);

  const tag = release?.tag_name || 'latest';
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  if (!assets.length) throw new Error(`No assets found in ${UPSTREAM_REPO} release (${tag})`);

  const outDir = path.resolve(process.cwd(), 'binaries');
  await fs.promises.mkdir(outDir, { recursive: true });

  const targets = wantTargets(platform, arch);
  for (const t of targets) {
    const { assetName, outName } = mappingForTarget(t);
    const asset = assets.find((a) => a && a.name === assetName);
    if (!asset || !asset.browser_download_url) {
      throw new Error(`Missing asset "${assetName}" in ${UPSTREAM_REPO} release (${tag})`);
    }

    const dest = path.join(outDir, outName);
    // eslint-disable-next-line no-console
    console.log(`⬇️  ${assetName} -> binaries/${outName} (release: ${tag})`);
    await downloadToFile(asset.browser_download_url, dest);
  }

  // --- Download SlipNet binaries ---
  // eslint-disable-next-line no-console
  console.log('\n📦 Downloading SlipNet (NoizDNS) binaries...');

  let slipnetRelease;
  try {
    slipnetRelease = await fetchJson(SLIPNET_API_LATEST);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`⚠️  Could not fetch SlipNet release: ${err?.message || err}. Skipping SlipNet binaries.`);
    // eslint-disable-next-line no-console
    console.log('✅ Done. SlipStream binaries are in ./binaries/');
    return;
  }

  const slipnetTag = slipnetRelease?.tag_name || 'latest';
  const slipnetAssets = Array.isArray(slipnetRelease?.assets) ? slipnetRelease.assets : [];

  const slipnetMappings = {
    'mac-arm64': { assetName: 'slipnet-darwin-arm64', outName: 'slipnet-darwin-arm64' },
    'mac-intel': { assetName: 'slipnet-darwin-amd64', outName: 'slipnet-darwin-amd64' },
    'linux':     { assetName: 'slipnet-linux-amd64',  outName: 'slipnet-linux-amd64' },
    'win':       { assetName: 'slipnet-windows-amd64.exe', outName: 'slipnet-windows-amd64.exe' }
  };

  for (const t of targets) {
    const mapping = slipnetMappings[t];
    if (!mapping) continue;
    const asset = slipnetAssets.find((a) => a && a.name === mapping.assetName);
    if (!asset || !asset.browser_download_url) {
      // eslint-disable-next-line no-console
      console.warn(`⚠️  Missing SlipNet asset "${mapping.assetName}" in ${SLIPNET_REPO} release (${slipnetTag}). Skipping.`);
      continue;
    }
    const dest = path.join(outDir, mapping.outName);
    // eslint-disable-next-line no-console
    console.log(`⬇️  ${mapping.assetName} -> binaries/${mapping.outName} (release: ${slipnetTag})`);
    await downloadToFile(asset.browser_download_url, dest);
  }

  // eslint-disable-next-line no-console
  console.log('✅ Done. All binaries are in ./binaries/');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`❌ Failed to download binaries:\n${err?.message || String(err)}`);
  process.exit(1);
});

