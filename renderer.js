// 渲染进程：UI 与交互逻辑
const { ipcRenderer } = require('electron');

// ---------- 配置/自选持久化 ----------
// 实际文件读写由主进程完成（store.js 逻辑在 main.js，文件位于 userData 目录，与 bounds.json 同机制、可靠跨重启）。
// 渲染进程只通过同步 IPC 把键值交给主进程落盘，避免渲染进程 fs 写入被环境吞掉导致配置丢失。
function sGet(k) {
  if (!k) { console.error('[store] sGet 收到无效键名:', k); return null; }
  try { return ipcRenderer.sendSync('store-get', k); } catch (e) { return null; }
}
// 关键修复（消除卡死）：改为异步 ipcRenderer.send，渲染线程不再被阻塞等待主进程写文件。
// 主进程收到后内存立即更新，文件写入防抖；退出时 will-quit 统一落盘，不会丢配置。
function sSet(k, v) {
  if (!k) { console.error('[store] sSet 收到无效键名:', k, '—— 配置未保存！'); return; }
  try { ipcRenderer.send('store-set', k, v); } catch (e) {}
}

const STORE_KEY = 'stock-widget-watchlist';   // 旧版单列表（迁移用）
const GROUP_KEY = 'stock-widget-groups';      // 新版分组存储
const SET_KEY = 'stock-widget-settings';      // 设置项存储（注意：此前漏定义导致配置存到 undefined 键、每次重启被重置）
const PRESETS = [
  { code: 'sh600519', name: '贵州茅台', label: '茅台' },
  { code: 'sz000001', name: '平安银行', label: '平安' },
  { code: 'sz300750', name: '宁德时代', label: '宁德' },
  { code: 'sh600036', name: '招商银行', label: '招行' },
  { code: 'hk00700', name: '腾讯控股', label: '腾讯' },
];

// ---------- 状态 ----------
let groupsState = loadGroupsState();
if (!groupsState) groupsState = { groups: initGroups(), activeId: null };
let groups = groupsState.groups;
let activeGroupId = (groupsState.activeId && groups.find(g => g.id === groupsState.activeId))
  ? groupsState.activeId : (groups[0] && groups[0].id);
// watchlist 始终指向“当前激活分组”的 items，增删/排序都直接作用在分组上
let watchlist = groups.length ? activeGroup().items : [];
let settings = Object.assign(
  {
    opacity: 0.9, interval: 3000, alwaysOnTop: true, locked: false, clickThrough: false,
    edgeHide: true, // QQ 式贴边自动收起（默认开）
    sortByChange: false, compact: false,
    upColor: '#e23b3b', downColor: '#12a150', pinned: '',
    glass: 0.48, theme: 'light', alertSound: true, fontSize: 13,
    rateUSD: 7.2, rateHKD: 0.92, // 持仓汇总用：外币→人民币近似汇率（用户可在设置调整）
    showChg: true, showHL: true, showPnl: true, showSpark: true, // 列表列显隐（用户可在设置调整）
    sparkMode: 'change', sparkColor: '#5b8def', // 分时图颜色：随涨跌 / 纯色
    taskbarTicker: true, // 任务栏行情条：贴任务栏空白区显示常驻票
    pinnedList: [], // 多只常驻票：任务栏行情条按此列表轮播（兼容旧单值 settings.pinned，pinned 恒 = pinnedList[0]）
    tickerRotateSec: 8 // 轮播间隔（秒）
  },
  loadSettings()
);
// 兼容旧设置：背景浓度可设为 0（完全透明背景、只留毛玻璃，模糊自动拉满保证文字清晰）。
// 注意：不能用 `|| 0.48` —— glass=0 是用户拖到最左的有效值，若当默认会静默重置为 0.48，表现为"背景浓度不保存"。
// 仅当 truly 缺失（isNaN）时才用默认 0.48；0 是合法值，必须保留。
const gRaw = parseFloat(settings.glass);
settings.glass = (isNaN(gRaw) ? 0.48 : Math.max(0, Math.min(0.95, gRaw)));
// 兼容旧版单常驻票：pinnedList 缺失/为空时从 pinned 迁移
if (!Array.isArray(settings.pinnedList)) settings.pinnedList = [];
if (!settings.pinnedList.length && settings.pinned) settings.pinnedList = [settings.pinned];
let timer = null;
let minuteTimer = null;
let searchTimer = null;
let lastSearch = [];     // 最近一次名称搜索的多条结果
let searchActiveIdx = -1; // 下拉高亮项索引（键盘导航）
let collapsed = false;
const pctMap = {}; // 代码 -> 涨跌幅，用于排序
const sparkData = {}; // 代码 -> [{t,p}] 分时序列（供 tooltip）
const spark5DayData = {}; // 代码 -> [{t,p,v,amount,avg}] 五日分时序列
const sparkPrevClose = {}; // 代码 -> 昨收价（供重排后恢复分时图基准线）
const alertState = {}; // 代码 -> {hi:bool, lo:bool} 预警触发状态（离开区间后自动复位，可再次触发）
const notifyLog = {}; // 预警通知去抖：key -> 上次时间
const lastPrice = {}; // 代码 -> 最新价（供持仓盈亏汇总，避免每次重算都依赖行情推送）
const klineData = {}; // `${code}|${period}` -> [{date,open,close,high,low,volume}]（K线缓存，避免每次重绘都拉取）
const rankData = { byTab: { up: [], down: [], turn: [], amount: [] }, tab: 'up' }; // 行情榜单：四榜单分别服务端排序

// 大盘指数速览（固定一组 A股核心指数，独立于自选股）
const INDICES = [
  { code: 'sh000001', name: '上证' },
  { code: 'sz399001', name: '深证' },
  { code: 'sz399006', name: '创业板' },
  { code: 'sh000688', name: '科创50' },
  { code: 'sh000300', name: '沪深300' },
  { code: 'sh000016', name: '上证50' },
  { code: 'sh000905', name: '中证500' },
  { code: 'sh000852', name: '中证1000' },
  { code: 'sz399330', name: '深证100' },
  { code: 'sz399005', name: '中小100' },
  { code: 'hkHSI', name: '恒生' },
  { code: 'sh000015', name: '红利指数' },
];

// 轻量 toast 容器（价格预警等提示）
const toastEl = document.createElement('div');
toastEl.className = 'toast-wrap';
document.body.appendChild(toastEl);

// ---------- DOM ----------
const listEl = document.getElementById('list');
const codeInput = document.getElementById('codeInput');
const settingsBtn = document.getElementById('settingsBtn');
const closeBtn = document.getElementById('closeBtn');
const refreshBtn = document.getElementById('refreshBtn');
const collapseBtn = document.getElementById('collapseBtn');
const menuBtn = document.getElementById('menuBtn');
const menu = document.getElementById('menu');
const menuToggle = document.getElementById('menuToggle');
const menuCollapse = document.getElementById('menuCollapse');
const menuReset = document.getElementById('menuReset');
const menuReload = document.getElementById('menuReload');
const menuQuit = document.getElementById('menuQuit');
const searchBox = document.getElementById('searchBox');
const settingsPanel = document.getElementById('settingsPanel');
const welcomeMask = document.getElementById('welcomeMask');
const opacitySlider = document.getElementById('opacitySlider');
const opacityVal = document.getElementById('opacityVal');
const glassSlider = document.getElementById('glassSlider');
const glassVal = document.getElementById('glassVal');
const fontSizeSlider = document.getElementById('fontSizeSlider');
const fontSizeVal = document.getElementById('fontSizeVal');
const themeSel = document.getElementById('themeSel');
const manageList = document.getElementById('manageList');
const intervalSel = document.getElementById('intervalSel');
const aotChk = document.getElementById('aotChk');
const taskbarChk = document.getElementById('taskbarChk');
const lockChk = document.getElementById('lockChk');
const clickChk = document.getElementById('clickChk');
const edgeChk = document.getElementById('edgeChk');
const sortChk = document.getElementById('sortChk');
const compactChk = document.getElementById('compactChk');
const upColor = document.getElementById('upColor');
const downColor = document.getElementById('downColor');
const groupsEl = document.getElementById('groups');
const groupsTrack = document.getElementById('groupsTrack');
const groupAddBtn = document.getElementById('groupAdd');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const titlebar = document.getElementById('titlebar');
const indicesEl = document.getElementById('indices');
const refreshBar = document.getElementById('refreshBar');
const chartModal = document.getElementById('chartModal');
const chartBig = document.getElementById('chartBig');
const chartTitle = document.getElementById('chartTitle');
const chartSub = document.getElementById('chartSub');
const chartAxis = document.getElementById('chartAxis');
const chartClose = document.getElementById('chartClose');
const chartTabs = document.getElementById('chartTabs');
const chartTabsTrack = document.getElementById('chartTabsTrack');
const chartTabsMore = document.getElementById('chartTabsMore');
const chartTabsDropdown = document.getElementById('chartTabsDropdown');
const indBtn = document.getElementById('indBtn');
const indPanel = document.getElementById('indPanel');
const rankBtn = document.getElementById('rankBtn');
const rankModal = document.getElementById('rankModal');
const rankTabs = document.getElementById('rankTabs');
const rankList = document.getElementById('rankList');
const rankClose = document.getElementById('rankClose');
// 新增 UI 元素引用：帮助按钮 / 弹窗 / 持仓汇总 / 右键菜单 / 备份导入 / 引导
const helpBtn = document.getElementById('helpBtn');
const helpModal = document.getElementById('helpModal');
const helpClose = document.getElementById('helpClose');
const helpBody = document.getElementById('helpBody');
const pfSummary = document.getElementById('pfSummary');
const pfGroupBtn = document.getElementById('pfGroupBtn');
const ctxMenu = document.getElementById('ctxMenu');
const exportBtn = document.getElementById('exportBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const importBtn = document.getElementById('importBtn');
const batchInput = document.getElementById('batchInput');
const batchAddBtn = document.getElementById('batchAddBtn');
const soundChk = document.getElementById('soundChk');
const rateUSD = document.getElementById('rateUSD');
const rateHKD = document.getElementById('rateHKD');
const colChg = document.getElementById('colChg');
const colHL = document.getElementById('colHL');
const colPnl = document.getElementById('colPnl');
const colSpark = document.getElementById('colSpark');
const sparkModeSel = document.getElementById('sparkModeSel');
const sparkColor = document.getElementById('sparkColor');
const settingsManageBtn = document.getElementById('settingsManageBtn');
const onboard = document.getElementById('onboard');
const onboardText = document.getElementById('onboardText');
const onboardDots = document.getElementById('onboardDots');
const onboardNext = document.getElementById('onboardNext');
const onboardSkip = document.getElementById('onboardSkip');
const watchlistView = document.getElementById('watchlistView');
const portfolioView = document.getElementById('portfolioView');
const indicesView = document.getElementById('indicesView');
const marketView = document.getElementById('marketView');
const viewSelector = document.getElementById('viewSelector');
const vsLabel = document.getElementById('vsLabel');
const viewDropdown = document.getElementById('viewDropdown');
const portfolioList = document.getElementById('portfolioList');
const pfHeaderNums = document.getElementById('pfHeaderNums');
const pfAddBtn = document.getElementById('pfAddBtn');
const indicesGrid = document.getElementById('indicesGrid');
const indicesGroups = document.getElementById('indicesGroups');
const marketSummary = document.getElementById('marketSummary');
const marketVolume = document.getElementById('marketVolume');
const trendCanvas = document.getElementById('trendCanvas');
const distCanvas = document.getElementById('distCanvas');
const distUpdated = document.getElementById('distUpdated');
const trendLegend = document.getElementById('trendLegend');
const trendTabs = document.getElementById('trendTabs');

// 新增数据视图 DOM 引用（热榜/天梯/板块/ETF）
const hotView = document.getElementById('hotView');
const hotList = document.getElementById('hotList');
const hotTabs = document.getElementById('hotTabs');
const ladderView = document.getElementById('ladderView');
const ladderList = document.getElementById('ladderList');
const ladderFilters = document.getElementById('ladderFilters');
const sectorsView = document.getElementById('sectorsView');
const sectorsTabs = document.getElementById('sectorsTabs');
const sectorsHead = document.getElementById('sectorsHead');
const sectorsList = document.getElementById('sectorsList');
const etfView = document.getElementById('etfView');
const etfList = document.getElementById('etfList');
const etfTabs = document.getElementById('etfTabs');
const etfTabsTrack = document.getElementById('etfTabsTrack');
const etfTabsMore = document.getElementById('etfTabsMore');
const etfTabsDropdown = document.getElementById('etfTabsDropdown');
const etfHead = document.getElementById('etfHead');
const boardModal = document.getElementById('boardModal');
const boardList = document.getElementById('boardList');
const boardTitle = document.getElementById('boardTitle');
const boardClose = document.getElementById('boardClose');

// 贴边吸附微光层（主进程 dock 时发送 edge-snap 触发一道边缘光）
const edgeGlow = document.createElement('div');
edgeGlow.className = 'edge-glow';
document.body.appendChild(edgeGlow);
let edgeGlowTimer = null;
// 窗口 resize 时重绘所有分时小图，让弹性放大的 SVG 保持清晰
let resizeSparkTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeSparkTimer);
  resizeSparkTimer = setTimeout(() => {
    for (const code in sparkData) drawSpark(code, sparkData[code]);
    if (chartCode) drawBigChart(chartCode);
    if (currentView === 'market') { drawDistChart(); drawTrendChart(); }
  }, 120);
});
// 窗口从后台切回（如 Alt-Tab、贴边唤出）后，若处于自选股视图则重绘分时，避免蓝色畸形块
window.addEventListener('focus', () => {
  if (currentView === 'watchlist') setTimeout(() => redrawAllSparks(), 60);
});
ipcRenderer.on('edge-snap', (event, edge) => {
  edgeGlow.className = 'edge-glow show ' + edge;
  if (edgeGlowTimer) clearTimeout(edgeGlowTimer);
  edgeGlowTimer = setTimeout(() => edgeGlow.classList.remove('show'), 1200);
});

// 滚动时给容器加 .scrolling，使精致滚动条浮现（停止 700ms 后淡出）
function attachScrollHint(el) {
  if (!el) return;
  let t = null;
  el.addEventListener('scroll', () => {
    el.classList.add('scrolling');
    if (t) clearTimeout(t);
    t = setTimeout(() => el.classList.remove('scrolling'), 700);
  }, { passive: true });
}
[listEl, settingsPanel, manageList, rankList, helpBody, groupsTrack, searchBox, portfolioList, indicesGrid, marketView, hotList, ladderList, sectorsList, etfList, boardList].forEach(attachScrollHint);
// 视图整体滚动提示（缩窗时 .view 自身可滚动，需同样浮现滚动条）
document.querySelectorAll('.view').forEach(attachScrollHint);

// ---------- 存储 ----------
function uid() { return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function activeGroup() { return groups.find(g => g.id === activeGroupId) || groups[0]; }
function loadGroupsState() {
  try {
    const o = JSON.parse(sGet(GROUP_KEY));
    if (o && Array.isArray(o.groups) && o.groups.length &&
        o.groups.every(g => g && Array.isArray(g.items))) return o;
  } catch {}
  return null;
}
function initGroups() {
  // 全新用户默认：一个「自选」分组，只放基本指数；PRESETS 仅作为添加面板的快捷胶囊保留
  let legacy = [];
  try { legacy = JSON.parse(sGet(STORE_KEY)) || []; } catch {}
  if (Array.isArray(legacy) && legacy.length) return [{ id: uid(), name: '我的自选', items: legacy }];
  return [{ id: uid(), name: '自选', items: [{ code: 'sh000001', name: '上证指数', alertHigh: '', alertLow: '', cost: '', shares: '' }] }];
}
function saveGroups() { sSet(GROUP_KEY, JSON.stringify({ groups, activeId: activeGroupId })); notifySaved(); }
function saveWatchlist() { saveGroups(); } // 兼容旧调用：分组结构统一存 GROUP_KEY
// 输入框每次击键都即时写盘会卡顿（大列表尤甚），这里做 400ms 防抖；结构性变更仍用 saveWatchlist() 即时保存
let _saveTimer = null;
function saveWatchlistDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; saveGroups(); }, 400);
}
function loadSettings() {
  try { return JSON.parse(sGet(SET_KEY)) || {}; } catch { return {}; }
}
function saveSettings() { sSet(SET_KEY, JSON.stringify(settings)); notifySaved(); }

// ---------- 代码归一化 ----------
// 内部代码转展示用代码：剥离 fu（期货）内部前缀，让行情行/搜索结果显示原始合约码（如 CN00Y 而非 fuCN00Y）
function uiCode(code) {
  if (!code) return '';
  return String(code).replace(/^fu/i, '');
}
function normalizeCode(raw) {
  let s = (raw || '').trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('sh') || s.startsWith('sz') || s.startsWith('hk') || s.startsWith('bj') || s.startsWith('us') || s.startsWith('bk') || s.startsWith('fu')) return s;
  // 富时A50期货：直接输入 CN0W/CN0Y/CN00Y 时统一加上 fu 前缀
  if (/^cn\d*[yw]$/.test(s)) return 'fu' + s.toUpperCase();
  if (/^\d{4,6}$/.test(s)) {
    const c = s[0];
    if (c === '6') return 'sh' + s;        // 沪市
    if (c === '0' || c === '3') return 'sz' + s; // 深市
    if (c === '8' || c === '4') return 'bj' + s; // 北交所
  }
  return s;
}

// ---------- 市场与汇率（持仓汇总换算用）----------
// 按代码前缀判断市场与计价币种：A股/指数/板块→人民币；港股→港币；美股→美元
function marketOf(code) {
  if (!code) return 'CNY';
  const c = String(code).toLowerCase();
  if (c.startsWith('hk')) return 'HKD';
  if (c.startsWith('us')) return 'USD';
  return 'CNY';
}
const CUR_SYM = { CNY: '¥', HKD: 'HK$', USD: '$' };
// 外币金额换算为人民币（按设置里的近似汇率），便于跨市场统一汇总
function fxToCNY(market, v) {
  if (market === 'HKD') return v * (parseFloat(settings.rateHKD) || 0.92);
  if (market === 'USD') return v * (parseFloat(settings.rateUSD) || 7.2);
  return v;
}

// ---------- 渲染列表（按 code 键合的增量渲染：复用已有行节点，避免增删时全列表闪烁） ----------
function createRow(item) {
  const row = document.createElement('div');
  row.className = 'row' + (settings.pinnedList.includes(item.code) ? ' pinned' : '');
  row.dataset.code = item.code;
  row.innerHTML = `
    <div class="row-head">
      <div class="info">
        <div class="name"><span>${item.name || item.code}</span></div>
        <div class="code">${uiCode(item.code)}</div>
      </div>
      <div class="chart"><svg class="spark" viewBox="0 0 90 38" preserveAspectRatio="none"></svg></div>
      <div class="price-wrap">
        <div class="chg">--</div>
        <div class="price">--</div>
        <div class="hl" style="display:none">高 -- · 低 --</div>
      </div>
      <div class="acts">
        <button class="pin no-drag" data-code="${item.code}" title="设为常驻票（任务栏轮播）">☆</button>
        <button class="del no-drag" data-idx="0" title="删除">×</button>
      </div>
    </div>
    <div class="pnl" style="display:none"></div>`;
  // 缓存子节点引用，避免每次行情刷新都 querySelector（减少 60fps 下的 DOM 查询开销）
  row._r = {
    price: row.querySelector('.price'),
    chg: row.querySelector('.chg'),
    hl: row.querySelector('.hl'),
    pnl: row.querySelector('.pnl'),
    name: row.querySelector('.name'),
  };
  return row;
}
function render() {
  const has = new Set(watchlist.map(w => w.code));
  // 兜底：移除已不存在的行（正常删除走 removeStock 的离场动画，不会进这里）
  listEl.querySelectorAll('.row').forEach(r => { if (!has.has(r.dataset.code)) r.remove(); });
  if (watchlist.length === 0) {
    if (!listEl.querySelector('.empty')) {
      listEl.innerHTML = '<div class="empty">在上方输入代码或名称搜索，选择即可添加（支持板块：搜「半导体」选中，或输入东财板块码 BK1036）</div>';
    }
    return;
  }
  const emptyEl = listEl.querySelector('.empty');
  if (emptyEl) emptyEl.remove();
  // 按 watchlist 顺序确保每行存在并归位（已存在的行只移动、不重建，保留热力/闪烁/分时图）
  let prev = null;
  watchlist.forEach(item => {
    let row = listEl.querySelector(`.row[data-code="${item.code}"]`);
    if (!row) {
      row = createRow(item);
      row.classList.add('entering');
      row.addEventListener('animationend', () => row.classList.remove('entering'), { once: true });
      if (prev) prev.after(row); else listEl.prepend(row);
    } else if (prev) {
      if (row.previousElementSibling !== prev) prev.after(row);
    } else if (row !== listEl.firstElementChild) {
      listEl.prepend(row);
    }
    prev = row;
  });
  rebuildMaps();
}

// code→行 / code→item 映射：行情高频刷新时避免反复 querySelector 与线性查找（60fps 关键路径）
const rowMap = new Map();
const itemMap = new Map();
function rebuildMaps() {
  rowMap.clear();
  itemMap.clear();
  watchlist.forEach(it => itemMap.set(it.code, it));
  listEl.querySelectorAll('.row').forEach(r => rowMap.set(r.dataset.code, r));
}

function updatePinned() {
  listEl.querySelectorAll('.row').forEach(r => {
    const on = settings.pinnedList.includes(r.dataset.code);
    r.classList.toggle('pinned', on);
    const pin = r.querySelector('.pin');
    if (pin) pin.textContent = on ? '★' : '☆'; // 常驻=金色实心星，未常驻=空心星
  });
}

// ---------- 行情刷新 ----------
let _pricesInFlight = false;
function refresh() {
  armCountdown();
  if (watchlist.length === 0) return;
  if (_pricesInFlight) return; // 慢响应时跳过本次，避免请求堆叠（配合 quotes.js 真实超时，杜绝冻屏）
  _pricesInFlight = true;
  ipcRenderer.send('fetch-prices', watchlist.map(w => w.code));
}
// 刷新倒计时进度条：每次刷新后从满格匀速收缩到 0，给用户"下一次刷新还有多久"的丝滑反馈
function armCountdown() {
  if (!refreshBar) return;
  const ms = Math.max(800, settings.interval);
  refreshBar.style.transition = 'none';
  refreshBar.style.width = '100%';
  void refreshBar.offsetWidth; // 强制重排以重启动画
  refreshBar.style.transition = `width ${ms}ms linear`;
  refreshBar.style.width = '0%';
}
function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, settings.interval);
  refresh();
}

ipcRenderer.on('prices', (event, data) => {
  _pricesInFlight = false; // 收到回复即解除在途标记（含 error/空数据分支）
  if (data && data.error) { setStatus('行情获取失败，重试中…', false); return; }
  if (!Array.isArray(data)) return;
  if (data.length === 0) { setStatus('无数据（代码无效？）', false); return; }
  data.forEach(updateRow);
  // 行情到达后按最新涨跌方向重绘行内分时：解决「分时先到 → 默认蓝色 → 行情到后才变色」的闪色问题
  redrawAllSparks();
  reorderRows();
  updatePortfolio(); // 刷新底部持仓汇总
  updateTaskbarTicker(); // 刷新任务栏/托盘常驻票徽标
  const closed = watchlist.length ? !watchlist.some(w => isMarketOpen(w.code)) : false;
  setStatus((closed ? '休市 · ' : '更新 ') + nowTime(), true);
  // 弹窗开启时，若正在看分时图则同步刷新大图
  if (chartCode && chartPeriod === 'min') drawBigChart(chartCode);
  // 添加面板开启时，回填选中股票的实时价到「现价」与成本价默认
  if (pfAddActive && pfAddSelItem && pfAddSelItem.code && Array.isArray(data)) {
    const m = data.find(d => d.code === pfAddSelItem.code);
    if (m && m.price != null) {
      const p = parseFloat(m.price);
      if (!isNaN(p)) { pfAddSelPrice.textContent = '现价 ' + fmtMoney(p); if (pfAddCost && !pfAddCost.value) pfAddCost.value = p.toFixed(2); }
    }
  }
});

// 主进程（托盘）切换鼠标穿透后同步 UI
ipcRenderer.on('click-through-changed', (event, v) => {
  settings.clickThrough = !!v;
  clickChk.checked = !!v;
  saveSettings();
});

// 鼠标穿透时：默认整窗穿透，仅设置按钮与当前可见弹窗可接收点击，
// 彻底避免穿透模式下误触电脑。
function isClickThroughInteractive(target) {
  if (!target || !target.closest) return false;
  if (target.closest('#settingsBtn')) return true;
  if (settingsPanel && !settingsPanel.hidden && target.closest('#settingsPanel')) return true;
  if (welcomeMask && !welcomeMask.hidden && target.closest('#welcomeMask')) return true;
  const modals = ['#manageModal', '#pfAddModal', '#chartModal', '#rankModal', '#boardModal', '#helpModal'];
  for (const sel of modals) {
    const el = document.querySelector(sel);
    if (el && !el.hidden && target.closest(sel)) return true;
  }
  return false;
}
let ctState = null;
function ctSet(ignore) { if (ctState === ignore) return; ctState = ignore; ipcRenderer.send('set-click-through', ignore); }
document.addEventListener('mouseover', e => {
  if (!settings.clickThrough) return;
  ctSet(!isClickThroughInteractive(e.target));
});
document.addEventListener('mouseout', e => {
  if (!settings.clickThrough) return;
  ctSet(!isClickThroughInteractive(e.relatedTarget));
});

function updateRow(d) {
  const row = rowMap.get(d.code);
  if (!row || !row._r) return;
  const { price, chg, hl } = row._r;

  pctMap[d.code] = d.changePct;

  // 价格跳动闪烁
  const prev = parseFloat(row.dataset.last || 'NaN');
  if (d.prevClose) { row.dataset.prevclose = d.prevClose; sparkPrevClose[d.code] = d.prevClose; } // 供分时图基准线
  price.textContent = d.price.toFixed(2);
  const sign = d.change >= 0 ? '+' : '';
  chg.textContent = `${sign}${d.changePct.toFixed(2)}%`;
  hl.textContent = `高 ${d.high ? d.high.toFixed(2) : '--'} · 低 ${d.low ? d.low.toFixed(2) : '--'}`;
  row.classList.remove('up', 'down', 'flat');
  row.classList.add(d.change > 0 ? 'up' : (d.change < 0 ? 'down' : 'flat'));
  // 休市变灰
  row.classList.toggle('closed', !isMarketOpen(d.code));

  // 已设预警的行加一个小标识（铃铛点）——注意默认值是空串 ''，需判断非空才点亮
  const item = itemMap.get(d.code);
  const alertSet = !!(item && (
    (item.alertHigh && String(item.alertHigh).trim() !== '') ||
    (item.alertLow && String(item.alertLow).trim() !== '')
  ));
  row.classList.toggle('has-alert', alertSet);
  if (!isNaN(prev) && d.price !== prev) {
    // 价格跳动闪烁统一用中性高亮（不再按涨跌染红绿，保持白色清爽观感）
    // 关键性能优化：用 _flashing / _bumping 标志避免每次 tick 都强制同步重排（void offsetWidth），
    // 一次动画周期内只启动一次，动画结束自动复位，既流畅又不再卡顿。
    const c = COLORS.spark;
    const rgb = hexToRgb(c);
    row.style.setProperty('--flash', rgb ? `rgba(${rgb.r},${rgb.g},${rgb.b},0.26)` : 'rgba(120,130,160,0.18)');
    if (!row._flashing) {
      row._flashing = true;
      row.classList.remove('flash');
      row.classList.add('flash');
      row.addEventListener('animationend', () => { row._flashing = false; row.classList.remove('flash'); }, { once: true });
    }
    // 价格数字轻微缩放脉冲，强化“跳动”的活感
    if (!price._bumping) {
      price._bumping = true;
      price.classList.remove('bump');
      price.classList.add('bump');
      price.addEventListener('animationend', () => { price._bumping = false; price.classList.remove('bump'); }, { once: true });
    }
  }
  row.dataset.last = d.price;
  lastPrice[d.code] = d.price;
  updateRowPnl(d.code); // 持仓盈亏（仅当填了成本价+股数时显示）

  // 价格预警检测（若该股设了高/低预警，触发桌面通知 + 应用内 toast）
  checkAlert(d);

  // 首次拿到名字后写回
  if (item && d.name && item.name !== d.name) {
    item.name = d.name;
    row._r.name.textContent = d.name;
    saveWatchlist();
  }
}

// ---------- 持仓盈亏 ----------
// 持仓信息：优先用分批建仓 lots 计算加权成本；否则回退单值 cost/shares（向后兼容）
function holdingOf(item) {
  if (!item) return null;
  const lots = item.lots;
  if (Array.isArray(lots) && lots.length) {
    let cs = 0, cv = 0;
    for (const l of lots) {
      const p = parseFloat(l && l.price), s = parseFloat(l && l.shares);
      if (!isNaN(p) && p > 0 && !isNaN(s) && s > 0) { cs += s; cv += p * s; }
    }
    if (cs > 0) return { avgCost: cv / cs, shares: cs };
    return null;
  }
  const cost = parseFloat(item.cost), shares = parseFloat(item.shares);
  if (!isNaN(cost) && cost > 0 && !isNaN(shares) && shares > 0) return { avgCost: cost, shares };
  return null;
}
// 计算浮动盈亏：持仓盈亏（相对加权成本）+ 今日盈亏（相对昨收）。未持仓返回 null
function computePnl(item, price) {
  const h = holdingOf(item);
  if (!h) return null;
  const prevClose = parseFloat(sparkPrevClose[item.code]);
  const hp = (price - h.avgCost) * h.shares;          // 持仓盈亏
  const hpPct = h.avgCost > 0 ? (hp / (h.avgCost * h.shares) * 100) : 0;
  let tp = null, tpPct = null;
  if (!isNaN(prevClose) && prevClose > 0) {
    tp = (price - prevClose) * h.shares;              // 今日盈亏
    tpPct = (price - prevClose) / prevClose * 100;
  }
  return { hp, hpPct, tp, tpPct };
}
// 盈亏数值 → 带符号、币种、涨跌色的 span（v 为 null 时返回空）
function pnlSpan(v, pct, sym, withPct) {
  if (v == null) return '';
  const cls = v >= 0 ? 'up' : 'down';
  const sign = v >= 0 ? '+' : '';
  const num = sym + Math.abs(v).toFixed(2);
  const p = withPct ? ` <span class="pct ${cls}">${sign}${pct.toFixed(2)}%</span>` : '';
  return `<span class="${cls}">${sign}${num}</span>${p}`;
}
// 刷新单行的盈亏显示：今日盈亏（相对昨收）+ 持仓盈亏（相对加权成本），红涨绿跌、带币种符号
function updateRowPnl(code) {
  const row = rowMap.get(code);
  if (!row || !row._r) return;
  const pnlEl = row._r.pnl;
  const item = itemMap.get(code);
  const h = holdingOf(item);
  const price = lastPrice[code];
  if (!h || price == null) {
    if (pnlEl._last !== '') { pnlEl.innerHTML = ''; pnlEl.style.display = 'none'; pnlEl._last = ''; }
    return;
  }
  const r = computePnl(item, price);
  if (!r || r.hp == null) {
    if (pnlEl._last !== '') { pnlEl.innerHTML = ''; pnlEl.style.display = 'none'; pnlEl._last = ''; }
    return;
  }
  const sym = CUR_SYM[marketOf(code)] || '';
  const today = pnlSpan(r.tp, r.tpPct, sym, true);
  const hold = pnlSpan(r.hp, r.hpPct, sym, true);
  const html = `<span class="pnl-t">今 ${today || '—'}</span> <span class="pnl-h">持 ${hold}</span>`;
  if (html === pnlEl._last) return; // 值未变，跳过 DOM 写，避免每 tick 重排
  pnlEl._last = html;
  pnlEl.innerHTML = html;
  pnlEl.style.display = '';
}
// 千分位格式化
function fmtMoney(n) { return (Math.round(n * 100) / 100).toLocaleString('zh-CN'); }
// 底部持仓汇总条（跨市场折算人民币）+ 分组级汇总（显示在分组栏）
function updatePortfolio() {
  if (!pfSummary) return;
  let mvCNY = 0, cvCNY = 0, n = 0;
  let tMV = 0, tCV = 0; // 今日：现价市值 vs 昨收市值
  const fxMV = { HKD: 0, USD: 0 };
  watchlist.forEach(it => {
    const price = lastPrice[it.code];
    const h = holdingOf(it);
    if (price == null || !h) return;
    const mkt = marketOf(it.code);
    const prevClose = parseFloat(sparkPrevClose[it.code]);
    mvCNY += fxToCNY(mkt, price * h.shares);
    cvCNY += fxToCNY(mkt, h.avgCost * h.shares);
    n++;
    if (mkt === 'HKD') fxMV.HKD += price * h.shares;
    else if (mkt === 'USD') fxMV.USD += price * h.shares;
    if (!isNaN(prevClose) && prevClose > 0) {
      tMV += fxToCNY(mkt, price * h.shares);
      tCV += fxToCNY(mkt, prevClose * h.shares);
    }
  });
  const sign = v => v >= 0 ? '+' : '';
  const cls = v => v >= 0 ? 'up' : 'down';
  if (n === 0) {
    pfSummary.hidden = true; pfSummary.innerHTML = ''; pfSummary._lastHtml = '';
    if (pfGroupBtn) { pfGroupBtn.hidden = true; pfGroupBtn.textContent = '持仓'; }
    return;
  }
  const pnl = mvCNY - cvCNY;
  const pct = cvCNY > 0 ? (pnl / cvCNY * 100) : 0;
  const todayPnl = tMV - tCV;
  const todayPct = tCV > 0 ? (todayPnl / tCV * 100) : 0;
  let html = `持仓 <b>${n}</b> 只 · 市值 <b>¥${fmtMoney(mvCNY)}</b> · 成本 <b>¥${fmtMoney(cvCNY)}</b> · 持仓盈亏 <b class="${cls(pnl)}">${sign(pnl)}¥${fmtMoney(Math.abs(pnl))}</b> <span class="${cls(pnl)}">(${sign(pnl)}${pct.toFixed(2)}%)</span>`;
  if (tMV > 0) html += ` · <span class="${cls(todayPnl)}">今日 ${sign(todayPnl)}¥${fmtMoney(Math.abs(todayPnl))} (${sign(todayPnl)}${todayPct.toFixed(2)}%)</span>`;
  const fxParts = [];
  if (fxMV.HKD > 0) fxParts.push(`港 HK$${fmtMoney(fxMV.HKD)}`);
  if (fxMV.USD > 0) fxParts.push(`美 $${fmtMoney(fxMV.USD)}`);
  if (fxParts.length) html += ` <span class="pf-fx">· ${fxParts.join(' · ')}</span>`;
  pfSummary.hidden = false;
  if (pfSummary._lastHtml !== html) { pfSummary.innerHTML = html; pfSummary._lastHtml = html; }
  // 分组栏右侧持仓按钮：显示持仓数量，点击切换到持仓视图
  if (pfGroupBtn) {
    pfGroupBtn.hidden = false;
    const btnText = `持仓 ${n}`;
    if (pfGroupBtn._lastText !== btnText) { pfGroupBtn.textContent = btnText; pfGroupBtn._lastText = btnText; }
  }
}

