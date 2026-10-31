/**
 * 打包两种发行版：
 *   node scripts/build.mjs          → 默认包（端口 17901/17902）
 *   node scripts/build.mjs alt      → Alt 包（端口 17911/17912，可并存）
 *   node scripts/build.mjs all      → 两个都打
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const flavorPath = path.join(root, 'src', 'flavor.json');

const FLAVORS = {
  default: {
    id: 'default',
    meshOffset: 0,
    label: '',
    appId: 'com.lanmesh.chat',
    productName: 'LAN Mesh Chat',
    executableName: 'lan-mesh-chat',
    artifactName: 'LAN-Mesh-Chat-${version}-${os}-${arch}.${ext}',
  },
  alt: {
    id: 'alt',
    meshOffset: 10,
    label: 'Alt',
    appId: 'com.lanmesh.chat.alt',
    productName: 'LAN Mesh Chat Alt',
    executableName: 'lan-mesh-chat-alt',
    artifactName: 'LAN-Mesh-Chat-Alt-${version}-${os}-${arch}.${ext}',
  },
};

function writeFlavor(flavor) {
  const payload = {
    id: flavor.id,
    meshOffset: flavor.meshOffset,
    label: flavor.label,
  };
  fs.writeFileSync(flavorPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[build] flavor → ${flavorPath}`);
  console.log(`[build] ${JSON.stringify(payload)}`);
}

function runBuilder(flavor) {
  writeFlavor(flavor);
  const config = {
    appId: flavor.appId,
    productName: flavor.productName,
    copyright: 'LAN Mesh Chat',
    directories: {
      output: 'release',
      buildResources: 'build',
    },
    files: ['src/**/*', 'package.json'],
    extraResources: [],
    icon: 'build/icon.png',
    asar: true,
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
      artifactName: flavor.artifactName,
      executableName: flavor.executableName,
      icon: 'build/icon.ico',
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      shortcutName: flavor.productName,
    },
    portable: {
      artifactName: flavor.artifactName.replace('.${ext}', '-portable.${ext}'),
    },
    linux: {
      target: ['AppImage'],
      artifactName: flavor.artifactName,
      category: 'Network',
      executableName: flavor.executableName,
    },
    mac: {
      target: ['dmg'],
      artifactName: flavor.artifactName,
    },
    extraMetadata: {
      name: flavor.executableName,
      productName: flavor.productName,
    },
  };

  const cfgPath = path.join(root, `.electron-builder.${flavor.id}.json`);
  fs.writeFileSync(cfgPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  console.log(`[build] electron-builder (${flavor.productName})…`);
  const r = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron-builder', '--config', cfgPath],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }
  );
  try {
    fs.unlinkSync(cfgPath);
  } catch {
    /* ignore */
  }
  if (r.status !== 0) {
    process.exit(r.status || 1);
  }
}

function main() {
  const arg = String(process.argv[2] || 'default').toLowerCase();
  const keys = arg === 'all' ? ['default', 'alt'] : [arg === 'alt' ? 'alt' : 'default'];
  for (const key of keys) {
    const flavor = FLAVORS[key];
    if (!flavor) {
      console.error(`未知 flavor: ${key}（可用 default | alt | all）`);
      process.exit(1);
    }
    runBuilder(flavor);
  }
  // 打完后恢复开发用 default flavor，避免本地被卡在 alt
  writeFlavor(FLAVORS.default);
  console.log('[build] done. 产物在 release/');
}

main();
