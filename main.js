const { app, BrowserWindow, Tray, Menu, shell, ipcMain, globalShortcut, screen, Notification, nativeImage, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { fetchQuotes, parseQuotes, fetchMinute, fetch5DayMinutes, fetchSuggest, fetchSuggestEM, fetchQuotesEM, fetchQuoteEMFallback, fetchMinuteEM, fetchMinutesEM, fetchKline, fetchRanking, fetchMarketSummary, fetchClistRaw, normCode, fetchIndicesGroups, fetchHotDetail, fetchSectorsFull, fetchEtfFull, fetchKlineSinaDaily, fetchBoardMinute } = require('./quotes');

// 主进程异常兜底：记录到日志而非弹出「A JavaScript error occurred in the main process」阻塞对话框。
// 典型触发：Windows 下 fs.watch 在窗口重载时偶发 error 事件；加此兜底后只记日志、不中断应用。
function logError(where, e) {
  const msg = `[${new Date().toISOString()}] ${where}: ${e && e.stack ? e.stack : e}\n`;
  console.error(where, e);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'stock-widget-error.log'), msg); } catch {}
}
process.on('uncaughtException', e => logError('uncaughtException', e));
process.on('unhandledRejection', e => logError('unhandledRejection', e));

// ---- 关闭后台节流：主窗口关到托盘后，其渲染进程的 setInterval 会被 Chromium 当作「后台隐藏页」降频
//      （标准节流到 ≥1 次/秒，隐藏约 5 分钟后进一步降到 ~1 次/分钟），任务栏行情条因数据全来自这个
//      被隐藏的渲染进程，表现为「有时几秒滚动、有时一分钟都不更新」。
//      这三个开关让隐藏窗口的定时器保持正常节奏，是 Electron 托盘类应用的标准解法（必须在 app ready 前设置）。
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// ---- 单实例锁：重复启动时聚焦已有窗口并退出新实例，避免双实例争抢 userData 缓存
//      （同时开两个实例会互相锁缓存目录，导致 Unable to move the cache: 0x5 / Gpu Cache Creation failed）----
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

let win;
let tray;
let clickThrough = false;
let allowQuit = false;
let aotEnabled = true;         // 是否开启「始终置顶」（与渲染端 settings.alwaysOnTop 同步）
let dockedEdge = null;         // 'left' | 'right' | 'top' | null（吸附到哪条边）
let dockedFull = null;         // 吸附后完整显示时的 bounds
let edgeHide = true;           // QQ 式贴边自动收起（默认开）
let edgeHidden = false;        // 当前是否已收起（只留一条边可见）
let edgeWatchTimer = null;     // 全局光标轮询定时器
let edgeShowGraceUntil = 0;    // 展开后的宽限期，避免滑入过程被误判收起
let collapseAfter = 0;         // 离开窗口后「延迟收起」的到期时间戳（0=不计时）
const EDGE_STRIP = 8;          // 收起后留在屏幕上的可见宽度(px)
const EDGE_SLACK = 6;          // 触发 / 离开判定容差(px)
const HIDE_DELAY = 350;        // 光标离开窗口后多久才收起(ms)，QQ 式缓冲，避免移动时误收

// 应用图标（窗口用 PNG，托盘用 ICO，均透明背景）
const iconPng = path.join(__dirname, 'icon.png');
const iconIco = path.join(__dirname, 'icon.ico');
// 图标统一从内存 Buffer 创建：nativeImage 按路径读取时，中文安装路径下会
// "Failed to load image from path"（Electron 已知坑，dev 纯英文路径不触发），导致托盘消失
let _iconPngImage = null;
function pngIcon() {
  if (_iconPngImage) return _iconPngImage;
  try { _iconPngImage = nativeImage.createFromBuffer(fs.readFileSync(iconPng)); } catch (e) { logError('pngIcon', e); }
  return _iconPngImage;
}

// ---- 更新配置（可选自托管：updateUrl 指向 version.json 所在目录；留空则不检查）----
// 软件为纯本地运行，无任何云端账号/验证；updateUrl 仅在自发放更新包时使用。
let cloudConfig = {};
try { cloudConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'cloud.config.json'), 'utf8')); }
catch (e) { cloudConfig = {}; }

// ---- 交流群配置（引流入口：群名/群号/活码图片，见 group.config.json）----
let groupConfig = {};
try { groupConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'group.config.json'), 'utf8')); }
catch (e) { console.log('[group] 未发现 group.config.json，交流群入口隐藏'); }
const qrcodeFile = path.join(__dirname, groupConfig.qrcodePath || 'resources/qrcode.png');
let applyingBounds = false;    // 程序内 setBounds 标记，避免 move 事件递归
let animTimer = null;          // 贴边/折叠补间定时器
let moveTimer = null;
let stockList = [];            // 渲染端同步过来的自选股（供托盘行情子菜单）
let collapsedHeight = 92;      // 折叠（只显示常驻票）时窗口高度
let savedHeight = 470;         // 折叠前的窗口高度
const boundsFile = path.join(app.getPath('userData'), 'bounds.json');
const storeFile = path.join(app.getPath('userData'), 'stock-widget-store.json');

// ---------- 配置/自选持久化（主进程持有文件，与 bounds.json 同 userData 目录，确保跨重启可靠保存）----------
let storeData = {};
try { storeData = JSON.parse(fs.readFileSync(storeFile, 'utf8')); }
catch (e) { console.log('[store] 未发现已有存档，将使用默认值'); }
function saveStoreFile() {
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify(storeData));
    console.log('[store] 已保存 ->', storeFile);
  } catch (e) { console.error('[store] 保存失败', storeFile, e); }
}
// 在模块顶层注册，确保渲染进程启动时 IPC 处理器已就绪（避免 sendSync 竞态导致读不到存档）
// store-set：内存立即更新（保证最新值不丢），文件写入防抖，避免拖动滑块时高频同步写盘阻塞主线程
let storeSaveTimer = null;
function scheduleStoreSave() {
  if (storeSaveTimer) clearTimeout(storeSaveTimer);
  storeSaveTimer = setTimeout(saveStoreFile, 300);
}
ipcMain.on('store-get', (e, key) => { e.returnValue = (key in storeData) ? storeData[key] : null; });
ipcMain.on('store-set', (e, key, value) => { storeData[key] = value; scheduleStoreSave(); });

// 交流群配置下发（渲染端设置页 / 欢迎页展示二维码与群号）
ipcMain.handle('group-config', () => ({
  groupName: groupConfig.groupName || '官方交流群',
  groupNumber: groupConfig.groupNumber || '',
  groupNotice: groupConfig.groupNotice || '',
  joinUrl: groupConfig.joinUrl || '',
  hasQrcode: fs.existsSync(qrcodeFile),
  qrcodeUrl: 'file://' + qrcodeFile.replace(/\\/g, '/'),
}));
// 托盘/菜单打开交流群面板
ipcMain.on('group-open-panel', () => {
  if (win && !win.isDestroyed()) { win.show(); win.webContents.send('group-open-panel'); }
});