// 是否处于交易时段（按市场区分：A股 / 港股 / 美股）
function usInDST(d) {
  const y = d.getFullYear();
  const mar = new Date(y, 2, 1).getDay();
  const secondSun = 1 + (7 - mar) % 7 + 7;          // 3 月第二个周日 02:00 起
  const nov = new Date(y, 10, 1).getDay();
  const firstSun = 1 + (7 - nov) % 7;               // 11 月第一个周日 02:00 止
  const start = new Date(y, 2, secondSun, 2, 0);
  const end = new Date(y, 10, firstSun, 2, 0);
  return d >= start && d < end;
}
function isMarketOpen(code) {
  const now = new Date();
  const day = now.getDay();
  const t = now.getHours() * 60 + now.getMinutes();
  const isWeekday = day >= 1 && day <= 5;
  if (code && code.startsWith('hk')) {               // 港股（HKT = 北京时）
    if (!isWeekday) return false;
    return (t >= 570 && t <= 720) || (t >= 780 && t <= 960); // 9:30-12:00 / 13:00-16:00
  }
  if (code && code.startsWith('us')) {               // 美股（ET→北京，含跨日）
    const off = usInDST(now) ? 12 : 13;              // 北京 = ET + 12/13 小时
    let etMin = t - off * 60, etDay = day;
    if (etMin < 0) { etMin += 1440; etDay = (day + 6) % 7; }
    if (etDay < 1 || etDay > 5) return false;
    return etMin >= 570 && etMin <= 960;             // 9:30-16:00 ET
  }
  if (!isWeekday) return false;                       // 默认 A股
  return (t >= 570 && t <= 690) || (t >= 780 && t <= 900);
}

// 按涨跌幅排序（FLIP 动画：记录首末位置→反推位移→播放过渡，行平滑归位而非瞬移）
function animateReorder(mutate) {
  const rows = Array.from(listEl.querySelectorAll('.row'));
  if (!rows.length) { mutate(); return; }
  const first = new Map();
  rows.forEach(r => first.set(r.dataset.code, r.getBoundingClientRect()));
  mutate();
  rows.forEach(r => {
    const f = first.get(r.dataset.code);
    if (!f) return;
    const l = r.getBoundingClientRect();
    const dx = f.left - l.left, dy = f.top - l.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    r.style.transition = 'none';
    r.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      r.style.transition = 'transform 0.42s cubic-bezier(0.2,0.8,0.2,1)';
      r.style.transform = '';
    });
    setTimeout(() => { r.style.transition = ''; }, 480);
  });
}
function reorderRows() {
  if (!settings.sortByChange) return;
  if (isDragging) return; // 拖拽中不打断手动排序
  // 先算目标顺序，若与当前 DOM 顺序一致则跳过（避免每 tick 无谓重排）
  const sorted = [...watchlist].sort((a, b) => (pctMap[b.code] || 0) - (pctMap[a.code] || 0));
  const rows = Array.from(listEl.querySelectorAll('.row'));
  let same = rows.length === sorted.length;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].dataset.code !== sorted[i].code) { same = false; break; }
  }
  if (same) return;
  animateReorder(() => {
    sorted.forEach((w, i) => {
      const r = rowMap.get(w.code);
      if (!r) return;
      listEl.appendChild(r); // 移动节点（保留闪烁状态）
      const d = r.querySelector('.del');
      if (d) d.dataset.idx = String(i);
    });
  });
}

function setStatus(text, ok) {
  statusText.textContent = text;
  statusDot.className = 'dot' + (ok ? ' ok' : ' err');
}
function nowTime() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 大盘指数速览条 ----------
function buildIndices() {
  if (!indicesEl) return;
  indicesEl.innerHTML = '<div class="idx-track" id="idxTrack"></div>';
  const track = indicesEl.querySelector('#idxTrack');
  const buildGroup = () => {
    const g = document.createElement('div');
    g.className = 'idx-group';
    g.style.display = 'flex';
    g.style.gap = '5px';
    INDICES.forEach(it => {
      const chip = document.createElement('div');
      chip.className = 'idx';
      chip.dataset.code = it.code;
      chip.innerHTML = `<span class="idx-name">${it.name}</span><span class="idx-val">--</span><span class="idx-pct">--</span>`;
      chip.addEventListener('click', () => ipcRenderer.send('open-url', it.code));
      g.appendChild(chip);
    });
    return g;
  };
  track.appendChild(buildGroup());
  // 第二份拷贝由 setupIdxMarquee 在溢出时动态添加，避免宽屏下出现重复
}
function fetchIndices() {
  ipcRenderer.send('fetch-indices', INDICES.map(i => i.code));
}
ipcRenderer.on('indices', (event, data) => {
  if (!indicesEl || !data || data.error) return;
  _indicesCache = data;
  data.forEach(d => {
    // 跑马灯双份拷贝，所有副本都要更新，否则滚动到第二份会显示陈旧的「--」
    indicesEl.querySelectorAll(`.idx[data-code="${d.code}"]`).forEach(chip => {
      const valEl = chip.querySelector('.idx-val');
      const pctEl = chip.querySelector('.idx-pct');
      if (valEl) valEl.textContent = (d.price != null) ? d.price.toFixed(2) : '--';
      const arrow = d.change > 0 ? '▲' : (d.change < 0 ? '▼' : '—');
      if (pctEl) pctEl.textContent = `${arrow} ${d.changePct >= 0 ? '+' : ''}${d.changePct.toFixed(2)}%`;
    });
  });
  if (currentView === 'indices' && indicesGrid) renderIndicesView();
});
let _indicesCache = [];
let _indicesGroupsCache = null;
function fetchIndicesGroups() {
  ipcRenderer.send('fetch-indices-groups');
}
ipcRenderer.on('indices-groups', (event, data) => {
  if (!data || data.error) return;
  _indicesGroupsCache = data;
  if (currentView === 'indices') renderIndicesView();
});
function renderIndicesView() {
  if (!indicesGroups) return;
  if (!_indicesGroupsCache) { indicesGroups.innerHTML = '<div class="empty">加载指数中…</div>'; return; }
  indicesGroups.innerHTML = '';
  _indicesGroupsCache.forEach(g => {
    const section = document.createElement('div');
    section.className = 'idx-section';
    const title = document.createElement('div');
    title.className = 'idx-section-title';
    title.textContent = g.name;
    section.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'idx-grid';
    g.items.forEach(it => {
      const card = document.createElement('div');
      card.className = 'idx-card';
      card.dataset.code = it.code;
      const cls = it.change > 0 ? 'up' : (it.change < 0 ? 'down' : 'flat');
      card.innerHTML = `
        <div class="idx-name">${it.name || it.code}</div>
        <div class="idx-price ${cls}">${it.price != null ? it.price.toFixed(2) : '--'}</div>
        <div class="idx-pct ${cls}">${it.change > 0 ? '+' : ''}${it.changePct != null ? it.changePct.toFixed(2) : '0.00'}%</div>
        <div class="idx-change ${cls}">${it.change > 0 ? '+' : ''}${it.change != null ? it.change.toFixed(2) : '0.00'}</div>`;
      card.addEventListener('click', () => openChart(it.code));
      grid.appendChild(card);
    });
    section.appendChild(grid);
    indicesGroups.appendChild(section);
  });
}

// ---------- 持仓视图（行内编辑 + 加仓 / 减仓 / 清仓）----------
function renderPortfolio() {
  if (!portfolioList) return;
  const items = watchlist.filter(it => holdingOf(it));
  let mvTotal = 0, todayTotal = 0, costTotal = 0;
  items.forEach(it => {
    const price = lastPrice[it.code];
    const h = holdingOf(it);
    if (price == null || !h) return;
    const mkt = marketOf(it.code);
    mvTotal += fxToCNY(mkt, price * h.shares);
    costTotal += fxToCNY(mkt, h.avgCost * h.shares);
    const prevClose = parseFloat(sparkPrevClose[it.code]);
    if (!isNaN(prevClose) && prevClose > 0) todayTotal += fxToCNY(mkt, (price - prevClose) * h.shares);
  });
  if (pfHeaderNums) {
    const cls = v => v >= 0 ? 'up' : 'down';
    const sign = v => v >= 0 ? '+' : '';
    // 总市值为中性数值（不按盈亏染色，避免把「市值」误显示为涨跌色）；仅「当日盈亏」按涨跌色
    pfHeaderNums.innerHTML = `总市值 <span>¥${fmtMoney(mvTotal)}</span> · 当日盈亏 <span class="${cls(todayTotal)}">${sign(todayTotal)}¥${fmtMoney(Math.abs(todayTotal))}</span>`;
  }
  portfolioList.innerHTML = '';
  if (items.length === 0) {
    portfolioList.innerHTML = '<div class="pf-empty"><div class="pf-empty-tip">还没有持仓</div><button class="mini-btn primary no-drag" id="pfEmptyAdd">＋ 添加第一笔持仓</button></div>';
    const ea = document.getElementById('pfEmptyAdd');
    if (ea) ea.addEventListener('click', () => openPfAdd('add'));
    return;
  }
  const header = document.createElement('div');
  header.className = 'pf-row pf-header';
  header.innerHTML = '<span class="pf-name">股票</span><span class="pf-cost">成本/现价</span><span class="pf-shares">持仓</span><span class="pf-ratio">仓位</span><span class="pf-pnl">当日盈亏</span><span class="pf-pnl">持仓盈亏</span>';
  portfolioList.appendChild(header);
  items.forEach(it => {
    const price = lastPrice[it.code];
    const h = holdingOf(it);
    const mkt = marketOf(it.code);
    const sym = CUR_SYM[mkt] || '¥';
    const row = document.createElement('div');
    row.className = 'pf-row';
    row.dataset.code = it.code;
    row.addEventListener('dblclick', () => { if (!row.classList.contains('editing')) openChart(it.code); });
    const ratio = mvTotal > 0 ? (fxToCNY(mkt, price * h.shares) / mvTotal * 100) : 0;
    const p = computePnl(it, price);
    const cls = v => v >= 0 ? 'up' : 'down';
    const sign = v => v >= 0 ? '+' : '';
    const today = p && p.tp != null ? `${sym}${sign(p.tp)}${Math.abs(p.tp).toFixed(2)} <span class="${cls(p.tp)}">${sign(p.tpPct)}${p.tpPct.toFixed(2)}%</span>` : '—';
    const hold = p && p.hp != null ? `${sym}${sign(p.hp)}${Math.abs(p.hp).toFixed(2)} <span class="${cls(p.hp)}">${sign(p.hpPct)}${p.hpPct.toFixed(2)}%</span>` : '—';
    row.innerHTML = `
      <div class="pf-main">
        <span class="pf-name" data-act="edit"><b>${esc(it.name || it.code)}</b><small>${esc(it.code)}</small></span>
        <span class="pf-cost" data-act="edit">${sym}${h.avgCost.toFixed(2)}<br><b>${sym}${price != null ? price.toFixed(2) : '--'}</b></span>
        <span class="pf-shares" data-act="edit">${Math.round(h.shares)}</span>
        <span class="pf-ratio">${ratio.toFixed(1)}%</span>
        <span class="pf-pnl ${cls(p && p.tp || 0)}">${today}</span>
        <span class="pf-pnl ${cls(p && p.hp || 0)}">${hold}</span>
      </div>
      <div class="pf-edit" hidden>${buildPfEdit(it, price, h)}</div>`;
    portfolioList.appendChild(row);
  });
}
// 行内编辑面板 HTML
function buildPfEdit(it, price, h) {
  const sym = CUR_SYM[marketOf(it.code)] || '¥';
  const cur = price != null ? price.toFixed(2) : '--';
  const name = esc(it.name || it.code);
  const code = esc(uiCode(it.code));
  const tag = tagOf(it) || marketTag(it.code);
  const first = name.slice(0, 1);
  let hash = 0;
  for (const c of String(it.code || '')) hash = ((hash * 31) + c.charCodeAt(0)) & 0xffff;
  const hue = 210 + (hash % 60);
  const iconBg = `linear-gradient(135deg, hsl(${hue}, 78%, 62%), hsl(${hue + 12}, 82%, 52%))`;
  return `
    <div class="pf-edit-card">
      <div class="pf-edit-header">
        <div class="pf-edit-icon" style="background:${iconBg}">${first}</div>
        <div class="pf-edit-info">
          <div class="pf-edit-name-line"><b>${name}</b>${tag ? `<span class="pf-edit-tag">${tag}</span>` : ''}</div>
          <small>${code}</small>
        </div>
        <div class="pf-edit-price">现价 ${sym}${cur}</div>
      </div>

      <div class="pf-edit-fields">
        <div class="pf-field">
          <label>成本价</label>
          <div class="pf-input-wrap">
            <input class="pf-cost-in no-drag" type="number" step="0.001" value="${h ? h.avgCost.toFixed(2) : ''}" placeholder="买入价">
            <span class="pf-input-suffix">元</span>
          </div>
        </div>
        <div class="pf-field">
          <label>股数</label>
          <div class="pf-input-wrap">
            <input class="pf-shares-in no-drag" type="number" step="1" value="${h ? Math.round(h.shares) : ''}" placeholder="持仓股数">
            <span class="pf-input-suffix">股</span>
          </div>
        </div>
      </div>

      <div class="pf-edit-opts">
        <button class="pf-opt-btn no-drag" data-act="now">按现价填入</button>
        <label class="pf-add-jiacang"><input type="checkbox" class="pf-jia no-drag"> 加仓（追加为一批次）</label>
      </div>

      <div class="pf-reduce" hidden>
        <div class="pf-reduce-label">卖出股数</div>
        <div class="pf-input-wrap">
          <input class="pf-reduce-in no-drag" type="number" step="1" placeholder="输入要卖的股数">
          <span class="pf-input-suffix">股</span>
        </div>
        <button class="pf-opt-btn no-drag" data-act="reduce-ok">确认减仓</button>
        <button class="pf-opt-btn text no-drag" data-act="reduce-cancel">取消</button>
      </div>

      <div class="pf-edit-divider"></div>

      <div class="pf-edit-main-actions">
        <button class="pf-add-btn secondary no-drag" data-act="cancel">取消</button>
        <button class="pf-add-btn primary no-drag" data-act="save">保存</button>
      </div>

      <div class="pf-edit-tool-actions">
        <button class="pf-tool-btn no-drag" data-act="reduce">减仓</button>
        <button class="pf-tool-btn danger no-drag" data-act="clear">清空持仓</button>
        <button class="pf-tool-btn no-drag" data-act="chart">看K线</button>
        <button class="pf-tool-btn danger no-drag" data-act="remove">移出自选</button>
      </div>
    </div>`;
}

// 代码对应的市场简称（用于行内编辑卡片标签）
function marketTag(code) {
  const c = String(code || '').toLowerCase();
  if (c.startsWith('sh')) return '沪';
  if (c.startsWith('sz')) return '深';
  if (c.startsWith('hk')) return '港';
  if (c.startsWith('us')) return '美';
  if (c.startsWith('bj')) return '北';
  if (c.startsWith('bk')) return '板';
  return '';
}
// 进入编辑态时，用当前实时价 / 持仓刷新输入框，保证「现价」不过期
function fillPfEdit(row, it, price, h) {
  const cin = row.querySelector('.pf-cost-in'); const sin = row.querySelector('.pf-shares-in');
  const cur = row.querySelector('.pf-edit-cur');
  const sym = CUR_SYM[marketOf(it.code)] || '¥';
  if (cin && h) cin.value = h.avgCost.toFixed(2);
  if (sin && h) sin.value = Math.round(h.shares);
  if (cur) cur.textContent = '现价 ' + sym + (price != null ? price.toFixed(2) : '--');
}
function togglePfEdit(row, item, force) {
  const main = row.querySelector('.pf-main'); const edit = row.querySelector('.pf-edit');
  const editing = (force === undefined) ? !row.classList.contains('editing') : force;
  row.classList.toggle('editing', editing);
  if (main) main.hidden = editing;
  if (edit) edit.hidden = !editing;
  if (editing) { const price = lastPrice[item.code]; fillPfEdit(row, item, price, holdingOf(item)); }
}
if (portfolioList) {
  portfolioList.addEventListener('click', e => {
    const row = e.target.closest('.pf-row'); if (!row) return;
    const code = row.dataset.code; if (!code) return; // 表头行忽略
    const item = itemMap.get(code); if (!item) return;
    const actEl = e.target.closest('[data-act]');
    if (!actEl) {
      if (e.target.closest('.pf-main')) togglePfEdit(row, item);
      return;
    }
    const act = actEl.dataset.act;
    const price = lastPrice[code];
    if (act === 'edit') { togglePfEdit(row, item); return; }
    if (act === 'now') { const inp = row.querySelector('.pf-cost-in'); if (price != null && inp) inp.value = price.toFixed(2); return; }
    if (act === 'reduce') {
      const r = row.querySelector('.pf-reduce');
      if (r) {
        const wasHidden = r.hidden;
        r.hidden = !wasHidden;
        if (wasHidden) {
          const rin = r.querySelector('.pf-reduce-in');
          if (rin) { rin.value = ''; setTimeout(() => rin.focus(), 30); }
        }
      }
      return;
    }
    if (act === 'reduce-cancel') { const r = row.querySelector('.pf-reduce'); if (r) r.hidden = true; return; }
    if (act === 'reduce-ok') {
      const rin = row.querySelector('.pf-reduce-in'); const reduce = parseFloat(rin && rin.value);
      const h = holdingOf(item);
      if (!h || isNaN(reduce) || reduce <= 0) { showToast('减仓', '请输入有效股数'); return; }
      if (reduce >= h.shares) { item.cost = ''; item.shares = ''; item.lots = []; }
      else { item.cost = h.avgCost.toFixed(3); item.shares = String(Math.round(h.shares - reduce)); item.lots = []; }
      saveWatchlistDebounced(); updatePortfolio(); renderPortfolio(); refresh();
      showToast('已减仓', (item.name || code) + ' 卖出 ' + Math.round(reduce) + ' 股');
      return;
    }
    if (act === 'clear') {
      item.cost = ''; item.shares = ''; item.lots = [];
      saveWatchlistDebounced(); updatePortfolio(); renderPortfolio();
      showToast('已清仓', (item.name || code) + ' 持仓已清空（仍在自选）');
      return;
    }
    if (act === 'remove') {
      // 移出自选：把整只票从列表移除（需确认，避免误删）
      if (!window.confirm('确定把「' + (item.name || code) + '」从自选列表移除？此操作不可撤销。')) return;
      removeStock(code); setTimeout(() => renderPortfolio(), 360);
      return;
    }
    if (act === 'chart') { openChart(code); return; }
    if (act === 'cancel') { togglePfEdit(row, item, false); return; }
    if (act === 'save') {
      const cin = row.querySelector('.pf-cost-in'); const sin = row.querySelector('.pf-shares-in'); const jia = row.querySelector('.pf-jia');
      const cost = parseFloat(cin && cin.value); const shares = parseFloat(sin && sin.value);
      if (!(cost > 0 && shares > 0)) { showToast('保存', '请填写有效的成本价和股数'); return; }
      const h0 = holdingOf(item);
      if (jia && jia.checked && h0) {
        if (!Array.isArray(item.lots) || !item.lots.length) item.lots = [{ date: '', price: String(h0.avgCost), shares: String(Math.round(h0.shares)) }];
        item.lots.push({ date: '', price: cost.toFixed(3), shares: String(Math.round(shares)) });
        item.cost = ''; item.shares = '';
      } else { item.cost = cost.toFixed(3); item.shares = String(Math.round(shares)); item.lots = []; }
      saveWatchlistDebounced(); updatePortfolio(); renderPortfolio(); refresh();
      showToast('已保存', (item.name || code) + ' 成本已更新');
      return;
    }
  });
}

