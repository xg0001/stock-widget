// 手动打包（离线）：等价 electron-packager 的产物布局
// 用法：node tools\make-package.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'release', '股票自选小窗-win32-x64');

// 1) 清空重建
if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// 2) Electron 运行时（npm install 已解压好的 dist，零网络）
fs.cpSync(path.join(root, 'node_modules', 'electron', 'dist'), dest, { recursive: true });

// 3) 改主程序名
fs.renameSync(path.join(dest, 'electron.exe'), path.join(dest, '股票自选小窗.exe'));

// 4) 应用文件
const appDir = path.join(dest, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
const files = ['index.html', 'main.js', 'quotes.js', 'renderer.js', 'pets.js', 'style.css', 'tickerbar.html', 'icon.png', 'icon.ico', 'group.config.json', 'package.json'];
for (const f of files) {
  if (!fs.existsSync(path.join(root, f))) { console.error('缺少文件:', f); process.exit(1); }
  fs.copyFileSync(path.join(root, f), path.join(appDir, f));
}
fs.cpSync(path.join(root, 'assets'), path.join(appDir, 'assets'), { recursive: true });
fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
// 只带 qrcode.png（server.crt 等云端遗留已删）
if (fs.existsSync(path.join(root, 'resources', 'qrcode.png'))) {
  fs.copyFileSync(path.join(root, 'resources', 'qrcode.png'), path.join(appDir, 'resources', 'qrcode.png'));
}

// 5) 嵌入图标与版本信息（rcedit 直接改 exe 资源）
async function main() {
  // ...上面步骤已同步执行完
  try {
    const { rcedit } = require('rcedit');
    await rcedit(path.join(dest, '股票自选小窗.exe'), {
      icon: path.join(root, 'icon.ico'),
      'version-string': {
        FileDescription: '股票自选小窗 - 实时行情桌面挂件',
        ProductName: '股票自选小窗',
        LegalCopyright: 'MIT License',
      },
    });
    console.log('rcedit OK');
  } catch (e) {
    console.error('rcedit 失败（exe 仍可用，仅图标/版本信息缺失）:', e.message);
    process.exitCode = 1;
  }

  // 6) 便携版压缩包（Node spawn 传参无编码坑；cmd 批处理里写中文会被 GBK 解析搞坏）
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '1.0.0';
  const zipPath = path.join(root, 'release', `股票自选小窗-v${version}-win64.zip`);
  try {
    fs.rmSync(zipPath, { force: true });
    const { spawnSync } = require('child_process');
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `$ErrorActionPreference='Stop'; Compress-Archive -Path (Join-Path '${dest.replace(/'/g, "''")}' '*') -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`],
      { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Compress-Archive failed');
    console.log('zip:', zipPath, '(' + (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1) + 'MB)');
  } catch (e) { console.error('zip 失败（不影响安装包）:', e.message); }

  // 7) 体积统计
  const size = (d) => { let s = 0; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); s += f.isDirectory() ? size(p) : fs.statSync(p).size; } return s; };
  console.log('打包完成:', dest);
  console.log('exe:', fs.existsSync(path.join(dest, '股票自选小窗.exe')) ? 'OK' : 'MISSING');
  console.log('index.html:', fs.existsSync(path.join(appDir, 'index.html')) ? 'OK' : 'MISSING!');
  console.log('resources/app 文件数:', fs.readdirSync(appDir).length);
  console.log('总大小:', (size(dest) / 1024 / 1024).toFixed(1), 'MB');
}
main();