// ---------- 任务栏行情条：贴在任务栏空白区的透明小窗（类似 Win11 天气小组件的实现方式）----------
// Windows 不允许第三方直接往任务栏写内容，这里用一个无边框透明置顶小窗压在任务栏空白区上，
// 显示常驻票「名称 现价 涨跌幅」，可整条左右拖动，位置记忆在 tickerbar-pos.json。
let tickerBar = null;
let tickerBarOn = false;
const TICKER_W = 190, TICKER_H = 34;
const tickerPosFile = path.join(app.getPath('userData'), 'tickerbar-pos.json');
function taskbarRect() {
  const d = screen.getPrimaryDisplay();
  const h = Math.max(30, d.bounds.height - d.workArea.y - d.workArea.height); // 底部任务栏高度
  return { x: d.workArea.x, y: d.workArea.y + d.workArea.height, w: d.workArea.width, h };
}
function clampTickerPos(p) {
  const tb = taskbarRect();
  // 右侧留 260px 给托盘/时钟区，避免行情条盖住系统图标
  const x = Math.max(tb.x + 4, Math.min(p.x, tb.x + tb.w - TICKER_W - 260));
  return { x, y: tb.y + Math.max(0, Math.round((tb.h - TICKER_H) / 2)) };
}
function saveTickerPos() {
  try { if (tickerBar) fs.writeFileSync(tickerPosFile, JSON.stringify(tickerBar.getBounds())); } catch (e) {}
}
function createTickerBar() {
  if (tickerBar) return;
  const tb = taskbarRect();
  let pos = null;
  try { pos = JSON.parse(fs.readFileSync(tickerPosFile, 'utf8')); } catch (e) {}
  if (!pos || typeof pos.x !== 'number') pos = { x: tb.x + tb.w - TICKER_W - 230, y: tb.y }; // 默认贴托盘左侧（用户红框位置）
  pos = clampTickerPos(pos);
  tickerBar = new BrowserWindow({
    x: pos.x, y: pos.y, width: TICKER_W, height: TICKER_H,
    frame: false, transparent: true, resizable: false, skipTaskbar: true,
    // 显式声明全透明底色：不写时部分机器/显卡驱动会把透明窗口画成纯黑
    backgroundColor: '#00000000',
    hasShadow: false, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, spellcheck: false },
  });
  // 任务栏本身是 topmost，行情条必须用更高层级才能压在任务栏空白区上
  tickerBar.setAlwaysOnTop(true, 'screen-saver');
  tickerBar.loadFile('tickerbar.html');
  tickerBar.once('ready-to-show', () => { if (tickerBarOn && tickerBar && !tickerBar.isDestroyed()) tickerBar.showInactive(); });
  tickerBar.on('moved', () => {
    try {
      const b = tickerBar.getBounds();
      const c = clampTickerPos({ x: b.x, y: b.y });
      if (c.x !== b.x || c.y !== b.y) tickerBar.setPosition(c.x, c.y);
    } catch (e) {}
    saveTickerPos();
  });
  screen.on('display-metrics-changed', () => {
    try {
      if (!tickerBar || tickerBar.isDestroyed()) return;
      const b = tickerBar.getBounds();
      const c = clampTickerPos({ x: b.x, y: b.y });
      tickerBar.setPosition(c.x, c.y);
    } catch (e) {}
  });
}
function tickerBarSetVisible(on) {
  tickerBarOn = !!on;
  if (on) {
    createTickerBar();
    if (tickerBar && !tickerBar.isVisible()) tickerBar.showInactive(); // 不抢焦点
  } else if (tickerBar && tickerBar.isVisible()) {
    tickerBar.hide();
  }
}
// Explorer 会周期性把任务栏重新置顶，压过我们的行情条 → 定时把它顶回最前（3 秒一次，开销可忽略）
setInterval(() => {
  try {
    if (tickerBar && !tickerBar.isDestroyed() && tickerBar.isVisible()) {
      tickerBar.setAlwaysOnTop(true, 'screen-saver');
      tickerBar.moveTop();
    }
  } catch (e) {}
}, 3000);

function loadBounds() {
  try { return JSON.parse(fs.readFileSync(boundsFile, 'utf8')); } catch { return null; }
}
function saveBounds(b) {
  try { fs.writeFileSync(boundsFile, JSON.stringify(b)); } catch {}
}

// 把窗口位置夹取到主屏幕可见区域内，避免窗口跑出屏幕外
function clampToScreen(b) {
  try {
    const area = screen.getPrimaryDisplay().workAreaSize;
    const w = b.width || 320, h = b.height || 470;
    let x = (typeof b.x === 'number') ? b.x : Math.round((area.width - w) / 2);
    let y = (typeof b.y === 'number') ? b.y : Math.round((area.height - h) / 2);
    x = Math.max(0, Math.min(x, area.width - w));
    y = Math.max(0, Math.min(y, area.height - h));
    return { x, y, width: w, height: h };
  } catch { return b; }
}

// 判断窗口当前是否落在任一屏幕的可见区域内（多显示器 / 分辨率变化后可能越界）
function isWindowVisibleOnScreen() {
  try {
    const b = win.getBounds();
    const disp = screen.getDisplayMatching(b);
    const a = disp.workArea;
    return (b.x + b.width > a.x && b.y + b.height > a.y && b.x < a.x + a.width && b.y < a.y + a.height);
  } catch { return true; }
}

// 重置窗口到主屏幕右上角，并持久化
function resetWindowPosition() {
  if (!win) return;
  const { width, height } = win.getBounds();
  const area = screen.getPrimaryDisplay().workAreaSize;
  const x = Math.round(area.width - width - 24);
  const y = Math.round(36);
  dockedEdge = null; dockedFull = null; edgeHidden = false; collapseAfter = 0; stopEdgeWatch();
  animateBounds({ x, y, width, height });
  applyTop(); // 重置位置后重新置顶，避免落到别的窗口后面
  saveBounds({ x, y, width, height });
}

// 程序内 setBounds，标记 applyingBounds 以屏蔽自身触发的 move 事件
function setB(b) {
  if (!win) return;
  applyingBounds = true;
  win.setBounds(b);
  setTimeout(() => { applyingBounds = false; }, 60);
}

// 平滑移动/缩放窗口：Electron 在 Windows 上 setBounds 的 animate 参数无效，
// 这里用主进程定时器手动补间（easeOutCubic），期间 applyingBounds 屏蔽 move 事件。
// 起点与终点几乎一致时直接落位，避免无意义动画与事件抖动。
function animateBounds(target, duration = 260) {
  if (!win) return;
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  const start = win.getBounds();
  const d = {
    x: (target.x ?? start.x) - start.x,
    y: (target.y ?? start.y) - start.y,
    width: (target.width ?? start.width) - start.width,
    height: (target.height ?? start.height) - start.height,
  };
  if (Math.abs(d.x) < 1 && Math.abs(d.y) < 1 && Math.abs(d.width) < 1 && Math.abs(d.height) < 1) {
    win.setBounds(target);
    // dockedFull 由 applyDocking/onMoveResize 维护，动画结束不再覆盖，避免收起坐标污染完整位置
    saveBounds(dockedEdge ? dockedFull : win.getBounds());
    return;
  }
  const t0 = Date.now();
  const ease = t => 1 - Math.pow(1 - t, 3);
  applyingBounds = true;
  animTimer = setInterval(() => {
    const p = Math.min(1, (Date.now() - t0) / duration);
    const e = ease(p);
    win.setBounds({
      x: Math.round(start.x + d.x * e),
      y: Math.round(start.y + d.y * e),
      width: Math.round(start.width + d.width * e),
      height: Math.round(start.height + d.height * e),
    });
    if (p >= 1) {
      clearInterval(animTimer); animTimer = null;
      applyingBounds = false;
      // dockedFull 由 applyDocking/onMoveResize 维护，动画结束不再覆盖，避免收起坐标污染完整位置
      saveBounds(dockedEdge ? dockedFull : win.getBounds());
    }
  }, 16);
}

const EDGE_T = 16; // 贴边吸附阈值(px)
function edgeOf(b) {
  try {
    const area = screen.getPrimaryDisplay().workAreaSize;
    if (b.x <= EDGE_T) return 'left';
    if (b.x + b.width >= area.width - EDGE_T) return 'right';
    if (b.y <= EDGE_T) return 'top';
  } catch {}
  return null;
}

// 吸附到边缘：把窗口对齐到最近的屏幕边缘（用户要的「自动贴边」）。
// 吸附后若开启「贴边自动收起」，启动光标轮询，鼠标离开即收起、滑到边缘即召回（QQ 式）。
function applyDocking(b) {
  if (!win) return;
  const edge = edgeOf(b);
  if (!edge) {
    if (dockedEdge) { dockedEdge = null; dockedFull = null; edgeHidden = false; collapseAfter = 0; stopEdgeWatch(); }
    return;
  }
  dockedEdge = edge;
  dockedFull = { ...b };
  const area = screen.getPrimaryDisplay().workAreaSize;
  if (edge === 'left') dockedFull.x = 0;
  else if (edge === 'right') dockedFull.x = area.width - b.width;
  else if (edge === 'top') dockedFull.y = 0;
  if (!edgeHidden) animateBounds(dockedFull);   // 收起态不强行展开，等光标滑入才展开
  if (win) win.webContents.send('edge-snap', edge);
  if (edgeHide) startEdgeWatch();               // QQ 式：吸附后启动光标轮询
}