// ---------- 涨跌分布 / 全市场统计 ----------
let _marketSummary = null;
let _trendIntraday = [];   // [{ t:'HH:MM', up, down }] 当日涨跌家数分时（由 market-summary 实时累积）
let _trendHistory = [];    // [{ date, up }] 近 N 日上涨家数
let _trendTotal = 0;       // 当前市场总家数，用于把历史上涨比例换算成家数
let _trendMode = 'intraday'; // 'intraday' | 'history'
let _indexTimer = null;
let _marketTimer = null;
function fetchMarketSummaryData() {
  ipcRenderer.send('fetch-market-summary');
}
ipcRenderer.on('market-summary', (event, data) => {
  if (!data || data.error) {
    console.error('[market-summary]', data && data.error);
    // 首次就没数据时不要整页空白：渲染「获取中/重试中」占位，下一次 30s 定时会自动再拉
    if (!_marketSummary) renderMarketView();
    return;
  }
  _marketSummary = data;
  _trendTotal = (data.up || 0) + (data.down || 0) + (data.flat || 0);
  // 累积当日涨跌家数分时（每 30s 一个点）
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const last = _trendIntraday[_trendIntraday.length - 1];
  if (!last || last.t !== t) {
    _trendIntraday.push({ t, up: data.up || 0, down: data.down || 0 });
    if (_trendIntraday.length > 300) _trendIntraday.shift();
  } else {
    last.up = data.up || 0; last.down = data.down || 0;
  }
  if (currentView === 'market') renderMarketView();
});
function startMarketSummary() {
  fetchMarketSummaryData();
  if (_marketTimer) clearInterval(_marketTimer);
  _marketTimer = setInterval(fetchMarketSummaryData, 30000);
  requestTrendHistory();
  if (_indexTimer) clearInterval(_indexTimer);
  // 历史情绪数据每 5 分钟刷新一次即可
  _indexTimer = setInterval(requestTrendHistory, 300000);
}
function renderMarketView() {
  if (!marketSummary) return;
  if (!_marketSummary) {
    // 数据未到/拉取失败：给出明确占位，而不是整块空白
    marketSummary.innerHTML = `<div class="ms-loading">涨跌分布数据获取中…（数据源偶尔限流，30 秒后自动重试）</div>`;
    if (marketVolume) marketVolume.innerHTML = '';
    if (distUpdated) { distUpdated.textContent = ''; distUpdated.classList.remove('stale'); }
    drawDistChart();
    drawTrendChart();
    return;
  }
  const d = _marketSummary;
  const ratio = d.prevAmount > 0 ? (d.amount / d.prevAmount * 100) : null;
  const cells = [
    { label: '上涨', value: d.up, cls: 'up', sub: '家' },
    { label: '平盘', value: d.flat, cls: 'flat', sub: '家' },
    { label: '下跌', value: d.down, cls: 'down', sub: '家' },
    { label: '涨停', value: d.limitUp, cls: 'up', sub: '家' },
    { label: '跌停', value: d.limitDown, cls: 'down', sub: '家' },
  ];
  marketSummary.innerHTML = cells.map(c => `
    <div class="ms-cell">
      <div class="ms-label">${c.label}</div>
      <div class="ms-value ${c.cls}">${c.value}</div>
      <div class="ms-sub">${c.sub}</div>
    </div>
  `).join('');
  if (marketVolume) {
    marketVolume.innerHTML = `
      <div class="mv-title">成交量</div>
      <div class="mv-grid">
        <div class="mv-cell"><div class="mv-label">当日成交额</div><div class="mv-value">¥${fmtYi(d.amount)}</div></div>
        <div class="mv-cell"><div class="mv-label">昨日成交</div><div class="mv-value">¥${fmtYi(d.prevAmount)}</div></div>
        <div class="mv-cell"><div class="mv-label">较昨日变动</div><div class="mv-value ${d.amountDelta >= 0 ? 'up' : 'down'}">${d.amountDelta >= 0 ? '+' : ''}¥${fmtYi(Math.abs(d.amountDelta))}</div></div>
        <div class="mv-cell"><div class="mv-label">预测全天</div><div class="mv-value">¥${fmtYi(d.predictedAmount || d.amount)}</div></div>
      </div>
    `;
  }
  // 涨跌分布数据时间：东财/新浪限流时用本地缓存兜底，明确标「缓存 HH:MM」避免误以为数据没出来
  if (distUpdated) {
    const ts = d.updatedAt ? new Date(d.updatedAt) : null;
    const hhmm = (ts && !isNaN(ts)) ? `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}` : '';
    distUpdated.textContent = hhmm ? ((d.stale ? '缓存 ' : '更新 ') + hhmm) : '';
    distUpdated.classList.toggle('stale', !!d.stale);
  }
  drawDistChart();
  drawTrendChart();
  if (_trendHistory.length === 0) requestTrendHistory();
}
function fmtYi(n) {
  if (n == null || isNaN(n)) return '—';
  // 成交额以元为单位，除以 1e12 得「万亿元」，必须带单位否则会被误读为几元
  return (n / 1e12).toFixed(2) + '万亿';
}
// 请求近60日市场涨跌家数历史（来自第三方情绪周期接口）
function requestTrendHistory() {
  ipcRenderer.send('fetch-market-sentiment-history', { days: 60 });
}
ipcRenderer.on('market-sentiment-history', (event, data) => {
  if (!data || data.error) { console.error('[market-sentiment-history]', data && data.error); return; }
  _trendHistory = (data.history || []).map(d => ({ date: String(d.date || ''), upRatio: Number(d.upRatio) || 0 }));
  if (currentView === 'market') drawTrendChart();
});
// 把原始值映射到好看的 Y 轴上限（截图风格：0/1200/2400/3600/4800…）
function niceYMax(v) {
  return Math.max(4800, Math.ceil(v / 1200) * 1200);
}
// 统一绘制「涨跌趋势」：当日为红绿两条分时线，近60日为红色上涨家数走势
function drawTrendChart() {
  if (!trendCanvas) return;
  const rect = trendCanvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width));
  const H = Math.max(1, Math.round(rect.height));
  trendCanvas.width = W; trendCanvas.height = H;
  const ctx = trendCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const padL = 28, padR = 4, padT = 6, padB = 16;

  if (_trendMode === 'intraday') {
    if (trendLegend) trendLegend.style.display = '';
    if (_trendIntraday.length < 2) {
      ctx.fillStyle = '#9ca3af'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('分时数据采集中…', W / 2, H / 2);
      return;
    }
    // 只保留交易时段，剔除午休，避免连出一条水平线
    const trading = _trendIntraday.filter(d => {
      const [h, m] = d.t.split(':').map(Number);
      const min = h * 60 + m;
      return (min >= 570 && min <= 690) || (min >= 780 && min <= 900);
    });
    if (trading.length < 2) {
      ctx.fillStyle = '#9ca3af'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('分时数据采集中…', W / 2, H / 2);
      return;
    }
    const ups = trading.map(d => d.up);
    const downs = trading.map(d => d.down);
    const yMax = niceYMax(Math.max(...ups, ...downs, 1));
    const xOf = i => padL + (i / (trading.length - 1)) * (W - padL - padR);
    const yOf = v => padT + (1 - v / yMax) * (H - padT - padB);
    const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    // 网格线 + Y 轴标签
    ctx.strokeStyle = 'rgba(120,130,150,0.12)';
    ctx.fillStyle = '#6b7280'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    for (let n = 0; n <= yMax; n += 1200) {
      const y = yOf(n);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(String(n), padL - 4, y + 3);
    }
    // 两条折线（午休处断开）
    const drawLine = (vals, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
      vals.forEach((v, i) => {
        const x = xOf(i), y = yOf(v);
        if (i === 0 || toMin(trading[i].t) - toMin(trading[i - 1].t) > 35) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    drawLine(downs, COLORS.down);
    drawLine(ups, COLORS.up);
    // X 轴时间
    ctx.fillStyle = '#6b7280'; ctx.font = '10px sans-serif';
    ctx.textAlign = 'left'; ctx.fillText('09:30', padL, H - 4);
    const mid = Math.floor((trading.length - 1) / 2);
    ctx.textAlign = 'center'; ctx.fillText('11:30', xOf(mid), H - 4);
    ctx.textAlign = 'right'; ctx.fillText('15:00', W - padR, H - 4);
    return;
  }

  // history 模式
  if (trendLegend) trendLegend.style.display = 'none';
  if (_trendHistory.length < 2) {
    ctx.fillStyle = '#9ca3af'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('走势数据采集中…', W / 2, H / 2);
    return;
  }
  const total = _trendTotal || 5300;
  const data = _trendHistory.map(d => ({
    date: d.date,
    up: Math.round(total * (d.upRatio / 100))
  }));
  const ups = data.map(d => d.up);
  const yMax = niceYMax(Math.max(...ups, 1));
  const xOf = i => padL + (i / (data.length - 1)) * (W - padL - padR);
  const yOf = v => padT + (1 - v / yMax) * (H - padT - padB);
  // 网格线 + Y 轴标签
  ctx.strokeStyle = 'rgba(120,130,150,0.12)';
  ctx.fillStyle = '#6b7280'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let n = 0; n <= yMax; n += 1200) {
    const y = yOf(n);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(String(n), padL - 4, y + 3);
  }
  // 上涨家数折线（红）
  ctx.strokeStyle = COLORS.up; ctx.lineWidth = 1.5; ctx.beginPath();
  ups.forEach((v, i) => { const x = xOf(i), y = yOf(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.stroke();
  // X 轴日期：起点 / 中间 / 终点
  ctx.fillStyle = '#6b7280'; ctx.font = '10px sans-serif';
  const first = data[0], last = data[data.length - 1], mid = data[Math.floor((data.length - 1) / 2)];
  const fmt = s => s && s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : (s || '');
  ctx.textAlign = 'left'; ctx.fillText(fmt(first.date), padL, H - 4);
  ctx.textAlign = 'center'; ctx.fillText(fmt(mid.date), xOf(Math.floor((data.length - 1) / 2)), H - 4);
  ctx.textAlign = 'right'; ctx.fillText(fmt(last.date), W - padR, H - 4);
}
function drawDistChart() {
  if (!distCanvas || !_marketSummary || !_marketSummary.distribution) return;
  const rect = distCanvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width));
  const H = Math.max(1, Math.round(rect.height));
  distCanvas.width = W; distCanvas.height = H;
  const ctx = distCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const dist = _marketSummary.distribution;
  const labels = ['>10%', '7~10%', '5~7%', '3~5%', '0~3%', '0', '0~-3%', '-3~-5%', '-5~-7%', '-7~-10%', '<-10%'];
  const counts = labels.map(l => (dist[l] || 0));
  const max = Math.max(...counts, 1);
  const pad = 22;
  const gap = 4;
  const barW = (W - pad * 2 - gap * (labels.length - 1)) / labels.length;
  // 零线：分隔涨跌两侧，让分布中轴更清晰
  const zeroIndex = labels.indexOf('0');
  const zeroX = pad + zeroIndex * (barW + gap);
  ctx.strokeStyle = 'rgba(120,130,150,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(zeroX, pad);
  ctx.lineTo(zeroX, H - pad);
  ctx.stroke();
  labels.forEach((l, i) => {
    const c = counts[i];
    const h = (c / max) * (H - pad * 2);
    const x = pad + i * (barW + gap);
    const y = H - pad - h;
    // 涨侧红色、跌侧绿色、平盘中性灰（之前把 0 也标成红色是误导性 bug）
    let color = COLORS.up;
    if (l === '0') color = '#9ca3af';
    else if (l.includes('-')) color = COLORS.down;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, Math.max(1, barW), h);
    // 文字
    ctx.fillStyle = '#6b7280';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(l, x + barW / 2, H - 8);
    if (c > 0) {
      ctx.fillStyle = '#2b2f3a';
      ctx.fillText(String(c), x + barW / 2, y - 4);
    }
  });
}

// ---------- 数据视图：热榜 / 涨停天梯 / 板块 / ETF ----------
// 复用通用列表样式（.dlist / .drow），点击行打开行情大图
// 东财 f12（如 600519 / BK0735）规范化为内部 code（主进程侧同名函数，这里渲染端独立实现）
function normCode(f12) {
  const s = String(f12 || '');
  if (/^bk/i.test(s)) return 'bk' + s.replace(/^bk/i, '').toUpperCase();
  // 富时A50期货：同花顺 CN0W/CN0Y 统一映射到东财 CN00Y
  if (/^CN\d*[YW]$/i.test(s)) return 'fuCN00Y';
  if (/^fu/i.test(s)) return 'fu' + s.replace(/^fu/i, '').toUpperCase();
  const digits = s.replace(/\D/g, '');
  if (!digits) return s;
  const first = digits[0];
  let mkt;
  if (first === '6' || first === '9' || first === '5') mkt = 'sh';
  else if (first === '8' || first === '4') mkt = 'bj';
  else mkt = 'sz';
  return mkt + digits;
}
let _hotCache = { tag: '1h', list: null };
let _ladderCache = null;
let _ladderFilter = 'all';
let _sectorsCache = { industry: null, concept: null };
let _etfCache = { category: 'all', list: null };
let sectorsTab = 'industry';
let etfCategory = 'all';
const ETF_TAB_ORDER = [
  { id: 'all', name: '全部ETF' },
  { id: 'china', name: '中概互联' },
  { id: 'hkmed', name: '港股医疗' },
  { id: 'hkdiv', name: '港股红利' },
  { id: 'gold', name: '黄金ETF' },
  { id: 'cross', name: '跨境ETF' },
  { id: 'other', name: '其他ETF' },
];
let hotTag = '1h';
let _dataTimer = null;

function fmtYiShort(n) {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(Math.round(n));
}
function chgCls(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }
function chgSign(v) { return v > 0 ? '+' : ''; }
function addBtn(code, name) {
  return `<button class="d-add no-drag" data-code="${code}" data-name="${name || ''}" title="加入自选">+</button>`;
}
function makeDrow(cols) {
  const row = document.createElement('div');
  row.className = 'drow';
  if (cols) row.style.gridTemplateColumns = cols;
  return row;
}
function fmtHeat(wan) {
  if (wan == null || isNaN(wan)) return '—';
  if (wan >= 10000) return (wan / 10000).toFixed(2) + '亿';
  return wan.toFixed(2) + '万';
}
// 数据列表表头（吸顶，与行共用同一 grid 列模板保证对齐）
function dHeadRow(cols, labels) {
  const h = document.createElement('div');
  h.className = 'drow dhead';
  if (cols) h.style.gridTemplateColumns = cols;
  h.innerHTML = labels.map(t => `<span>${t}</span>`).join('');
  return h;
}

// 列表内的 + / 成分按钮统一委托（避免行点击冲突）
function onDrowClick(e, listEl, openFn) {
  const add = e.target.closest('.d-add');
  const board = e.target.closest('.d-btn[data-action="board"]');
  const row = e.target.closest('.drow');
  if (add) { addStock(add.dataset.code, add.dataset.name); showToast('已加入自选', add.dataset.name); return; }
  if (board) { openBoard(board.dataset.code, board.dataset.name); return; }
  if (row && openFn) openFn(row.dataset.code, row.dataset.name);
}

// 股票热榜
function fetchHot(tag = hotTag) {
  hotTag = tag;
  if (hotList) hotList.innerHTML = '<div class="empty">加载热榜中…</div>';
  ipcRenderer.send('fetch-hot', { tag });
}
ipcRenderer.on('hot', (event, data) => {
  if (!data || data.error) { if (hotView && !hotView.hidden) hotList.innerHTML = '<div class="empty">热榜加载失败</div>'; return; }
  _hotCache = { tag: data.tag || '1h', list: data.list };
  if (hotView && !hotView.hidden) renderHot();
});
function renderHot() {
  if (!hotList) return;
  const list = _hotCache && _hotCache.list;
  if (!list) { hotList.innerHTML = '<div class="empty">加载热榜中…</div>'; return; }
  if (!list.length) { hotList.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  hotList.innerHTML = '';
  hotList.appendChild(dHeadRow('30px 1fr 48px 58px 42px 58px 28px', ['#', '名称', '涨跌幅', '成交额', '换手', '主力', '']));
  list.forEach((r, i) => {
    const cls = chgCls(r.chgPct);
    const row = makeDrow('30px 1fr 48px 58px 42px 58px 28px');
    row.dataset.code = r.code; row.dataset.name = r.name;
    row.innerHTML = `
      <span class="d-rank ${i < 3 ? 'top' : ''}">${i + 1}</span>
      <span class="d-name" title="${r.code}">${r.name}</span>
      <span class="d-chg ${cls}">${chgSign(r.chgPct)}${r.chgPct.toFixed(2)}%</span>
      <span class="d-extra">${fmtYiShort(r.amount)}</span>
      <span class="d-extra">${r.turnover != null ? r.turnover.toFixed(2) + '%' : '—'}</span>
      <span class="d-extra ${chgCls(r.mainNet)}">${fmtYiShort(r.mainNet)}</span>
      ${addBtn(r.code, r.name)}`;
    hotList.appendChild(row);
  });
  hotList.scrollTop = 0;
}
if (hotList) hotList.addEventListener('click', e => onDrowClick(e, hotList, code => openChart(code)));

// 涨停天梯
function fetchLadder() {
  if (ladderList) ladderList.innerHTML = '<div class="empty">统计涨停连板中…</div>';
  ipcRenderer.send('fetch-limit-ladder');
}
ipcRenderer.on('limit-ladder', (event, data) => {
  if (!data || data.error) { if (ladderView && !ladderView.hidden) ladderList.innerHTML = '<div class="empty">天梯加载失败</div>'; return; }
  _ladderCache = data;
  if (ladderView && !ladderView.hidden) renderLadder();
});
function renderLadder() {
  if (!ladderList || !_ladderCache) return;
  ladderList.className = 'ladder-view';
  if (!_ladderCache.length) { ladderList.innerHTML = '<div class="empty">当前无涨停</div>'; return; }
  ladderList.innerHTML = '';
  _ladderCache.forEach(g => {
    const stocks = _ladderFilter === 'no-st' ? g.stocks.filter(s => !s.name.includes('ST')) : g.stocks;
    if (!stocks.length) return;
    const section = document.createElement('div');
    section.className = 'ladder-section';
    const title = document.createElement('div');
    title.className = 'ladder-section-title';
    title.textContent = `${g.boards}板（${stocks.length}个）`;
    section.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'ladder-grid';
    stocks.forEach(u => {
      const cls = chgCls(u.chgPct);
      const card = document.createElement('div');
      card.className = 'ladder-card';
      card.dataset.code = u.code; card.dataset.name = u.name;
      const shortCode = u.code.replace(/^(sh|sz|bj)/i, '').toUpperCase();
      const industry = u.industry || '';
      card.innerHTML = `
        <div class="lc-top">
          <span class="lc-name" title="${u.code}">${u.name}</span>
          <button class="lc-add no-drag" data-code="${u.code}" data-name="${u.name || ''}" title="加入自选">+</button>
        </div>
        ${industry ? `<div class="lc-industry">${industry}</div>` : `<div class="lc-code">${shortCode}</div>`}
        <div class="lc-pct ${cls}">${chgSign(u.chgPct)}${u.chgPct.toFixed(2)}%</div>
        <div class="lc-extra">${g.boards}天${g.boards}板</div>`;
      grid.appendChild(card);
    });
    section.appendChild(grid);
    ladderList.appendChild(section);
  });
  if (!ladderList.children.length) { ladderList.innerHTML = '<div class="empty">当前无涨停</div>'; return; }
  ladderList.scrollTop = 0;
}
if (ladderList) ladderList.addEventListener('click', e => {
  const add = e.target.closest('.lc-add');
  const card = e.target.closest('.ladder-card');
  if (add) { addStock(add.dataset.code, add.dataset.name); showToast('已加入自选', add.dataset.name); return; }
  if (card) openChart(card.dataset.code);
});

// 板块（行业 / 概念）
function fetchSectors(type) {
  if (sectorsList) sectorsList.innerHTML = '<div class="empty">加载板块…</div>';
  ipcRenderer.send('fetch-sectors-full', { type, pz: 100 });
}
ipcRenderer.on('sectors-full', (event, data) => {
  if (!data || data.error) return;
  const type = data.type || 'industry';
  _sectorsCache[type] = data.list;
  if (sectorsView && !sectorsView.hidden && sectorsTab === type) renderSectors();
});
function renderSectors() {
  if (!sectorsList) return;
  const list = _sectorsCache[sectorsTab];
  if (!list) { sectorsList.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  if (!list.length) { sectorsList.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  sectorsList.innerHTML = '';
  sectorsList.appendChild(dHeadRow('1fr 46px 56px 56px 70px 42px 40px', ['名称', '涨幅', '净流入', '成交额', '领涨股', '涨速', '成分']));
  list.forEach(s => {
    const cls = chgCls(s.chgPct);
    const row = makeDrow('1fr 46px 56px 56px 70px 42px 40px');
    row.dataset.code = s.code; row.dataset.name = s.name;
    row.innerHTML = `
      <span class="d-name">${s.name}</span>
      <span class="d-chg ${cls}">${chgSign(s.chgPct)}${s.chgPct.toFixed(2)}%</span>
      <span class="d-extra ${chgCls(s.mainNet)}">${fmtYiShort(s.mainNet)}</span>
      <span class="d-extra">${fmtYiShort(s.amount)}</span>
      <span class="d-name" style="font-weight:400" title="${s.leading || ''} ${chgSign(s.leadingChgPct)}${s.leadingChgPct.toFixed(2)}%">${s.leading || '—'}</span>
      <span class="d-extra">${s.speed != null ? s.speed.toFixed(2) + '%' : '—'}</span>
      <button class="d-btn no-drag" data-action="board" data-code="${s.code}" data-name="${s.name}">成分</button>`;
    sectorsList.appendChild(row);
  });
  sectorsList.scrollTop = 0;
}
if (sectorsList) sectorsList.addEventListener('click', e => onDrowClick(e, sectorsList, code => openChart(code)));

// ETF 榜
function fetchEtf(category) {
  etfCategory = category;
  if (etfList) etfList.innerHTML = '<div class="empty">加载 ETF…</div>';
  ipcRenderer.send('fetch-etf-full', { category, pz: 200 });
}
ipcRenderer.on('etf-full', (event, data) => {
  if (!data || data.error) return;
  _etfCache = { category: data.category || 'all', list: data.list };
  if (etfView && !etfView.hidden) renderEtf();
});
function renderEtf() {
  if (!etfList || !_etfCache || !_etfCache.list) return;
  const list = _etfCache.list;
  if (!list.length) { etfList.innerHTML = '<div class="empty">该分类暂无数据</div>'; return; }
  etfList.innerHTML = '';
  etfList.appendChild(dHeadRow('1fr 46px 56px 56px 42px 78px 28px', ['名称', '涨幅', '成交额', '规模', '换手', '跟踪指数', '']));
  list.forEach(x => {
    const cls = chgCls(x.chgPct);
    const row = makeDrow('1fr 46px 56px 56px 42px 78px 28px');
    row.dataset.code = x.code; row.dataset.name = x.name;
    row.innerHTML = `
      <span class="d-name" title="${x.code}">${x.name}</span>
      <span class="d-chg ${cls}">${chgSign(x.chgPct)}${x.chgPct.toFixed(2)}%</span>
      <span class="d-extra">${fmtYiShort(x.amount)}</span>
      <span class="d-extra">${fmtYiShort(x.scale)}</span>
      <span class="d-extra">${x.turnover != null ? x.turnover.toFixed(2) + '%' : '—'}</span>
      <span class="d-name" style="font-weight:400" title="${x.tracking}">${x.tracking || '—'}</span>
      ${addBtn(x.code, x.name)}`;
    etfList.appendChild(row);
  });
  etfList.scrollTop = 0;
}
if (etfList) etfList.addEventListener('click', e => onDrowClick(e, etfList, code => openChart(code)));

// 板块成分股弹窗
let _boardCache = null;
function openBoard(bk, name) {
  if (!boardModal) return;
  _boardCache = null;
  boardTitle.textContent = name || '板块';
  boardList.innerHTML = '<div class="empty">加载成分股…</div>';
  boardModal.hidden = false;
  requestAnimationFrame(() => boardModal.classList.add('show'));
  ipcRenderer.send('fetch-clist', { tag: 'board', bk, fs: 'b:' + bk.replace(/^bk/i, '').toUpperCase(), fields: 'f12,f14,f2,f3,f6,f8', pz: 200, fid: 'f3' });
}
function closeBoard() {
  if (!boardModal) return;
  boardModal.classList.remove('show');
  boardModal.hidden = true;
}
function renderBoard() {
  if (!boardList || !_boardCache) return;
  const diff = _boardCache.stocks;
  if (!diff || !diff.length) { boardList.innerHTML = '<div class="empty">暂无成分股</div>'; return; }
  boardList.innerHTML = '';
  diff.forEach((d, i) => {
    const code = normCode(d.f12);
    const name = String(d.f14 || '');
    const price = (typeof d.f2 === 'number') ? d.f2 : parseFloat(d.f2) || 0;
    const chgPct = (typeof d.f3 === 'number') ? d.f3 : parseFloat(d.f3) || 0;
    const amount = (typeof d.f6 === 'number') ? d.f6 : parseFloat(d.f6) || 0;
    const col = chgPct > 0 ? COLORS.up : (chgPct < 0 ? COLORS.down : COLORS.flat);
    const div = document.createElement('div');
    div.className = 'r-item no-drag';
    div.dataset.code = code; div.dataset.name = name;
    div.innerHTML = `
      <span class="r-rank">${i + 1}</span>
      <span class="r-name">${name}</span>
      <span class="r-code">${code.replace(/^(sh|sz|hk|bj|us)/i, '').toUpperCase()}</span>
      <span class="r-price" style="color:${col}">${price.toFixed(2)}</span>
      <span class="r-chg" style="color:${col}">${chgSign(chgPct)}${chgPct.toFixed(2)}%</span>
      <span class="r-extra">${fmtYiShort(amount)}</span>
      <button class="r-add no-drag" title="加入自选">+</button>`;
    boardList.appendChild(div);
  });
}
if (boardClose) boardClose.addEventListener('click', closeBoard);
if (boardModal) boardModal.addEventListener('click', e => { if (e.target === boardModal) closeBoard(); });
if (boardList) boardList.addEventListener('click', e => {
  const add = e.target.closest('.r-add');
  const row = e.target.closest('.r-item');
  if (!row) return;
  if (add) { addStock(row.dataset.code, row.dataset.name); showToast('已加入自选', row.dataset.name); return; }
  openChart(row.dataset.code);
});

ipcRenderer.on('clist', (event, data) => {
  if (!data || data.error) return;
  if (data.tag === 'board') {
    _boardCache = { bk: data.bk, stocks: data.diff };
    if (boardModal && !boardModal.hidden) renderBoard();
  }
});

// 热榜 tab 切换
if (hotTabs) hotTabs.addEventListener('click', e => {
  const b = e.target.closest('button[data-hot]');
  if (!b) return;
  hotTag = b.dataset.hot;
  hotTabs.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  fetchHot(hotTag);
});

// 天梯 ST 过滤
if (ladderFilters) ladderFilters.addEventListener('change', e => {
  _ladderFilter = e.target.value || 'all';
  renderLadder();
});

// 板块 tab 切换
if (sectorsTabs) sectorsTabs.addEventListener('click', e => {
  const b = e.target.closest('button[data-sec]');
  if (!b) return;
  sectorsTab = b.dataset.sec;
  sectorsTabs.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  fetchSectors(sectorsTab);
});

// ETF tab 折叠渲染与切换
function setEtfDropdown(open) {
  if (!etfTabsDropdown) return;
  etfTabsDropdown.hidden = !open;
  if (etfTabsMore) etfTabsMore.classList.toggle('active', open);
}
function renderEtfTabs() {
  if (!etfTabs || !etfTabsTrack || !etfTabsMore || !etfTabsDropdown) return;
  const containerWidth = etfTabs.clientWidth || 9999;
  // 创建全部按钮测量宽度（含 gap）
  etfTabsTrack.innerHTML = '';
  etfTabsDropdown.innerHTML = '';
  const widths = [];
  ETF_TAB_ORDER.forEach(cat => {
    const btn = document.createElement('button');
    btn.dataset.etf = cat.id;
    btn.textContent = cat.name;
    if (cat.id === etfCategory) btn.classList.add('active');
    etfTabsTrack.appendChild(btn);
    const rect = btn.getBoundingClientRect();
    widths.push(rect.width + 5); // +gap
  });
  const moreWidth = 27; // 更多按钮 22px + gap 5px
  let used = 0;
  const visibleIds = [];
  const hiddenIds = [];
  ETF_TAB_ORDER.forEach((cat, i) => {
    const reserve = (i === ETF_TAB_ORDER.length - 1) ? 0 : moreWidth;
    if (used + widths[i] + reserve <= containerWidth + 0.5) {
      visibleIds.push(cat.id);
      used += widths[i];
    } else {
      hiddenIds.push(cat.id);
    }
  });
  // 当前选中如果被折叠，强制放入可见区（替换最后一个可见项）
  if (!visibleIds.includes(etfCategory)) {
    const idx = ETF_TAB_ORDER.findIndex(c => c.id === etfCategory);
    if (visibleIds.length) {
      const replaced = visibleIds.pop();
      hiddenIds.unshift(replaced);
    }
    if (idx !== -1) {
      visibleIds.push(etfCategory);
      const hi = hiddenIds.indexOf(etfCategory);
      if (hi !== -1) hiddenIds.splice(hi, 1);
    }
  }
  // 渲染可见 track
  etfTabsTrack.innerHTML = '';
  ETF_TAB_ORDER.forEach(cat => {
    if (!visibleIds.includes(cat.id)) return;
    const btn = document.createElement('button');
    btn.dataset.etf = cat.id;
    btn.textContent = cat.name;
    if (cat.id === etfCategory) btn.classList.add('active');
    etfTabsTrack.appendChild(btn);
  });
  // 渲染下拉
  etfTabsDropdown.innerHTML = '';
  ETF_TAB_ORDER.forEach(cat => {
    if (!hiddenIds.includes(cat.id)) return;
    const btn = document.createElement('button');
    btn.dataset.etf = cat.id;
    btn.textContent = cat.name;
    if (cat.id === etfCategory) btn.classList.add('active');
    etfTabsDropdown.appendChild(btn);
  });
  const hasHidden = hiddenIds.length > 0;
  etfTabsMore.hidden = !hasHidden;
  if (!hasHidden) setEtfDropdown(false);
}
if (etfTabsTrack) {
  etfTabsTrack.addEventListener('click', e => {
    const b = e.target.closest('button[data-etf]');
    if (!b) return;
    etfCategory = b.dataset.etf;
    setEtfDropdown(false);
    renderEtfTabs();
    fetchEtf(etfCategory);
  });
}
if (etfTabsMore) {
  etfTabsMore.addEventListener('click', e => {
    e.stopPropagation();
    setEtfDropdown(etfTabsDropdown.hidden);
  });
}
if (etfTabsDropdown) {
  etfTabsDropdown.addEventListener('click', e => {
    const b = e.target.closest('button[data-etf]');
    if (!b) return;
    etfCategory = b.dataset.etf;
    setEtfDropdown(false);
    renderEtfTabs();
    fetchEtf(etfCategory);
  });
}
// 点外部 / Esc 收起 ETF 下拉
document.addEventListener('click', e => {
  if (etfTabsDropdown && !etfTabsDropdown.hidden && etfTabs && !etfTabs.contains(e.target)) {
    setEtfDropdown(false);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && etfTabsDropdown && !etfTabsDropdown.hidden) {
    setEtfDropdown(false);
  }
});
// ETF 视图尺寸变化时重排 tab
if (etfTabs && typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => { if (etfView && !etfView.hidden) renderEtfTabs(); }).observe(etfTabs);
}

// 涨跌趋势当日 / 近60日切换
if (trendTabs) trendTabs.addEventListener('click', e => {
  const b = e.target.closest('button[data-trend]');
  if (!b) return;
  _trendMode = b.dataset.trend;
  trendTabs.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  drawTrendChart();
});

// 数据视图自动刷新：每 30 秒，仅当该视图处于激活态时拉取
function startDataTimer() {
  if (_dataTimer) clearInterval(_dataTimer);
  _dataTimer = setInterval(() => {
    if (currentView === 'hot') fetchHot(hotTag);
    else if (currentView === 'ladder') fetchLadder();
    else if (currentView === 'sectors') fetchSectors(sectorsTab);
    else if (currentView === 'etf') fetchEtf(etfCategory);
    else if (currentView === 'indices') fetchIndicesGroups();
  }, 30000);
}

// 溢出时启动 CSS 跑马灯（不溢出则静止，且不再用每帧 rAF 占用主线程）
function setupIdxMarquee() {
  if (!indicesEl) return;
  const track = indicesEl.querySelector('#idxTrack');
  if (!track) return;
  const buildGroup = () => {
    const g = document.createElement('div');
    g.className = 'idx-group';
    g.style.display = 'flex';
    g.style.gap = '5px';
    INDICES.forEach(it => {
      const chip = document.createElement('div');
      chip.className = 'idx';
      chip.dataset.code = it.code;
      chip.innerHTML = `<span class="idx-name">${it.name}</span><span class="idx-val">--</span><span class="idx-pct">--</span>`;
      chip.addEventListener('click', () => ipcRenderer.send('open-url', it.code));
      g.appendChild(chip);
    });
    return g;
  };
  const apply = () => {
    // 先移除旧副本（保留第一份），然后根据是否需要滚动动态添加
    while (track.childElementCount > 1) track.lastElementChild.remove();
    const singleW = track.scrollWidth;
    const overflow = singleW > indicesEl.clientWidth + 4;
    if (overflow) {
      track.appendChild(buildGroup());
      const dur = Math.max(14, INDICES.length * 2.6);
      track.style.setProperty('--idx-dur', dur + 's');
      track.classList.add('marquee');
    } else {
      track.classList.remove('marquee');
      track.style.transform = '';
    }
  };
  apply();
  window.addEventListener('resize', () => { clearTimeout(track._mt); track._mt = setTimeout(apply, 150); });
}
function startIndices() {
  buildIndices();
  fetchIndices();
  setInterval(fetchIndices, 15000);
  setupIdxMarquee();
}

// ---------- 分时走势图 ----------
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
// 缓存涨跌色：避免每只股票每次刷新都触发 getComputedStyle（减少样式重算，更丝滑）
let COLORS = { up: '#e23b3b', down: '#12a150', spark: '#5b8def' };
function refreshColors() {
  COLORS.up = cssVar('--up') || '#e23b3b';
  COLORS.down = cssVar('--down') || '#12a150';
  COLORS.spark = cssVar('--spark') || '#5b8def';
}
// EM 限流退避：分时数据连续全空（失败）时按 15s/次 递增拉取间隔（上限 2 分钟），
// 避免限流状态下每 30 秒 46+ 路请求把东财配额打满，导致行情整体挂掉
let _minFailStreak = 0;
let _minLastTry = 0;
function fetchMinutes() {
  if (watchlist.length === 0) return;
  if (_minFailStreak >= 2) {
    const wait = Math.min(120000, (_minFailStreak - 1) * 15000);
    if (Date.now() - _minLastTry < wait) return; // 还在退避窗口内，跳过本轮
  }
  _minLastTry = Date.now();
  ipcRenderer.send('fetch-minute', watchlist.map(w => w.code));
}
function startMinuteTimer() {
  if (minuteTimer) clearInterval(minuteTimer);
  minuteTimer = setInterval(fetchMinutes, 30000);
  fetchMinutes();
}
ipcRenderer.on('minute', (event, data) => {
  if (!data || data.error) { _minFailStreak++; return; }
  const entries = Object.values(data);
  const got = entries.filter(s => Array.isArray(s) && s.length >= 2).length;
  if (entries.length > 0 && got === 0) _minFailStreak++; // 全部为空 = 本轮全失败（多为限流）
  else _minFailStreak = 0;
  for (const code in data) drawSpark(code, data[code]);
  // 仅分时视图下，行情/分时数据到达时自动重绘（K线/五日由各自 IPC 触发，避免互相打断）
  if (chartCode && chartPeriod === 'min') drawBigChart(chartCode);
});
// 板块分时是用成分股等权合成的（基准 1000），与板块指数实际点位不同量纲。
// 这里按「板块现价 / 曲线最后一点」整体缩放，让曲线、悬浮提示、昨收基准都用真实点位。
function boardScaleTarget(code) {
  let cur = lastPrice[code];
  if (!(cur > 0)) {
    const pc = sparkPrevClose[code];
    const pct = pctMap[code];
    if (pc > 0 && typeof pct === 'number') cur = pc * (1 + pct / 100);
  }
  return cur > 0 ? cur : 0;
}
function scaleBoardSeries(code, series) {
  if (!/^bk/i.test(code) || !Array.isArray(series) || !series.length) return series;
  const cur = boardScaleTarget(code);
  const lastP = series[series.length - 1].p;
  if (!(cur > 0) || !(lastP > 0)) return series;
  const k = cur / lastP;
  return series.map(d => ({ ...d, p: d.p * k }));
}
function drawSpark(code, series) {
  if (!series || series.length < 2) return;
  series = scaleBoardSeries(code, series);
  sparkData[code] = series; // 存原始（含时刻）供 tooltip / 弹窗，即使不在自选股列表
  const row = listEl.querySelector(`.row[data-code="${code}"]`);
  if (!row) return;
  const svg = row.querySelector('.spark');
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width));
  const H = Math.max(1, Math.round(rect.height));
  // 视图隐藏/尺寸未就绪时延迟重绘，避免画成畸形填充块
  if (W <= 1 || H <= 1 || rect.width === 0 || rect.height === 0) {
    if (!svg._retryTimer) {
      svg._retryTimer = setTimeout(() => {
        svg._retryTimer = null;
        drawSpark(code, series);
      }, 80);
    }
    return;
  }
  const pad = 3;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const prices = series.map(d => d.p);
  // 板块行情未到时合成曲线还是 1000 基准，与板块昨收不在一个量纲，画基准线会把线压到最底部；
  // 此时跳过基准线，等 prices 回调重绘时再按真实点位显示
  const isBoardCode = /^bk/i.test(code);
  const prevClose = (isBoardCode && boardScaleTarget(code) <= 0)
    ? NaN
    : parseFloat(row.dataset.prevclose || 'NaN');
  let min = Math.min(...prices), max = Math.max(...prices);
  if (!isNaN(prevClose)) { min = Math.min(min, prevClose); max = Math.max(max, prevClose); }
  const range = (max - min) || 1;
  const xOf = i => (i / (series.length - 1)) * W;
  const yOf = v => H - pad - ((v - min) / range) * (H - pad * 2);
  const line = prices.map((p, i) => xOf(i).toFixed(1) + ',' + yOf(p).toFixed(1)).join(' ');
  // 按设置决定分时颜色：纯色或随涨跌色
  let color;
  if (settings.sparkMode === 'solid') {
    color = settings.sparkColor || COLORS.spark;
  } else {
    const pct = pctMap[code];
    if (pct !== undefined) {
      color = pct >= 0 ? COLORS.up : COLORS.down;
    } else if (!isNaN(prevClose)) {
      // 分时比行情先到时，用最后价 vs 昨收判断方向，避免先画默认蓝色再跳成涨跌色
      color = prices[prices.length - 1] >= prevClose ? COLORS.up : COLORS.down;
    } else {
      // 连昨收都没有（刚启动）：先不画，等行情到达后由 prices 回调重绘，杜绝蓝色占位闪一下
      const rowUp = row.classList.contains('up');
      const rowDown = row.classList.contains('down');
      if (!rowUp && !rowDown) return;
      color = rowUp ? COLORS.up : COLORS.down;
    }
  }
  const rgb = hexToRgb(color);
  const fill = rgb ? `rgba(${rgb.r},${rgb.g},${rgb.b},0.16)` : 'rgba(120,130,160,0.10)';
  const baselineY = !isNaN(prevClose) ? yOf(prevClose).toFixed(1) : H;
  let html = '';
  if (!isNaN(prevClose)) {
    html += `<line x1="0" y1="${baselineY}" x2="${W}" y2="${baselineY}" stroke="rgba(86,91,107,0.45)" stroke-width="1" stroke-dasharray="3 3" />`;
  }
  // 面积填充以昨收为基准，高于基准向上填、低于基准向下填，更像真实分时图
  html += `<polygon points="0,${baselineY} ${line} ${W},${baselineY}" fill="${fill}" />`;
  html += `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />`;
  svg.innerHTML = html;
}
function redrawAllSparks() {
  for (const code in sparkData) drawSpark(code, sparkData[code]);
}
// 任一颜色 / 分时图设置变更后：行内分时图 + 正在查看的放大弹窗同步重绘，做到「改完立刻变色」
// 防抖：拖动颜色/滑块时 input 事件一秒触发几十次，重绘 SVG 很费，这里合并到每 120ms 最多一次，杜绝卡顿
let _sparkRedrawTimer = null;
function applySparkRedraw() {
  if (_sparkRedrawTimer) clearTimeout(_sparkRedrawTimer);
  _sparkRedrawTimer = setTimeout(() => {
    _sparkRedrawTimer = null;
    redrawAllSparks();
    if (chartCode && chartPeriod === 'min') drawBigChart(chartCode);
    updateSparkPreview();
  }, 120);
}
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex || '').trim());
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}
// 时间格式化：腾讯分时 t 为 "0930"，东方财富为 "09:31"；统一显示为 "09:30"
// 五日分时 t 为 "2026-07-20 09:30"，简化为 "07-20 09:30"
function fmtTime(t) {
  if (!t) return '';
  t = String(t).trim();
  if (t.length === 4 && /^\d{4}$/.test(t)) return t.slice(0, 2) + ':' + t.slice(2);
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})$/);
  if (m) return `${m[2]}-${m[3]} ${m[4]}`;
  return t;
}