// 光标是否落在某矩形内（带容差）
function cursorInRect(c, b, slack) {
  return c.x >= b.x - slack && c.x <= b.x + b.width + slack &&
         c.y >= b.y - slack && c.y <= b.y + b.height + slack;
}
// 光标是否落在「收起后留下的可见条」区域（或屏幕边缘附近）—— 用于召回
function cursorInStrip(c, edge, full, area) {
  const s = EDGE_STRIP + EDGE_SLACK;
  if (edge === 'left')  return c.x <= s && c.y >= full.y - s && c.y <= full.y + full.height + s;
  if (edge === 'right') return c.x >= area.width - s && c.y >= full.y - s && c.y <= full.y + full.height + s;
  if (edge === 'top')   return c.y <= s && c.x >= full.x - s && c.x <= full.x + full.width + s;
  return false;
}
// 收起时（只留 EDGE_STRIP 可见）的 bounds
function edgeHiddenBounds(edge, full) {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const b = { ...full };
  if (edge === 'left') b.x = -(full.width - EDGE_STRIP);
  else if (edge === 'right') b.x = area.width - EDGE_STRIP;
  else if (edge === 'top') b.y = -(full.height - EDGE_STRIP);
  return b;
}
// 重新断言置顶：Windows 上透明 + 不显示任务栏的窗口在 hide→show 循环后，
// HWND_TOPMOST 置顶标志会丢失（窗口落到别的窗口后面）。因此每次窗口变为可见都必须重新置顶，
// 并 moveTop 提到最前（覆盖其它同样是 topmost 的窗口）。仅当用户确实开启置顶时才强制。
function applyTop() {
  if (!win) return;
  try {
    win.setAlwaysOnTop(!!aotEnabled, 'screen-saver');
    if (aotEnabled) win.moveTop();
  } catch (e) {}
}

// 把收起的窗口完整展开（托盘点开 / 设置变更时调用），并给一段宽限期防止立刻又被收起
function revealDocked() {
  if (!win || !dockedEdge) return;
  if (!win.isVisible()) win.show();
  edgeHidden = false;
  edgeShowGraceUntil = Date.now() + 1000;
  collapseAfter = 0;
  applyTop(); // 展开时重新置顶，避免 hide→show 丢 topmost
  const full = dockedFull || win.getBounds();
  if (edgeOf(full) === dockedEdge) animateBounds(full);
  if (edgeHide) startEdgeWatch();
}
function startEdgeWatch() {
  if (edgeWatchTimer || !win || !dockedEdge || !edgeHide) return;
  edgeWatchTick();
  edgeWatchTimer = setInterval(edgeWatchTick, 120);
}
function stopEdgeWatch() {
  if (edgeWatchTimer) { clearInterval(edgeWatchTimer); edgeWatchTimer = null; }
}
// 核心轮询：QQ 式贴边行为
//  - 收起态：光标碰到「边缘可见细条」才展开（窄条判定，避免整条隐形带都触发展开）
//  - 展开态：光标落在「实际窗口」内就保持；离开窗口并持续 HIDE_DELAY 才收起
//            （关键：鼠标在窗口内移动 / 短暂移出又移回，都不会误触发收起，像 QQ 一样顺手）
//  仅依赖全局光标坐标（screen.getCursorScreenPoint），不依赖 DOM 事件 / 鼠标穿透，避免「藏了叫不出来」。
function edgeWatchTick() {
  if (!win || !dockedEdge || !edgeHide) { stopEdgeWatch(); return; }
  if (!win.isVisible()) return; // 被托盘隐藏时暂停判定
  const area = screen.getPrimaryDisplay().workAreaSize;
  // 光标坐标是屏幕物理像素，getBounds 是 DIP(logical)，高 DPI 屏必须统一，否则判定错位
  const cRaw = screen.getCursorScreenPoint();
  const c = (typeof screen.screenToDipPoint === 'function')
    ? screen.screenToDipPoint(cRaw)
    : { x: cRaw.x / (screen.getPrimaryDisplay().scaleFactor || 1), y: cRaw.y / (screen.getPrimaryDisplay().scaleFactor || 1) };
  const now = Date.now();
  if (edgeHidden) {
    // 收起态：只有光标落在「边缘可见细条」区域才展开（用窄条判定，不把整条隐形带都当作触发区）
    if (cursorInStrip(c, dockedEdge, dockedFull || win.getBounds(), area)) {
      edgeHidden = false;
      edgeShowGraceUntil = now + 400;   // 展开后宽限期，避免滑入过程被误判收起
      collapseAfter = 0;                  // 取消任何待收起计时
      animateBounds(dockedFull || win.getBounds()); // full 是完整吸附位置（永不被收起动画污染）
    }
  } else {
    // 展开态：以「实际窗口」几何判定，移动鼠标在窗口内 / 短暂移出再移回都不会误收起
    const cur = win.getBounds();
    const inWin = cursorInRect(c, cur, EDGE_SLACK);
    if (inWin) {
      collapseAfter = 0;                  // 光标在窗口内 → 取消收起计时
    } else if (now > edgeShowGraceUntil) {
      if (collapseAfter === 0) collapseAfter = now + HIDE_DELAY; // 第一次离开：开始倒计时
      else if (now >= collapseAfter) {                        // 持续离开够久 → 收起
        edgeHidden = true;
        collapseAfter = 0;
        animateBounds(edgeHiddenBounds(dockedEdge, cur));
      }
    }
  }
}
// 开发期热重载：监听核心源码文件，变更后让渲染进程忽略缓存重新加载。
// 重新加载渲染进程，并先清空会话缓存，确保 style.css / renderer.js 等本地文件强制重新读取（绕过 file:// 缓存）
// （顶层函数：setupDevReload 与 ipc 'reload' 都要用，之前放在 createWindow 内导致热重载 ReferenceError）
function doReload(w) {
  if (!w || w.isDestroyed()) return;
  const s = w.webContents.session;
  if (s && typeof s.clearCache === 'function') {
    try {
      const p = s.clearCache();
      const fin = () => { if (!w.isDestroyed()) w.reloadIgnoringCache(); };
      if (p && typeof p.then === 'function') p.then(fin).catch(fin);
      else fin();
      return;
    } catch (e) { /* 落到下面的 reloadIgnoringCache */ }
  }
  w.reloadIgnoringCache();
}
// 解决「关窗只隐藏到托盘、旧页面常驻」导致改了样式却看不到效果的问题。
// 注意：打包后（app.isPackaged）不再监听，避免无谓的文件监听；且 watcher 必须挂 error 监听，
// 否则 Windows 下窗口重载时反复读取被监听文件会偶发 error 事件 -> 主进程未捕获异常 -> 弹「main process」错误框。
function setupDevReload(targetWin) {
  if (app.isPackaged) return;
  const watchFiles = ['index.html', 'style.css', 'renderer.js', 'quotes.js'];
  let reloadTimer = null;
  const trigger = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (targetWin && !targetWin.isDestroyed()) {
        console.log('[dev-reload] 源码变更，重新加载渲染进程');
        doReload(targetWin);
      }
    }, 300);
  };
  watchFiles.forEach(f => {
    const p = path.join(__dirname, f);
    if (!fs.existsSync(p)) return;
    try {
      const w = fs.watch(p, () => trigger());
      w.on('error', e => console.error('[dev-reload] watch error（已忽略）', f, e));
    }
    catch (e) { console.error('[dev-reload] 监听失败', f, e); }
  });
}

// ---------- 轻量自动更新（自托管场景：读 updateUrl/version.json，有新版则提示/打开下载）----------
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try { return fetchJson(new URL(res.headers.location, url).href).then(resolve, reject); } catch (e) { return reject(e); }
      }
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('版本信息解析失败')); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('检查更新超时')));
  });
}
function versionGreater(remote, local) {
  const a = String(remote).split('.').map(Number);
  const b = String(local).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
async function checkForUpdates(manual) {
  const updateUrl = (cloudConfig && cloudConfig.updateUrl) || '';
  if (!updateUrl) {
    if (manual && win) win.webContents.send('toast', '未配置更新地址', '请在 cloud.config.json 填写 updateUrl');
    return;
  }
  if (!app.isPackaged) {
    if (manual && win) win.webContents.send('toast', '开发模式', '打包后才会检查更新');
    return;
  }
  try {
    const info = await fetchJson(updateUrl.replace(/\/$/, '') + '/version.json');
    if (versionGreater(info.version, app.getVersion())) {
      const file = info.file || ('stock-ticker-widget-Setup-' + info.version + '.exe');
      const url = (updateUrl.replace(/\/$/, '') + '/' + file).replace(/\\/g, '/');
      if (win) win.webContents.send('update-available', info.version, url);
      if (manual && shell) shell.openExternal(url);
    } else if (manual && win) {
      win.webContents.send('toast', '已是最新', '当前版本 v' + app.getVersion());
    }
  } catch (e) {
    if (manual && win) win.webContents.send('toast', '检查更新失败', String(e.message || e));
  }
}

function createWindow() {
  const b = clampToScreen(loadBounds() || {});
  if (b.width < 300) b.width = 320;
  win = new BrowserWindow({
    width: (b && b.width) || 320,
    height: (b && b.height) || 470,
    minWidth: 260,
    x: (b && typeof b.x === 'number') ? b.x : undefined,
    y: (b && typeof b.y === 'number') ? b.y : undefined,
    transparent: true,      // 透明窗口
    frame: false,           // 无边框
    alwaysOnTop: true,      // 始终置顶
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,   // 不在任务栏显示，完全托盘运行
    icon: pngIcon(),   // 任务栏 / Alt-Tab / 缩略图图标（内存 Buffer，规避中文路径读取失败）
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  // 不带 query：原 cfg 参数是云端遗留（account.js 已删），且 query + 中文安装路径会触发
  // Chromium file:// 的 ERR_FILE_NOT_FOUND（曾导致打包版白屏）
  win.loadFile('index.html');
  setupDevReload(win);
  // 启动后自动检查更新（打包环境才真正联网；开发模式仅记录，不弹窗）
  checkForUpdates(false);

  // 若保存的位置本就贴着边缘，则恢复吸附态，使「贴边自动收起」从启动即生效
  const initB = win.getBounds();
  if (edgeOf(initB)) { dockedEdge = edgeOf(initB); dockedFull = { ...initB }; }
  if (dockedEdge && edgeHide) { edgeShowGraceUntil = Date.now() + 1500; startEdgeWatch(); }

  // 移动/缩放后记住位置，并做贴边吸附
  const onMoveResize = () => {
    if (applyingBounds) return; // 忽略程序内 setBounds 触发的 move
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!win) return;
      const b = win.getBounds();
      if (dockedEdge) dockedFull = { ...b };
      applyDocking(b); // 拖到边缘就吸附（不依赖隐藏开关），吸附后保存完整位置
      saveBounds(dockedEdge ? dockedFull : b);
    }, 400);
  };
  win.on('resize', onMoveResize);
  win.on('move', onMoveResize);
  // 关闭时不退出，而是最小化到托盘（真正的挂件行为）
  win.on('close', (e) => { if (allowQuit) return; e.preventDefault(); win.hide(); });
  // 托盘 / 快捷键显隐：隐藏时暂停轮询；显示时若已吸附则展开并重新进入 QQ 式自动收起
  win.on('hide', () => stopEdgeWatch());
  win.on('show', () => { applyTop(); if (dockedEdge && edgeHide) revealDocked(); });

  // 行情请求
  ipcMain.on('fetch-prices', async (event, codes) => {
    try {
      const list = Array.isArray(codes) ? codes : [codes];
      const bk = list.filter(c => /^bk/i.test(c));
      const others = list.filter(c => !/^bk/i.test(c));
      console.log('[prices] total=', list.length, 'bk=', bk, 'others=', others.slice(0, 5));
      let data = [];
      if (others.length) {
        try {
          const stockData = parseQuotes(await fetchQuotes(others));
          data = data.concat(stockData);
          console.log('[prices] stockData len=', stockData.length);
          const found = new Set(stockData.map(d => d.code));
          const missing = others.filter(c => !found.has(c));
          if (missing.length) {
            console.log('[prices] tencent missing=', missing);
            try {
              const emFallback = await fetchQuoteEMFallback(missing);
              console.log('[prices] emFallback len=', emFallback.length);
              data = data.concat(emFallback);
            } catch (e) { console.error('[prices] EM fallback failed', e); }
          }
        } catch (e) { console.error('[prices] stock fetch failed', e); }
      }
      if (bk.length) {
        try {
          const emData = await fetchQuotesEM(bk);
          // 板块数据源偶发返回 undefined，直接 log/ concat 会抛 "Cannot read properties of undefined (reading 'slice')"
          console.log('[prices] emData len=', (emData || []).length, 'first=', JSON.stringify((emData && emData[0]) || null).slice(0, 180));
          if (Array.isArray(emData)) data = data.concat(emData);
        } catch (e) { console.error('[prices] board fetch failed', e); }
      }
      console.log('[prices] replied total=', data.length);
      event.reply('prices', data);
    } catch (e) {
      console.error('[prices] catch ERROR', e);
      event.reply('prices', { error: String(e && e.message ? e.message : e) });
    }
  });

  ipcMain.on('set-opacity', (e, v) => { if (win) win.setOpacity(v); });
  ipcMain.on('set-always-on-top', (e, v) => { aotEnabled = !!v; applyTop(); });
  // 贴边自动收起开关：开启则吸附时启动轮询；关闭则若已收起则展开还原
  ipcMain.on('set-edge-hide', (e, v) => {
    edgeHide = !!v;
    collapseAfter = 0;
    if (edgeHide) { if (dockedEdge) startEdgeWatch(); }
    else { stopEdgeWatch(); if (dockedEdge && edgeHidden) revealDocked(); }
  });
  ipcMain.on('set-click-through', (e, v) => {
    clickThrough = !!v;
    if (win) win.setIgnoreMouseEvents(clickThrough, { forward: true });
  });
  // 任务栏行情（渲染端推送常驻票行情）：透明行情条贴任务栏空白区；窗口标题同步（悬停/Alt+Tab 可见）。
  // 不再做任务栏角标与托盘图标替换（用户反馈移除）。{on:true} 表示已开启但行情未就绪，先只就位。
  ipcMain.on('taskbar-ticker', (e, t) => {
    try {
      if (t && !t.info) { // 开启模式但暂无数据：行情条先就位
        if (win && !win.isDestroyed()) win.setSkipTaskbar(false);
        tickerBarSetVisible(true);
        return;
      }
      if (!t) { // 关闭：还原纯托盘 + 隐藏行情条
        if (win && !win.isDestroyed()) win.setSkipTaskbar(true);
        tickerBarSetVisible(false);
        if (win && !win.isDestroyed()) win.setTitle('股票自选小窗');
        return;
      }
      if (win && !win.isDestroyed()) win.setSkipTaskbar(false);
      tickerBarSetVisible(true);
      if (win && !win.isDestroyed() && t.title) win.setTitle(String(t.title).slice(0, 60));
      if (tickerBar && !tickerBar.isDestroyed() && t.info) tickerBar.webContents.send('ticker-data', t.info);
    } catch (err) { logError('taskbar-ticker', err); }
  });
  ipcMain.on('open-url', (e, code) => shell.openExternal(buildUrl(code)));
  ipcMain.on('hide', () => { if (win) win.hide(); });
  ipcMain.on('quit', () => { allowQuit = true; app.quit(); });
  ipcMain.on('reload', () => doReload(win));
  // 手动检查更新（托盘菜单 / 将来可加的按钮触发）
  ipcMain.on('app:check-update', () => checkForUpdates(true));

  // K线（蜡烛图）：code + period(day/week/month/year/m5/m15/m30/m60/m120)
  ipcMain.on('fetch-kline', async (e, arg) => {
    try {
      const { code, period } = arg || {};
      e.reply('kline', { code, period, data: await fetchKline(code, period) });
    } catch (err) { e.reply('kline', { error: String(err) }); }
  });
  // 五日分时：code
  ipcMain.on('fetch-5day', async (e, arg) => {
    try {
      const { code } = arg || {};
      e.reply('5day', { code, data: await fetch5DayMinutes(code) });
    } catch (err) { e.reply('5day', { error: String(err) }); }
  });
  // 股票热榜（人气榜）详情
  ipcMain.on('fetch-hot', async (e, arg) => {
    try {
      const { tag = '1h', pz = 50 } = arg || {};
      const fid = tag === '1h' ? 'f6' : 'f3'; // 1小时按成交额，24小时按涨跌幅（东财无精确分钟级热度）
      const list = await fetchHotDetail({ pz, fid });
      e.reply('hot', { tag, list });
    } catch (err) { e.reply('hot', { error: String(err) }); }
  });

  // 板块（行业/概念）完整字段
  ipcMain.on('fetch-sectors-full', async (e, arg) => {
    try {
      const { type = 'industry', pz = 100 } = arg || {};
      const list = await fetchSectorsFull(type, { pz });
      e.reply('sectors-full', { type, list });
    } catch (err) { e.reply('sectors-full', { error: String(err) }); }
  });

  // ETF 分类榜
  ipcMain.on('fetch-etf-full', async (e, arg) => {
    try {
      const { category = 'all', pz = 200 } = arg || {};
      const list = await fetchEtfFull(category, { pz });
      e.reply('etf-full', { category, list });
    } catch (err) { e.reply('etf-full', { error: String(err) }); }
  });

  // 行情榜单（涨幅/跌幅/换手/成交额，一次取数）
  ipcMain.on('fetch-ranking', async (e) => {
    try { e.reply('ranking', await fetchRanking()); }
    catch (err) { e.reply('ranking', { error: String(err) }); }
  });
  // 全市场 A 股概览（涨跌家数、成交额、分布）
  // 全市场要翻 50+ 页，请求很重，东财/新浪都会对高频翻页限流（ERR_EMPTY_RESPONSE / socket hang up）。
  // 因此：① TTL 5 分钟（30 秒一刷全市场必然被限流），期间沿用缓存并标注数据时间；
  // ② 最近一次成功统计落盘，拉取失败时用缓存兜底；③ 失败后 60 秒冷却，避免每 30 秒重打一轮 50+ 请求。
  let _marketListCache = null;
  let _marketListAt = 0;
  let _marketFetchFailAt = 0;
  const MARKET_LIST_TTL = 300000;
  let _marketSummaryCache = null;
  const marketSummaryCacheFile = path.join(app.getPath('userData'), 'market-summary-cache.json');
  try { _marketSummaryCache = JSON.parse(fs.readFileSync(marketSummaryCacheFile, 'utf8')); } catch (e) {}
  function saveMarketSummaryCache(summary) {
    _marketSummaryCache = { at: Date.now(), date: localDate(), summary };
    try { fs.writeFileSync(marketSummaryCacheFile, JSON.stringify(_marketSummaryCache)); } catch (e) {}
  }
  let _marketListPromise = null; // 进行中的抓取：新浪兜底要 20s+，避免 30s 定时器叠加出第二次全量扫描
  async function getMarketList() {
    const now = Date.now();
    if (_marketListCache && now - _marketListAt <= MARKET_LIST_TTL) return _marketListCache;
    if (_marketListPromise) return _marketListPromise;
    if (now - _marketFetchFailAt < 60000) return _marketListCache; // 刚失败过：冷却 60s，先展示缓存
    _marketListPromise = (async () => {
      try {
        const fresh = await fetchMarketSummary();
        if (fresh && fresh.length) { _marketListCache = fresh; _marketListAt = Date.now(); }
        else _marketFetchFailAt = Date.now();
      } catch (e) {
        _marketFetchFailAt = Date.now();
        console.log('[market] fetch fail, keep cache:', e.message); // 失败保留上一份，下一轮再试
      }
      return _marketListCache;
    })();
    try { return await _marketListPromise; } finally { _marketListPromise = null; }
  }
  ipcMain.on('fetch-market-summary', async (e) => {
    try {
      const list = await getMarketList();
      if (list && list.length) {
        const summary = buildMarketSummary(list);
        saveMarketSummaryCache(summary);
        // updatedAt 用「全市场列表实际抓取时间」，而不是每次回复时间：
        // 列表 TTL 2 分钟，若在两次抓取之间每 30s 重算，时间戳会被误刷成最新
        const age = Date.now() - _marketListAt;
        e.reply('market-summary', Object.assign(summary, { updatedAt: _marketListAt, stale: age > MARKET_LIST_TTL * 1.5 }));
        return;
      }
      const c = _marketSummaryCache;
      if (c && c.summary && c.date === localDate()) {
        e.reply('market-summary', Object.assign(c.summary, { updatedAt: c.at, stale: true }));
        return;
      }
      e.reply('market-summary', { error: '涨跌分布数据获取失败（数据源限流，自动重试中）' });
    } catch (err) {
      e.reply('market-summary', { error: String(err) });
    }
  });

  // 指数日K：走腾讯 fqkline（sh/sz+代码，稳定且不受东财 push2his 限流影响），
  // 不依赖 quotes.fetchKline 的腾讯优先链路（其个股走 ifzq 对裸代码有效，但指数需 sh/sz 前缀才会返回）。
  function fetchIndexKlineEM(code, lmt) {
    const sym = (/^6/.test(code) || code === '000001') ? 'sh' + code : 'sz' + code;
    return new Promise((resolve) => {
      // web.ifzq 会被腾讯 WAF 间歇拦截，改用不带 web. 的 ifzq
      const url = `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,320,qfq`;
      const finish = (out) => {
        if (out && out.length) return resolve(out);
        // 腾讯不可用时新浪日K兜底，避免涨跌分布页「近60日走势」空图
        fetchKlineSinaDaily(sym, 240, lmt || 320).then(s => resolve(s || [])).catch(() => resolve([]));
      };
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        let s = ''; res.on('data', d => s += d); res.on('end', () => {
          try {
            const j = JSON.parse(s);
            const node = j && j.data && (j.data[sym] || j.data[sym.toUpperCase()]);
            const arr = node && (node.qfqday || node.day || node.qfq || node.qfkline || []);
            if (Array.isArray(arr) && arr.length) {
              const out = arr.map(it => ({
                date: String(it[0] || ''), open: parseFloat(it[1]) || 0, close: parseFloat(it[2]) || 0,
                high: parseFloat(it[3]) || 0, low: parseFloat(it[4]) || 0, volume: parseFloat(it[5]) || 0,
              })).filter(x => x.date);
              return finish(out.slice(-lmt));
            }
          } catch (_) {}
          finish([]);
        });
      });
      req.on('error', () => finish([]));
    });
  }
  // 涨跌分布页「日内分时」：上证指数当日真实分时（trends2，东财），并附带昨收基准（来自日K倒数第二根）
  ipcMain.on('fetch-index-intraday', async (e, arg) => {
    try {
      const code = (arg && arg.code) || '000001';
      const sym = (/^6/.test(code) || code === '000001') ? 'sh' + code : 'sz' + code;
      // 优先腾讯分时（ifzq 稳定），取不到再走东财，避免东财限流时整段空白
      let trends = [];
      try { trends = await fetchMinute(sym); } catch (e) {}
      if (!trends || !trends.length) trends = await fetchMinuteEM(code);
      let prevClose = null;
      try {
        const k = await fetchIndexKlineEM(code, 2);
        if (k && k.length >= 2) prevClose = k[k.length - 2].close;
      } catch (_) { /* 分时图无昨收时退化为以首点为零轴，绘制仍能显示 */ }
      e.reply('index-intraday', { code, trends, prevClose });
    } catch (err) { e.reply('index-intraday', { error: String(err) }); }
  });
  // 涨跌分布页「近60日走势」：上证指数日K（腾讯 fqkline），取最后 lmt 根
  ipcMain.on('fetch-index-kline', async (e, arg) => {
    try {
      const code = (arg && arg.code) || '000001';
      const lmt = (arg && arg.lmt) || 60;
      const k = await fetchIndexKlineEM(code, lmt);
      e.reply('index-kline', { code, data: k });
    } catch (err) { e.reply('index-kline', { error: String(err) }); }
  });

  // 涨跌趋势「近60日」：市场情绪周期历史（上涨比例 / 涨停家数 / 跌停家数）
  function fetchMarketSentimentHistory(days = 60) {
    return new Promise((resolve) => {
      const url = 'https://www.stockapi.com.cn/v1/base/emotionalCycle';
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        let s = ''; res.on('data', d => s += d); res.on('end', () => {
          try {
            const j = JSON.parse(s);
            if (j && j.code === 20000 && j.data && Array.isArray(j.data.contentList) && j.data.colNameList) {
              const cols = j.data.colNameList;
              const idxDate = cols.indexOf('date1');
              const idxUp = cols.indexOf('szbl');
              const idxLimitUp = cols.indexOf('ztjs');
              const idxLimitDown = cols.indexOf('dtjs');
              const out = j.data.contentList.map(row => ({
                date: String(row[idxDate] || ''),
                upRatio: parseFloat(row[idxUp]) || 0,
                limitUp: parseInt(row[idxLimitUp]) || 0,
                limitDown: parseInt(row[idxLimitDown]) || 0,
              })).filter(x => x.date).slice(-days);
              return resolve(out);
            }
          } catch (_) {}
          resolve([]);
        });
      });
      req.on('error', () => resolve([]));
    });
  }
  ipcMain.on('fetch-market-sentiment-history', async (e, arg) => {
    try {
      const days = (arg && arg.days) || 60;
      const history = await fetchMarketSentimentHistory(days);
      e.reply('market-sentiment-history', { history });
    } catch (err) { e.reply('market-sentiment-history', { error: String(err) }); }
  });

  // 通用榜单/板块/ETF 抓取（renderer 按 tag 区分用途）
  ipcMain.on('fetch-clist', async (e, arg) => {
    const { fs, fields, pz, fid, po, tag } = arg || {};
    try {
      const diff = await fetchClistRaw(fs, { pz: pz || 300, fid: fid || 'f3', fields: fields || undefined, po: po || 1 });
      e.reply('clist', { tag, diff });
    } catch (err) { e.reply('clist', { tag, error: String(err) }); }
  });

  // 涨停天梯：全市场过滤涨停股，按日K线统计连板天数，按连板数分组
  const _ladderCache = { at: 0, data: null };
  ipcMain.on('fetch-limit-ladder', async (e) => {
    try {
      const now = Date.now();
      if (_ladderCache.data && now - _ladderCache.at < 180000) { e.reply('limit-ladder', _ladderCache.data); return; }
      const list = await getMarketList();
      _marketListCache = list;
      // 涨停股可能上百只，按成交额取前 150 只统计连板，避免一次性拉上百条 K 线卡死
      // 涨停判定按板块涨跌幅限制（主板10%/创业板科创板20%/ST 5%/北交所30%）
      const ups = list.filter(d => { const L = limitPctOf(d.code, d.name); return d.chgPct >= L - 0.10 && d.code && /^\d{6}$/.test(d.code); })
        .sort((a, b) => b.amount - a.amount);
      // 全量统计所有涨停股的连板天数，不再只取「成交额前 150 只」——之前截断会导致
      // 低成交额涨停股消失、天梯连板数不全、用户觉得「不准」。
      // 仅对成交额前 N 只拉 K 线统计连板（N 取较大上限覆盖绝大多数交易日），其余默认 1 板；
      // 列表本身仍包含全部涨停股（数量准确），连板数对前 N 只精确、其余保守记为 1 板。
      const ANALYZE_CAP = 400;
      const toAnalyze = ups.slice(0, ANALYZE_CAP);
      // 限并发获取日K线，统计连续涨停天数（只取最近 20 根加速；按各板块涨跌幅限制判定当日是否涨停）
      const pool = [];
      let idx = 0;
      const worker = async () => {
        while (idx < toAnalyze.length) {
          const u = toAnalyze[idx++];
          try {
            // fetchKline 需要带市场前缀的 code（如 sh600519），而 u.code 是纯6位数字
            const prefixed = normCode(u.code);
            const k = await fetchKline(prefixed, 'day', 20);
            let boards = 0;
            const L = limitPctOf(u.code, u.name) / 100;
            for (let i = k.length - 1; i >= 0; i--) {
              const cur = k[i], prev = k[i - 1];
              if (!prev || !prev.close) break;
              const pct = (cur.close - prev.close) / prev.close;
              if (pct >= L - 0.01) boards++; else break;
            }
            u.boards = boards || 1;
          } catch (e2) { u.boards = 1; }
        }
      };
      const N = Math.min(10, Math.max(3, toAnalyze.length));
      for (let i = 0; i < N; i++) pool.push(worker());
      await Promise.all(pool);
      // 分组：连板数 → 列表（每组按成交额降序），使用全部 ups 保证数量准确
      const groups = {};
      ups.forEach(u => { const b = u.boards || 1; (groups[b] = groups[b] || []).push(u); });
      Object.values(groups).forEach(g => g.sort((a, b) => b.amount - a.amount));
      const result = Object.keys(groups).map(Number).sort((a, b) => b - a)
        .map(b => ({ boards: b, stocks: groups[b].map(u => ({ code: normCode(u.code), name: u.name, price: u.price, chgPct: u.chgPct, amount: u.amount, turnover: u.turnover, industry: u.industry || '' })) }));
      _ladderCache.at = now; _ladderCache.data = result;
      e.reply('limit-ladder', result);
    } catch (err) { e.reply('limit-ladder', { error: String(err) }); }
  });

  // 大盘指数分组速览（中国指数/大盘指数/50指数/港股指数/汇率期货）
  ipcMain.on('fetch-indices-groups', async (e) => {
    try { e.reply('indices-groups', await fetchIndicesGroups()); }
    catch (err) { e.reply('indices-groups', { error: String(err) }); }
  });
  // 保留原单组指数接口供自选股指数条使用
  ipcMain.on('fetch-indices', async (e, codes) => {
    try {
      const list = Array.isArray(codes) ? codes : [codes];
      let data = parseQuotes(await fetchQuotes(list));
      const found = new Set(data.map(d => d.code));
      const missing = list.filter(c => !found.has(c));
      if (missing.length) {
        console.log('[indices] tencent missing=', missing);
        try {
          const emFallback = await fetchQuoteEMFallback(missing);
          data = data.concat(emFallback);
        } catch (e) { console.error('[indices] EM fallback failed', e); }
      }
      e.reply('indices', data);
    } catch (err) { e.reply('indices', { error: String(err) }); }
  });
  // 桌面通知（价格预警等）：优先主进程原生通知，避免渲染进程被点穿/无焦点时收不到
  ipcMain.on('show-notification', (e, payload) => {
    try {
      const n = new Notification({ title: payload && payload.title || '提示', body: payload && payload.body || '' });
      n.show();
    } catch (err) { /* 某些环境通知不可用，忽略 */ }
  });

  // 分时走势：所有代码并行拉取，板块批量一次请求，互不阻塞
  ipcMain.on('fetch-minute', async (e, codes) => {
    try {
      const list = Array.isArray(codes) ? codes : [codes];
      const bk = list.filter(c => /^bk/i.test(c));
      const others = list.filter(c => !/^bk/i.test(c));
      const out = {};
      const tasks = [];
      // 股票/指数/ETF：腾讯，逐码并行；若腾讯为空则回退东财 trends2
      // 期货（fu 开头）腾讯无数据且会返回 HTML 错误页，直接走东财
      for (const code of others) {
        tasks.push((async () => {
          let s = [];
          if (/^fu/i.test(code)) {
            try { s = await fetchMinuteEM(code); } catch (e) {}
          } else {
            try { s = await fetchMinute(code); } catch (e) {}
            if (!s || !s.length) {
              try { s = await fetchMinuteEM(code); } catch (e) {}
            }
          }
          out[code] = s;
        })());
      }
      // 板块：东财 trends2 优先；被限流时用成分股腾讯分时等权合成（否则板块行没有分时小图）
      if (bk.length) {
        tasks.push((async () => {
          for (const code of bk) {
            let s = [];
            try { const em = await fetchMinuteEM(code); if (Array.isArray(em)) s = em; } catch (e) {}
            if (!s || !s.length) { try { s = await fetchBoardMinute(code); } catch (e) {} }
            out[code] = s || [];
          }
        })());
      }
      await Promise.all(tasks);
      e.reply('minute', out);
    } catch (err) { e.reply('minute', { error: String(err) }); }
  });
  // 名称/代码搜索（多结果：东方财富 suggest）
  ipcMain.on('fetch-search', async (e, kw) => {
    try { e.reply('search', await fetchSuggestEM(kw)); }
    catch (err) { e.reply('search', { error: String(err) }); }
  });
  // 静默搜索（批量导入用，不弹搜索下拉框）
  ipcMain.on('fetch-search-silent', async (e, kw) => {
    try { e.reply('search-silent', await fetchSuggestEM(kw)); }
    catch (err) { e.reply('search-silent', { error: String(err) }); }
  });
  // 复制文本到系统剪贴板（右键菜单「复制代码/名称」用）
  ipcMain.on('copy-text', (e, text) => {
    try { clipboard.writeText(String(text || '')); } catch (err) {}
  });
  // 下拉菜单用：显隐 / 重置位置
  ipcMain.on('toggle-win', () => toggleWin());
  ipcMain.on('reset-position', () => resetWindowPosition());
  // 渲染端同步自选股列表（供托盘行情子菜单）
  ipcMain.on('sync-watchlist', (e, list) => {
    stockList = Array.isArray(list) ? list : [];
    if (tray) buildTrayMenu(); // 刷新托盘行情子菜单
  });
  // 托盘「添加自选」→ 显示窗口并聚焦输入框
  function focusAdd() {
    if (!win) return;
    win.show();
    applyTop(); // 重新置顶并提到最前
    win.focus();
    win.webContents.send('focus-add');
  }
  ipcMain.on('focus-add', focusAdd);
  // 导出自选股（分组 + 设置 + 预警 + 持仓）为 JSON 文件
  ipcMain.on('export-watchlist', (e, data) => {
    try {
      dialog.showSaveDialog(win, {
        title: '导出自选股',
        defaultPath: 'stock-widget-backup.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      }).then(res => {
        if (!res.canceled && res.filePath) {
          fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
          e.reply('export-done', { ok: true, path: res.filePath });
        } else {
          e.reply('export-done', { ok: false });
        }
      }).catch(err => e.reply('export-done', { ok: false, err: String(err) }));
    } catch (err) { e.reply('export-done', { ok: false, err: String(err) }); }
  });
  // 导出持仓为 CSV（含实时市值/今日盈亏/持仓盈亏）；BOM 防 Excel 中文乱码
  ipcMain.on('export-csv', (e, rows) => {
    try {
      dialog.showSaveDialog(win, {
        title: '导出持仓CSV',
        defaultPath: '持仓.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      }).then(res => {
        if (res.canceled || !res.filePath) { e.reply('export-csv-done', { ok: false }); return; }
        const headers = ['代码', '名称', '市场', '股数', '加权成本', '现价', '市值', '今日盈亏', '持仓盈亏'];
        const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const lines = [headers.join(',')].concat(rows.map(r => [r.code, r.name, r.cur, r.shares, r.avgCost, r.price, r.mv, r.today, r.holding].map(esc).join(',')));
        fs.writeFileSync(res.filePath, '﻿' + lines.join('\r\n'), 'utf8');
        e.reply('export-csv-done', { ok: true });
      }).catch(err => e.reply('export-csv-done', { ok: false, err: String(err) }));
    } catch (err) { e.reply('export-csv-done', { ok: false, err: String(err) }); }
  });
  ipcMain.on('import-watchlist', (e) => {
    try {
      dialog.showOpenDialog(win, {
        title: '导入自选股',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      }).then(res => {
        if (res.canceled || !res.filePaths || !res.filePaths[0]) { e.reply('import-data', { ok: false }); return; }
        let txt;
        try { txt = fs.readFileSync(res.filePaths[0], 'utf8'); }
        catch (err) { e.reply('import-data', { ok: false, err: '读取失败：' + err.message }); return; }
        let parsed;
        try { parsed = JSON.parse(txt); } catch (err) { e.reply('import-data', { ok: false, err: '文件格式错误' }); return; }
        // 含设置 → 询问恢复策略；选「保留当前设置」则剥离 settings 仅合并自选
        if (parsed && parsed.settings && typeof parsed.settings === 'object') {
          const choice = dialog.showMessageBoxSync(win, {
            type: 'question',
            title: '导入设置',
            message: '该备份包含界面设置（主题 / 透明度 / 鼠标穿透等）。是否一并恢复？',
            detail: '选「保留当前设置」只合并自选股，不改你的界面；选「恢复备份设置」会覆盖当前界面设置。',
            buttons: ['保留当前设置', '恢复备份设置', '取消导入'],
            defaultId: 0,
            cancelId: 2,
          });
          if (choice === 2) { e.reply('import-data', { ok: false }); return; }
          if (choice === 0) {
            const clone = Object.assign({}, parsed); delete clone.settings;
            txt = JSON.stringify(clone);
          }
        }
        e.reply('import-data', { ok: true, data: txt });
      }).catch(err => e.reply('import-data', { ok: false, err: String(err) }));
    } catch (err) { e.reply('import-data', { ok: false, err: String(err) }); }
  });
  // 折叠（只显示常驻票）
  ipcMain.on('set-collapsed', (e, collapsed) => {
    if (!win) return;
    const b = win.getBounds();
    if (collapsed) { savedHeight = b.height; animateBounds({ ...b, height: collapsedHeight }); }
    else { animateBounds({ ...b, height: savedHeight || 470 }); }
  });
}