// ---------- 价格预警 + 通知 ----------
function notify(title, body) {
  // 同 key 60 秒内不重复弹，避免连续刷新反复轰炸
  const key = title + '|' + body;
  const now = Date.now();
  if (notifyLog[key] && now - notifyLog[key] < 60000) return;
  notifyLog[key] = now;
  ipcRenderer.send('show-notification', { title, body }); // 主进程原生通知（点穿/无焦点也收得到）
  showToast(title, body);                                   // 应用内 toast
}
function showToast(title, body) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<div class="toast-title">${title}</div><div class="toast-body">${body}</div>`;
  toastEl.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 350);
  }, 4200);
}
// 保存成功的轻提示（去抖，避免拖动滑块时疯狂刷屏）。非技术用户也能一眼确认“改了就被记住了”。
let _savedToast = null, _savedTimer = null;
function notifySaved() {
  if (!toastEl) return;
  if (!_savedToast) {
    _savedToast = document.createElement('div');
    _savedToast.className = 'toast toast-saved';
    _savedToast.innerHTML = '<div class="toast-title">✓ 已保存</div>';
    toastEl.appendChild(_savedToast);
    requestAnimationFrame(() => _savedToast.classList.add('show'));
  }
  clearTimeout(_savedTimer);
  _savedTimer = setTimeout(() => {
    if (_savedToast) { const el = _savedToast; _savedToast = null; el.classList.remove('show'); setTimeout(() => el.remove(), 350); }
  }, 1500);
}
// 预警提示音：Web Audio 合成两声短 beep，无需音频文件；首次需用户交互后才可发声
let _audioCtx = null;
function playAlertSound() {
  if (!settings.alertSound) return;
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const beep = (t, freq) => {
      const o = _audioCtx.createOscillator(), g = _audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(_audioCtx.destination);
      const now = _audioCtx.currentTime + t;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      o.start(now); o.stop(now + 0.2);
    };
    beep(0, 880); beep(0.22, 1175);
  } catch (e) {}
}

function checkAlert(d) {
  const item = itemMap.get(d.code);
  if (!item || !d.price) return;
  const price = d.price;
  const pctMode = item.alertMode === 'pct'; // true=按涨跌幅%预警，false=按绝对价
  const hi = parseFloat(item.alertHigh);
  const lo = parseFloat(item.alertLow);
  const st = alertState[d.code] || {};
  // 高位命中：价格模式 price>=hi；百分比模式 changePct>=hi
  const hiHit = !isNaN(hi) && (pctMode ? d.changePct >= hi : price >= hi);
  // 低位命中：价格模式 price<=lo；百分比模式 changePct<=lo（可为负，如 -3%）
  const loHit = !isNaN(lo) && (pctMode ? d.changePct <= lo : price <= lo);
  if (hiHit && !st.hi) {
    notify(`${item.name || d.code} 触及高位`, pctMode ? `现涨幅 ${d.changePct.toFixed(2)}%　预警 ${hi.toFixed(2)}%` : `现价 ${price.toFixed(2)}　预警价 ${hi.toFixed(2)}`);
    playAlertSound();
    st.hi = true;
  }
  if (loHit && !st.lo) {
    notify(`${item.name || d.code} 触及低位`, pctMode ? `现涨幅 ${d.changePct.toFixed(2)}%　预警 ${lo.toFixed(2)}%` : `现价 ${price.toFixed(2)}　预警价 ${lo.toFixed(2)}`);
    playAlertSound();
    st.lo = true;
  }
  // 离开预警区间后复位，下次再进入可再次触发
  if (!hiHit) st.hi = false;
  if (!loHit) st.lo = false;
  alertState[d.code] = st;
}

// ---------- 分时图悬停 tooltip ----------
const tipEl = document.createElement('div');
tipEl.className = 'tip';
tipEl.style.display = 'none';
document.body.appendChild(tipEl);
function positionTipEl(x, y) {
  tipEl.style.display = 'block';
  const w = tipEl.offsetWidth || 120;
  const h = tipEl.offsetHeight || 60;
  const vw = window.innerWidth || 800;
  const vh = window.innerHeight || 600;
  let left = x + 14;
  let top = y - 12;
  if (left + w > vw - 8) left = x - w - 14;
  if (left < 8) left = 8;
  if (top + h > vh - 8) top = vh - h - 8;
  if (top < 8) top = 8;
  tipEl.style.left = left + 'px';
  tipEl.style.top = top + 'px';
}
listEl.addEventListener('mousemove', e => {
  const row = e.target.closest('.row');
  if (!row) { tipEl.style.display = 'none'; return; }
  const code = row.dataset.code;
  const s = code && sparkData[code];
  if (!s || s.length < 2) { tipEl.style.display = 'none'; return; }
  const chart = row.querySelector('.chart') || row;
  const rect = chart.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const idx = Math.round(ratio * (s.length - 1));
  const d = s[idx];
  tipEl.innerHTML = `<b>${fmtTime(d.t)}</b>　${d.p.toFixed(2)}`;
  positionTipEl(e.clientX, e.clientY);
});
listEl.addEventListener('mouseleave', () => { tipEl.style.display = 'none'; });

// ---------- 拖拽排序自选股 ----------
let isDragging = false;     // 拖拽进行中：阻止行情自动重排打断手动排序
let suppressClickUntil = 0; // 拖拽结束后短暂抑制行内点击（避免误开放大图）
function syncWatchlist() {
  ipcRenderer.send('sync-watchlist', watchlist.map(w => ({ name: w.name, code: w.code })));
}
// 自定义指针拖拽：卡片直接跟随光标、实时重排（取代原生 HTML5 拖拽，修复“向下拖失效”与“仅松手才生效”的问题）
function applyOrder(codes) {
  const grp = activeGroup();
  const map = new Map(grp.items.map(w => [w.code, w]));
  const next = [];
  codes.forEach(c => { if (map.has(c)) { next.push(map.get(c)); map.delete(c); } });
  map.forEach(w => next.push(w)); // 兜底：保留未能匹配的项
  grp.items.length = 0;
  next.forEach(x => grp.items.push(x));
  watchlist = grp.items;
  saveWatchlist();
  syncWatchlist();
  animateReorder(render); // 增量重排，保留分时图/闪烁状态
  updatePinned();
  renderManage();
}
function setupPointerDrag(container, rowSel, onCommit) {
  const ROW_CLS = rowSel.replace('.', '');
  let st = null;
  const siblings = () => [...container.children].filter(el => el !== st.row && el !== st.placeholder && el.classList.contains(ROW_CLS));

  container.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, a, .no-drag')) return; // 控件上不触发拖拽
    const row = e.target.closest(rowSel);
    if (!row) return;
    st = { row, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, phase: 'pending', placeholder: null, shift: 0 };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  function onMove(e) {
    if (!st) return;
    if (st.phase === 'pending') {
      if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) < 5) return; // 5px 阈值：区分点击与拖拽
      startDrag(e);
    }
    if (st.phase !== 'dragging') return;
    e.preventDefault();
    st.row.style.top = (e.clientY - st.shift) + 'px'; // 卡片直接跟随光标
    const sibs = siblings();
    let idx = sibs.length;
    for (let i = 0; i < sibs.length; i++) {
      const r = sibs[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { idx = i; break; }
    }
    flipMove(idx);
  }

  function startDrag(e) {
    st.phase = 'dragging';
    isDragging = true;
    const rect = st.row.getBoundingClientRect();
    st.shift = e.clientY - rect.top;
    const ph = document.createElement('div');
    ph.className = 'drag-placeholder';
    ph.style.height = rect.height + 'px';
    container.insertBefore(ph, st.row);
    st.placeholder = ph;
    st.row.classList.add('dragging');
    Object.assign(st.row.style, {
      position: 'fixed', width: rect.width + 'px', left: rect.left + 'px',
      top: rect.top + 'px', height: rect.height + 'px', zIndex: '1000',
      margin: '0', pointerEvents: 'none', boxShadow: '0 12px 32px rgba(30,40,80,0.30)'
    });
    try { container.setPointerCapture(st.pointerId); } catch {}
    document.body.classList.add('dragging-active');
    if (settings.sortByChange) { settings.sortByChange = false; if (sortChk) sortChk.checked = false; saveSettings(); } // 手动排序后关闭自动按涨跌排序，使手动顺序生效
  }

  function flipMove(idx) {
    const sibs = siblings();
    const first = new Map();
    sibs.forEach(el => first.set(el, el.getBoundingClientRect().top));
    const target = idx < sibs.length ? sibs[idx] : null;
    if (target) { if (st.placeholder.nextElementSibling !== target) container.insertBefore(st.placeholder, target); }
    else if (container.lastElementChild !== st.placeholder) container.appendChild(st.placeholder);
    sibs.forEach(el => {
      const dy = first.get(el) - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) { // FLIP：其余卡片平滑让位
        el.style.transition = 'none';
        el.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => { el.style.transition = 'transform .16s ease'; el.style.transform = ''; });
      }
    });
  }

  function onUp() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (!st) return;
    if (st.phase === 'dragging') {
      try { container.releasePointerCapture(st.pointerId); } catch {}
      container.insertBefore(st.row, st.placeholder);
      st.placeholder.remove();
      const r = st.row;
      r.classList.remove('dragging');
      r.style.position = r.style.width = r.style.left = r.style.top = r.style.height = r.style.zIndex = r.style.margin = r.style.pointerEvents = r.style.boxShadow = '';
      document.body.classList.remove('dragging-active');
      isDragging = false;
      const order = [...container.children].filter(el => el.classList.contains(ROW_CLS)).map(el => el.dataset.code);
      st = null;
      onCommit(order);
      suppressClickUntil = Date.now() + 250; // 抑制拖拽结束瞬间误触打开放大图
    } else {
      st = null;
    }
  }
}
setupPointerDrag(listEl, '.row', applyOrder);

// ---------- 名称搜索（多结果下拉 + 键盘选择） ----------
function tagOf(item) {
  const t = item.type || '';
  if (/^bk/i.test(item.code)) return '板';
  if (item.market === 'hk') return '港';
  if (/^sh000|^sz000|^sh399|^sz399|^[H9]\d+$/.test(item.code)) return '指';
  if (/ETF|基金|LOF/.test(t)) return 'ETF';
  if (/^sh6/.test(item.code)) return '沪';
  if (/^sz30/.test(item.code)) return '创';
  if (/^sz/.test(item.code)) return '深';
  if (/^bj/.test(item.code)) return '京';
  if (/期货/.test(t)) return '期';
  return t.slice(0, 2) || '股';
}
codeInput.addEventListener('input', () => {
  const q = codeInput.value.trim();
  searchActiveIdx = -1;
  if (!q) { hideSearch(); return; }
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => ipcRenderer.send('fetch-search', q), 200);
});
codeInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') {
    if (!searchBox.hidden && lastSearch.length) {
      e.preventDefault();
      searchActiveIdx = Math.min(searchActiveIdx + 1, lastSearch.length - 1);
      highlightSearch();
    }
  } else if (e.key === 'ArrowUp') {
    if (!searchBox.hidden && lastSearch.length) {
      e.preventDefault();
      searchActiveIdx = Math.max(searchActiveIdx - 1, 0);
      highlightSearch();
    }
  } else if (e.key === 'Enter') {
    if (!searchBox.hidden && searchActiveIdx >= 0 && lastSearch[searchActiveIdx]) {
      e.preventDefault();
      pickSearch(lastSearch[searchActiveIdx]);
    } else {
      commitAdd();
    }
  } else if (e.key === 'Escape') {
    hideSearch();
  }
});
ipcRenderer.on('search', (event, res) => {
  if (pfAddActive) { renderPfAddResults(res); return; }
  if (!res || res.error) {
    searchBox.innerHTML = '<div class="s-empty">搜索失败，可直接输入代码</div>';
    showSearch();
    return;
  }
  lastSearch = res;
  renderSearch(res);
});
function renderSearch(list) {
  searchBox.innerHTML = '';
  if (!list || !list.length) { searchBox.innerHTML = '<div class="s-empty">无匹配</div>'; showSearch(); return; }
  searchActiveIdx = -1;
  list.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 's-item no-drag';
    div.dataset.idx = String(i);
    div.style.animationDelay = (i * 0.025) + 's'; // 搜索结果逐条浮入
    div.innerHTML = `<span class="s-tag">${tagOf(item)}</span><span class="s-name">${item.name}</span><span class="s-code">${uiCode(item.code)}</span>`;
    div.addEventListener('click', () => pickSearch(item));
    searchBox.appendChild(div);
  });
  showSearch();
}
function highlightSearch() {
  searchBox.querySelectorAll('.s-item').forEach((el, i) => el.classList.toggle('active', i === searchActiveIdx));
  const el = searchBox.querySelector('.s-item.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}
function pickSearch(item) {
  if (!item) return;
  addStock(item.code, item.name); // 带上搜索给的名称（板块在行情里取不到名称）
  codeInput.value = '';
  hideSearch();
  searchActiveIdx = -1;
}
function showSearch() {
  searchBox.hidden = false;
  requestAnimationFrame(() => searchBox.classList.add('open'));
}
function hideSearch() {
  searchActiveIdx = -1;
  if (searchBox.hidden) return;
  searchBox.classList.remove('open');
  setTimeout(() => { if (!searchBox.classList.contains('open')) { searchBox.hidden = true; searchBox.innerHTML = ''; } }, 180);
}

// （板块已改为：搜索直接出结果，选中即加入自选，无需独立面板）

// ---------- 颜色自定义 ----------
function applyColors() {
  document.documentElement.style.setProperty('--up', settings.upColor);
  document.documentElement.style.setProperty('--down', settings.downColor);
  refreshColors();
}
function applyGlass() {
  document.documentElement.style.setProperty('--glass', String(settings.glass));
  // 低浓度（更透明）时加大模糊，文字才能在不透明背景上保持清晰；高浓度时适度减弱
  const blur = 8 + 22 * (1 - settings.glass); // glass=1 → 8px, glass=0.18 → 26px
  document.documentElement.style.setProperty('--blur', `${blur.toFixed(1)}px`);
  if (glassVal) glassVal.textContent = Number(settings.glass).toFixed(2);
}
// 设置面板里「分时图颜色」的实时预览小图：当前模式 / 颜色下分时线应该长什么样，改完立刻可见
function updateSparkPreview() {
  const el = document.getElementById('sparkPreview');
  if (!el) return;
  let color;
  if (settings.sparkMode === 'solid') {
    color = settings.sparkColor || COLORS.spark;
  } else {
    // 随涨跌：用涨色(红)代表，提示「按当日涨跌着色」
    color = COLORS.up;
  }
  const W = 220, H = 40, pad = 4;
  const pts = [16, 22, 18, 26, 33, 28, 36, 30, 42, 38, 50, 44, 40, 52, 58, 50, 62, 56, 68, 60, 72, 66, 78, 74];
  const min = Math.min(...pts), max = Math.max(...pts);
  const range = (max - min) || 1;
  const line = pts.map((p, i) => ((i / (pts.length - 1)) * W).toFixed(1) + ',' + (H - pad - ((p - min) / range) * (H - pad * 2)).toFixed(1)).join(' ');
  const rgb = hexToRgb(color);
  const fill = rgb ? `rgba(${rgb.r},${rgb.g},${rgb.b},0.14)` : 'rgba(120,130,160,0.10)';
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
    + `<polygon points="0,${H} ${line} ${W},${H}" fill="${fill}"/>`
    + `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function applyTheme() {
  document.body.classList.toggle('theme-dark', settings.theme === 'dark');
}
function applyFontSize() {
  const size = Math.max(10, Math.min(17, parseInt(settings.fontSize, 10) || 13));
  document.documentElement.style.setProperty('--font-size', size + 'px');
  if (fontSizeSlider) fontSizeSlider.value = size;
  if (fontSizeVal) fontSizeVal.textContent = size + 'px';
}
// 设置面板里的自选列表管理
// HTML 转义：防止外部导入的 JSON 中 name/code 含标签造成注入
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// 成本 chip 文案：有持仓显示加权成本与股数，否则提示「记录成本」
// 实时盈亏预览（用于管理弹窗紧凑行与详情），无持仓返回空
function mPnlPreview(item) {
  const h = holdingOf(item);
  const price = lastPrice[item.code];
  if (!h || price == null) return '';
  const r = computePnl(item, price);
  if (!r || r.hp == null) return '';
  const sym = CUR_SYM[marketOf(item.code)] || '';
  const hold = pnlSpan(r.hp, r.hpPct, sym, true);
  const today = pnlSpan(r.tp, r.tpPct, sym, true);
  return `<span class="mp-h">持 ${hold}</span>${today ? ` <span class="mp-t">今 ${today}</span>` : ''}`;
}
// 成本区（detail 内）：成本价 + 股数并排，下方实时盈亏预览
function buildCostArea(item) {
  const h = holdingOf(item);
  const cost = (item.cost != null && item.cost !== '') ? item.cost : (h ? h.avgCost.toFixed(3) : '');
  const shares = (item.shares != null && item.shares !== '') ? item.shares : (h ? Math.round(h.shares) : '');
  return `<div class="m-cost">
    <label>成本价<input class="cost-price no-drag" type="number" step="0.001" placeholder="买入价" value="${esc(cost)}"></label>
    <label>股数<input class="cost-shares no-drag" type="number" step="1" placeholder="持仓股数" value="${esc(shares)}"></label>
  </div>
  <div class="m-pnl-preview">${mPnlPreview(item) || '<span class="m-pnl-hint">填完整成本与股数后显示盈亏</span>'}</div>
  <button class="cost-adv no-drag" title="多批次建仓点此展开高级模式">高级：分批建仓</button>
  <div class="lots-editor" data-code="${esc(item.code)}" hidden></div>`;
}
// 建仓批次编辑器 HTML（点击「高级」时懒加载），含「返回简单成本」互通
function buildLotsEditor(item) {
  const lots = Array.isArray(item.lots) ? item.lots : [];
  const today = new Date().toISOString().slice(0, 10);
  const rows = lots.map((l, i) => `<div class="lot-row">
    <input class="lot-date no-drag" data-i="${i}" type="date" value="${esc(l.date || '')}">
    <input class="lot-price no-drag" data-i="${i}" type="number" step="0.01" placeholder="价格" value="${esc(l.price || '')}">
    <input class="lot-shares no-drag" data-i="${i}" type="number" step="1" placeholder="股数" value="${esc(l.shares || '')}">
    <button class="lot-del no-drag" data-i="${i}" title="删除">×</button>
  </div>`).join('');
  const h = holdingOf(item);
  const avg = h ? `加权成本 <b>¥${h.avgCost.toFixed(2)}</b> · 持仓 <b>${Math.round(h.shares)}</b> 股` : '尚未建仓';
  return `<div class="lots-head">建仓批次（自动算加权成本）</div>
    <div class="lots-rows">${rows || '<div class="lots-none">暂无批次，下面添加</div>'}</div>
    <div class="lot-add-row">
      <input class="lot-date-new no-drag" type="date" value="${today}">
      <input class="lot-price-new no-drag" type="number" step="0.01" placeholder="价格">
      <input class="lot-shares-new no-drag" type="number" step="1" placeholder="股数">
      <button class="lot-add no-drag" title="添加批次">＋</button>
    </div>
    <div class="lots-avg">${avg}</div>
    <button class="lot-back no-drag" title="把加权成本回填为单笔简单成本">返回简单成本</button>`;
}
// 刷新某条的成本预览（简单模式输入后实时反馈）
function refreshMpnl(it, item) {
  const preview = it.querySelector('.m-pnl-preview');
  if (preview) preview.innerHTML = mPnlPreview(item) || '<span class="m-pnl-hint">填完整成本与股数后显示盈亏</span>';
  const barPnl = it.querySelector('.m-pnl');
  if (barPnl) barPnl.innerHTML = mPnlPreview(item);
}
function renderManage() {
  if (!manageList) return;
  manageList.innerHTML = '';
  if (!watchlist.length) { manageList.innerHTML = '<div class="m-empty">暂无自选股</div>'; return; }
  watchlist.forEach(item => {
    const d = document.createElement('div');
    d.className = 'm-item';
    d.dataset.code = item.code;
    const pinned = settings.pinnedList.includes(item.code);
    const pnl = mPnlPreview(item);
    d.innerHTML = `
      <div class="m-bar no-drag">
        <span class="m-star" title="设为常驻票">${pinned ? '★' : '☆'}</span>
        <span class="m-name">${esc(item.name || item.code)}</span>
        <span class="m-code">${esc(uiCode(item.code))}</span>
        <span class="m-pnl">${pnl}</span>
        <span class="m-del" title="删除">×</span>
        <span class="m-expand" title="展开设置">▾</span>
      </div>
      <div class="m-cost-wrap">${buildCostArea(item)}</div>
      <div class="m-detail" hidden>
        <div class="m-alerts">
          <label>高 <input class="m-hi no-drag" type="number" step="0.01" placeholder="预警价" value="${esc(item.alertHigh || '')}"></label>
          <label>低 <input class="m-lo no-drag" type="number" step="0.01" placeholder="预警价" value="${esc(item.alertLow || '')}"></label>
          <label class="m-pct-label" title="勾选后，高/低按涨跌幅%预警（如 跌超3% 填 -3）"><input class="m-pct no-drag" type="checkbox" ${item.alertMode === 'pct' ? 'checked' : ''}>按%</label>
        </div>
      </div>`;
    manageList.appendChild(d);
  });
}
if (manageList) {
  setupPointerDrag(manageList, '.m-item', applyOrder); // 整行拖拽（指针实现），输入框/按钮不触发
  // 预警价 / 成本 / 批次输入即时保存
  manageList.addEventListener('input', e => {
    const it = e.target.closest('.m-item');
    if (!it) return;
    const item = itemMap.get(it.dataset.code) || watchlist.find(w => w.code === it.dataset.code);
    if (!item) return;
    const inp = e.target;
    if (inp.classList.contains('m-hi')) {
      item.alertHigh = inp.value.trim();
      saveWatchlistDebounced();
    } else if (inp.classList.contains('m-lo')) {
      item.alertLow = inp.value.trim();
      saveWatchlistDebounced();
    } else if (inp.classList.contains('cost-price') || inp.classList.contains('cost-shares')) {
      // 简单模式：直接写 item.cost / item.shares（与 holdingOf 兼容，单框也能保存）
      const price = it.querySelector('.cost-price').value.trim();
      const shares = it.querySelector('.cost-shares').value.trim();
      item.cost = price;
      item.shares = shares;
      item.lots = []; // 简单模式清空批次，避免 holdingOf 优先用 lots 导致简单设置无效
      refreshMpnl(it, item);
      updateRowPnl(item.code); updatePortfolio();
      saveWatchlistDebounced();
    } else if (inp.classList.contains('lot-price') || inp.classList.contains('lot-shares') || inp.classList.contains('lot-date')) {
      const i = parseInt(inp.dataset.i, 10);
      if (!Array.isArray(item.lots)) item.lots = [];
      if (!item.lots[i]) item.lots[i] = {};
      const key = inp.classList.contains('lot-price') ? 'price' : inp.classList.contains('lot-shares') ? 'shares' : 'date';
      item.lots[i][key] = inp.value.trim();
      const ed = it.querySelector('.lots-editor');
      if (ed && !ed.hidden) {
        const avg = ed.querySelector('.lots-avg');
        if (avg) { const h = holdingOf(item); avg.innerHTML = h ? `加权成本 <b>¥${h.avgCost.toFixed(2)}</b> · 持仓 <b>${Math.round(h.shares)}</b> 股` : '尚未建仓'; }
      }
      updateRowPnl(item.code); updatePortfolio(); saveWatchlistDebounced();
    }
  });
  // 按%预警模式切换（checkbox 用 change 事件更稳）
  manageList.addEventListener('change', e => {
    const pct = e.target.closest('.m-pct');
    if (!pct) return;
    const it = e.target.closest('.m-item');
    if (!it) return;
    const item = itemMap.get(it.dataset.code) || watchlist.find(w => w.code === it.dataset.code);
    if (!item) return;
    item.alertMode = pct.checked ? 'pct' : 'price';
    saveWatchlistDebounced();
  });
  // 点击交互：星标 / 删除 / 高级批次切换 / 返回简单 / 批次增删 / 展开收起
  manageList.addEventListener('click', e => {
    const it = e.target.closest('.m-item');
    if (!it) return;
    const code = it.dataset.code;
    const item = itemMap.get(code) || watchlist.find(w => w.code === code);
    if (!item) return;
    const star = e.target.closest('.m-star');
    if (star) {
      togglePinned(code);
      return;
    }
    const del = e.target.closest('.m-del');
    if (del) { removeStock(code); renderManage(); return; }
    const adv = e.target.closest('.cost-adv');
    if (adv) {
      const ed = it.querySelector('.lots-editor');
      if (ed.hidden) {
        // 简单 → 高级：把当前 cost/shares 转成首个批次（若有），不丢数据
        if (!item.lots || item.lots.length === 0) {
          const p = parseFloat(item.cost), s = parseFloat(item.shares);
          if (!isNaN(p) && p > 0 && !isNaN(s) && s > 0) item.lots = [{ date: '', price: item.cost, shares: item.shares }];
        }
        ed.innerHTML = buildLotsEditor(item); ed.hidden = false; adv.textContent = '收起批次';
      } else { ed.hidden = true; adv.textContent = '高级：分批建仓'; }
      return;
    }
    const back = e.target.closest('.lot-back');
    if (back) {
      const h = holdingOf(item);
      if (h) { item.cost = h.avgCost.toFixed(3); item.shares = String(Math.round(h.shares)); }
      item.lots = [];
      const ed = it.querySelector('.lots-editor'); ed.hidden = true;
      const adv = it.querySelector('.cost-adv'); if (adv) adv.textContent = '高级：分批建仓';
      const cw = it.querySelector('.m-cost-wrap'); if (cw) cw.innerHTML = buildCostArea(item);
      refreshMpnl(it, item); updateRowPnl(item.code); updatePortfolio(); saveWatchlistDebounced();
      return;
    }
    const add = e.target.closest('.lot-add');
    if (add) {
      const ed = it.querySelector('.lots-editor');
      const p = ed.querySelector('.lot-price-new').value.trim();
      const s = ed.querySelector('.lot-shares-new').value.trim();
      if (p && s && parseFloat(s) > 0) {
        if (!Array.isArray(item.lots)) item.lots = [];
        item.lots.push({ date: ed.querySelector('.lot-date-new').value.trim(), price: p, shares: s });
        ed.innerHTML = buildLotsEditor(item);
        updateRowPnl(item.code); updatePortfolio(); saveWatchlistDebounced();
      }
      return;
    }
    const ldel = e.target.closest('.lot-del');
    if (ldel) {
      const i = parseInt(ldel.dataset.i, 10);
      if (Array.isArray(item.lots)) item.lots.splice(i, 1);
      const ed = it.querySelector('.lots-editor'); ed.innerHTML = buildLotsEditor(item);
      updateRowPnl(item.code); updatePortfolio(); saveWatchlistDebounced();
      return;
    }
    // 点击紧凑行（非按钮）展开 / 收起详情
    const bar = e.target.closest('.m-bar');
    if (bar) {
      const detail = it.querySelector('.m-detail');
      const open = detail.hidden;
      detail.hidden = !open;
      it.classList.toggle('expanded', open);
    }
  });
}
upColor.addEventListener('input', () => { settings.upColor = upColor.value; applyColors(); applySparkRedraw(); saveSettings(); });
downColor.addEventListener('input', () => { settings.downColor = downColor.value; applyColors(); applySparkRedraw(); saveSettings(); });
if (sparkModeSel) sparkModeSel.addEventListener('change', () => {
  settings.sparkMode = sparkModeSel.value;
  if (sparkColor) sparkColor.style.display = (settings.sparkMode === 'solid') ? 'block' : 'none';
  saveSettings();
  applySparkRedraw();
});
if (sparkColor) sparkColor.addEventListener('input', () => {
  settings.sparkColor = sparkColor.value;
  saveSettings();
  applySparkRedraw();
});
if (settingsManageBtn) settingsManageBtn.addEventListener('click', () => { openManage(); closeSettings(); });

// ---------- 设置应用 ----------
function applySettings() {
  ipcRenderer.send('set-opacity', settings.opacity);
  ipcRenderer.send('set-always-on-top', settings.alwaysOnTop);
  ipcRenderer.send('set-click-through', settings.clickThrough);
  applyColors();
  applyGlass();
  applyTheme();
  applyFontSize();
  opacitySlider.value = settings.opacity;
  opacityVal.textContent = Number(settings.opacity).toFixed(2);
  intervalSel.value = String(settings.interval);
  aotChk.checked = settings.alwaysOnTop;
  lockChk.checked = settings.locked;
  clickChk.checked = settings.clickThrough;
  if (edgeChk) edgeChk.checked = settings.edgeHide !== false;
  ipcRenderer.send('set-edge-hide', settings.edgeHide !== false);
  sortChk.checked = settings.sortByChange;
  compactChk.checked = settings.compact;
  upColor.value = settings.upColor;
  downColor.value = settings.downColor;
  if (glassSlider) glassSlider.value = settings.glass;
  if (themeSel) themeSel.value = settings.theme;
  if (fontSizeSlider) fontSizeSlider.value = settings.fontSize;
  if (fontSizeVal) fontSizeVal.textContent = settings.fontSize + 'px';
  if (soundChk) soundChk.checked = settings.alertSound;
  if (taskbarChk) taskbarChk.checked = settings.taskbarTicker !== false;
  // 任务栏行情开关同步主进程（无数据也要先切换任务栏按钮显隐）
  ipcRenderer.send('taskbar-ticker', (settings.taskbarTicker === false) ? null : { on: true });
  if (rateUSD) rateUSD.value = settings.rateUSD;
  if (rateHKD) rateHKD.value = settings.rateHKD;
  if (sparkModeSel) sparkModeSel.value = settings.sparkMode || 'change';
  if (sparkColor) sparkColor.value = settings.sparkColor || '#5b8def';
  if (sparkColor) sparkColor.style.display = (settings.sparkMode === 'solid') ? 'block' : 'none';
  updateSparkPreview();
  // 列表列显隐：取消勾选即在 body 上加 hide-* 类（CSS 隐藏对应列）
  [['colChg', 'showChg', 'chg'], ['colHL', 'showHL', 'hl'], ['colPnl', 'showPnl', 'pnl'], ['colSpark', 'showSpark', 'spark']].forEach(([elId, key, cls]) => {
    const el = { colChg, colHL, colPnl, colSpark }[elId];
    if (!el) return;
    el.checked = settings[key];
    document.body.classList.toggle('hide-' + cls, !settings[key]);
  });
  document.body.classList.toggle('locked', settings.locked);
  document.body.classList.toggle('compact', settings.compact);
}

// ---------- 事件 ----------
function addStock(raw, name) {
  const code = normalizeCode(raw);
  if (!code) return;
  const idx = watchlist.findIndex(w => w.code === code);
  if (idx >= 0) {
    // 已在自选：移到最上面（保留原持仓/预警/成本等数据，只更新名称）
    const [item] = watchlist.splice(idx, 1);
    if (name) item.name = name;
    watchlist.unshift(item);
  } else {
    watchlist.unshift({ code, name: name || code, alertHigh: '', alertLow: '', cost: '', shares: '', lots: [] });
  }
  saveWatchlist();
  syncWatchlist();
  render(); // 增量渲染：仅新增这一行（createRow 已带淡入动画），不影响其它行
  updatePinned();
  renderManage();
  refresh();
  fetchMinutes();
}

// 带动画的删除：先播放退场动画，结束后再真正移除数据并重绘
function removeStock(code) {
  const row = rowMap.get(code);
  const finish = () => {
    const idx = watchlist.findIndex(w => w.code === code);
    if (idx >= 0) { watchlist.splice(idx, 1); saveWatchlist(); syncWatchlist(); }
    // 从常驻列表移除，并保持 pinned = 第一只（避免任务栏轮播到已删除的票）
    const pi = settings.pinnedList.indexOf(code);
    if (pi >= 0) { settings.pinnedList.splice(pi, 1); settings.pinned = settings.pinnedList[0] || ''; saveSettings(); }
    delete alertState[code]; delete pctMap[code]; delete sparkData[code]; delete sparkPrevClose[code];
    render(); updatePinned(); renderManage(); refresh(); fetchMinutes();
  };
  if (row) {
    row.classList.add('leaving');
    let done = false;
    const once = () => { if (done) return; done = true; row.removeEventListener('animationend', once); finish(); };
    row.addEventListener('animationend', once);
    setTimeout(once, 320); // 兜底，防止 animationend 未触发
  } else finish();
}

// 添加提交：代码直接加；名称则触发搜索弹出多结果下拉供挑选（不自动加第一条）
function commitAdd() {
  const raw = codeInput.value.trim();
  if (!raw) return;
  const code = normalizeCode(raw);
  // 已是合法代码格式（含市场前缀的数字 / 板块 BK 代码）→ 直接加
  if (/^(sh|sz|hk|bj|us|bk)\d{4,6}$/i.test(code)) {
    addStock(raw, raw.toUpperCase());
    codeInput.value = '';
    hideSearch();
    return;
  }
  // 名称：触发搜索，弹出多条候选供手动挑选
  if (searchTimer) clearTimeout(searchTimer);
  ipcRenderer.send('fetch-search', raw);
  showSearch();
}

listEl.addEventListener('click', e => {
  const pinBtn = e.target.closest('.pin');
  if (pinBtn) {
    togglePinned(pinBtn.dataset.code);
    return;
  }
  const btn = e.target.closest('.del');
  if (!btn) return;
  const row = e.target.closest('.row');
  if (row) removeStock(row.dataset.code);
});
// 双击股票行 → 浏览器打开完整行情（单击已打开内置大图，右键菜单也可选「浏览器打开」）
listEl.addEventListener('dblclick', e => {
  const row = e.target.closest('.row');
  if (!row || e.target.closest('.acts')) return;
  ipcRenderer.send('open-url', row.dataset.code);
});
// 分组标签栏：单击切换 / 双击重命名 / 右键移除；右侧 ＋ 添加分组
function renderGroups() {
  if (!groupsTrack) return;
  groupsTrack.innerHTML = '';
  groups.forEach(g => {
    const tab = document.createElement('div');
    tab.className = 'group-tab' + (g.id === activeGroupId ? ' active' : '');
    tab.dataset.id = g.id;
    tab.textContent = g.name;
    tab.title = g.name + '（' + g.items.length + ' 只）· 双击重命名 · 右键移除';
    groupsTrack.appendChild(tab);
  });
  if (groupsTrack.lastElementChild) groupsTrack.lastElementChild.scrollIntoView({ inline: 'end', block: 'nearest' });
}
function switchGroup(id) {
  if (id === activeGroupId) return;
  const g = groups.find(x => x.id === id);
  if (!g) return;
  activeGroupId = id;
  watchlist = g.items;
  saveGroups();
  renderGroups(); render(); updatePinned(); renderManage(); refresh(); fetchMinutes();
}
function addGroup() {
  const g = { id: uid(), name: '新分组' + (groups.length + 1), items: [] };
  groups.push(g);
  activeGroupId = g.id;
  watchlist = g.items;
  saveGroups();
  renderGroups(); render(); updatePinned(); renderManage(); refresh(); fetchMinutes();
  const tab = groupsTrack.querySelector(`.group-tab[data-id="${g.id}"]`);
  if (tab) startRename(tab, g.id); // 新建后直接进入重命名，方便起名
}
function removeGroup(id) {
  if (groups.length <= 1) { showToast('提示', '至少保留一个分组'); return; }
  const idx = groups.findIndex(g => g.id === id);
  if (idx < 0) return;
  const [removed] = groups.splice(idx, 1);
  removed.items.forEach(it => { delete alertState[it.code]; delete pctMap[it.code]; delete sparkData[it.code]; delete sparkPrevClose[it.code]; });
  if (activeGroupId === id) {
    activeGroupId = (groups[Math.max(0, idx - 1)] || groups[0]).id;
    watchlist = activeGroup().items;
    render(); updatePinned(); renderManage(); refresh(); fetchMinutes();
  }
  saveGroups();
  renderGroups();
}
function startRename(tab, id) {
  const g = groups.find(x => x.id === id);
  if (!g) return;
  tab.contentEditable = 'true';
  tab.textContent = g.name;
  tab.classList.add('editing');
  tab.focus();
  const sel = window.getSelection();
  if (sel) { const r = document.createRange(); r.selectNodeContents(tab); sel.removeAllRanges(); sel.addRange(r); }
  const finish = () => {
    tab.removeEventListener('blur', finish);
    tab.contentEditable = 'false';
    tab.classList.remove('editing');
    const v = tab.textContent.trim();
    g.name = v || g.name;
    tab.textContent = g.name;
    saveGroups();
  };
  tab.addEventListener('blur', finish);
  tab.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); tab.blur(); }
    else if (e.key === 'Escape') { tab.textContent = g.name; tab.blur(); }
  });
}
if (groupsTrack) {
  groupsTrack.addEventListener('click', e => {
    const tab = e.target.closest('.group-tab');
    if (!tab || tab.isContentEditable) return;
    switchGroup(tab.dataset.id);
  });
  groupsTrack.addEventListener('dblclick', e => {
    const tab = e.target.closest('.group-tab');
    if (tab) startRename(tab, tab.dataset.id);
  });
  groupsTrack.addEventListener('contextmenu', e => {
    const tab = e.target.closest('.group-tab');
    if (!tab) return;
    e.preventDefault();
    removeGroup(tab.dataset.id);
  });
}
if (groupAddBtn) groupAddBtn.addEventListener('click', addGroup);
if (pfGroupBtn) pfGroupBtn.addEventListener('click', () => switchView('portfolio'));

settingsBtn.addEventListener('click', () => { if (settingsPanel.hidden) openSettings(); else closeSettings(); });
const settingsClose = document.getElementById('settingsClose');
if (settingsClose) settingsClose.addEventListener('click', closeSettings);

// ---------- 视图下拉切换 ----------
const VIEW_TITLES = {
  watchlist: '自选股',
  portfolio: '持仓',
  indices: '指数',
  market: '涨跌分布',
  hot: '股票热榜',
  ladder: '涨停天梯',
  sectors: '板块',
  etf: 'ETF 榜',
  settings: '设置'
};
const VIEW_ICONS = {
  watchlist: '📈', portfolio: '💼', indices: '📊', market: '🌡️',
  hot: '🔥', ladder: '🚀', sectors: '🗂️', etf: '💰'
};
const VIEW_ORDER = ['watchlist', 'portfolio', 'indices', 'market', 'hot', 'ladder', 'sectors', 'etf'];
let currentView = 'watchlist';
function switchView(view) {
  if (!view || view === currentView) return;
  if (view === 'settings') { openSettings(); return; }
  // 关闭设置面板，切回普通视图
  closeSettings();
  currentView = view;
  if (view === 'market' && typeof completeTask === 'function') completeTask('market');
  // 标题
  if (vsLabel) vsLabel.textContent = VIEW_TITLES[view] || '自选股';
  // 视图显隐
  [watchlistView, portfolioView, indicesView, marketView, hotView, ladderView, sectorsView, etfView].forEach(v => {
    if (!v) return;
    const isTarget = v.dataset.view === view;
    v.classList.toggle('active', isTarget);
    v.hidden = !isTarget;
  });
  // 若下拉开着，刷新高亮
  if (viewDropdown && !viewDropdown.hidden) buildViewDropdown();
  // 渲染特定视图
  if (view === 'watchlist') {
    // 从其他视图切回自选股时，列表由 display:none 恢复，分时图尺寸可能已错乱，需重绘
    setTimeout(() => { for (const code in sparkData) drawSpark(code, sparkData[code]); }, 80);
  }
  if (view === 'portfolio') renderPortfolio();
  if (view === 'indices') { fetchIndicesGroups(); renderIndicesView(); }
  if (view === 'market') renderMarketView();
  if (view === 'hot') { fetchHot(); }
  if (view === 'ladder') { fetchLadder(); }
  if (view === 'sectors') { fetchSectors(sectorsTab); }
  if (view === 'etf') { fetchEtf(etfCategory); requestAnimationFrame(() => renderEtfTabs()); }
}
// 下拉选择器
function buildViewDropdown() {
  if (!viewDropdown) return;
  viewDropdown.innerHTML = '';
  VIEW_ORDER.forEach(v => {
    const item = document.createElement('div');
    item.className = 'vd-item' + (v === currentView ? ' active' : '');
    item.dataset.view = v;
    item.innerHTML = `<span class="vd-icon">${VIEW_ICONS[v] || ''}</span><span class="vd-name">${VIEW_TITLES[v] || v}</span>`;
    item.addEventListener('click', () => { closeViewDropdown(); switchView(v); });
    viewDropdown.appendChild(item);
  });
}
function openViewDropdown() {
  buildViewDropdown();
  if (viewDropdown) viewDropdown.hidden = false;
  if (viewSelector) viewSelector.classList.add('open');
}
function closeViewDropdown() {
  if (viewDropdown) viewDropdown.hidden = true;
  if (viewSelector) viewSelector.classList.remove('open');
}
if (viewSelector) {
  viewSelector.addEventListener('click', e => {
    e.stopPropagation();
    if (viewDropdown && !viewDropdown.hidden) closeViewDropdown();
    else openViewDropdown();
  });
}
// 点击空白处 / 按 ESC 关闭下拉
document.addEventListener('click', e => {
  if (viewDropdown && !viewDropdown.hidden &&
      !viewDropdown.contains(e.target) && !viewSelector.contains(e.target)) {
    closeViewDropdown();
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeViewDropdown(); });

const manageModal = document.getElementById('manageModal');
const manageClose = document.getElementById('manageClose');
function openSettings() {
  settingsPanel.classList.remove('closing');
  settingsPanel.hidden = false;
  requestAnimationFrame(() => settingsPanel.classList.add('open'));
}
function closeSettings() {
  if (settingsPanel.hidden) return;
  settingsPanel.classList.remove('open');
  settingsPanel.classList.add('closing');
  const done = () => {
    if (!settingsPanel.classList.contains('closing')) return; // 已被重新打开，放弃收起
    settingsPanel.classList.remove('closing');
    settingsPanel.hidden = true;
  };
  settingsPanel.addEventListener('animationend', done, { once: true });
  setTimeout(done, 260); // 兜底，防止 animationend 未触发
}
function openManage() {
  if (!manageModal) return;
  renderManage();
  manageModal.hidden = false;
  requestAnimationFrame(() => manageModal.classList.add('show'));
}
function closeManage() {
  if (!manageModal || manageModal.hidden) return;
  manageModal.classList.remove('show');
  manageModal.hidden = true;
}
if (manageClose) manageClose.addEventListener('click', closeManage);
if (manageModal) manageModal.addEventListener('click', e => { if (e.target === manageModal) closeManage(); });
// ---------- 持仓：轻量「添加持仓」面板 ----------
const pfAddModal = document.getElementById('pfAddModal');
const pfAddInput = document.getElementById('pfAddInput');
const pfAddResults = document.getElementById('pfAddResults');
const pfAddSearchWrap = document.getElementById('pfAddSearchWrap');
const pfAddSel = document.getElementById('pfAddSel');
const pfAddSelName = document.getElementById('pfAddSelName');
const pfAddSelCode = document.getElementById('pfAddSelCode');
const pfAddSelPrice = document.getElementById('pfAddSelPrice');
const pfAddSelIcon = document.getElementById('pfAddSelIcon');
const pfAddSelTag = document.getElementById('pfAddSelTag');
const pfAddCost = document.getElementById('pfAddCost');
const pfAddShares = document.getElementById('pfAddShares');
const pfAddJia = document.getElementById('pfAddJia');
const pfAddHint = document.getElementById('pfAddHint');
const pfAddTitle = document.getElementById('pfAddTitle');
const pfAddNowBtn = document.getElementById('pfAddNow');
const pfAddOkBtn = document.getElementById('pfAddOk');
const pfAddCancelBtn = document.getElementById('pfAddCancel');
const pfAddCloseBtn = document.getElementById('pfAddClose');
let pfAddActive = false;
let pfAddMode = 'add';
let pfAddSelItem = null;
let pfAddResultsList = [];

function setPfAddSelMeta(item) {
  if (!item) return;
  const name = item.name || item.code || '?';
  if (pfAddSelIcon) {
    pfAddSelIcon.textContent = name.slice(0, 1);
    let hash = 0;
    for (const c of String(item.code || '')) hash = ((hash * 31) + c.charCodeAt(0)) & 0xffff;
    const hue = 210 + (hash % 60);
    pfAddSelIcon.style.background = `linear-gradient(135deg, hsl(${hue}, 78%, 62%), hsl(${hue + 12}, 82%, 52%))`;
  }
  if (pfAddSelTag) {
    const tag = tagOf(item);
    pfAddSelTag.textContent = tag;
    pfAddSelTag.hidden = !tag;
  }
}

function openPfAdd(mode, prefill) {
  pfAddActive = true;
  pfAddMode = mode || 'add';
  const isEdit = pfAddMode === 'edit';
  pfAddTitle.textContent = isEdit ? '设置成本价/股数' : (pfAddMode === 'add' ? '添加持仓' : '加仓');
  if (pfAddOkBtn) pfAddOkBtn.textContent = isEdit ? '保存' : '添加';
  if (pfAddSearchWrap) pfAddSearchWrap.classList.toggle('hidden', isEdit);
  pfAddInput.value = '';
  pfAddResults.hidden = true; pfAddResults.innerHTML = ''; pfAddResultsList = [];
  pfAddSel.hidden = true; pfAddSelItem = null;
  pfAddCost.value = ''; pfAddShares.value = ''; if (pfAddJia) pfAddJia.checked = false; pfAddHint.textContent = '';
  if (prefill && prefill.code) {
    pfAddSelItem = { code: prefill.code, name: prefill.name || prefill.code };
    pfAddSelName.textContent = prefill.name || prefill.code;
    pfAddSelCode.textContent = uiCode(prefill.code);
    setPfAddSelMeta(prefill);
    const price = lastPrice[prefill.code];
    pfAddSelPrice.textContent = price != null ? ('现价 ' + fmtMoney(price)) : '现价 --';
    const h = holdingOf(itemMap.get(prefill.code));
    pfAddCost.value = h ? h.avgCost.toFixed(2) : '';
    pfAddShares.value = h ? Math.round(h.shares) : '';
    if (pfAddJia) pfAddJia.checked = false; // 编辑默认覆盖原持仓，不自动追加批次
    pfAddSel.hidden = false;
    pfAddHint.textContent = isEdit ? '保存后将覆盖该股成本价与股数' : '已在该股持仓，勾选「加仓」将追加为一批次';
  }
  pfAddModal.hidden = false;
  requestAnimationFrame(() => pfAddModal.classList.add('show'));
  setTimeout(() => {
    if (isEdit) {
      if (pfAddCost && !pfAddCost.value) pfAddCost.focus();
      else if (pfAddShares) pfAddShares.focus();
    } else if (pfAddInput) {
      pfAddInput.focus();
    }
  }, 60);
}
function closePfAdd() {
  pfAddActive = false;
  if (!pfAddModal) return;
  pfAddModal.classList.remove('show');
  setTimeout(() => { if (!pfAddModal.classList.contains('show')) pfAddModal.hidden = true; }, 250);
}
function renderPfAddResults(res) {
  if (!pfAddResults) return;
  pfAddResults.innerHTML = ''; pfAddResultsList = [];
  if (!res || res.error || !res.length) {
    pfAddResults.innerHTML = '<div class="s-empty">' + (res && res.error ? '搜索失败，可直接输入代码' : '无匹配') + '</div>';
    pfAddResults.hidden = false; pfAddResults.classList.add('open'); return;
  }
  res.forEach(item => {
    pfAddResultsList.push(item);
    const div = document.createElement('div');
    div.className = 's-item no-drag';
    div.innerHTML = `<span class="s-tag">${tagOf(item)}</span><span class="s-name">${esc(item.name)}</span><span class="s-code">${esc(uiCode(item.code))}</span>`;
    div.addEventListener('click', () => pickPfAdd(item));
    pfAddResults.appendChild(div);
  });
  pfAddResults.hidden = false; pfAddResults.classList.add('open');
}
function pickPfAdd(item) {
  if (!item) return;
  pfAddSelItem = { code: item.code, name: item.name };
  pfAddSelName.textContent = item.name;
  pfAddSelCode.textContent = uiCode(item.code);
  setPfAddSelMeta(item);
  pfAddInput.value = '';
  pfAddResults.hidden = true; pfAddResults.innerHTML = ''; pfAddResultsList = [];
  const price = lastPrice[item.code];
  if (price != null) {
    pfAddSelPrice.textContent = '现价 ' + fmtMoney(price);
  } else {
    pfAddSelPrice.textContent = '现价 --';
    ipcRenderer.send('fetch-prices', [item.code]); // 触发取价，prices 事件会回填
  }
  const ex = itemMap.get(item.code);
  const h = ex ? holdingOf(ex) : null;
  pfAddCost.value = h ? h.avgCost.toFixed(2) : (price != null ? price.toFixed(2) : '');
  pfAddShares.value = h ? Math.round(h.shares) : '';
  if (pfAddJia) pfAddJia.checked = !!h;
  pfAddHint.textContent = h ? '已在该股持仓；不勾加仓将覆盖原成本' : '填成本价与股数后添加';
  pfAddSel.hidden = false;
  setTimeout(() => { if (pfAddCost) pfAddCost.focus(); }, 30);
}
let pfAddSearchTimer = null;
if (pfAddInput) {
  pfAddInput.addEventListener('input', () => {
    const q = pfAddInput.value.trim();
    if (!q) { if (pfAddResults) { pfAddResults.hidden = true; pfAddResults.innerHTML = ''; } return; }
    if (pfAddSearchTimer) clearTimeout(pfAddSearchTimer);
    pfAddSearchTimer = setTimeout(() => ipcRenderer.send('fetch-search', q), 200);
  });
  pfAddInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      if (!pfAddResults.hidden && pfAddResultsList.length) pickPfAdd(pfAddResultsList[0]);
    } else if (e.key === 'Escape') closePfAdd();
  });
}
if (pfAddCost) {
  pfAddCost.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (pfAddShares) pfAddShares.focus(); }
    else if (e.key === 'Escape') closePfAdd();
  });
}
if (pfAddShares) {
  pfAddShares.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (pfAddOkBtn) pfAddOkBtn.click(); }
    else if (e.key === 'Escape') closePfAdd();
  });
}
if (pfAddNowBtn) pfAddNowBtn.addEventListener('click', () => {
  const p = pfAddSelItem && lastPrice[pfAddSelItem.code];
  if (p != null) pfAddCost.value = p.toFixed(2);
});
if (pfAddOkBtn) pfAddOkBtn.addEventListener('click', () => {
  if (!pfAddSelItem) { showToast('添加持仓', '请先搜索并选择一只股票'); return; }
  const cost = parseFloat(pfAddCost.value);
  const shares = parseFloat(pfAddShares.value);
  if (!(cost > 0 && shares > 0)) { showToast('添加持仓', '请填写有效的成本价和股数'); return; }
  const code = pfAddSelItem.code, name = pfAddSelItem.name;
  let item = itemMap.get(code);
  if (!item) { addStock(code, name); item = itemMap.get(code); }
  if (!item) { showToast('添加持仓', '添加失败'); return; }
  const h0 = holdingOf(item);
  if (pfAddJia && pfAddJia.checked && h0) {
    if (!Array.isArray(item.lots) || !item.lots.length) item.lots = [{ date: '', price: String(h0.avgCost), shares: String(Math.round(h0.shares)) }];
    item.lots.push({ date: '', price: cost.toFixed(3), shares: String(Math.round(shares)) });
    item.cost = ''; item.shares = '';
  } else {
    item.cost = cost.toFixed(3); item.shares = String(Math.round(shares)); item.lots = [];
  }
  saveWatchlistDebounced(); updatePortfolio(); renderPortfolio(); refresh();
  showToast(pfAddMode === 'edit' ? '已保存' : '已添加', (name || code) + ' 持仓已更新');
  closePfAdd();
});
if (pfAddCancelBtn) pfAddCancelBtn.addEventListener('click', closePfAdd);
if (pfAddCloseBtn) pfAddCloseBtn.addEventListener('click', closePfAdd);
if (pfAddModal) pfAddModal.addEventListener('click', e => { if (e.target === pfAddModal) closePfAdd(); });
if (pfAddBtn) pfAddBtn.addEventListener('click', () => { openPfAdd('add'); });
closeBtn.addEventListener('click', () => ipcRenderer.send('hide'));
refreshBtn.addEventListener('click', () => {
  refreshBtn.classList.remove('spin');
  void refreshBtn.offsetWidth; // 重启动画
  refreshBtn.classList.add('spin');
  refresh();
});