function buildUrl(code) {
  if (code.startsWith('bk')) return `https://data.eastmoney.com/bkzj/${code.replace(/^bk/i, 'BK')}.html`;
  if (code.startsWith('hk')) return `https://gu.qq.com/${code}`;
  return `https://quote.eastmoney.com/${code}.html`;
}

// 按代码/名称识别该股票的当日涨跌停幅度（%），用于准确统计涨停/跌停家数
// 主板/北交所?：主板与沪深B股 ±10%；创业板(30/301)、科创板(688/689) ±20%；
// 北交所(8xxxxx/4xxxxx/92xxxx) ±30%；ST/*ST ±5%（名称判断优先）
function limitPctOf(code, name) {
  const n = String(name || '');
  if (/^(?:\*?ST\b|\*ST)/i.test(n) || /^ST\s/i.test(n)) return 5;
  const c = String(code || '');
  if (/^8|^4|92/.test(c)) return 30;          // 北交所
  if (/^688|^689/.test(c)) return 20;         // 科创板
  if (/^30/.test(c)) return 20;               // 创业板
  return 10;                                  // 主板 + 沪深B股
}
// 本地日期 YYYYMMDD（避免 toISOString 的 UTC 偏差导致「较昨日」错位）
function localDate() {
  const d = new Date();
  const ld = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return ld.toISOString().slice(0, 10).replace(/-/g, '');
}
function buildMarketSummary(list) {
  const up = list.filter(d => typeof d.chgPct === 'number' && !isNaN(d.chgPct) && d.chgPct > 0).length;
  const down = list.filter(d => typeof d.chgPct === 'number' && !isNaN(d.chgPct) && d.chgPct < 0).length;
  const flat = list.filter(d => d.chgPct === 0).length;
  // 涨停/跌停：按板块涨跌幅限制判定（容差 0.10% 吸收 f3 两位小数四舍五入）。
  // 上限 L+0.5 / 下限 -L-0.5 用于排除无涨跌幅限制的票（新股上市首日、退市整理期等），
  // 否则这些票会被误判为涨停/跌停（同花顺不计）。
  const limitUp = list.filter(d => { const L = limitPctOf(d.code, d.name); return typeof d.chgPct === 'number' && !isNaN(d.chgPct) && d.chgPct >= L - 0.10 && d.chgPct <= L + 0.5; }).length;
  const limitDown = list.filter(d => { const L = limitPctOf(d.code, d.name); return typeof d.chgPct === 'number' && !isNaN(d.chgPct) && d.chgPct <= -L + 0.10 && d.chgPct >= -L - 0.5; }).length;
  const amount = list.reduce((s, d) => s + d.amount, 0);
  const dist = {
    '>10%': 0, '7~10%': 0, '5~7%': 0, '3~5%': 0, '0~3%': 0,
    '0': 0, '0~-3%': 0, '-3~-5%': 0, '-5~-7%': 0, '-7~-10%': 0, '<-10%': 0
  };
  for (const d of list) {
    const p = d.chgPct;
    if (p > 10) dist['>10%']++;
    else if (p >= 7) dist['7~10%']++;
    else if (p >= 5) dist['5~7%']++;
    else if (p >= 3) dist['3~5%']++;
    else if (p > 0) dist['0~3%']++;
    else if (p === 0) dist['0']++;
    else if (p > -3) dist['0~-3%']++;
    else if (p > -5) dist['-3~-5%']++;
    else if (p > -7) dist['-5~-7%']++;
    else if (p > -10) dist['-7~-10%']++;
    else dist['<-10%']++;
  }
  // 昨日成交额缓存：用于计算放量（用本地日期，避免跨时区错位）
  const today = localDate();
  let cache = storeData['market-amount-cache'] || { date: '', amount: 0, prevAmount: 0 };
  let prevAmount = cache.prevAmount || 0;
  if (today > cache.date) {
    // 新的一天：昨天的最终成交额 = 缓存里上一交易日的 amount
    prevAmount = cache.amount || 0;
    cache = { date: today, amount, prevAmount };
  } else if (today === cache.date) {
    cache = { ...cache, amount };
  }
  storeData['market-amount-cache'] = cache;
  scheduleStoreSave();
  // 首次运行无缓存时按当日 95% 兜底，避免放量显示为 100%
  if (prevAmount <= 0) prevAmount = amount * 0.95;
  // 预测全天成交额（按交易时间进度线性外推；240分钟为 A 股总交易时长）
  const now = new Date();
  const h = now.getHours(), m = now.getMinutes();
  let elapsed = 0;
  if (h > 9 || (h === 9 && m >= 30)) elapsed = (h - 9) * 60 + (m - 30);
  if (h > 11 || (h === 11 && m >= 30)) elapsed += 90; // 早盘 120 分钟
  if (h > 13 || (h === 13 && m >= 0)) elapsed += (h - 13) * 60 + m;
  elapsed = Math.max(1, Math.min(240, elapsed));
  const predictedAmount = (h >= 15 && m > 0) ? amount : (amount / (elapsed / 240));
  return { up, down, flat, limitUp, limitDown, amount, prevAmount, amountDelta: amount - prevAmount, predictedAmount, distribution: dist };
}