opacitySlider.addEventListener('input', () => {
  settings.opacity = parseFloat(opacitySlider.value);
  opacityVal.textContent = settings.opacity.toFixed(2);
  ipcRenderer.send('set-opacity', settings.opacity);
  saveSettings();
});
intervalSel.addEventListener('change', () => {
  settings.interval = parseInt(intervalSel.value, 10);
  saveSettings();
  startTimer();
});
aotChk.addEventListener('change', () => {
  settings.alwaysOnTop = aotChk.checked;
  ipcRenderer.send('set-always-on-top', settings.alwaysOnTop);
  saveSettings();
});
lockChk.addEventListener('change', () => {
  settings.locked = lockChk.checked;
  document.body.classList.toggle('locked', settings.locked);
  saveSettings();
});
clickChk.addEventListener('change', () => {
  settings.clickThrough = clickChk.checked;
  ipcRenderer.send('set-click-through', settings.clickThrough);
  saveSettings();
});
if (edgeChk) edgeChk.addEventListener('change', () => {
  settings.edgeHide = edgeChk.checked;
  ipcRenderer.send('set-edge-hide', settings.edgeHide);
  saveSettings();
});
sortChk.addEventListener('change', () => {
  settings.sortByChange = sortChk.checked;
  saveSettings();
  reorderRows();
});
compactChk.addEventListener('change', () => {
  settings.compact = compactChk.checked;
  document.body.classList.toggle('compact', settings.compact);
  saveSettings();
});
if (soundChk) soundChk.addEventListener('change', () => {
  settings.alertSound = soundChk.checked;
  saveSettings();
  if (settings.alertSound) playAlertSound(); // 开启时试听一声，确认有声
});
if (taskbarChk) taskbarChk.addEventListener('change', () => {
  settings.taskbarTicker = taskbarChk.checked;
  saveSettings();
  if (settings.taskbarTicker) updateTaskbarTicker(true);
  else ipcRenderer.send('taskbar-ticker', null); // 关闭：主进程还原托盘图标与标题
});

// ---------- 任务栏/托盘实时行情（常驻票 ★，多只轮播）----------
// 任务栏行情条（tickerbar）：透明小窗贴在任务栏空白区显示「名称 现价 涨跌幅」，可拖动；
// 支持多只常驻票：给多只票点 ★，任务栏每 tickerRotateSec 秒轮播下一只。
let _tickerKey = '';
let _tickerIdx = 0;
let _lastRotateAt = Date.now();
// 统一的常驻票切换（多只）：点击 ★ 在 pinnedList 中加入/移除；pinned 恒等于列表第一只（折叠模式用）
function togglePinned(code) {
  const list = Array.isArray(settings.pinnedList) ? settings.pinnedList : (settings.pinnedList = []);
  const i = list.indexOf(code);
  if (i >= 0) list.splice(i, 1); else list.unshift(code);
  settings.pinned = list[0] || '';
  _tickerIdx = 0; _lastRotateAt = Date.now();
  saveSettings(); updatePinned(); renderManage(); updateTaskbarTicker(true);
}
// 任务栏当前展示的票：pinnedList（过滤掉已删除的）轮播取当前位；空则回落第一只自选
function tickerStock() {
  const list = (settings.pinnedList || []).filter(c => watchlist.some(w => w.code === c));
  if (!list.length) return watchlist[0] || null;
  const code = list[_tickerIdx % list.length];
  return watchlist.find(w => w.code === code) || watchlist[0];
}
function updateTaskbarTicker(force) {
  if (settings.taskbarTicker === false) return;
  const st = tickerStock();
  if (!st) return;
  const pct = pctMap[st.code];
  const price = lastPrice[st.code];
  if (typeof pct !== 'number' || typeof price !== 'number' || isNaN(price)) return; // 行情未就绪
  const up = pct > 0, down = pct < 0;
  // 注意：pct 为负时 toFixed 自带负号，不能再拼 '-'，否则窗口标题会出现 "--1.10%"
  const title = `${st.name || st.code} ${price.toFixed(2)} ${up ? '+' : down ? '-' : ''}${Math.abs(pct).toFixed(2)}%`;
  const key = st.code + '|' + price.toFixed(2) + '|' + pct.toFixed(2);
  if (!force && key === _tickerKey) return; // 没变化不发送
  _tickerKey = key;
  ipcRenderer.send('taskbar-ticker', {
    title, tip: title,
    info: { code: st.code, name: st.name || st.code, price, pct, tip: title } // 任务栏行情条用
  });
}
// 轮播心跳：多只常驻票时按间隔切换（单只时无动作）
setInterval(() => {
  const list = (settings.pinnedList || []).filter(c => watchlist.some(w => w.code === c));
  if (list.length < 2) return;
  if (Date.now() - _lastRotateAt < (settings.tickerRotateSec || 8) * 1000) return;
  _lastRotateAt = Date.now();
  _tickerIdx = (_tickerIdx + 1) % list.length;
  updateTaskbarTicker(true);
}, 1000);
// 汇率（持仓汇总用）：改动即时保存并刷新底部汇总
if (rateUSD) rateUSD.addEventListener('input', () => {
  const v = parseFloat(rateUSD.value);
  if (!isNaN(v) && v > 0) { settings.rateUSD = v; saveSettings(); updatePortfolio(); }
});
if (rateHKD) rateHKD.addEventListener('input', () => {
  const v = parseFloat(rateHKD.value);
  if (!isNaN(v) && v > 0) { settings.rateHKD = v; saveSettings(); updatePortfolio(); }
});
// 列表列显隐：勾选变化即切换 body 的 hide-* 类并保存
[['colChg', 'showChg', 'chg'], ['colHL', 'showHL', 'hl'], ['colPnl', 'showPnl', 'pnl'], ['colSpark', 'showSpark', 'spark']].forEach(([elId, key, cls]) => {
  const el = { colChg, colHL, colPnl, colSpark }[elId];
  if (!el) return;
  el.addEventListener('change', () => {
    settings[key] = el.checked;
    document.body.classList.toggle('hide-' + cls, !el.checked);
    saveSettings();
  });
});
if (glassSlider) glassSlider.addEventListener('input', () => {
  settings.glass = parseFloat(glassSlider.value);
  applyGlass();
  saveSettings();
});
if (themeSel) themeSel.addEventListener('change', () => {
  settings.theme = themeSel.value;
  applyTheme();
  saveSettings();
});
if (fontSizeSlider) fontSizeSlider.addEventListener('input', () => {
  settings.fontSize = parseInt(fontSizeSlider.value, 10);
  applyFontSize();
  saveSettings();
  // 字号改变后行高/容器尺寸变化，重绘分时图避免比例错位
  redrawAllSparks();
});
ipcRenderer.on('focus-add', () => { if (codeInput) codeInput.focus(); });
// 双击标题栏切换置顶
titlebar.addEventListener('dblclick', () => {
  settings.alwaysOnTop = !settings.alwaysOnTop;
  aotChk.checked = settings.alwaysOnTop;
  ipcRenderer.send('set-always-on-top', settings.alwaysOnTop);
  saveSettings();
});

// 折叠：只显示常驻票
collapseBtn.addEventListener('click', toggleCollapse);
function toggleCollapse() {
  collapsed = !collapsed;
  if (collapsed && !settings.pinnedList.length && watchlist.length) {
    settings.pinnedList = [watchlist[0].code];
    settings.pinned = watchlist[0].code;
    saveSettings();
    updatePinned();
    updateTaskbarTicker(true);
  }
  document.body.classList.toggle('collapsed', collapsed);
  collapseBtn.textContent = collapsed ? '▴' : '▾';
  collapseBtn.classList.toggle('rot', collapsed);
  ipcRenderer.send('set-collapsed', collapsed);
}

// 下拉菜单（带淡入/下滑进出场动画）
function openMenu() { menu.hidden = false; requestAnimationFrame(() => menu.classList.add('open')); }
function closeMenu() {
  if (menu.hidden) return;
  menu.classList.remove('open');
  setTimeout(() => { if (!menu.classList.contains('open')) menu.hidden = true; }, 200);
}
const menuManage = document.getElementById('menuManage');
menuBtn.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) openMenu(); else closeMenu(); });
menuToggle.addEventListener('click', () => { ipcRenderer.send('toggle-win'); closeMenu(); });
menuCollapse.addEventListener('click', () => { toggleCollapse(); closeMenu(); });
if (menuManage) menuManage.addEventListener('click', () => { openManage(); closeMenu(); });
menuReset.addEventListener('click', () => { ipcRenderer.send('reset-position'); closeMenu(); });
if (menuReload) menuReload.addEventListener('click', () => { ipcRenderer.send('reload'); closeMenu(); });
menuQuit.addEventListener('click', () => { ipcRenderer.send('quit'); });
document.addEventListener('click', (e) => {
  if (!menu.contains(e.target) && e.target !== menuBtn) closeMenu();
  if (!searchBox.contains(e.target) && e.target !== codeInput) hideSearch();
});

// ---------- 放大走势 / K线弹窗 ----------
let chartCode = null;
let chartGeo = null; // 当前大图几何信息（供十字光标联动）
let chartPeriod = 'min'; // min(分时) / 5day(五日) / day(日K) / week(周K) / month(月K) / year(年K) / m120/m60/m30/m15/m5（无 1分：数据源不可用）
let chartFadeNext = false; // 周期切换 / 打开弹窗时，让走势图淡入（避免每次行情刷新都闪烁）
const ALL_PERIODS = [
  { id: 'min', label: '分时' },
  { id: '5day', label: '五日' },
  { id: 'day', label: '日K' },
  { id: 'week', label: '周K' },
  { id: 'month', label: '月K' },
  { id: 'year', label: '年K' },
  { id: 'm120', label: '120分' },
  { id: 'm60', label: '60分' },
  { id: 'm30', label: '30分' },
  { id: 'm15', label: '15分' },
  { id: 'm5', label: '5分' }
];
// 用户自定义周期顺序（默认按 ALL_PERIODS），持久化到 settings
if (!Array.isArray(settings.chartPeriodOrder) || settings.chartPeriodOrder.length !== ALL_PERIODS.length) {
  settings.chartPeriodOrder = ALL_PERIODS.map(p => p.id);
  saveSettings();
}
// 兼容旧设置：移除已废弃的 1分（数据源不可用）
if (Array.isArray(settings.chartPeriodOrder) && settings.chartPeriodOrder.includes('m1')) {
  settings.chartPeriodOrder = settings.chartPeriodOrder.filter(id => id !== 'm1');
  saveSettings();
}
let klineView = null; // K线可见视口：{start, end}（索引，end 不含）；null = 全量
// K线指标设置（本地文件持久化）：均线周期数组 + 是否显示 MACD 副图
const KL_IND_KEY = 'stock-widget-kline-ind';
function loadKlineInd() {
  try {
    const raw = sGet(KL_IND_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      const ma = Array.isArray(o.ma) && o.ma.length ? o.ma.slice() : [5, 10, 20];
      return { ma, macd: o.macd !== false };
    }
  } catch (e) {}
  return { ma: [5, 10, 20], macd: true };
}
function saveKlineInd() {
  try { sSet(KL_IND_KEY, JSON.stringify(klineInd)); } catch (e) {}
}
let klineInd = loadKlineInd();
// 体积格式化（手）
function fmtVol(v) {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿手';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万手';
  return Math.round(v) + '手';
}
// ---------- 周期标签栏：用户固定顺序 + 单排折叠 + 指针拖拽排序 ----------
// 顺序完全由用户拖拽决定并持久化（settings.chartPeriodOrder）；点击切换周期不再改变顺序。
let chartTabsVisibleIds = []; // 当前可见的周期 id
let chartTabsLastDragEnd = 0; // 拖拽结束后短暂屏蔽 click，避免误切周期
let tabDrag = null; // 进行中的拖拽 { id, container, el, startX, startY, active, overId }
function setDropdown(open) {
  if (!chartTabsDropdown || !chartTabsMore) return;
  chartTabsDropdown.hidden = !open;
  chartTabsMore.classList.toggle('active', open);
}
function getOrderedPeriods() {
  const order = Array.isArray(settings.chartPeriodOrder) ? settings.chartPeriodOrder : ALL_PERIODS.map(p => p.id);
  // 容错：若设置里缺了某个周期，补到末尾
  const set = new Set(order);
  ALL_PERIODS.forEach(p => { if (!set.has(p.id)) order.push(p.id); });
  return order.map(id => ALL_PERIODS.find(p => p.id === id)).filter(Boolean);
}
function saveChartPeriodOrder(newOrder) {
  settings.chartPeriodOrder = newOrder.slice(0, ALL_PERIODS.length);
  saveSettings();
}
function renderChartTabs() {
  if (!chartTabsTrack || !chartTabsDropdown || !chartTabsMore) return;
  // 严格按用户设定顺序渲染；当前周期只用高亮表示，绝不再挪到队首（那样用户拖好的顺序每次点击都会被打乱）
  const periods = getOrderedPeriods();
  const gap = 3;
  // 先把全部按钮放进轨道以测量真实宽度
  chartTabsTrack.innerHTML = '';
  const btnEls = [];
  periods.forEach(p => {
    const b = document.createElement('button');
    b.dataset.period = p.id;
    b.textContent = p.label;
    b.classList.toggle('active', p.id === chartPeriod);
    b.title = '点击切换周期 · 按住拖动可调整顺序';
    chartTabsTrack.appendChild(b);
    btnEls.push({ p, el: b });
  });
  const widths = btnEls.map(({ el }) => el.offsetWidth + gap);
  // 根据轨道宽度决定可见/折叠；若有折叠项需给“更多”按钮预留空间
  function fit(reserveMore) {
    const avail = (chartTabs.clientWidth || 9999) - (reserveMore || 0);
    let used = 0; const vis = [], hid = [];
    btnEls.forEach((item, i) => {
      const w = widths[i];
      if (used + w <= avail + 0.5) { vis.push(item.p); used += w; }
      else hid.push(item.p);
    });
    return { vis, hid };
  }
  // 第一遍：假设「更多」只显示箭头
  chartTabsMore.textContent = '▾';
  let r = fit(chartTabsMore.offsetWidth + gap);
  if (r.hid.length === 0) r = fit(0); // 无折叠项时「更多」隐藏，不必预留宽度
  let visible = r.vis, hidden = r.hid;
  // 当前周期被折叠进下拉时，把它的名字显示在「更多」按钮上，避免看不出当前在看哪个周期
  if (hidden.some(p => p.id === chartPeriod)) {
    const lbl = (ALL_PERIODS.find(p => p.id === chartPeriod) || {}).label || chartPeriod;
    chartTabsMore.textContent = lbl + ' ▾';
    const rr = fit(chartTabsMore.offsetWidth + gap);
    visible = rr.vis; hidden = rr.hid;
  }
  // 把不在可见区的按钮从轨道移除
  btnEls.forEach(({ p, el }) => { if (!visible.includes(p)) el.remove(); });
  const hasHidden = hidden.length > 0;
  chartTabsMore.hidden = !hasHidden;
  chartTabsMore.classList.toggle('active', !chartTabsDropdown.hidden && hasHidden);
  chartTabsMore.classList.toggle('current', hasHidden && hidden.some(p => p.id === chartPeriod));
  // 下拉菜单：渲染被折叠的周期。文字区点击切换，左侧把手拖动排序（指针事件实现）
  chartTabsDropdown.innerHTML = '';
  hidden.forEach(p => {
    const b = document.createElement('button');
    b.dataset.period = p.id;
    b.classList.toggle('active', p.id === chartPeriod);
    b.title = '点击文字切换周期 · 拖动左侧把手可调整顺序';
    const label = document.createElement('span');
    label.className = 'chart-tab-label';
    label.textContent = p.label;
    const handle = document.createElement('span');
    handle.className = 'chart-tab-drag-handle';
    handle.textContent = '⋮⋮';
    handle.title = '按住拖动调整顺序';
    b.appendChild(handle);
    b.appendChild(label);
    // 文字区直接绑定 click：最可靠，避免被事件委托或拖拽逻辑吞掉
    label.addEventListener('click', e => {
      e.stopPropagation();
      if (Date.now() - chartTabsLastDragEnd < 250) return; // 刚拖完，忽略误触
      switchChartPeriod(p.id);
    });
    chartTabsDropdown.appendChild(b);
  });
  chartTabsVisibleIds = visible.map(p => p.id);
  bindChartTabDragEvents();
  // 已无折叠项时自动收起下拉
  if (hidden.length === 0) setDropdown(false);
}
// 指针拖拽排序：HTML5 drag 在 Electron 透明窗口下偶发不触发、且与点击切换冲突，
// 这里统一用 pointerdown/move/up，拖过 5px 才算拖动，松手落在目标标签上即换位。
function bindChartTabDragEvents() {
  if (!chartTabsTrack) return;
  const attach = (el, container, id, onlyHandle) => {
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (onlyHandle && !e.target.closest('.chart-tab-drag-handle')) return;
      tabDrag = { id, container, el: onlyHandle ? e.target.closest('.chart-tab-drag-handle') : el, startX: e.clientX, startY: e.clientY, active: false, overId: '' };
    });
  };
  chartTabsTrack.querySelectorAll('button[data-period]').forEach(btn => attach(btn, chartTabsTrack, btn.dataset.period, false));
  if (chartTabsDropdown) {
    chartTabsDropdown.querySelectorAll('button[data-period]').forEach(btn => attach(btn, chartTabsDropdown, btn.dataset.period, true));
  }
}
function clearChartTabDragMarks() {
  document.querySelectorAll('.chart-tabs-track button[data-period], .chart-tabs-dropdown button[data-period]')
    .forEach(b => b.classList.remove('dragging', 'drag-over'));
}
function movePeriodTo(draggedId, targetId) {
  const order = getOrderedPeriods().map(p => p.id);
  const from = order.indexOf(draggedId), to = order.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return;
  order.splice(from, 1);
  order.splice(to, 0, draggedId);
  saveChartPeriodOrder(order);
  renderChartTabs(); // 立即按新顺序重排（顺序已持久化，重启后保持）
}
function endTabDrag() {
  if (!tabDrag) return;
  const d = tabDrag; tabDrag = null;
  clearChartTabDragMarks();
  document.body.classList.remove('tab-reordering');
  if (!d.active) return; // 只是点击，不是拖拽 → 交给 click 正常切换周期
  chartTabsLastDragEnd = Date.now();
  if (d.overId && d.overId !== d.id) movePeriodTo(d.id, d.overId);
}
document.addEventListener('pointermove', e => {
  if (!tabDrag) return;
  if (!tabDrag.active) {
    if (Math.hypot(e.clientX - tabDrag.startX, e.clientY - tabDrag.startY) < 5) return; // 未达拖动阈值
    tabDrag.active = true;
    tabDrag.el.classList.add('dragging');
    document.body.classList.add('tab-reordering');
  }
  const overEl = document.elementFromPoint(e.clientX, e.clientY);
  const overBtn = overEl && overEl.closest ? overEl.closest('button[data-period]') : null;
  clearChartTabDragMarks();
  tabDrag.el.classList.add('dragging');
  if (overBtn && tabDrag.container.contains(overBtn) && overBtn.dataset.period !== tabDrag.id) {
    overBtn.classList.add('drag-over');
    tabDrag.overId = overBtn.dataset.period;
  } else {
    tabDrag.overId = '';
  }
});
document.addEventListener('pointerup', endTabDrag);
document.addEventListener('pointercancel', endTabDrag);
function switchChartPeriod(p) {
  if (!chartCode || p === chartPeriod) return;
  chartPeriod = p;
  klineView = null; // 周期切换重置视口
  renderChartTabs(); // 更新高亮（不改顺序）
  setDropdown(false);
  chartFadeNext = true; // 周期切换淡入
  drawBigChart(chartCode);
}
// K线周期定时刷新：弹窗打开且处于 K 线周期时，每 30s 重新拉取当前周期（更新当日最后一根蜡烛）
let klineRefreshTimer = null;
function startKlineRefresh() {
  if (klineRefreshTimer) return;
  klineRefreshTimer = setInterval(() => {
    if (!chartCode || chartModal.hidden) return;
    if (chartPeriod === 'min' || chartPeriod === '5day') return; // 分时/五日由各自机制刷新
    ipcRenderer.send('fetch-kline', { code: chartCode, period: chartPeriod });
  }, 30000);
}
function stopKlineRefresh() {
  if (klineRefreshTimer) { clearInterval(klineRefreshTimer); klineRefreshTimer = null; }
}
function openChart(code, period) {
  if (!chartModal) return;
  chartCode = code;
  klineView = null; // 打开新标的时重置视口
  if (period) chartPeriod = period;
  setDropdown(false); // 打开弹窗时确保下拉收起
  chartModal.hidden = false;
  requestAnimationFrame(() => {
    chartModal.classList.add('show');
    // 同步周期标签：弹窗显示后再计算真实宽度
    renderChartTabs();
  });
  chartFadeNext = true; // 打开弹窗时走势图淡入
  drawBigChart(code);
  startKlineRefresh();
}
function closeChart() {
  if (!chartModal) return;
  setDropdown(false); // 关闭弹窗时收起下拉
  stopKlineRefresh();
  chartModal.classList.remove('show');
  chartModal.hidden = true;
  chartCode = null;
}
function drawBigChart(code) {
  if (chartPeriod === 'min') {
    if (sparkData[code] && sparkData[code].length >= 2) {
      const isBk = /^bk/i.test(code);
      const pc = (isBk && boardScaleTarget(code) <= 0) ? NaN : sparkPrevClose[code];
      return drawMinuteChart(code, scaleBoardSeries(code, sparkData[code]), pc);
    }
    return drawChartPlaceholder(code, '加载分时数据…', () => ipcRenderer.send('fetch-minute', [code]));
  }
  if (chartPeriod === '5day') {
    if (spark5DayData[code] && spark5DayData[code].length >= 2) return drawMinuteChart(code, spark5DayData[code], sparkPrevClose[code], true);
    return drawChartPlaceholder(code, '加载五日分时…', () => ipcRenderer.send('fetch-5day', { code }));
  }
  // K线：有缓存先画（避免闪白），同时始终拉最新（盘中当日最后一根会变化）；无缓存则显示占位并拉取
  const key = code + '|' + chartPeriod;
  const need = chartPeriod === 'year' ? 1 : 2;
  if (klineData[key] && klineData[key].length >= need) {
    drawKline(code);
    ipcRenderer.send('fetch-kline', { code, period: chartPeriod }); // 拉最新，回来自动重绘
    return;
  }
  return drawChartPlaceholder(code, '加载K线…', () => ipcRenderer.send('fetch-kline', { code, period: chartPeriod }));
}
// 弹窗内图表占位（含按需拉取），统一坐标系避免窄窗拉伸
function drawChartPlaceholder(code, msg, onShow) {
  const W = Math.max(160, Math.round(chartBig.clientWidth) || 600);
  const H = Math.max(120, Math.round(chartBig.clientHeight) || 260);
  chartBig.setAttribute('viewBox', `0 0 ${W} ${H}`);
  chartBig.setAttribute('preserveAspectRatio', 'none');
  chartBig.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#8a909c" font-size="14">${msg}</text>`;
  chartAxis.innerHTML = '';
  chartTitle.textContent = (watchlist.find(w => w.code === code) || {}).name || code;
  chartTitle.style.color = '';
  chartSub.textContent = '';
  if (onShow) onShow();
}
function drawMinuteChart(code, series, prevClose, is5Day = false) {
  const item = watchlist.find(w => w.code === code);
  const W = Math.max(160, Math.round(chartBig.clientWidth) || 600);
  const H = Math.max(180, Math.round(chartBig.clientHeight) || 320);
  if (!series || series.length < 2) {
    chartBig.setAttribute('viewBox', `0 0 ${W} ${H}`);
    chartBig.setAttribute('preserveAspectRatio', 'none');
    chartBig.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#8a909c" font-size="14">暂无分时数据…</text>`;
    chartAxis.innerHTML = '';
    return;
  }
  const padL = 10, padR = 52, padT = 14, padB = 18;
  const plotW = W - padL - padR;
  // 三分区：价格主图 50% / 成交量 18% / MACD 32%（MACD 区域加大，便于看清柱/线）
  const priceTop = padT, priceBot = Math.round(H * 0.50);
  const volTop = Math.round(H * 0.55), volBot = Math.round(H * 0.70);
  const macdTop = Math.round(H * 0.75), macdBot = H - padB;
  const prices = series.map(d => d.p);
  let min = Math.min(...prices), max = Math.max(...prices);
  if (!isNaN(prevClose)) { min = Math.min(min, prevClose); max = Math.max(max, prevClose); }
  const range = (max - min) || 1;
  const xOf = i => padL + (i / (series.length - 1)) * plotW;
  const yOf = v => priceTop + (priceBot - priceTop) - ((v - min) / range) * (priceBot - priceTop);
  const line = prices.map((p, i) => xOf(i).toFixed(1) + ',' + yOf(p).toFixed(1)).join(' ');
  // 放大分时图同样遵循颜色设置：纯色用 sparkColor；随涨跌按当日涨跌着色（与行内分时图一致）
  let color;
  if (settings.sparkMode === 'solid') {
    color = settings.sparkColor || COLORS.spark;
  } else {
    const pct = pctMap[code];
    if (pct !== undefined) {
      color = pct >= 0 ? COLORS.up : COLORS.down;
    } else if (typeof prevClose === 'number' && !isNaN(prevClose)) {
      // 行情未就绪时按最后价 vs 昨收着色，避免先闪默认蓝色
      color = prices[prices.length - 1] >= prevClose ? COLORS.up : COLORS.down;
    } else {
      color = COLORS.spark;
    }
  }
  const rgb = hexToRgb(color);
  const fill = rgb ? `url(#areaGrad)` : 'rgba(120,130,160,0.08)';
  const baselineY = !isNaN(prevClose) ? yOf(prevClose).toFixed(1) : priceBot.toFixed(1);
  const defs = rgb
    ? `<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0%" stop-color="rgb(${rgb.r},${rgb.g},${rgb.b})" stop-opacity="0.28"/>`
      + `<stop offset="100%" stop-color="rgb(${rgb.r},${rgb.g},${rgb.b})" stop-opacity="0.03"/>`
      + `</linearGradient></defs>`
    : '';

  // 成交量（分钟量）与 MACD
  // 数据源已把成交量/额换算成「每分钟增量」（字段 v/amount 就是增量），这里不能再做差分，
  // 否则差值近似 0，成交量柱会几乎消失（五日分时尤其明显）。
  const vols = series.map(d => Math.max(0, d.v || 0));
  const amounts = series.map(d => Math.max(0, d.amount || 0));
  const vmax = Math.max(1, ...vols);
  const vOf = v => volBot - (v / vmax) * (volBot - volTop);
  let dif = null, dea = null, macdBar = null, mmax = 1;
  if (prices.length >= 26) {
    const ema = (arr, p) => {
      const k2 = 2 / (p + 1); let prev = arr[0]; const out = [prev];
      for (let i = 1; i < arr.length; i++) { prev = arr[i] * k2 + prev * (1 - k2); out.push(prev); }
      return out;
    };
    // 分时 MACD 基于原始价格序列计算（标准算法）。
    // 低价股（中国银河 12 元）的 MACD bar 绝对值极小，若线性缩放，
    // 多数柱子不足 1px，挤成一条线。这里仍用真实价格算 MACD，
    // 但显示时做“平方根视觉放大”，让小 bar 也能看清，大 bar 不会出框。
    const e12 = ema(prices, 12), e26 = ema(prices, 26);
    dif = prices.map((_, i) => e12[i] - e26[i]);
    dea = ema(dif, 9);
    macdBar = dif.map((v, i) => (v - dea[i]) * 2);
    macdBar.forEach(v => { const a = Math.abs(v); if (a > mmax) mmax = a; });
  }
  // 关键：DIF / DEA / bar 必须用同一套【线性】映射，才能保持三者真实关系
  // （bar = 2×(DIF−DEA)，标准 MACD 中 bar 应正好落在 DIF 线与 DEA 线之间）。
  // 之前用五次方根非线性放大，把 DIF/DEA 线压平、与 bar 错位，导致“线不准确”。
  // 改用线性：缩放基准 = 数据集最大绝对值，让最大 bar 占满半区（约 95%）。
  // → 中国银河最大 bar 与上证指数最大 bar 视觉高度一致（“一样大”），且线准确。
  // 注：低价股典型 bar 占比小（真实形态），仅以 2px 最小高度保底，不额外扭曲。
  const visualMmax = mmax > 0 ? mmax / 0.95 : 1;
  const halfH = (macdBot - macdTop) / 2;
  const myOf = v => {
    const sign = v >= 0 ? 1 : -1;
    const ratio = Math.min(1, Math.abs(v) / visualMmax);
    return (macdTop + macdBot) / 2 - sign * ratio * halfH;
  };

  let html = '';
  // 价格区横向网格
  for (let g = 0; g <= 3; g++) {
    const gy = (priceTop + (priceBot - priceTop) * g / 3).toFixed(1);
    html += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(120,128,148,0.14)" stroke-width="1" />`;
  }
  // 五日分时：用虚线分隔每一天，避免 5 天连成一条看不出日期边界
  if (is5Day) {
    for (let i = 1; i < series.length; i++) {
      const d0 = String(series[i - 1].t || '').slice(0, 10);
      const d1 = String(series[i].t || '').slice(0, 10);
      if (d0 && d1 && d0 !== d1) {
        const x = xOf(i).toFixed(1);
        html += `<line x1="${x}" y1="${priceTop}" x2="${x}" y2="${volBot}" stroke="rgba(120,128,148,0.30)" stroke-width="1" stroke-dasharray="3 3"/>`;
      }
    }
  }
  // 成交量 / MACD 分隔线 + 左侧刻度
  html += `<line x1="${padL}" y1="${volTop.toFixed(1)}" x2="${W - padR}" y2="${volTop.toFixed(1)}" stroke="rgba(120,128,148,0.18)" stroke-width="1"/>`;
  html += `<line x1="${padL}" y1="${macdTop.toFixed(1)}" x2="${W - padR}" y2="${macdTop.toFixed(1)}" stroke="rgba(120,128,148,0.18)" stroke-width="1"/>`;
  if (macdBar) {
    const mz = myOf(0).toFixed(1);
    html += `<line x1="${padL}" y1="${mz}" x2="${W - padR}" y2="${mz}" stroke="rgba(120,128,148,0.25)" stroke-width="1" stroke-dasharray="3 3"/>`;
  }
  html += `<text x="${padL - 2}" y="${(volTop + 10).toFixed(1)}" text-anchor="end" fill="rgba(138,144,156,0.75)" font-size="8">量</text>`;
  html += `<text x="${padL - 2}" y="${(volBot - 2).toFixed(1)}" text-anchor="end" fill="rgba(138,144,156,0.55)" font-size="7">${fmtVol(vmax)}</text>`;
  if (macdBar) {
    html += `<text x="${padL - 2}" y="${(macdTop + 10).toFixed(1)}" text-anchor="end" fill="rgba(138,144,156,0.75)" font-size="8">MACD</text>`;
    html += `<text x="${padL - 2}" y="${(macdTop + 20).toFixed(1)}" text-anchor="end" fill="rgba(138,144,156,0.55)" font-size="7">+${mmax.toFixed(4)}</text>`;
    html += `<text x="${padL - 2}" y="${(macdBot - 2).toFixed(1)}" text-anchor="end" fill="rgba(138,144,156,0.55)" font-size="7">-${mmax.toFixed(4)}</text>`;
  }

  if (!isNaN(prevClose)) {
    html += `<line x1="${padL}" y1="${baselineY}" x2="${W - padR}" y2="${baselineY}" stroke="rgba(120,128,148,0.5)" stroke-width="1" stroke-dasharray="4 4" />`;
  }
  html += `<polygon points="${xOf(0).toFixed(1)},${baselineY} ${line} ${xOf(series.length - 1).toFixed(1)},${baselineY}" fill="${fill}" />`;
  html += `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;

  // 成交量柱 + MACD 柱/线
  const barW = Math.max(2, (plotW / series.length) * 0.80);
  series.forEach((d, i) => {
    const x = xOf(i);
    const up = i > 0 ? prices[i] >= prices[i - 1] : (pctMap[code] >= 0);
    const c = up ? COLORS.up : COLORS.down;
    const vy = vOf(vols[i]);
    html += `<rect x="${(x - barW / 2).toFixed(1)}" y="${vy.toFixed(1)}" width="${barW.toFixed(1)}" height="${(volBot - vy).toFixed(1)}" fill="${c}" opacity="0.55"/>`;
    if (macdBar) {
      const v = macdBar[i];
      if (v != null) {
        const y0 = myOf(0), yv = myOf(v);
        const top = Math.min(y0, yv), hh = Math.max(2, Math.abs(yv - y0)); // 最小 2px 柱高保底
        html += `<rect x="${(x - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${hh.toFixed(1)}" fill="${v >= 0 ? COLORS.up : COLORS.down}" opacity="0.95"/>`;
      }
    }
  });
  if (macdBar) {
    const macdLine = (arr, col) => {
      const pts = [];
      arr.forEach((v, i) => { if (v != null) pts.push(`${xOf(i).toFixed(1)},${myOf(v).toFixed(1)}`); });
      return pts.length > 1 ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" opacity="1"/>` : '';
    };
    html += macdLine(dif, '#ffbe3d');
    html += macdLine(dea, '#5aaaff');
  }

  // 末点标记 + 现价标签（放在右侧留白）
  const lastX = xOf(series.length - 1), lastY = yOf(prices[prices.length - 1]);
  html += `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3" fill="${color}" stroke="#fff" stroke-width="1.5" />`;
  html += `<text x="${(W - padR + 4).toFixed(1)}" y="${(lastY + 4).toFixed(1)}" text-anchor="start" fill="${color}" font-size="11" font-weight="700" font-family="tabular-nums">${prices[prices.length - 1].toFixed(2)}</text>`;

  chartBig.setAttribute('viewBox', `0 0 ${W} ${H}`);
  chartBig.setAttribute('preserveAspectRatio', 'none');
  const fadeCls = chartFadeNext ? ' fade-in' : '';
  chartFadeNext = false;
  chartBig.innerHTML = `${defs}<g id="chartPlot" class="${fadeCls.trim()}">${html}</g><g id="chartCross" style="display:none"></g>`;

  const base = isNaN(prevClose) ? prices[0] : prevClose;
  chartGeo = {
    kind: 'min', W, H, padL, padR, padT, plotW,
    priceTop, priceBot, volTop, volBot, macdTop, macdBot,
    items: series.map((d, i) => ({ ...d, chg: base ? ((d.p - base) / base * 100) : 0, mv: vols[i], ma: amounts[i] })),
    xOf, yOf, vOf, myOf, color, macd: !!macdBar, dif, dea, macdBar, mmax,
  };
  const last = prices[prices.length - 1];
  const chg = last - base;
  const pct = base ? (chg / base * 100) : 0;
  const arrow = chg > 0 ? '▲' : (chg < 0 ? '▼' : '—');
  chartTitle.textContent = item ? (item.name || code) : code;
  chartTitle.style.color = '';
  chartSub.innerHTML = `现价 <b style="color:${color}">${last.toFixed(2)}</b>　`
    + `<span style="color:${color}">${arrow} ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}　${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`
    + (isNaN(prevClose) ? '' : `　昨收 ${prevClose.toFixed(2)}`);
  const lab = d => (d.day ? d.day + ' ' : '') + fmtTime(d.t);
  chartAxis.innerHTML = `<span>${lab(series[0])}</span><span>${lab(series[Math.floor(series.length / 2)])}</span><span>${lab(series[series.length - 1])}</span>`;
}
// K线（蜡烛图）：蜡烛 + 动态均线 + 成交量副图 +（可选）MACD 副图；红涨绿跌
// 支持：视口缩放/平移（klineView）、可调均线周期（klineInd.ma）、MACD 副图（klineInd.macd）
function drawKline(code) {
  const item = watchlist.find(w => w.code === code);
  const key = code + '|' + chartPeriod;
  const k = klineData[key];
  const W = Math.max(220, Math.round(chartBig.clientWidth) || 600);
  const H = Math.max(200, Math.round(chartBig.clientHeight) || 300);
  const need = chartPeriod === 'year' ? 1 : 2;
  if (!k || k.length < need) {
    chartBig.setAttribute('viewBox', `0 0 ${W} ${H}`);
    chartBig.setAttribute('preserveAspectRatio', 'none');
    // 板块 K 线依赖东财（限流时整段不可用），提示要说明会自动重试，避免用户以为功能坏了
    const msg = /^bk/i.test(code) ? '板块K线数据源限流，稍后自动重试…' : '暂无K线数据';
    chartBig.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#8a909c" font-size="14">${msg}</text>`;
    chartAxis.innerHTML = '';
    return;
  }
  const N = k.length;
  // 视口（索引区间，end 不含）；null = 全量
  let s = 0, e = N;
  if (klineView) {
    s = Math.max(0, Math.min(N - 1, klineView.start | 0));
    e = Math.max(s + 2, Math.min(N, klineView.end | 0));
  }
  const vk = k.slice(s, e); // 可见数据
  const n = vk.length;
  const padL = 44, padR = 12, padT = 14, axisH = 16;
  const showMacd = !!klineInd.macd;
  let priceTop, priceBot, volTop, volBot, macdTop, macdBot;
  if (showMacd) {
    priceTop = padT; priceBot = H * 0.58;
    volTop = H * 0.66; volBot = H * 0.80;
    macdTop = H * 0.84; macdBot = H - axisH;
  } else {
    priceTop = padT; priceBot = H * 0.72;
    volTop = H * 0.80; volBot = H - axisH;
  }
  const plotW = W - padL - padR;
  const candleW = plotW / n;
  const bodyW = Math.max(1.5, candleW * 0.64);
  // 价格区间（仅可见蜡烛）
  let pmin = Infinity, pmax = -Infinity;
  vk.forEach(d => { pmin = Math.min(pmin, d.low); pmax = Math.max(pmax, d.high); });
  // 均线（基于全量计算，避免视口边缘被截断）—— 渲染时仅取可见部分
  const maCalc = win => k.map((d, i) => {
    let sum = 0, c = 0;
    for (let j = Math.max(0, i - win + 1); j <= i; j++) { if (k[j].close) { sum += k[j].close; c++; } }
    return c ? sum / c : null;
  });
  const maColors = { 5: '#f5a623', 10: '#4a90e2', 20: '#9b59b6', 60: '#27ae60' };
  const mas = (klineInd.ma || []).map(w => ({ win: w, arr: maCalc(w), col: maColors[w] || '#8a909c' }));
  // 把可见部分均线值纳入价格区间，避免压边
  mas.forEach(m => vk.forEach((d, li) => { const v = m.arr[s + li]; if (v != null) { pmin = Math.min(pmin, v); pmax = Math.max(pmax, v); } }));
  const prange = (pmax - pmin) || 1;
  const vmax = Math.max(1, ...vk.map(d => d.volume));
  const xOf = i => padL + candleW * (i + 0.5);
  const yOf = v => priceBot - ((v - pmin) / prange) * (priceBot - priceTop);
  const vyOf = v => volBot - (v / vmax) * (volBot - volTop);
  // MACD（基于全量 close 计算 EMA）
  let dif = null, dea = null, macdBar = null, mmax = 1;
  if (showMacd) {
    const ema = (arr, p) => {
      const k2 = 2 / (p + 1); let prev = arr[0]; const out = [prev];
      for (let i = 1; i < arr.length; i++) { prev = arr[i] * k2 + prev * (1 - k2); out.push(prev); }
      return out;
    };
    const c = k.map(d => d.close);
    const e12 = ema(c, 12), e26 = ema(c, 26);
    dif = c.map((_, i) => e12[i] - e26[i]);
    dea = ema(dif, 9);
    macdBar = dif.map((v, i) => (v - dea[i]) * 2);
    macdBar.forEach(v => { const a = Math.abs(v); if (a > mmax) mmax = a; });
  }
  const myOf = v => (macdTop + macdBot) / 2 - (v / mmax) * ((macdBot - macdTop) / 2);
  const last = k[N - 1];
  const base = (N > 1) ? k[N - 2].close : last.open;
  const up = last.close >= base;
  const color = up ? COLORS.up : COLORS.down;
  let html = '';
  // 价格横向网格 + 刻度（左侧留白）
  for (let g = 0; g <= 4; g++) {
    const gy = (priceTop + (priceBot - priceTop) * g / 4).toFixed(1);
    html += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(120,128,148,0.14)" stroke-width="1"/>`;
    html += `<text x="${padL - 4}" y="${(parseFloat(gy) - 2).toFixed(1)}" text-anchor="end" fill="rgba(138,144,156,0.95)" font-size="9" font-family="tabular-nums">${(pmax - prange * g / 4).toFixed(2)}</text>`;
  }
  // 成交量区分隔线
  html += `<line x1="${padL}" y1="${volTop.toFixed(1)}" x2="${W - padR}" y2="${volTop.toFixed(1)}" stroke="rgba(120,128,148,0.18)" stroke-width="1"/>`;
  if (showMacd) {
    const mz = myOf(0).toFixed(1);
    html += `<line x1="${padL}" y1="${mz}" x2="${W - padR}" y2="${mz}" stroke="rgba(120,128,148,0.18)" stroke-width="1"/>`;
    html += `<text x="${padL - 4}" y="${(macdTop + 3).toFixed(1)}" text-anchor="end" fill="rgba(138,144,156,0.85)" font-size="8">MACD</text>`;
  }
  // 蜡烛 + 成交量柱
  vk.forEach((d, li) => {
    const x = xOf(li);
    const isUp = d.close >= d.open;
    const c = isUp ? COLORS.up : COLORS.down;
    const yO = yOf(d.open), yC = yOf(d.close), yH = yOf(d.high), yL = yOf(d.low);
    const top = Math.min(yO, yC), bot = Math.max(yO, yC);
    html += `<line x1="${x.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yL.toFixed(1)}" stroke="${c}" stroke-width="1"/>`;
    const bh = Math.max(1, bot - top);
    html += `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${c}"/>`;
    const vy = vyOf(d.volume);
    html += `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${vy.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${(volBot - vy).toFixed(1)}" fill="${c}" opacity="0.4"/>`;
  });
  // 均线
  const maLine = (arr, col) => {
    const pts = [];
    vk.forEach((d, li) => { const v = arr[s + li]; if (v != null) pts.push(`${xOf(li).toFixed(1)},${yOf(v).toFixed(1)}`); });
    return pts.length > 1 ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="1.3" stroke-linejoin="round" opacity="0.92"/>` : '';
  };
  mas.forEach(m => { html += maLine(m.arr, m.col); });
  // MACD 柱 + DIF/DEA 线
  if (showMacd) {
    vk.forEach((d, li) => {
      const v = macdBar[s + li];
      if (v == null) return;
      const x = xOf(li);
      const y0 = myOf(0), yv = myOf(v);
      const col = v >= 0 ? COLORS.up : COLORS.down;
      const top = Math.min(y0, yv), hh = Math.max(1, Math.abs(yv - y0));
      html += `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${hh.toFixed(1)}" fill="${col}" opacity="0.75"/>`;
    });
    const macdLine = (arr, col) => {
      const pts = [];
      vk.forEach((d, li) => { const v = arr[s + li]; if (v != null) pts.push(`${xOf(li).toFixed(1)},${myOf(v).toFixed(1)}`); });
      return pts.length > 1 ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="1.1" stroke-linejoin="round" opacity="0.95"/>` : '';
    };
    html += macdLine(dif, '#f5a623');
    html += macdLine(dea, '#4a90e2');
  }
  // 末收标记（可见最后一根）
  const lastVi = n - 1;
  html += `<circle cx="${xOf(lastVi).toFixed(1)}" cy="${yOf(vk[lastVi].close).toFixed(1)}" r="2.6" fill="${color}" stroke="#fff" stroke-width="1.2"/>`;

  chartBig.setAttribute('viewBox', `0 0 ${W} ${H}`);
  chartBig.setAttribute('preserveAspectRatio', 'none');
  const fadeCls = chartFadeNext ? ' fade-in' : '';
  chartFadeNext = false;
  chartBig.innerHTML = `<g id="chartPlot" class="${fadeCls.trim()}">${html}</g><g id="chartCross" style="display:none"></g>`;
  chartGeo = {
    kind: 'kline', W, H, padL, padR, padT, plotW,     items: vk.map((d, li) => {
      const j = s + li;
      const ref = j > 0 ? k[j - 1].close : d.open;
      return { t: d.date, p: d.close, chg: ref ? (d.close - ref) / ref * 100 : 0, ref, o: d.open, h: d.high, l: d.low, v: d.volume };
    }), xOf, yOf, color, volTop, volBot, vmax, priceTop, priceBot,
    macdTop, macdBot, macd: showMacd, dif, dea, macdBar, start: s,
  };
  chartTitle.textContent = item ? (item.name || code) : code;
  chartTitle.style.color = '';
  const chg = last.close - base;
  const pct = base ? chg / base * 100 : 0;
  // 顶部均线图例（同花顺风格：5MA 12.34，每条带对应颜色），取全量最后一根的均线值
  const maLegend = (mas || []).map(m => {
    const v = m.arr[N - 1];
    if (v == null) return '';
    return `<span style="color:${m.col};font-weight:600">${m.win}MA</span> <span style="color:${m.col}">${v.toFixed(2)}</span>　`;
  }).join('');
  chartSub.innerHTML = `收 <b style="color:${color}">${last.close.toFixed(2)}</b>　`
    + `开 ${last.open.toFixed(2)}　高 ${last.high.toFixed(2)}　低 ${last.low.toFixed(2)}　`
    + `<span style="color:${color}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}　${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>　`
    + maLegend;
  // 底部坐标轴：可见窗口起止日期 + 视口根数
  const viewInfo = klineView ? `　<span style="color:#8a909c">[${n}根]</span>` : '';
  chartAxis.innerHTML = `<span>${vk[0].date}</span><span>${vk[Math.floor(n / 2)].date}</span><span>${vk[n - 1].date}</span>${viewInfo}`;
}
chartClose.addEventListener('click', closeChart);
chartModal.addEventListener('click', e => { if (e.target === chartModal) closeChart(); });
// 放大图鼠标十字光标 + 数据点高亮 + 跟随 tooltip（让弹窗可交互、更丰富）
function setupChartCross() {
  if (!chartBig) return;
  chartBig.addEventListener('mousemove', e => {
    if (!chartGeo || !chartGeo.items || chartGeo.items.length < 2) return;
    const rect = chartBig.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * chartGeo.W;
    const n = chartGeo.items.length;
    const padL = chartGeo.padL || 0, padR = chartGeo.padR || 0;
    let ratio = (x - padL) / (chartGeo.W - padL - padR);
    ratio = Math.max(0, Math.min(1, ratio));
    const idx = Math.round(ratio * (n - 1));
    const d = chartGeo.items[idx];
    const cx = chartGeo.xOf(idx), cy = chartGeo.yOf(d.p);
    const cross = chartBig.querySelector('#chartCross');
    if (cross) {
      cross.style.display = '';
      cross.innerHTML = `<line x1="${cx.toFixed(1)}" y1="0" x2="${cx.toFixed(1)}" y2="${chartGeo.H.toFixed(1)}" stroke="rgba(120,128,148,0.5)" stroke-width="1" stroke-dasharray="3 3"/>`
        + `<line x1="${padL.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(chartGeo.W - padR).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="rgba(120,128,148,0.4)" stroke-width="1" stroke-dasharray="3 3"/>`
        + `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.5" fill="${chartGeo.color}" stroke="#fff" stroke-width="1.5"/>`;
    }
    tipEl.style.display = 'block';
    const lbl = d.day ? d.day + ' ' + fmtTime(d.t) : fmtTime(d.t);
    let html;
    if (chartGeo.kind === 'kline') {
      const kUp = d.p >= d.o;
      const kCol = kUp ? COLORS.up : COLORS.down;
      const chgAmt = d.p - d.ref;
      const amp = d.ref ? ((d.h - d.l) / d.ref * 100) : 0;
      html = `<div style="font-weight:600;color:#fff;margin-bottom:3px">${lbl}</div>`;
      html += `<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:5px">`;
      html += `<span style="font-size:15px;font-weight:700;color:${kCol}">${d.p.toFixed(2)}</span>`;
      html += `<span style="color:${kCol};font-weight:600">${chgAmt >= 0 ? '+' : ''}${chgAmt.toFixed(2)}</span>`;
      html += `<span style="color:${kCol};font-weight:600">${d.chg >= 0 ? '+' : ''}${d.chg.toFixed(2)}%</span>`;
      html += `</div>`;
      html += `<div style="display:grid;grid-template-columns:repeat(2,auto);gap:2px 14px;color:#c8cdd8;font-size:11px;margin-bottom:4px">`;
      html += `<span>开盘 ${d.o.toFixed(2)}</span><span>收盘 ${d.p.toFixed(2)}</span>`;
      html += `<span>最高 ${d.h.toFixed(2)}</span><span>最低 ${d.l.toFixed(2)}</span>`;
      html += `<span>振幅 ${amp.toFixed(2)}%</span><span>量 ${fmtVol(d.v)}</span>`;
      html += `</div>`;
      if (chartGeo.macd) {
        const j = chartGeo.start + idx;
        const df = chartGeo.dif[j], de = chartGeo.dea[j], mb = chartGeo.macdBar[j];
        if (df != null) {
          html += `<div style="border-top:1px solid rgba(255,255,255,0.12);padding-top:4px;display:grid;grid-template-columns:repeat(2,auto);gap:2px 14px;font-size:11px">`;
          html += `<span style="color:#f5a623">DIF ${df.toFixed(2)}</span>`;
          html += `<span style="color:#4a90e2">DEA ${de.toFixed(2)}</span>`;
          html += `<span style="color:${mb >= 0 ? COLORS.up : COLORS.down}">MACD ${mb >= 0 ? '+' : ''}${mb.toFixed(2)}</span>`;
          html += `</div>`;
        }
      }
    } else {
      html = `<b>${lbl}</b>　${d.p.toFixed(2)}`;
      if (d.chg != null) html += `　<span style="color:${d.chg >= 0 ? COLORS.up : COLORS.down}">${d.chg >= 0 ? '+' : ''}${d.chg.toFixed(2)}%</span>`;
      if (d.mv != null && d.mv > 0) {
        html += `<div style="color:#8a909c;margin-top:2px">量 ${fmtVol(d.mv)}`;
        if (d.ma != null && d.ma > 0) html += `　额 ${fmtAmount(d.ma)}`;
        html += `</div>`;
      }
      if (chartGeo.macd) {
        const df = chartGeo.dif[idx], de = chartGeo.dea[idx], mb = chartGeo.macdBar[idx];
        if (df != null) {
          html += `<div style="margin-top:2px;color:#ffbe3d">DIF ${df.toFixed(4)}</div>`;
          html += `<div style="color:#5aaaff">DEA ${de.toFixed(4)}</div>`;
          html += `<div style="color:${mb >= 0 ? COLORS.up : COLORS.down}">MACD ${mb >= 0 ? '+' : ''}${mb.toFixed(4)}</div>`;
        }
      }
    }
    tipEl.innerHTML = html;
    positionTipEl(e.clientX, e.clientY);
  });
  chartBig.addEventListener('mouseleave', () => {
    const cross = chartBig.querySelector('#chartCross');
    if (cross) cross.style.display = 'none';
    tipEl.style.display = 'none';
  });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (chartTabsDropdown && !chartTabsDropdown.hidden) { setDropdown(false); return; } // 先收起周期下拉
    if (chartModal && !chartModal.hidden) closeChart();
    else if (rankModal && !rankModal.hidden) closeRank();
    else if (manageModal && !manageModal.hidden) closeManage();
  }
});
// 东财风格：单击整行任意处（除操作按钮）→ 打开内置行情大图
listEl.addEventListener('click', e => {
  if (Date.now() < suppressClickUntil) return; // 拖拽结束后的误触，忽略
  if (e.target.closest('.acts') || e.target.closest('.pin') || e.target.closest('.del')) return; // 让操作按钮走各自逻辑
  const row = e.target.closest('.row');
  if (row) openChart(row.dataset.code);
});
// K线数据到达 → 若正在看该 code+period 则重绘
ipcRenderer.on('kline', (event, res) => {
  if (!res || res.error || !res.code) return;
  const key = res.code + '|' + res.period;
  const data = res.data || [];
  // 数据源限流时会返回空：已有有效数据就保留，避免 30s 定时刷新把好好的 K 线刷成「暂无K线数据」
  if (!data.length && klineData[key] && klineData[key].length) return;
  klineData[key] = data;
  if (chartCode === res.code && chartPeriod === res.period) drawKline(res.code);
});
// 五日分时数据到达 → 若正在看该 code 的五日分时则重绘
ipcRenderer.on('5day', (event, res) => {
  if (!res || res.error || !res.code) return;
  spark5DayData[res.code] = res.data || [];
  if (chartCode === res.code && chartPeriod === '5day') drawBigChart(res.code);
});
// 周期标签切换（分时 / 五日 / 日K / 周K / 月K / 年K / 分钟K）
if (chartTabs) {
  chartTabs.addEventListener('click', e => {
    // 忽略拖拽结束可能触发的误 click
    if (Date.now() - chartTabsLastDragEnd < 250) return;
    // 忽略拖拽把手的点击（只让文字区触发切换）
    if (e.target.closest('.chart-tab-drag-handle')) return;
    const b = e.target.closest('button[data-period]');
    if (!b) return;
    switchChartPeriod(b.dataset.period);
  });
}
// 更多周期下拉按钮：统一用 setDropdown 开/关，避免状态竞态
if (chartTabsMore && chartTabsDropdown) {
  chartTabsMore.addEventListener('click', e => {
    e.stopPropagation(); // 阻止冒泡到 document，避免被“点击外部”逻辑立即关掉
    setDropdown(chartTabsDropdown.hidden); // 当前隐藏→打开；当前打开→关闭
  });
  document.addEventListener('click', e => {
    if (!chartTabsDropdown.hidden && !chartTabs.contains(e.target)) setDropdown(false);
  });
}
// 弹窗大小变化/打开时重新计算可见周期（监听标签栏容器，而非 track，避免可见按钮数变化引发重排死循环）
if (chartModal) {
  const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(() => renderChartTabs()) : null;
  if (ro) ro.observe(chartTabs);
}

// ---------- K线视口导航：滚轮缩放 + 拖拽平移 + 双击复位 ----------
function setupKlineNav() {
  if (!chartBig) return;
  let dragging = false, dragStartX = 0, dragStartView = null;
  chartBig.style.cursor = '';
  chartBig.addEventListener('wheel', e => {
    if (chartPeriod === 'min' || !chartGeo || chartGeo.kind !== 'kline') return;
    const k = klineData[chartCode + '|' + chartPeriod];
    if (!k) return;
    e.preventDefault();
    const N = k.length;
    const curS = klineView ? klineView.start : 0;
    const curE = klineView ? klineView.end : N;
    const curN = curE - curS;
    const rect = chartBig.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width; // 0..1 鼠标相对图宽
    const anchorRel = Math.max(0, Math.min(1, (mx * chartGeo.W - chartGeo.padL) / (chartGeo.W - chartGeo.padL - chartGeo.padR)));
    const anchorIdx = curS + anchorRel * (curN - 1);
    const zoom = e.deltaY < 0 ? 0.82 : 1 / 0.82; // 上滚放大(缩小窗口)，下滚缩小(放大窗口)
    let newN = Math.round(curN * zoom);
    newN = Math.max(20, Math.min(N, newN));
    if (newN >= N) { klineView = null; drawKline(chartCode); return; }
    let ns = Math.round(anchorIdx - anchorRel * (newN - 1));
    let ne = ns + newN;
    if (ns < 0) { ne -= ns; ns = 0; }
    if (ne > N) { ns -= (ne - N); ne = N; }
    ns = Math.max(0, ns);
    if (ne - ns < 20) return;
    klineView = { start: ns, end: ne };
    drawKline(chartCode);
  }, { passive: false });
  chartBig.addEventListener('mousedown', e => {
    if (chartPeriod === 'min' || !chartGeo || chartGeo.kind !== 'kline') return;
    dragging = true; dragStartX = e.clientX; dragStartView = klineView ? { ...klineView } : null;
    chartBig.style.cursor = 'grabbing';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const k = klineData[chartCode + '|' + chartPeriod];
    if (!k) return;
    const N = k.length;
    const dv = dragStartView || { start: 0, end: N };
    const width = dv.end - dv.start;
    if (width >= N) return; // 已满窗口，无空间平移
    const rect = chartBig.getBoundingClientRect();
    const dx = e.clientX - dragStartX;
    const plotW = chartGeo.W - chartGeo.padL - chartGeo.padR;
    const pxPerIdx = plotW / Math.max(1, width);
    const shiftIdx = Math.round(dx / pxPerIdx);
    let s = dv.start - shiftIdx, en = dv.end - shiftIdx;
    if (s < 0) { en += -s; s = 0; }
    if (en > N) { s -= (en - N); en = N; }
    s = Math.max(0, s);
    if (en - s < 20) return;
    klineView = { start: s, end: en };
    drawKline(chartCode);
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    if (chartBig) chartBig.style.cursor = '';
  });
  // 双击复位到全量
  chartBig.addEventListener('dblclick', e => {
    if (chartPeriod === 'min' || !chartGeo || chartGeo.kind !== 'kline') return;
    if (klineView) { klineView = null; drawKline(chartCode); }
  });
}

// ---------- 指标面板：均线复选 + MACD 开关 + 持久化 ----------
function setupIndPanel() {
  if (!indBtn || !indPanel) return;
  // 初始化勾选状态
  indPanel.querySelectorAll('input[data-ma]').forEach(cb => {
    cb.checked = klineInd.ma.includes(parseInt(cb.dataset.ma, 10));
  });
  const macdChk = indPanel.querySelector('#macdChk');
  if (macdChk) macdChk.checked = !!klineInd.macd;
  indBtn.addEventListener('click', e => {
    e.stopPropagation();
    indPanel.hidden = !indPanel.hidden;
  });
  indPanel.addEventListener('change', e => {
    const cb = e.target.closest('input[data-ma]');
    if (cb) {
      const w = parseInt(cb.dataset.ma, 10);
      if (cb.checked) { if (!klineInd.ma.includes(w)) klineInd.ma.push(w); }
      else { klineInd.ma = klineInd.ma.filter(x => x !== w); }
      klineInd.ma.sort((a, b) => a - b);
    } else if (e.target.id === 'macdChk') {
      klineInd.macd = e.target.checked;
    }
    saveKlineInd();
    if (chartCode && chartGeo && chartGeo.kind === 'kline') drawKline(chartCode);
  });
  // 点击面板外部关闭
  document.addEventListener('click', e => {
    if (!indPanel.hidden && !indPanel.contains(e.target) && e.target !== indBtn && !indBtn.contains(e.target)) {
      indPanel.hidden = true;
    }
  });
}

// ---------- 行情榜单（涨幅/跌幅/换手/成交额，一次取数客户端排序） ----------
function openRank() {
  if (!rankModal) return;
  rankModal.hidden = false;
  requestAnimationFrame(() => rankModal.classList.add('show'));
  if (!rankData.byTab[rankData.tab].length) {
    rankList.innerHTML = '<div class="empty">加载榜单…</div>';
    ipcRenderer.send('fetch-ranking');
  } else renderRank();
}
function closeRank() {
  if (!rankModal) return;
  rankModal.classList.remove('show');
  rankModal.hidden = true;
}
function fmtAmount(v) {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(Math.round(v));
}
function renderRank() {
  if (!rankList) return;
  const tab = rankData.tab;
  // 服务端已按各榜单字段排序取 TopN，这里直接取对应榜单（再 slice 保险）
  let arr = (rankData.byTab[tab] || []).slice();
  if (tab === 'up') arr.sort((a, b) => b.chgPct - a.chgPct);
  else if (tab === 'down') arr.sort((a, b) => a.chgPct - b.chgPct);
  else if (tab === 'turn') arr.sort((a, b) => b.turnover - a.turnover);
  else if (tab === 'amount') arr.sort((a, b) => b.amount - a.amount);
  arr = arr.slice(0, 60);
  rankList.innerHTML = '';
  arr.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'r-item no-drag';
    div.dataset.code = r.code;
    div.dataset.name = r.name;
    const up = r.chgPct >= 0;
    const col = up ? COLORS.up : COLORS.down;
    const extra = (tab === 'amount') ? `成交额 ${fmtAmount(r.amount)}` : `换手 ${r.turnover.toFixed(2)}%`;
    div.style.animationDelay = (i * 14) + 'ms'; // 错峰淡入
    div.innerHTML = `
      <span class="r-rank">${i + 1}</span>
      <span class="r-name">${r.name}</span>
      <span class="r-code">${r.code.replace(/^(sh|sz|hk|bj|us)/i, '').toUpperCase()}</span>
      <span class="r-price" style="color:${col}">${r.price.toFixed(2)}</span>
      <span class="r-chg" style="color:${col}">${up ? '+' : ''}${r.chgPct.toFixed(2)}%</span>
      <span class="r-extra">${extra}</span>
      <button class="r-add no-drag" title="加入自选">+</button>`;
    rankList.appendChild(div);
  });
}
ipcRenderer.on('ranking', (event, data) => {
  if (!data || data.error) return;
  rankData.byTab = { up: data.up || [], down: data.down || [], turn: data.turn || [], amount: data.amount || [] };
  if (rankModal && !rankModal.hidden) renderRank();
});
if (rankTabs) rankTabs.addEventListener('click', e => {
  const b = e.target.closest('button[data-rank]');
  if (!b) return;
  rankData.tab = b.dataset.rank;
  rankTabs.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  renderRank();
});
if (rankList) rankList.addEventListener('click', e => {
  const add = e.target.closest('.r-add');
  const row = e.target.closest('.r-item');
  if (!row) return;
  if (add) {
    addStock(row.dataset.code, row.dataset.name);
    showToast('已加入自选', row.dataset.name + '（' + row.dataset.code + '）');
    return;
  }
  openChart(row.dataset.code); // 点榜单行 → 打开该股 K线
});
if (rankBtn) rankBtn.addEventListener('click', openRank);
if (rankClose) rankClose.addEventListener('click', closeRank);
if (rankModal) rankModal.addEventListener('click', e => { if (e.target === rankModal) closeRank(); });

// 滚动条：不滚动时自动隐藏（滚动/悬停时显示圆形滚动条）
function setupAutoHideScrollbars() {
  const sel = '.settings, .list, .manage-list, .rank-list';
  document.querySelectorAll(sel).forEach(el => {
    if (el._autoHideBound) return;
    el._autoHideBound = true;
    let t = null;
    el.addEventListener('scroll', () => {
      el.classList.add('scrolling');
      if (t) clearTimeout(t);
      t = setTimeout(() => el.classList.remove('scrolling'), 1000);
    }, { passive: true });
  });
}

// ---------- 帮助 / 引导 / 右键菜单 / 备份导入 ----------
// 快捷键与帮助弹窗
const HELP_ITEMS = [
  ['全局显隐', 'Ctrl+Alt+S：呼出/隐藏窗口（即使被遮挡也能唤出）'],
  ['移动窗口', '拖动标题栏；双击标题栏切换置顶'],
  ['添加自选', '顶部输入框输代码或名称，下拉多选；直接输代码回车'],
  ['搜索板块', '输「半导体」「白酒」等，选中板块(BK)即加入'],
  ['行情详情', '点击分时小图弹出大图（分时 / K线，支持缩放平移）'],
  ['行情榜单', '标题栏「榜」看涨幅 / 跌幅 / 换手 / 成交额榜'],
  ['常驻票', '行尾 ★ 设为常驻；点 ▾ 收起窗口只留常驻票'],
  ['持仓盈亏', '在「持仓」视图点任意一行即可就地改成本价+股数（支持加仓/减仓/清仓）；也可点 ＋ 打开添加面板'],
  ['价格预警', '自选管理里填高/低预警价，触及弹通知 + 提示音'],
  ['托盘', '点 × 最小化到托盘；托盘可显隐 / 重置位置 / 退出'],
  ['贴边隐藏', '设置开启后拖到屏幕边缘吸附，鼠标悬停展开'],
  ['导出备份', '设置→备份与导入，导出自选 JSON，换机不丢'],
];
function showHelp() {
  if (!helpModal || !helpBody) return;
  helpBody.innerHTML = HELP_ITEMS.map(([k, v]) => `<div class="help-row"><span class="help-k">${k}</span><span class="help-v">${v}</span></div>`).join('');
  helpModal.hidden = false;
  requestAnimationFrame(() => helpModal.classList.add('show')); // 复用 chart-modal 的淡入（默认 opacity:0）
}
function closeHelp() { if (helpModal) { helpModal.classList.remove('show'); helpModal.hidden = true; } }
if (helpBtn) helpBtn.addEventListener('click', showHelp);
if (helpClose) helpClose.addEventListener('click', closeHelp);
if (helpModal) helpModal.addEventListener('click', e => { if (e.target === helpModal) closeHelp(); });
document.addEventListener('keydown', e => { if (e.key === 'F1') { e.preventDefault(); showHelp(); } });
// Ctrl/Cmd+R 或 F5：重新加载渲染进程，让 style.css / renderer.js 改动即时生效
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); ipcRenderer.send('reload'); }
  else if (e.key === 'F5') { e.preventDefault(); ipcRenderer.send('reload'); }
});