function toggleWin() {
  if (!win) return;
  // 收起态（可见但贴边隐藏）按「显示/隐藏」应召回，而非再次隐藏
  if (win.isVisible() && !edgeHidden) {
    win.hide();
  } else {
    // 收起态、或窗口越界（多屏/分辨率变化）→ 直接拉回主屏可见区并取消吸附/收起，
    // 保证点「显示窗口」一定能在眼前看到，而不是只展开回边缘细条
    if (edgeHidden || !isWindowVisibleOnScreen()) {
      resetWindowPosition();
    } else {
      win.show();
      win.setBounds(clampToScreen(win.getBounds()));
    }
    applyTop(); // 重新置顶（尊重 aotEnabled，仅在用户开启置顶时强制）
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
    win.focus(); // 用户主动显隐时同时置为活动窗口，确保立刻在眼前
  }
}

function buildTrayMenu() {
  const visible = !!(win && win.isVisible() && !edgeHidden);
  const quoteItems = stockList.length
    ? [
        ...stockList.slice(0, 10).map(item => ({
          label: `${item.name || item.code}    ${item.code}`,
          click: () => {
            shell.openExternal(buildUrl(item.code));
            if (win && !win.isVisible()) toggleWin();
          },
        })),
        ...(stockList.length > 10 ? [{ type: 'separator' }, { label: `还有 ${stockList.length - 10} 只自选股…`, enabled: false }] : []),
      ]
    : [{ label: '（暂无自选股）', enabled: false }];

  function ensureVisible() {
    if (!win) return;
    if (!win.isVisible() || edgeHidden) toggleWin();
  }

  function sendView(viewName) {
    ensureVisible();
    if (!win) return;
    if (viewName === 'pet') win.webContents.send('open-pet-center');
    else win.webContents.send('switch-view', viewName);
  }

  const template = [
    // 核心显示控制
    { label: visible ? '隐藏窗口' : '显示窗口', click: () => toggleWin() },
    { type: 'separator' },

    // 快捷操作
    { label: '添加自选…', click: () => focusAdd() },
    {
      label: '打开视图',
      submenu: [
        { label: '自选股', click: () => sendView('watchlist') },
        { label: '持仓', click: () => sendView('portfolio') },
        { label: '行情榜单', click: () => sendView('market') },
        { type: 'separator' },
        { label: '萌宠交易所', click: () => sendView('pet') },
      ],
    },

    // 行情子菜单
    { label: '自选股行情', submenu: quoteItems },
    { type: 'separator' },

    // 窗口工具
    {
      label: '鼠标穿透',
      type: 'checkbox',
      checked: clickThrough,
      click: () => {
        clickThrough = !clickThrough;
        if (win) win.setIgnoreMouseEvents(clickThrough, { forward: true });
        if (win) win.webContents.send('click-through-changed', clickThrough);
        buildTrayMenu();
      },
    },
    { label: '重置窗口位置', click: () => resetWindowPosition() },
    { type: 'separator' },

    // 引流：官方交流群
    { label: '加入交流群', click: () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); win.webContents.send('group-open-panel'); } } },
    { type: 'separator' },

    // 其他
    { label: '检查更新', click: () => checkForUpdates(true) },
    { label: '退出', click: () => { allowQuit = true; app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  // 从内存 Buffer 创建（ICO 按路径加载在中文安装路径下会失败），PNG 多分辨率由系统自动缩放
  const img = pngIcon();
  if (!img || img.isEmpty()) { console.error('图标缺失或读取失败，无法创建托盘'); logError('createTray', new Error('icon empty')); return; }
  tray = new Tray(img);
  tray.setToolTip('股票自选小窗');
  tray.on('click', () => toggleWin());
  buildTrayMenu();
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide(); // macOS 下连 Dock 也隐藏，做到完全托盘
  createWindow();
  createTray();
  try {
    // 全局快捷键：Ctrl+Alt+S 显隐窗口
    globalShortcut.register('Ctrl+Alt+S', () => toggleWin());
  } catch (e) { console.error('全局快捷键注册失败：', e); }
});

app.on('will-quit', () => {
  allowQuit = true; // 真正退出时放行窗口 close，避免行情条/主窗口拦截导致后台残留
  try { if (tickerBar && !tickerBar.isDestroyed()) tickerBar.destroy(); } catch (e) {}
  try {
    // 涨跌幅排序是临时查看态，退出时不固化，避免覆盖用户自己排好的自选顺序
    // （仅影响“退出应用”后重新打开；隐藏到托盘不触发，排序保持）
    const s = storeData['stock-widget-settings'];
    if (s && typeof s === 'object') s.sortByChange = false;
  } catch (e) { logError('reset-sortByChange', e); }
  try { saveStoreFile(); } catch {}
  try { globalShortcut.unregisterAll(); } catch {}
});

app.on('activate', () => { if (win) toggleWin(); });