// 右键行菜单
function copyItemToGroup(code, groupId) {
  const src = watchlist.find(w => w.code === code);
  if (!src) return;
  const g = groups.find(x => x.id === groupId);
  if (!g) return;
  if (g.items.some(it => it.code === code)) { showToast('已在该分组', src.name || code); return; }
  g.items.push({ code: src.code, name: src.name, alertHigh: src.alertHigh || '', alertLow: src.alertLow || '', cost: src.cost || '', shares: src.shares || '' });
  saveGroups(); renderGroups(); renderManage();
  showToast('已加入「' + g.name + '」', src.name || code);
}
// 移动到分组：从当前（激活）分组移除，仅留在目标分组
function moveItemToGroup(code, groupId) {
  const src = watchlist.find(w => w.code === code);
  if (!src) return;
  const g = groups.find(x => x.id === groupId);
  if (!g) return;
  if (g.id === activeGroupId) { showToast('已在当前分组', src.name || code); return; }
  // 从当前分组移除
  const idx = watchlist.findIndex(w => w.code === code);
  if (idx >= 0) watchlist.splice(idx, 1);
  // 加入目标分组（去重）
  if (!g.items.some(it => it.code === code)) {
    g.items.push({ code: src.code, name: src.name, alertHigh: src.alertHigh || '', alertLow: src.alertLow || '', cost: src.cost || '', shares: src.shares || '' });
  }
  saveGroups(); renderGroups(); render(); updatePinned(); renderManage(); refresh(); fetchMinutes();
  showToast('已移动到「' + g.name + '」', src.name || code);
}
// 新建分组并把当前票放进去，随后进入重命名（与「新建分组」按钮一致体验）
function createGroupWith(code) {
  const src = watchlist.find(w => w.code === code);
  if (!src) return;
  const g = { id: uid(), name: '新分组' + (groups.length + 1), items: [] };
  g.items.push({ code: src.code, name: src.name, alertHigh: src.alertHigh || '', alertLow: src.alertLow || '', cost: src.cost || '', shares: src.shares || '' });
  groups.push(g);
  activeGroupId = g.id;
  watchlist = g.items;
  saveGroups();
  renderGroups(); render(); updatePinned(); renderManage(); refresh(); fetchMinutes();
  const tab = groupsTrack.querySelector(`.group-tab[data-id="${g.id}"]`);
  if (tab) startRename(tab, g.id);
  showToast('已新建并加入', src.name || code);
}
function showCtxMenu(code, x, y) {
  if (!ctxMenu) return;
  const item = watchlist.find(w => w.code === code);
  if (!item) return;
  const pinned = settings.pinnedList.includes(code);
  const otherGroups = groups.filter(g => g.id !== activeGroupId);
  let html = '';
  html += `<div class="ctx-item" data-act="open">打开行情</div>`;
  html += `<div class="ctx-item" data-act="setcost">设置成本价/股数</div>`;
  html += `<div class="ctx-item" data-act="pin">${pinned ? '取消常驻' : '设为常驻'}</div>`;
  html += `<div class="ctx-item danger" data-act="del">删除</div>`;
  // 复制
  html += `<div class="ctx-sep"></div><div class="ctx-label">复制</div>`;
  html += `<div class="ctx-item" data-act="copy-code">复制代码</div>`;
  html += `<div class="ctx-item" data-act="copy-name">复制名称</div>`;
  // 加入分组（保留原分组）
  html += `<div class="ctx-sep"></div><div class="ctx-label">加入分组（保留原分组）</div>`;
  html += `<div class="ctx-item" data-act="new-group">＋ 新建分组并加入</div>`;
  if (otherGroups.length) {
    otherGroups.forEach(g => {
      const has = g.items.some(it => it.code === code);
      html += `<div class="ctx-item" data-act="group" data-gid="${g.id}">加入「${g.name}」${has ? ' ✓' : ''}</div>`;
    });
  } else {
    html += `<div class="ctx-item disabled">（无其他分组）</div>`;
  }
  // 移动到分组（仅留目标分组）
  html += `<div class="ctx-sep"></div><div class="ctx-label">移动到分组（仅留此分组）</div>`;
  if (otherGroups.length) {
    otherGroups.forEach(g => {
      html += `<div class="ctx-item" data-act="move" data-gid="${g.id}">移动到「${g.name}」</div>`;
    });
  } else {
    html += `<div class="ctx-item disabled">（无其他分组）</div>`;
  }
  ctxMenu.innerHTML = html;
  ctxMenu.hidden = false;
  const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  ctxMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  ctxMenu.dataset.code = code;
  requestAnimationFrame(() => ctxMenu.classList.add('open'));
}
function hideCtxMenu() {
  if (!ctxMenu || ctxMenu.hidden) return;
  ctxMenu.classList.remove('open');
  setTimeout(() => { if (!ctxMenu.classList.contains('open')) ctxMenu.hidden = true; }, 150);
}
listEl.addEventListener('contextmenu', e => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  showCtxMenu(row.dataset.code, e.clientX, e.clientY);
});
if (ctxMenu) {
  ctxMenu.addEventListener('click', e => {
    const el = e.target.closest('.ctx-item');
    if (!el || el.classList.contains('disabled')) return;
    const code = ctxMenu.dataset.code;
    const act = el.dataset.act;
    if (act === 'open') ipcRenderer.send('open-url', code);
    else if (act === 'setcost') { const it = watchlist.find(w => w.code === code); if (it) openPfAdd('edit', { code: it.code, name: it.name }); hideCtxMenu(); }
    else if (act === 'pin') { togglePinned(code); }
    else if (act === 'del') removeStock(code);
    else if (act === 'group') copyItemToGroup(code, el.dataset.gid);
    else if (act === 'move') moveItemToGroup(code, el.dataset.gid);
    else if (act === 'new-group') createGroupWith(code);
    else if (act === 'copy-code') { ipcRenderer.send('copy-text', code); showToast('已复制代码', code); }
    else if (act === 'copy-name') { const it = watchlist.find(w => w.code === code); const nm = it ? it.name : code; ipcRenderer.send('copy-text', nm); showToast('已复制名称', nm); }
    hideCtxMenu();
  });
}
document.addEventListener('click', e => { if (ctxMenu && !ctxMenu.hidden && !e.target.closest('#ctxMenu')) hideCtxMenu(); });
window.addEventListener('scroll', hideCtxMenu, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });

// 导出 / 导入 / 批量添加
function importWatchlist(parsed) {
  if (!parsed || !Array.isArray(parsed.groups)) { showToast('导入失败', '缺少分组数据'); return; }
  let added = 0, updated = 0;
  parsed.groups.forEach(g => {
    if (!g || !Array.isArray(g.items)) return;
    let cur = groups.find(x => x.id === g.id);
    if (!cur) { cur = { id: g.id || uid(), name: g.name || '导入分组', items: [] }; groups.push(cur); }
    g.items.forEach(it => {
      if (!it || !it.code) return;
      const ex = cur.items.find(x => x.code === it.code);
      if (ex) { ex.name = it.name || ex.name; ex.alertHigh = it.alertHigh || ''; ex.alertLow = it.alertLow || ''; ex.cost = it.cost || ''; ex.shares = it.shares || ''; updated++; }
      else { cur.items.push({ code: it.code, name: it.name || it.code, alertHigh: it.alertHigh || '', alertLow: it.alertLow || '', cost: it.cost || '', shares: it.shares || '' }); added++; }
    });
  });
  if (parsed.activeId && groups.some(g => g.id === parsed.activeId)) activeGroupId = parsed.activeId;
  if (parsed.settings && typeof parsed.settings === 'object') {
    Object.assign(settings, parsed.settings);
    const igRaw = parseFloat(settings.glass);
    settings.glass = (isNaN(igRaw) ? 0.48 : Math.max(0, Math.min(0.95, igRaw)));
  }
  saveGroups(); saveSettings();
  watchlist = groups.length ? activeGroup().items : [];
  renderGroups(); render(); updatePinned(); renderManage(); applySettings(); refresh(); fetchMinutes();
  showToast('导入完成', `新增 ${added} · 更新 ${updated}`);
}
function searchOne(kw) {
  return new Promise(resolve => {
    const handler = (e, list) => { ipcRenderer.removeListener('search-silent', handler); resolve(Array.isArray(list) ? list : []); };
    ipcRenderer.on('search-silent', handler);
    ipcRenderer.send('fetch-search-silent', kw);
    setTimeout(() => { ipcRenderer.removeListener('search-silent', handler); resolve([]); }, 4000);
  });
}
if (exportBtn) exportBtn.addEventListener('click', () => {
  ipcRenderer.send('export-watchlist', { version: 1, groups, activeId: activeGroupId, settings });
});
if (importBtn) importBtn.addEventListener('click', () => { ipcRenderer.send('import-watchlist'); });
// 导出持仓 CSV（含实时市值/今日盈亏/持仓盈亏），主进程弹保存框写文件
if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => {
  const rows = [];
  watchlist.forEach(it => {
    const h = holdingOf(it);
    const price = lastPrice[it.code];
    const prevClose = parseFloat(sparkPrevClose[it.code]);
    const mkt = marketOf(it.code);
    if (!h || price == null) {
      rows.push({ code: it.code, name: it.name || it.code, cur: mkt, shares: '', avgCost: '', price: '', mv: '', today: '', holding: '' });
      return;
    }
    const mv = price * h.shares;
    const hold = (price - h.avgCost) * h.shares;
    const today = (!isNaN(prevClose) && prevClose > 0) ? (price - prevClose) * h.shares : null;
    rows.push({
      code: it.code, name: it.name || it.code, cur: mkt,
      shares: String(Math.round(h.shares)), avgCost: h.avgCost.toFixed(2), price: price.toFixed(2),
      mv: fmtMoney(mv), today: today == null ? '' : fmtMoney(today), holding: fmtMoney(hold)
    });
  });
  if (!rows.length) { showToast('导出持仓', '列表为空'); return; }
  ipcRenderer.send('export-csv', rows);
});
ipcRenderer.on('export-csv-done', (e, res) => {
  if (res && res.ok) showToast('已导出', '持仓CSV已保存');
  else showToast('导出失败', (res && res.err) || '');
});
if (batchAddBtn) batchAddBtn.addEventListener('click', async () => {
  if (!batchInput) return;
  const raw = batchInput.value.trim();
  if (!raw) return;
  const parts = raw.split(/[\n,，\s]+/).map(s => s.trim()).filter(Boolean);
  const wanted = []; // 先收集，最后统一渲染+刷新一次，避免每只各发一次网络请求；按输入顺序去重
  for (const p of parts) {
    if (/^(sh|sz|hk|bj|us|bk)?\d{4,6}$/i.test(p) || /^bk/i.test(p)) {
      const code = normalizeCode(p);
      if (code && !wanted.some(t => t.code === code)) wanted.push({ code, name: code });
    } else {
      const list = await searchOne(p);
      if (list && list.length) {
        const it = list[0];
        const code = normalizeCode(it.code);
        if (code && !wanted.some(t => t.code === code)) wanted.push({ code, name: it.name || it.code });
      }
    }
  }
  if (wanted.length) {
    const wantedSet = new Set(wanted.map(w => w.code));
    // 已存在的项保留原数据（持仓/预警/成本），新项用默认字段；名称若提供了新的则更新
    const wantedItems = wanted.map(t => {
      const exist = watchlist.find(w => w.code === t.code);
      return exist ? Object.assign(exist, { name: t.name || exist.name }) : { code: t.code, name: t.name || t.code, alertHigh: '', alertLow: '', cost: '', shares: '', lots: [] };
    });
    // 先从当前列表移除（原地修改，保持对分组 items 的引用），再统一置顶
    for (let i = watchlist.length - 1; i >= 0; i--) if (wantedSet.has(watchlist[i].code)) watchlist.splice(i, 1);
    // 倒序 unshift，使输入顺序保持在最上方
    for (let k = wanted.length - 1; k >= 0; k--) watchlist.unshift(wantedItems[k]);
    saveWatchlist(); syncWatchlist(); render(); updatePinned(); renderManage(); refresh(); fetchMinutes();
  }
  batchInput.value = '';
  showToast('批量添加', `已添加/置顶 ${wanted.length} 只`);
});
ipcRenderer.on('export-done', (e, res) => {
  if (res && res.ok) showToast('已导出', res.path || '');
  else showToast('导出失败', (res && res.err) || '');
});
ipcRenderer.on('import-data', (e, res) => {
  if (!res || !res.ok) { showToast('导入失败', (res && res.err) || ''); return; }
  try { importWatchlist(JSON.parse(res.data)); } catch (err) { showToast('导入失败', '文件格式错误'); }
});

// 首次使用引导
const ONBOARD_STEPS = [
  { t: '在顶部输入框输入代码或名称即可添加自选，支持中文名（如「茅台」）和板块（如「半导体」）。' },
  { t: '点 ⚙ 设置可调透明度、主题、刷新间隔；在「自选管理」给每只票填成本价 + 股数，就能看持仓盈亏并底部汇总。' },
  { t: '标题栏「榜」看行情榜单，「?」看全部快捷键；点 × 最小化到托盘，Ctrl+Alt+S 随时呼出窗口。' },
];
let onboardIdx = 0;
function renderOnboard() {
  if (!onboardText || !onboardDots) return;
  onboardText.textContent = ONBOARD_STEPS[onboardIdx].t;
  onboardDots.innerHTML = ONBOARD_STEPS.map((_, i) => `<span class="ob-dot${i === onboardIdx ? ' on' : ''}"></span>`).join('');
  if (onboardNext) onboardNext.textContent = (onboardIdx === ONBOARD_STEPS.length - 1) ? '开始使用' : '下一步';
}
function startOnboard() {
  if (!onboard) return;
  if (sGet('onboarded') === '1') return;
  onboardIdx = 0; renderOnboard(); onboard.hidden = false;
}
function finishOnboard() { if (onboard) onboard.hidden = true; try { sSet('onboarded', '1'); } catch {} }
if (onboardNext) onboardNext.addEventListener('click', () => {
  if (onboardIdx < ONBOARD_STEPS.length - 1) { onboardIdx++; renderOnboard(); } else finishOnboard();
});
if (onboardSkip) onboardSkip.addEventListener('click', finishOnboard);

// ---------- 初始化 ----------
renderGroups(); // 渲染分组标签栏
renderChartTabs(); // 初始化周期标签栏
render();
updatePinned();
applySettings();
renderManage();
syncWatchlist();
startIndices(); // 大盘指数速览条
startMarketSummary(); // 全市场涨跌分布
startDataTimer(); // 热榜/天梯/板块/ETF 自动刷新（仅激活视图）
setupChartCross(); // 放大图十字光标
setupKlineNav(); // K线滚轮缩放 + 拖拽平移 + 双击复位
setupIndPanel(); // 指标面板（均线 / MACD）
document.body.classList.toggle('compact', settings.compact);
startTimer();
startMinuteTimer();
setupAutoHideScrollbars(); // 滚动条：不滚动时自动隐藏
updatePortfolio(); // 首屏汇总（有持仓且已取价后才会显示）
startOnboard();   // 首次使用引导（已引导过则自动跳过）

// =================== 桌面宠物：萌宠交易所（签到 / 装扮 / 商城） ===================
(function initPetFeature() {
  const PET_KEY = 'stock-widget-pet';
  const petCat = document.getElementById('petCat');
  if (!petCat) return;
  const petLayerEl = document.getElementById('petLayer');
  const petInner = document.getElementById('petInner');
  const petArt = document.getElementById('petArt');
  const petAura = document.getElementById('petAura');
  const petBubble = document.getElementById('petBubble');
  const petBadge = document.getElementById('petBadge');
  const petCenter = document.getElementById('petCenter');
  const petCenterClose = document.getElementById('petCenterClose');
  const pcPoints = document.getElementById('pcPoints');
  const pcTabs = document.getElementById('pcTabs');
  const pcSignArt = document.getElementById('pcSignArt');
  const pcDressArt = document.getElementById('pcDressArt');
  const pcDressTip = document.getElementById('pcDressTip');
    const pcPetGrid = document.getElementById('pcPetGrid');
    const pcCostumeGrid = document.getElementById('pcCostumeGrid');
    const pcPetShop = document.getElementById('pcPetShop');
    const pcCostumeShop = document.getElementById('pcCostumeShop');
    const pcAuraShop = document.getElementById('pcAuraShop');
    const pcActionShop = document.getElementById('pcActionShop');
    const pcAuraGrid = document.getElementById('pcAuraGrid');
    const pcActionGrid = document.getElementById('pcActionGrid');
  const psiLevel = document.getElementById('psiLevel');
  const psiPoints = document.getElementById('psiPoints');
  const psiStreak = document.getElementById('psiStreak');
  const psiExpBar = document.getElementById('psiExpBar');
  const psiExpTxt = document.getElementById('psiExpTxt');
  const petSignMsg = document.getElementById('petSignMsg');
  const petSignBtn = document.getElementById('petSignBtn');
  const pcPassSeason = document.getElementById('passSeason');
  const pcPassLevel = document.getElementById('passLevel');
  const pcPassTier = document.getElementById('passTier');
  const pcPassXpFill = document.getElementById('passXpFill');
  const pcPassXpTxt = document.getElementById('passXpTxt');
  const pcPassBuy = document.getElementById('passBuyBtn');
  const pcPassTasks = document.getElementById('passTasks');
  const pcPassTrack = document.getElementById('passTrack');
  const pcPassClaimAll = document.getElementById('passClaimAllBtn');

  const PET_W = 56;
  const PET_LEVELS = [0, 30, 80, 150, 250, 400, 600, 850, 1150, 1500, 2000, 2600, 3300, 4200, 5200];

  const petTodayStr = (d) => {
    const x = d || new Date();
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const petYesterdayStr = () => { const d = new Date(); d.setDate(d.getDate() - 1); return petTodayStr(d); };
  function defaultPass() {
    return { season: 1, level: 1, xp: 0, tier: 'free', premiumUntil: 0, claimed: { free: [], premium: [] }, tasks: {}, streakBonusGiven: '' };
  }
  const petDefault = () => ({
    lastSign: '', streak: 0, points: 0, totalDays: 0, born: petTodayStr(), // 新用户默认 0 积分，靠签到积累
    pos: null, equippedPet: 'cat', ownedPets: ['cat', 'shiba', 'bear', 'bunny', 'penguin'],
    roamOff: false, // 拖拽或手动关闭后，商城/积分宠物停止巡逻、固定在当前位置
    ownedCostumes: [], equippedCostume: null,
    ownedAuras: [], equippedAura: null,
    auraExpiry: {}, // { auraId: expiresAt_ms }
    ownedActions: {}, equippedAction: {},
    ownedActionsAll: [],
    pass: defaultPass(),
  });
  const loadPet = () => {
    try {
      const raw = localStorage.getItem(PET_KEY);
      if (!raw) return petDefault();
      const s = Object.assign(petDefault(), JSON.parse(raw));
      // 迁移：旧版 ownedAuras 是字符串数组且没有 auraExpiry，视为已拥有但无期限；
      // 新版要求所有光效都有有效期，因此给旧光效统一补一个 7 天倒计时（从当前时间开始）
      if (!s.auraExpiry) s.auraExpiry = {};
      const now = Date.now();
      (s.ownedAuras || []).forEach(id => {
        if (!s.auraExpiry[id]) s.auraExpiry[id] = now + 7 * 24 * 3600000;
      });
      return s;
    }
    catch (e) { return petDefault(); }
  };
  const savePet = (p) => {
    try { localStorage.setItem(PET_KEY, JSON.stringify(p)); } catch (e) {}
  };
  const petLevelOf = (pts) => { let lv = 1; for (let i = 0; i < PET_LEVELS.length; i++) { if (pts >= PET_LEVELS[i]) lv = i + 1; else break; } return lv; };
  const petLevelInfo = (pts) => {
    const lv = petLevelOf(pts);
    const cur = PET_LEVELS[lv - 1];
    const next = (PET_LEVELS[lv] !== undefined) ? PET_LEVELS[lv] : null;
    const span = (next !== null) ? (next - cur) : 1;
    const got = (next !== null) ? (pts - cur) : span;
    return { lv, cur, next, ratio: (next !== null) ? Math.min(1, got / span) : 1, maxed: next === null };
  };
  const petSignReward = (streak) => {
    // 固定每日签到 100 积分（连签加成保留参数，未来要做阶梯奖励再启用）
    return 100;
  };

  let petState = loadPet();
  window.petState = petState;

  // ---- 账号位（萌宠面板标题栏）：纯本地软件无账号，展示「QQ交流群」入口 ----
  function renderGroupChip() {
    const el = document.getElementById('pcAccount');
    if (!el) return;
    el.innerHTML = '<button class="pc-ac-btn" id="pcQqGroup" title="加入官方QQ交流群">QQ交流群</button>';
    const lo = document.getElementById('pcQqGroup');
    if (lo) lo.addEventListener('click', () => GroupPanel.open());
  }

  function renderAllPet() {
    renderPetArt(); renderBadge(); renderPoints(); renderSignPane(); renderShopPane(); renderDressPane(); renderPassPane();
  }

  // ---- 官方交流群（引流入口：登录窗 / 设置页 / 托盘菜单共用一个弹窗）----
  const GroupPanel = (function () {
    const { clipboard, shell } = require('electron');
    let cfg = null;
    const $ = (id) => document.getElementById(id);
    async function loadCfg() {
      if (cfg) return cfg;
      try { cfg = (await ipcRenderer.invoke('group-config')) || {}; }
      catch (e) { cfg = { groupName: '官方交流群', hasQrcode: false, qrcodeUrl: '', groupNumber: '', groupNotice: '', joinUrl: '' }; }
      return cfg;
    }
    async function renderMini() {
      const c = await loadCfg();
      const nothing = !c.hasQrcode && !c.groupNumber && !c.joinUrl;
      // 设置页整个板块（含标题）：未配置群时整体隐藏
      const section = $('groupSection');
      if (section) section.hidden = nothing;
      // 设置页迷你卡片
      const card = $('groupMiniCard');
      if (card) {
        card.hidden = nothing;
        if (!nothing) {
          $('groupMiniName').textContent = c.groupName || '官方交流群';
          const img = $('groupQrcodeMini');
          if (c.hasQrcode) { img.src = c.qrcodeUrl + '?t=' + Date.now(); img.style.display = ''; }
          else img.style.display = 'none';
        }
      }
      // 欢迎页（首次启动引流位）：二维码 + 群号
      const wq = $('welcomeQr'), wMiss = $('welcomeQrMissing');
      if (wq && wMiss) {
        if (c.hasQrcode) { wq.src = c.qrcodeUrl + '?t=' + Date.now(); wq.hidden = false; wMiss.hidden = true; }
        else { wq.hidden = true; wMiss.hidden = false; }
      }
      const wRow = $('welcomeGroupRow');
      if (wRow) {
        if (c.groupNumber) { $('welcomeGroupName').textContent = (c.groupName || '官方交流群') + ' ' + c.groupNumber; wRow.hidden = false; }
        else wRow.hidden = true;
      }
    }
    // 首次启动展示欢迎页；未配置群信息时不弹也不记（等配置好后下次启动再弹）
    async function maybeShowWelcome() {
      try { if (localStorage.getItem('welcome-seen')) return; } catch (e) { return; }
      const c = await loadCfg();
      if (!c.hasQrcode && !c.groupNumber && !c.joinUrl) return;
      const m = $('welcomeMask');
      if (!m) return;
      m.hidden = false;
      renderMini();
    }
    function closeWelcome() {
      const m = $('welcomeMask');
      if (m) m.hidden = true;
      try { localStorage.setItem('welcome-seen', '1'); } catch (e) {}
    }
    async function open() {
      const c = await loadCfg();
      const modal = $('groupModal');
      if (!modal) return;
      $('groupTitle').textContent = c.groupName || '官方交流群';
      const img = $('groupQrcode'), miss = $('groupQrMissing');
      if (c.hasQrcode) { img.src = c.qrcodeUrl + '?t=' + Date.now(); img.hidden = false; miss.hidden = true; }
      else { img.hidden = true; miss.hidden = false; }
      const notice = $('groupNotice');
      if (c.groupNotice) { notice.textContent = c.groupNotice; notice.hidden = false; } else notice.hidden = true;
      const row = $('groupNumberRow');
      if (c.groupNumber) { $('groupNumber').textContent = '群号：' + c.groupNumber; row.hidden = false; } else row.hidden = true;
      const urlBtn = $('groupUrlBtn');
      if (c.joinUrl) urlBtn.hidden = false; else urlBtn.hidden = true;
      modal.hidden = false;
      modal.classList.add('show'); // .chart-modal 默认 opacity:0，必须加 .show 才真正显示
      renderMini();
    }
    function close() {
      const m = $('groupModal');
      if (m) { m.hidden = true; m.classList.remove('show'); }
    }
    function bind() {
      const gOpen = $('groupMiniOpen'); if (gOpen) gOpen.addEventListener('click', (e) => { e.stopPropagation(); open(); });
      const gCard = $('groupMiniCard'); if (gCard) gCard.addEventListener('click', open);
      const gClose = $('groupClose'); if (gClose) gClose.addEventListener('click', close);
      const gModal = $('groupModal'); if (gModal) gModal.addEventListener('click', (e) => { if (e.target === gModal) close(); });
      const gCopy = $('groupCopyBtn');
      if (gCopy) gCopy.addEventListener('click', async () => {
        const c = await loadCfg();
        if (!c.groupNumber) return;
        try { clipboard.writeText(c.groupNumber); showToast('已复制', '群号 ' + c.groupNumber + ' 已复制，去QQ「加好友/群」粘贴即可'); }
        catch (e) { showToast('复制失败', '请手动记下群号 ' + c.groupNumber); }
      });
      const wStart = $('welcomeStart'); if (wStart) wStart.addEventListener('click', closeWelcome);
      const wMask = $('welcomeMask');
      if (wMask) wMask.addEventListener('click', (e) => { if (e.target === wMask) closeWelcome(); });
      const wCopy = $('welcomeCopyBtn');
      if (wCopy) wCopy.addEventListener('click', async () => {
        const c = await loadCfg();
        if (!c.groupNumber) return;
        try { clipboard.writeText(c.groupNumber); showToast('已复制', '群号 ' + c.groupNumber + ' 已复制，去QQ「加好友/群」粘贴即可'); }
        catch (e) { showToast('复制失败', '请手动记下群号 ' + c.groupNumber); }
      });
      const gUrl = $('groupUrlBtn');
      if (gUrl) gUrl.addEventListener('click', async () => {
        const c = await loadCfg();
        if (c.joinUrl) { try { shell.openExternal(c.joinUrl); } catch (e) {} }
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('groupModal') && !$('groupModal').hidden) close(); });
      // 托盘「加入交流群」→ 主进程通知打开
      ipcRenderer.on('group-open-panel', () => open());
      renderMini();
      maybeShowWelcome();
    }
    return { open, close, bind };
  })();
  GroupPanel.bind();

  // 主进程发现新版本时，弹出可点击提示
  window.__showUpdateToast = (version, url) => {
    showToast('发现新版本 v' + version, '点击此处前往下载');
    const t = document.querySelector('.toast');
    if (t) t.style.cursor = 'pointer', t.onclick = () => { try { require('electron').shell.openExternal(url); } catch (e) {} };
  };
  // 确保默认宠物始终拥有
  const DEFAULT_IDS = ['cat', 'shiba', 'bear', 'bunny', 'penguin'];
  DEFAULT_IDS.forEach(id => { if (!petState.ownedPets.includes(id)) petState.ownedPets.push(id); });
  if (!petState.equippedPet || !petState.ownedPets.includes(petState.equippedPet)) petState.equippedPet = 'cat';

  // 迁移：动作所有权/装备态改为「按猫分别记录」（旧版是全局数组/字符串）
  if (Array.isArray(petState.ownedActions)) petState.ownedActions = {};
  if (!petState.ownedActions || typeof petState.ownedActions !== 'object') petState.ownedActions = {};
  if (typeof petState.equippedAction === 'string' || petState.equippedAction === null || Array.isArray(petState.equippedAction)) petState.equippedAction = {};
  if (!petState.equippedAction || typeof petState.equippedAction !== 'object') petState.equippedAction = {};

  // 光效有效期工具：所有光效购买后限时生效，过期自动清理并取消装备
  const AURA_MS_PER_HOUR = 3600000;
  const auraExpiryOf = (id) => (petState.auraExpiry && petState.auraExpiry[id]) || 0;
  const isAuraOwned = (id) => {
    if (!petState.ownedAuras.includes(id)) return false;
    return auraExpiryOf(id) > Date.now();
  };
  const auraTimeLeft = (id) => Math.max(0, auraExpiryOf(id) - Date.now());
  const formatAuraTime = (ms) => {
    if (ms <= 0) return '已过期';
    const h = Math.floor(ms / AURA_MS_PER_HOUR);
    const m = Math.floor((ms % AURA_MS_PER_HOUR) / 60000);
    if (h >= 24) return Math.floor(h / 24) + '天' + (h % 24) + '时';
    return h + '时' + m + '分';
  };
  const cleanExpiredAuras = () => {
    const now = Date.now();
    let changed = false;
    petState.ownedAuras = petState.ownedAuras.filter(id => {
      const ok = (petState.auraExpiry[id] || 0) > now;
      if (!ok) { delete petState.auraExpiry[id]; changed = true; }
      return ok;
    });
    if (petState.equippedAura && !isAuraOwned(petState.equippedAura)) {
      petState.equippedAura = null; changed = true;
    }
    if (changed) savePet(petState);
  };

  const currentPet = () => (window.petById ? window.petById(petState.equippedPet) : { id: 'cat', effect: null });
  const isRoaming = () => !!currentPet().effect && !petState.roamOff;   // 商城（积分）宠物会巡逻；roamOff 钉住后停止

  // 萌宠交易所头部的「自动走动」开关：仅对带光效（会巡逻）的宠物显示
  const petRoamToggle = document.getElementById('petRoamToggle');
  function syncRoamToggle() {
    if (!petRoamToggle) return;
    const hasEffect = !!(currentPet() && currentPet().effect);
    petRoamToggle.hidden = !hasEffect;              // 默认 5 只猫无需此开关
    if (!hasEffect) return;
    const roaming = isRoaming();
    petRoamToggle.classList.toggle('on', roaming);
    petRoamToggle.textContent = roaming ? '🚶' : '⏸';
    petRoamToggle.title = roaming ? '自动走动：开（点此停下并固定位置）' : '自动走动：关（点此让猫咪巡逻）';
  }
  if (petRoamToggle) {
    petRoamToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!petState.roamOff) {
        // 当前在巡逻 → 钉住：记录当前位置并停止巡逻
        const lr = petLayerEl.getBoundingClientRect();
        petState.pos = { x: Math.round(petCat.getBoundingClientRect().left - lr.left), y: Math.round(petCat.getBoundingClientRect().top - lr.top) };
        petState.roamOff = true;
        petCat.classList.remove('roaming');
        applyIdlePos();
      } else {
        // 当前已钉住 → 恢复巡逻
        petState.roamOff = false;
        petCat.classList.add('roaming');
        resetRoam();
      }
      savePet(petState);
      syncRoamToggle();
    });
  }
  // 某只猫当前生效的动作 id：未显式设置时回退到该猫的默认动作；'' 表示静止（无动作）
  const defaultActionOf = (petId) => {
    const p = window.petById ? window.petById(petId) : null;
    return (p && p.defaultAction) ? p.defaultAction : 'act-jump';
  };
  const equippedActionOf = (petId) => {
    const v = petState.equippedAction[petId];
    return (v === undefined) ? defaultActionOf(petId) : v; // '' 表示静止
  };

  // ---------- 渲染 ----------
  const showBubble = (text, ms) => {
    if (!petBubble) return;
    petBubble.textContent = text; petBubble.classList.add('show');
    clearTimeout(showBubble._t);
    showBubble._t = setTimeout(() => petBubble.classList.remove('show'), ms || 2600);
  };
  const petBounce = () => {
    petCat.classList.remove('bounce'); void petCat.offsetWidth; petCat.classList.add('bounce');
    setTimeout(() => petCat.classList.remove('bounce'), 600);
  };
  const clearActClasses = () => {
    [...petInner.classList].forEach(c => { if (c.indexOf('act-') === 0) petInner.classList.remove(c); });
    petInner.classList.remove('acting');
  };
  const renderPetArt = () => {
    if (!petArt) return;
    cleanExpiredAuras();
    const eff = currentPet().effect;
    let auraId = (petState.equippedAura && isAuraOwned(petState.equippedAura)) ? petState.equippedAura : null;
    if (!auraId && eff && window.AURA_ART && window.AURA_ART[eff]) auraId = eff; // 宠物签名光环自动环绕展示
    const curPetColor = (currentPet() && currentPet().color) || null;
    petAura.innerHTML = auraId ? window.buildAuraSVG(auraId, false, curPetColor) : '';
    petCat.classList.toggle('has-aura', !!auraId);
    petCat.classList.toggle('aura-on', !!auraId);
    const actId = equippedActionOf(petState.equippedPet);
    const act = actId ? window.actionById(actId) : null;
    // 真实猫咪（assets/pets/{id}.png 照片）+ 可选服装 SVG 叠加，动作走 CSS 关键帧
    petArt.innerHTML = window.buildPetArt ? window.buildPetArt(petState.equippedPet, petState.equippedCostume) : '';
    clearActClasses();
    if (act) petInner.classList.add('acting', 'act-' + act.anim);
    petCat.classList.toggle('roaming', isRoaming());
    if (!isRoaming()) {
      petInner.style.transform = ''; // 清除巡逻残留的镜像翻转（空闲/动作动画也会覆盖，双保险）
      if (typeof applyIdlePos === 'function') applyIdlePos(); // 切换到非巡逻宠物时归位（修复残留巡逻坐标）
    }
    syncRoamToggle();
    petCat.title = (window.petById ? window.petById(petState.equippedPet).name : '宠物') + ' · 点我打开萌宠交易所';
  };
  const renderBadge = () => { if (petBadge) petBadge.textContent = 'Lv.' + petLevelInfo(petState.points).lv; };
  const renderPoints = () => { if (pcPoints) pcPoints.textContent = petState.points; };

  const renderSignPane = () => {
    if (!psiLevel) return;
    const info = petLevelInfo(petState.points);
    const t = petTodayStr();
    const signedToday = (petState.lastSign === t);
    psiLevel.textContent = 'Lv.' + info.lv;
    psiPoints.textContent = petState.points;
    psiStreak.textContent = petState.streak + ' 天';
    if (info.maxed) { psiExpBar.style.width = '100%'; psiExpTxt.textContent = '已达最高等级 🎉'; }
    else { psiExpBar.style.width = Math.round(info.ratio * 100) + '%'; psiExpTxt.textContent = `距下一级还差 ${info.next - petState.points} 分`; }
    if (signedToday) {
      petSignBtn.disabled = true; petSignBtn.textContent = '今日已签到 ✓';
      petSignMsg.textContent = '明天再来，连签奖励更多哦～';
    } else {
      const reward = petSignReward(petState.streak >= 1 ? petState.streak + 1 : 1);
      petSignBtn.disabled = false; petSignBtn.textContent = `签到领 ${reward} 积分`;
      const broken = petState.lastSign && petState.lastSign !== petYesterdayStr();
      petSignMsg.textContent = broken ? '昨天没签到，连签中断啦～今天签一下重新开始！' : '点下方按钮签到，领取积分养宠物升级～';
    }
    if (pcSignArt) pcSignArt.innerHTML = window.buildPetArt(petState.equippedPet, petState.equippedCostume);
  };

  // ---------- 装扮 / 商城 通用卡片组件 ----------
  const miniCard = (svg, label, opts) => {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'pc-card' + (opts.active ? ' active' : '') + (opts.locked ? ' locked' : '');
    el.innerHTML = `<div class="pc-card-art">${svg}</div>` +
      `<div class="pc-card-name">${label}</div>` +
      (opts.badge ? `<div class="pc-card-badge">${opts.badge}</div>` : '') +
      (opts.tag ? `<div class="pc-card-tag">${opts.tag}</div>` : '');
    return el;
  };

  // 商城商品卡片（双列网格，信息更完整）
  const shopCard = (svg, name, desc, price, opts) => {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'pc-shop-card' + (opts.active ? ' active' : '') + (opts.owned ? ' owned' : '') + (opts.locked ? ' locked' : '');
    let btn;
    if (!opts.owned) {
      const can = petState.points >= price;
      btn = `<button class="mini-btn no-drag primary pc-buy" data-price="${price}" ${can ? '' : 'disabled'}>💎 ${price}</button>`;
    } else if (opts.active) {
      btn = opts.toggle
        ? `<button class="mini-btn no-drag pc-off">已装备</button>`
        : `<span class="pc-owned on">使用中</span>`;
    } else {
      btn = `<button class="mini-btn no-drag pc-use">${opts.locked ? '切换并装备' : '装备'}</button>`;
    }
    const metaTag = opts.effect ? `<span class="pc-shop-fx">${opts.effect}</span>` : (opts.tag ? `<span class="pc-shop-tag">${opts.tag}</span>` : '');
    const lockHint = opts.locked ? `<div class="pc-shop-lock">${opts.lockText || '未解锁'}</div>` : '';
    el.innerHTML = `<div class="pc-shop-art">${svg}</div>` +
      `<div class="pc-shop-meta"><div class="pc-shop-name">${name}${metaTag}</div><div class="pc-shop-desc">${desc}</div>${lockHint}</div>` +
      `<div class="pc-shop-footer">${btn}</div>`;
    return el;
  };

  const renderDressPane = () => {
    if (!pcPetGrid) return;
    try {
      // 顶部大预览：当前猫 + 服饰 + 光效 + 动作名
      if (pcDressArt) {
        const cur = currentPet();
        const actId = equippedActionOf(petState.equippedPet);
        const act = actId ? window.actionById(actId) : null;
        const actValid = !!act;
        let previewHtml = window.buildPetArt(petState.equippedPet, petState.equippedCostume);
        const auraId = petState.equippedAura;
        if (auraId && isAuraOwned(auraId)) {
          previewHtml = '<div class="pc-preview-aura">' + window.buildAuraSVG(auraId, false, cur.color) + '</div>' + previewHtml;
        }
        let label = cur.name;
        if (petState.equippedCostume && window.costumeById) {
          const cname = window.costumeById(petState.equippedCostume);
          if (cname) label += ' · ' + cname.name;
        }
        if (actValid) label += ' · ' + act.name;
        pcDressArt.innerHTML = previewHtml + '<div class="pc-preview-label">' + label + '</div>';
      }
      if (pcDressTip) pcDressTip.textContent = '点下方卡片切换宠物 / 穿戴装扮 / 施展动作';

      // 我的宠物
      pcPetGrid.innerHTML = '';
      window.PETS.forEach(p => {
        if (petState.ownedPets.indexOf(p.id) < 0) return;
        const active = p.id === petState.equippedPet;
        const card = miniCard(window.buildPetArt(p.id, null), p.name, { active, tag: active ? '当前' : '' });
        card.addEventListener('click', () => {
          petState.equippedPet = p.id; savePet(petState); completeTask('switch');
          renderPetArt(); renderBadge(); renderDressPane(); resetRoam();
          if (pcDressTip) pcDressTip.textContent = '已切换为「' + p.name + '」';
        });
        pcPetGrid.appendChild(card);
      });

      // 我的服饰
      pcCostumeGrid.innerHTML = petState.ownedCostumes.length ? '' : '<div class="pc-empty">还没有服装，去「商城」兑换吧～</div>';
      if (petState.ownedCostumes.length) {
        window.COSTUMES.forEach(c => {
          if (petState.ownedCostumes.indexOf(c.id) < 0) return;
          const on = petState.equippedCostume === c.id;
          const catLabel = c.cat === 'armor' ? '盔甲' : c.cat === 'head' ? '头饰' : c.cat === 'cloak' ? '披风' : '衣服';
          const card = miniCard(window.buildPetArt(petState.equippedPet, c.id), c.name, { active: on, tag: catLabel });
          card.addEventListener('click', () => {
            petState.equippedCostume = on ? null : c.id; savePet(petState); completeTask('dress');
            renderPetArt(); renderDressPane();
            if (pcDressTip) pcDressTip.textContent = on ? '已脱下「' + c.name + '」' : '已穿上「' + c.name + '」';
          });
          pcCostumeGrid.appendChild(card);
        });
      }

      // 我的光效（自动过滤已过期）
      const activeAuraIds = petState.ownedAuras.filter(id => isAuraOwned(id));
      pcAuraGrid.innerHTML = activeAuraIds.length ? '' : '<div class="pc-empty">还没有光效，去「商城」兑换吧～</div>';
      if (activeAuraIds.length) {
        window.AURAS.forEach(a => {
          if (!isAuraOwned(a.id)) return;
          const on = petState.equippedAura === a.id;
          const art = '<div class="pc-aura-mini">' + window.buildAuraSVG(a.id, true) + '</div>';
          const card = miniCard(art, a.name, { active: on, tag: on ? '开启' : formatAuraTime(auraTimeLeft(a.id)) });
          card.addEventListener('click', () => {
            petState.equippedAura = on ? null : a.id; savePet(petState); completeTask('dress');
            renderPetArt(); renderDressPane();
            if (pcDressTip) pcDressTip.textContent = on ? '已关闭「' + a.name + '」光效' : '已开启「' + a.name + '」光效';
          });
          pcAuraGrid.appendChild(card);
        });
      }

      // 我的动作：当前猫的默认动作 + 已购买的额外动作 + 静止
      const curPetId = petState.equippedPet;
      const defActId = defaultActionOf(curPetId);
      const ownedExtras = (petState.ownedActions[curPetId] || []).concat(petState.ownedActionsAll || []);
      const availIds = Array.from(new Set([defActId].concat(ownedExtras)));
      pcActionGrid.innerHTML = '';
      availIds.forEach(id => {
        const ac = window.actionById(id);
        if (!ac) return;
        const isDef = id === defActId;
        const eq = petState.equippedAction[curPetId];
        const on = (eq === undefined) ? isDef : (eq === id);
        const art = '<div class="pc-card-act pet-inner acting act-' + ac.anim + '">' + window.buildPetArt(curPetId, petState.equippedCostume) + '</div>';
        const card = miniCard(art, ac.name, { active: on, badge: isDef ? '默认' : '已购' });
        card.addEventListener('click', () => {
          const e = petState.equippedAction[curPetId];
          if ((e === undefined && isDef) || e === id) {
            petState.equippedAction[curPetId] = '';        // 取消 → 静止
            if (pcDressTip) pcDressTip.textContent = '已静止，不施展动作';
          } else {
            petState.equippedAction[curPetId] = id;        // 装备该动作
            if (pcDressTip) pcDressTip.textContent = '已施展「' + ac.name + '」';
          }
          savePet(petState); renderPetArt(); renderDressPane(); completeTask('dress');
        });
        pcActionGrid.appendChild(card);
      });
      // 静止（无动作）选项
      const idleOn = petState.equippedAction[curPetId] === '';
      const idleArt = '<div class="pc-card-act pet-inner">' + window.buildPetArt(curPetId, petState.equippedCostume) + '</div>';
      const idleCard = miniCard(idleArt, '静止', { active: idleOn, badge: '无动作' });
      idleCard.addEventListener('click', () => {
        petState.equippedAction[curPetId] = ''; savePet(petState); renderPetArt(); renderDressPane();
        if (pcDressTip) pcDressTip.textContent = '已静止，不施展动作';
      });
      pcActionGrid.appendChild(idleCard);
    } catch (e) { console.error('[pet] renderDressPane error:', e); }
  };

  const renderShopPane = () => {
    if (!pcPetShop) return;
    try {
      // 宠物
      pcPetShop.innerHTML = '';
      window.PETS.forEach(p => {
        const owned = petState.ownedPets.indexOf(p.id) >= 0;
        const active = p.id === petState.equippedPet;
        let petArtHtml = window.buildPetArt(p.id, null);
        if (p.effect && window.AURA_ART && window.AURA_ART[p.effect]) {
          petArtHtml = '<div class="pc-shop-aura">' + window.buildAuraSVG(p.effect, true, p.color) + '</div>' + petArtHtml;
        }
        const card = shopCard(petArtHtml, p.name, p.desc, p.price, { owned, active, effect: p.effect ? '专属光环' : '', tag: p.tag === 'default' ? '免费' : '' });
        const btn = card.querySelector('button');
        if (btn) btn.addEventListener('click', () => {
          if (owned) { petState.equippedPet = p.id; savePet(petState); renderPetArt(); renderBadge(); renderShopPane(); resetRoam(); }
          else buyItem('pet', p);
        });
        pcPetShop.appendChild(card);
      });

      // 服饰
      pcCostumeShop.innerHTML = '';
      window.COSTUMES.forEach(c => {
        const owned = petState.ownedCostumes.indexOf(c.id) >= 0;
        const active = petState.equippedCostume === c.id;
        const catLabel = c.cat === 'armor' ? '盔甲' : c.cat === 'head' ? '头饰' : c.cat === 'cloak' ? '披风' : '衣服';
        const card = shopCard(window.buildPetArt(petState.equippedPet, c.id), c.name, c.desc, c.price, { owned, active, toggle: true, tag: catLabel });
        const btn = card.querySelector('button');
        if (btn) btn.addEventListener('click', () => {
          if (owned) { petState.equippedCostume = active ? null : c.id; savePet(petState); renderPetArt(); renderShopPane(); completeTask('dress'); }
          else buyItem('costume', c);
        });
        pcCostumeShop.appendChild(card);
      });

      // 光效（限时有效，过期后需重新购买）
      pcAuraShop.innerHTML = '';
      window.AURAS.forEach(a => {
        const owned = isAuraOwned(a.id);
        const expired = !owned && petState.ownedAuras.indexOf(a.id) >= 0;
        const active = owned && petState.equippedAura === a.id;
        const art = '<div class="pc-aura-mini">' + window.buildAuraSVG(a.id, true) + '</div>';
        const timeTag = owned ? formatAuraTime(auraTimeLeft(a.id)) : (a.duration >= 24 ? Math.floor(a.duration / 24) + '天' : a.duration + '时');
        const desc = expired ? ('已过期 · 点击重新购买 · ' + a.desc) : a.desc;
        const card = shopCard(art, a.name, desc, a.price, {
          owned, active, toggle: true,
          tag: timeTag
        });
        const btn = card.querySelector('button');
        if (btn) btn.addEventListener('click', () => {
          if (owned) { petState.equippedAura = active ? null : a.id; savePet(petState); renderPetArt(); renderShopPane(); completeTask('dress'); }
          else buyItem('aura', a);
        });
        pcAuraShop.appendChild(card);
      });

      // 动作：通用，预览用当前猫；默认动作免费且始终可用，其余付费额外购买（按当前猫记录）
      pcActionShop.innerHTML = '';
      const shopPet = petState.equippedPet;
      const defId = defaultActionOf(shopPet);
      window.ACTIONS.forEach(ac => {
        const isDef = ac.id === defId;
        const ownedExtra = (petState.ownedActions[shopPet] || []).indexOf(ac.id) >= 0 || (petState.ownedActionsAll || []).indexOf(ac.id) >= 0;
        const owned = isDef || ownedExtra;
        const eq = petState.equippedAction[shopPet];
        const active = (eq === undefined) ? isDef : (eq === ac.id);
        const art = '<div class="pc-shop-act pet-inner acting act-' + ac.anim + '">' + window.buildPetArt(shopPet, petState.equippedCostume) + '</div>';
        const card = shopCard(art, ac.name, ac.desc, isDef ? 0 : ac.price, {
          owned, active, toggle: true,
          tag: isDef ? '默认动作' : '动作',
        });
        const btn = card.querySelector('button');
        if (btn) btn.addEventListener('click', () => {
          if (isDef) {
            // 默认动作：直接装备 / 取消（取消=静止）
            if (active) { petState.equippedAction[shopPet] = ''; }
            else { delete petState.equippedAction[shopPet]; }
            savePet(petState); renderPetArt(); renderShopPane(); completeTask('dress');
            if (pcDressTip) pcDressTip.textContent = active ? '已静止' : ('已施展默认动作「' + ac.name + '」');
          } else if (ownedExtra) {
            // 已购买：装备 / 取消
            if (active) { petState.equippedAction[shopPet] = ''; }
            else { petState.equippedAction[shopPet] = ac.id; }
            savePet(petState); renderPetArt(); renderShopPane(); completeTask('dress');
            if (pcDressTip) pcDressTip.textContent = active ? '已静止' : ('已施展「' + ac.name + '」');
          } else {
            buyItem('action', ac);
          }
        });
        pcActionShop.appendChild(card);
      });
    } catch (e) { console.error('[pet] renderShopPane error:', e); }
  };

  const buyItem = (kind, item) => {
    if (petState.points < item.price) { showToast('积分不足', `还差 ${item.price - petState.points} 积分`); return; }
    petState.points -= item.price;
    completeTask('dress');
    if (kind === 'pet') {
      if (petState.ownedPets.indexOf(item.id) < 0) petState.ownedPets.push(item.id);
      petState.equippedPet = item.id;
      completeTask('switch');
      showToast('兑换成功', `获得宠物「${item.name}」并装备`);
    } else if (kind === 'costume') {
      if (petState.ownedCostumes.indexOf(item.id) < 0) petState.ownedCostumes.push(item.id);
      petState.equippedCostume = item.id;
      showToast('兑换成功', `获得服装「${item.name}」并穿上`);
    } else if (kind === 'aura') {
      const now = Date.now();
      const addMs = (item.duration || 24) * AURA_MS_PER_HOUR;
      if (petState.ownedAuras.indexOf(item.id) < 0) petState.ownedAuras.push(item.id);
      // 已拥有未过期则续期，否则从当前时间开始计时
      petState.auraExpiry[item.id] = Math.max(now, petState.auraExpiry[item.id] || 0) + addMs;
      petState.equippedAura = item.id;
      const days = (item.duration || 24) >= 24 ? Math.floor((item.duration || 24) / 24) + '天' : (item.duration || 24) + '小时';
      showToast('兑换成功', `获得光效「${item.name}」· 有效期 ${days}`);
    } else if (kind === 'action') {
      const pid = petState.equippedPet;
      if (!Array.isArray(petState.ownedActions[pid])) petState.ownedActions[pid] = [];
      if (petState.ownedActions[pid].indexOf(item.id) < 0) petState.ownedActions[pid].push(item.id);
      petState.equippedAction[pid] = item.id;
      showToast('兑换成功', `获得动作「${item.name}」并装备到「${currentPet().name}」`);
    }
    savePet(petState); renderPetArt(); renderBadge(); renderPoints(); renderSignPane(); renderShopPane(); renderDressPane(); resetRoam();
    petBounce();
  };

  const updateAll = () => {
    renderPetArt(); renderBadge(); renderPoints();
    if (petCenter && !petCenter.hidden) {
      const tab = pcTabs.querySelector('button.active');
      const name = tab ? tab.dataset.tab : 'sign';
      if (name === 'sign') renderSignPane();
      else if (name === 'dress') renderDressPane();
      else if (name === 'shop') renderShopPane();
    }
  };

  // ---------- 通行证引擎 ----------
  const PASS_TASKS = [
    { id: 'open', name: '打开桌面宠物', xp: 80 },
    { id: 'market', name: '浏览一次行情', xp: 80 },
    { id: 'center', name: '逛萌宠交易所', xp: 80 },
    { id: 'dress', name: '装扮一次猫咪', xp: 80 },
    { id: 'switch', name: '切换一只宠物', xp: 80 },
  ];
  const passReq = (lv) => 50 + lv * 6;   // 升到下一关所需 XP
  const passT = () => petState.pass;
  function completeTask(id) {
    const p = passT(); if (!p) return;
    const t = petTodayStr();
    if (p.tasks[id] === t) return;       // 每日仅一次
    p.tasks[id] = t;
    const tk = PASS_TASKS.find(x => x.id === id);
    if (tk) passAddXp(tk.xp);
    savePet(petState);
    if (petCenter && !petCenter.hidden) renderPassPane();
  }
  // 暴露为全局：switchView（顶层作用域）切到「涨跌分布」时需调用 completeTask('market') 完成「浏览一次行情」任务，
  // 但 completeTask 定义在本模块内部作用域，顶层不可见会抛 ReferenceError 导致涨跌分布视图打不开。挂到 window 后即可跨作用域访问。
  window.completeTask = completeTask;
  function passAddXp(n) {
    const p = passT(); if (!p) return;
    p.xp += n;
    while (p.level < 100 && p.xp >= passReq(p.level)) { p.xp -= passReq(p.level); p.level++; }
    if (p.level >= 100) p.xp = 0;
    savePet(petState);
    if (petCenter && !petCenter.hidden) renderPassPane();
  }
  function passPremiumActive() { const p = passT(); return !!p && p.tier === 'premium' && p.premiumUntil > Date.now(); }
  function grantPremium(days) {
    const p = passT(); if (!p) return;
    p.tier = 'premium';
    const base = passPremiumActive() ? p.premiumUntil : Date.now();
    p.premiumUntil = base + days * 86400000;
    savePet(petState);
    if (petCenter && !petCenter.hidden) renderPassPane();
  }
  function passRewardMeta(r) {
    if (r.type === 'coins') return { name: r.qty + ' 积分', art: '💎', kind: 'coins' };
    if (r.type === 'pet') { const x = window.petById(r.id); return { name: x ? x.name : r.id, art: window.buildPetArt(r.id, null), kind: 'pet' }; }
    if (r.type === 'aura') { const x = window.auraById(r.id); return { name: x ? x.name : r.id, art: '<div class="pc-aura-mini">' + window.buildAuraSVG(r.id, true) + '</div>', kind: 'aura' }; }
    if (r.type === 'costume') { const x = window.costumeById(r.id); return { name: x ? x.name : r.id, art: window.buildPetArt(petState.equippedPet, r.id), kind: 'costume' }; }
    if (r.type === 'action') { const x = window.actionById(r.id); return { name: x ? x.name : r.id, art: '<div class="pc-card-act pet-inner acting act-' + (x ? x.anim : 'jump') + '">' + window.buildPetArt(petState.equippedPet, petState.equippedCostume) + '</div>', kind: 'action' }; }
    if (r.type === 'bundle') { const b = r.bundle || {}; const n = (b.pets ? b.pets.length : 0) + (b.auras ? b.auras.length : 0) + (b.actions ? b.actions.length : 0) + (b.costumes ? b.costumes.length : 0); return { name: '满级豪华大礼包', art: '🎁', kind: 'bundle', final: true, sub: (b.coins ? b.coins + ' 积分 · ' : '') + n + ' 件好礼' }; }
    return { name: '', art: '', kind: r.type };
  }
  function claimPass(level, track, silent) {
    const p = passT(); if (!p) return;
    if (level > p.level) return;
    if (track === 'premium' && !passPremiumActive()) { if (!silent) showToast('需开通豪华版', '先开通豪华通行证'); return; }
    if (p.claimed[track].indexOf(level) >= 0) return;
    const table = window.buildPassTable();
    const row = table[level - 1]; if (!row) return;
    const r = row[track];
    if (r.type === 'coins') petState.points += r.qty;
    else if (r.type === 'pet') { if (petState.ownedPets.indexOf(r.id) < 0) petState.ownedPets.push(r.id); }
    else if (r.type === 'aura') {
      const now = Date.now();
      const info = window.auraById ? window.auraById(r.id) : null;
      const dur = (info && info.duration) ? info.duration : 24;
      if (petState.ownedAuras.indexOf(r.id) < 0) petState.ownedAuras.push(r.id);
      petState.auraExpiry[r.id] = Math.max(now, petState.auraExpiry[r.id] || 0) + dur * AURA_MS_PER_HOUR;
    }
    else if (r.type === 'costume') { if (petState.ownedCostumes.indexOf(r.id) < 0) petState.ownedCostumes.push(r.id); }
    else if (r.type === 'action') { if (petState.ownedActionsAll.indexOf(r.id) < 0) petState.ownedActionsAll.push(r.id); }
    else if (r.type === 'bundle') {
      const b = r.bundle || {};
      const now = Date.now();
      if (b.coins) petState.points += b.coins;
      (b.pets || []).forEach(id => { if (petState.ownedPets.indexOf(id) < 0) petState.ownedPets.push(id); });
      (b.auras || []).forEach(id => {
        if (petState.ownedAuras.indexOf(id) < 0) petState.ownedAuras.push(id);
        const info = window.auraById ? window.auraById(id) : null;
        const dur = (info && info.duration) ? info.duration : 24;
        petState.auraExpiry[id] = Math.max(now, petState.auraExpiry[id] || 0) + dur * AURA_MS_PER_HOUR;
      });
      (b.actions || []).forEach(id => { if (petState.ownedActionsAll.indexOf(id) < 0) petState.ownedActionsAll.push(id); });
      (b.costumes || []).forEach(id => { if (petState.ownedCostumes.indexOf(id) < 0) petState.ownedCostumes.push(id); });
    }
    p.claimed[track].push(level);
    if (silent) return;   // 一键领取（批量）时由 claimAllPass 统一保存与渲染，避免重复刷新与刷屏
    savePet(petState);
    renderPetArt(); renderBadge(); renderPoints(); renderPassPane(); renderShopPane(); renderDressPane();
    const meta = passRewardMeta(r);
    showToast('领取成功', '获得 ' + meta.name + (r.type === 'bundle' ? '（含 ' + (r.bundle.coins || 0) + ' 积分 + 多件好礼）' : ''));
  }
  // 一键领取：批量领取所有已达等级且未领取的普通轨（及已激活的进阶轨）奖励
  function claimAllPass() {
    const p = passT(); if (!p) return;
    const prem = passPremiumActive();
    const table = window.buildPassTable();
    let count = 0;
    table.forEach(row => {
      const lvl = row.lv;
      if (lvl > p.level) return;
      if (p.claimed.free.indexOf(lvl) < 0) { claimPass(lvl, 'free', true); count++; }
      if (prem && p.claimed.premium.indexOf(lvl) < 0) { claimPass(lvl, 'premium', true); count++; }
    });
    if (count === 0) { showToast('暂无可领奖励', '升级或完成通行证任务后再来领取'); return; }
    savePet(petState);
    renderPetArt(); renderBadge(); renderPoints(); renderPassPane(); renderShopPane(); renderDressPane();
    showToast('一键领取成功', '共领取 ' + count + ' 个通行证奖励');
  }
  function renderPassPane() {
    if (!pcPassTrack) return;
    const p = passT(); if (!p) return;
    const prem = passPremiumActive();
    if (pcPassSeason) pcPassSeason.textContent = p.season;
    if (pcPassLevel) pcPassLevel.textContent = p.level;
    if (pcPassTier) { pcPassTier.textContent = prem ? '豪华通行证' : '免费通行证'; pcPassTier.classList.toggle('premium', prem); }
    const need = passReq(p.level);
    if (pcPassXpFill) pcPassXpFill.style.width = Math.min(100, Math.round((p.xp / need) * 100)) + '%';
    if (pcPassXpTxt) pcPassXpTxt.textContent = p.level >= 100 ? '已满级' : (p.xp + ' / ' + need + ' XP');
    if (pcPassBuy) {
      if (prem) {
        const days = Math.max(0, Math.ceil((p.premiumUntil - Date.now()) / 86400000));
        pcPassBuy.textContent = '豪华生效中 · 剩 ' + days + ' 天（续费 +30天）';
        pcPassBuy.classList.add('active'); pcPassBuy.disabled = false;
      } else {
        pcPassBuy.textContent = '开通豪华通行证（200 积分 / 30天）';
        pcPassBuy.classList.remove('active'); pcPassBuy.disabled = false;
      }
    }
    if (pcPassTasks) {
      pcPassTasks.innerHTML = '';
      PASS_TASKS.forEach(tk => {
        const done = p.tasks[tk.id] === petTodayStr();
        const el = document.createElement('div');
        el.className = 'pass-task' + (done ? ' done' : '');
        el.innerHTML = '<span class="dot">' + (done ? '✓' : '') + '</span><span>' + tk.name + '</span><span class="xp">+' + tk.xp + ' XP</span>';
        pcPassTasks.appendChild(el);
      });
    }
    const table = window.buildPassTable();
    let lvHtml = '', freeHtml = '', premHtml = '';
    table.forEach(row => {
      const lvl = row.lv;
      const reached = lvl <= p.level;
      const free = passRewardMeta(row.free);
      const premR = passRewardMeta(row.premium);
      const freeClaimed = p.claimed.free.indexOf(lvl) >= 0;
      const premClaimed = p.claimed.premium.indexOf(lvl) >= 0;
      const ms = row.milestone ? ' milestone' : '';
      const reachCls = reached ? ' reached' : '';
      lvHtml += '<div class="pass-lvnum' + ms + '">' + lvl + '</div>';
      const freeBtn = !reached ? '<span class="pass-lock">未达</span>'
        : (freeClaimed ? '<span class="pass-done">已领</span>'
          : '<button class="pass-claim" data-lv="' + lvl + '" data-tr="free">领取</button>');
      freeHtml += '<div class="pass-rew free' + ms + reachCls + '">'
        + '<div class="pass-rew-art">' + free.art + '</div>'
        + '<div class="pass-rew-name">' + free.name + '</div>' + freeBtn + '</div>';
      const isBundle = row.premium.type === 'bundle';
      const premDouble = row.premium.type === 'coins' ? '<span class="pass-double">2×</span>' : '';
      const premBtn = !reached ? '<span class="pass-lock">未达</span>'
        : (!prem ? '<span class="pass-lock up">豪华</span>'
          : (premClaimed ? '<span class="pass-done">已领</span>'
            : '<button class="pass-claim" data-lv="' + lvl + '" data-tr="premium">领取</button>'));
      premHtml += '<div class="pass-rew prem' + (prem ? '' : ' locked') + ms + reachCls + (isBundle ? ' final' : '') + '">'
        + premDouble
        + '<div class="pass-rew-art">' + premR.art + '</div>'
        + '<div class="pass-rew-name">' + premR.name + '</div>'
        + (premR.sub ? '<div class="pass-rew-sub">' + premR.sub + '</div>' : '')
        + premBtn + '</div>';
    });
    pcPassTrack.innerHTML = '<div class="pass-promo">🎉 豪华通行证积分 <b>双倍</b> 发放 · 满级再送 <b>豪华大礼包</b></div>'
      + '<div class="pass-track-wrap">'
      + '<div class="pass-track-labels"><div class="pass-track-label">等级</div><div class="pass-track-label">普通</div><div class="pass-track-label prem">豪华</div></div>'
      + '<div class="pass-track"><div class="pass-lvrow">' + lvHtml + '</div><div class="pass-freerow">' + freeHtml + '</div><div class="pass-premrow">' + premHtml + '</div></div>'
      + '</div>';
    pcPassTrack.querySelectorAll('.pass-claim').forEach(b => b.addEventListener('click', () => claimPass(parseInt(b.dataset.lv, 10), b.dataset.tr)));
    // 一键领取按钮：有可领奖励时高亮可点，否则置灰
    if (pcPassClaimAll) {
      let has = false;
      table.forEach(row => {
        const lvl = row.lv;
        if (lvl > p.level) return;
        if (p.claimed.free.indexOf(lvl) < 0) has = true;
        else if (prem && p.claimed.premium.indexOf(lvl) < 0) has = true;
      });
      pcPassClaimAll.disabled = !has;
      pcPassClaimAll.classList.toggle('ready', has);
    }
  }

  // ---------- 签到 ----------
  const doSign = () => {
    const t = petTodayStr();
    if (petState.lastSign === t) { showBubble('今天已经签到啦～'); return; }
    petState.streak = (petState.lastSign === petYesterdayStr()) ? petState.streak + 1 : 1;
    const reward = petSignReward(petState.streak);
    const before = petLevelOf(petState.points);
    petState.points += reward; petState.totalDays += 1; petState.lastSign = t;
    if (petState.streak > 0 && petState.streak % 7 === 0) {
      grantPremium(30);
      setTimeout(() => showBubble('连续签到7天，赠送豪华通行证 30 天！🎉', 3200), 300);
    }
    const after = petLevelOf(petState.points);
    savePet(petState); updateAll(); petBounce();
    setTimeout(() => { petCat.classList.add('happy'); setTimeout(() => petCat.classList.remove('happy'), 950); }, 200);
    if (after > before) { showBubble(`升级啦！Lv.${after} 🎉`, 3200); petCat.classList.add('lvup'); setTimeout(() => petCat.classList.remove('lvup'), 1000); }
    else { showBubble(`签到 +${reward} 积分！`, 2800); }
    renderSignPane();
  };

  // ---------- 面板开关 ----------
  const openCenter = (tab) => {
    if (!petCenter) return;
    petCenter.hidden = false;
    switchTab(tab || 'sign');
    completeTask('center');
    petBounce();
  };
  const closeCenter = () => { if (petCenter) petCenter.hidden = true; };
  const switchTab = (tab) => {
    pcTabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.pc-pane').forEach(p => p.hidden = (p.dataset.pane !== tab));
    if (tab === 'sign') renderSignPane();
    else if (tab === 'dress') renderDressPane();
    else if (tab === 'shop') renderShopPane();
    else if (tab === 'pass') renderPassPane();
  };

  // ---------- 初始渲染 & 位置 ----------
  renderPetArt(); renderBadge(); renderPoints();
  completeTask('open');
  if (!petState.lastSign && petState.points === 0) setTimeout(() => showBubble('点我打开萌宠交易所～'), 900);

  // ---------- 初始化（纯本地软件：无账号无门禁，欢迎页由 GroupPanel 首次启动弹出）----------
  renderGroupChip();
  // 主进程转发提示（自动更新等）
  ipcRenderer.on('toast', (e, title, body) => showToast(title || '', body || ''));
  // 托盘右键「萌宠交易所」入口
  ipcRenderer.on('open-pet-center', () => { if (typeof openCenter === 'function') openCenter('sign'); });
  // 托盘右键「打开视图」统一入口
  ipcRenderer.on('switch-view', (e, viewName) => {
    if (!viewName) return;
    if (viewName === 'settings') { if (typeof openSettings === 'function') openSettings(); }
    else if (typeof switchView === 'function') switchView(viewName);
  });

  function clamp(v, mn, mx) { return Math.max(mn, Math.min(v, mx)); }
  function applyIdlePos() {
    if (isRoaming()) return; // 巡逻宠物由 roam 控制 left
    const lr = petLayerEl.getBoundingClientRect();
    let x, y;
    if (petState.pos) { x = petState.pos.x; y = petState.pos.y; }
    else { x = Math.max(4, lr.width - PET_W - 8); y = Math.max(4, lr.height - PET_W - 44); }
    petCat.style.right = 'auto'; petCat.style.bottom = 'auto';
    petCat.style.left = clamp(x, 4, Math.max(4, lr.width - PET_W - 4)) + 'px';
    petCat.style.top = clamp(y, 4, Math.max(4, lr.height - PET_W - 4)) + 'px';
  }
  applyIdlePos();
  window.addEventListener('resize', () => { if (!isRoaming()) applyIdlePos(); });

  // ---------- 拖拽（任意猫咪均可拖到任意位置，松手即钉住） ----------
  let petDragging = false, petDragMoved = false, petStartX = 0, petStartY = 0, petBaseX = 0, petBaseY = 0;
  petCat.addEventListener('pointerdown', (e) => {
    petDragging = true; petDragMoved = false;
    petCat.classList.add('dragging');
    const lr = petLayerEl.getBoundingClientRect();
    const pr = petCat.getBoundingClientRect();
    petBaseX = pr.left - lr.left; petBaseY = pr.top - lr.top;
    petCat.style.right = 'auto'; petCat.style.bottom = 'auto';
    petCat.style.left = petBaseX + 'px'; petCat.style.top = petBaseY + 'px';
    petStartX = e.clientX; petStartY = e.clientY;
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!petDragging) return;
    const dx = e.clientX - petStartX, dy = e.clientY - petStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) petDragMoved = true;
    const lr = petLayerEl.getBoundingClientRect();
    const nx = clamp(petBaseX + dx, 4, Math.max(4, lr.width - PET_W - 4));
    const ny = clamp(petBaseY + dy, 4, Math.max(4, lr.height - PET_W - 4));
    petCat.style.left = nx + 'px'; petCat.style.top = ny + 'px';
  });
  window.addEventListener('pointerup', () => {
    if (!petDragging) return;
    petDragging = false; petCat.classList.remove('dragging');
    if (!petDragMoved) return; // 纯点击（未拖动）不改动位置/巡逻状态
    const lr = petLayerEl.getBoundingClientRect();
    const pr = petCat.getBoundingClientRect();
    // 拖拽即钉住：记录坐标；若是巡逻宠物则关闭巡逻，让猫咪停在松手处（含上下）
    petState.pos = { x: Math.round(pr.left - lr.left), y: Math.round(pr.top - lr.top) };
    if (isRoaming()) petState.roamOff = true;
    savePet(petState);
    petCat.classList.toggle('roaming', isRoaming());
    syncRoamToggle();
  });

  petCat.addEventListener('click', () => {
    if (petDragMoved) { petDragMoved = false; return; }
    if (petCenter && !petCenter.hidden) closeCenter(); else openCenter('sign');
  });

  // ---------- 巡逻（仅商城/积分宠物） ----------
  let roamX = 0, dir = -1, rstate = 'walk', rEnd = 0;
  const ROAM_SPEED = 0.55;
  function resetRoam() {
    const lr = petLayerEl.getBoundingClientRect();
    if (isRoaming()) {
      const x = clamp(petCat.getBoundingClientRect().left - lr.left, 4, Math.max(4, lr.width - PET_W - 4));
      roamX = (x >= 4 && x <= lr.width) ? x : lr.width - PET_W - 8;
    }
    dir = Math.random() < 0.5 ? 1 : -1; rstate = 'walk'; rEnd = performance.now() + 2500 + Math.random() * 2500;
  }
  resetRoam();
  function roamFrame(t) {
    requestAnimationFrame(roamFrame);
    if (petDragging || isBlocked() || !isRoaming()) return;
    const lr = petLayerEl.getBoundingClientRect();
    const xMax = Math.max(4, lr.width - PET_W - 4);
    if (rstate === 'walk') {
      roamX += dir * ROAM_SPEED;
      if (roamX <= 4) { roamX = 4; dir = 1; }
      if (roamX >= xMax) { roamX = xMax; dir = -1; }
      if (t > rEnd && Math.random() < 0.004) {
        if (Math.random() < 0.6) { rstate = 'pause'; rEnd = t + 800 + Math.random() * 2000; }
        else { rstate = 'jump'; rEnd = t + 620; petInner.classList.add('jumping'); }
      }
    } else if (rstate === 'pause') {
      if (t >= rEnd) { rstate = 'walk'; rEnd = t + 2500 + Math.random() * 3000; }
    } else if (rstate === 'jump') {
      if (t >= rEnd) { rstate = 'walk'; petInner.classList.remove('jumping'); rEnd = t + 2500 + Math.random() * 3000; }
    }
    petCat.style.left = roamX + 'px';
    petInner.style.transform = dir < 0 ? 'scaleX(-1)' : 'scaleX(1)';
  }
  requestAnimationFrame(roamFrame);

  // 积分宠物特效已统一为「3D 环绕光环」(见 renderPetArt 中的 buildAuraSVG)，
  // 光环挂在宠物身上、随宠物移动，不会像旧的浮动 emoji 那样残留累积，因此无需粒子拖尾系统。

  function isBlocked() {
    const sp = document.getElementById('settingsPanel');
    const ob = document.getElementById('onboard');
    return (sp && !sp.hidden) || (ob && !ob.hidden) || (petCenter && !petCenter.hidden);
  }

  // ---------- 事件绑定 ----------
  if (petCenterClose) petCenterClose.addEventListener('click', closeCenter);
  if (petCenter) petCenter.addEventListener('click', (e) => { if (e.target === petCenter) closeCenter(); });
  if (pcTabs) pcTabs.querySelectorAll('button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
if (pcPassBuy) pcPassBuy.addEventListener('click', () => {
  const p = passT(); if (!p) return;
  if (petState.points < 200) { showToast('积分不足', '开通/续费豪华通行证需 200 积分'); return; }
  petState.points -= 200; grantPremium(30); renderPoints();
  showToast(passPremiumActive() ? '续费成功' : '开通成功', '豪华通行证已激活 30 天');
});
if (pcPassClaimAll) pcPassClaimAll.addEventListener('click', () => claimAllPass());
  // 装扮 / 商城 内部子页签（宠物 / 服饰 / 光效 / 动作）
  const bindSubTabs = () => {
    document.querySelectorAll('.pc-pane[data-pane="dress"], .pc-pane[data-pane="shop"]').forEach(pane => {
      const subs = pane.querySelectorAll('.pc-sub');
      const btns = pane.querySelectorAll('.pc-subtabs button');
      btns.forEach(b => b.addEventListener('click', () => {
        const sub = b.dataset.sub;
        subs.forEach(s => { s.hidden = (s.dataset.sub !== sub); });
        btns.forEach(x => x.classList.toggle('active', x === b));
      }));
    });
  };
  bindSubTabs();
  if (petSignBtn) petSignBtn.addEventListener('click', doSign);
  // 设置 / 引导 / 宠物中心打开时，isBlocked() 会暂停巡逻与特效
  // 隐藏由 .panel:has(...) .pet-layer { display:none } 处理
  setInterval(() => { if (petCenter && !petCenter.hidden) { renderPoints(); } }, 60 * 60 * 1000);

  // 暴露给外部测试/调试（IIFE 内部函数不 global）
  window.renderDressPane = renderDressPane;
  window.renderShopPane = renderShopPane;
  window.savePet = savePet;
})();
