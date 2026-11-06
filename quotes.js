// 行情抓取与解析（主进程内执行，避免浏览器跨域限制）
// 数据源：腾讯财经 qt.gtimg.cn（免费、无需鉴权，支持 A股/港股/美股/指数/ETF）
//        东财（板块/榜单）：push2 常被网络/安全软件拦截，故优先 push2his 备用主机。

const https = require('https');

// 上线静音：默认关闭高频数据日志（[EM]/[prices]/[minute] 每刷新周期几十条，日志暴涨）；
// 开发排查时设 STOCK_WIDGET_DEBUG=1 恢复。console.error 不受影响。
if (process.env.STOCK_WIDGET_DEBUG !== '1') {
  const _origLog = console.log.bind(console);
  console.log = function (...a) {
    const s = typeof a[0] === 'string' ? a[0] : '';
    if (/^\[(EM|prices|minute)/i.test(s)) return;
    _origLog(...a);
  };
}

// ---------- 东财网络层（板块/榜单）----------
// 用户网络/安全软件常拦截 push2.eastmoney.com 与 push2his.eastmoney.com（实时推送主机），
// 实测同族 push2delay.eastmoney.com 可达，故优先 push2delay，失败再依次回退 push2his / push2；
// 每个主机按 electron.net（Chromium 栈）→ Node https → fetch(undici) 顺序重试，
// 但 electron.net 在部分 Electron 版本上 API 不全（如缺 setTimeout），命中一次即本会话永久跳过，改走 Node https。
const EM_HOSTS = ['push2delay.eastmoney.com', 'push2his.eastmoney.com', 'push2.eastmoney.com'];

// ---------- 板块K线缓存 ----------
// 东财板块K线接口（secid=90.BKxxx）经常整段被限流，只能退化为「用成分股合成」。
// 但成分股列表也要走东财 clist，同样会被限流 → 所以把成分股列表落盘缓存，
// 之后即使东财不可用，也能用稳定的腾讯日K合成板块K线（板块成分变动很慢，缓存可长期复用）。
const _boardConsCache = new Map(); // 'bk0475' -> ['sh600030', ...]
const _boardKCache = new Map();    // 'bk0475|day' -> { at, data }
const _boardKFailAt = new Map();   // 'bk0475|day' -> 最近失败时间（60s 内不重试，避免反复打接口）
let _boardConsLoaded = false, _boardConsFile = null;
function boardConsFile() {
  if (_boardConsFile !== null) return _boardConsFile;
  try { _boardConsFile = require('path').join(require('electron').app.getPath('userData'), 'board-cons-cache.json'); }
  catch (e) { _boardConsFile = ''; }
  return _boardConsFile;
}
function boardConsLoad() {
  if (_boardConsLoaded) return;
  _boardConsLoaded = true;
  try {
    const f = boardConsFile();
    if (!f) return;
    const o = JSON.parse(require('fs').readFileSync(f, 'utf8')) || {};
    Object.keys(o).forEach(k => { if (Array.isArray(o[k]) && o[k].length >= 3) _boardConsCache.set(k, o[k]); });
  } catch (e) {}
}
function boardConsSave() {
  try {
    const f = boardConsFile();
    if (!f) return;
    const o = {};
    _boardConsCache.forEach((v, k) => { o[k] = v; });
    require('fs').writeFileSync(f, JSON.stringify(o));
  } catch (e) {}
}

// 东财数据中心：板块成分股（按板块代码过滤）。
// 关键：push2(clist) 被限流时 datacenter-web 域名仍然可用，用它拿成分股，
// 再用稳定的腾讯 K 线合成板块指数，板块K线不再完全依赖 push2。
async function fetchBoardConstituentsDC(boardNum, max = 40) {
  const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/' };
  const out = [];
  try {
    for (let page = 1; page <= 3 && out.length < max; page++) {
      const filter = encodeURIComponent(`(NEW_BOARD_CODE="BK${boardNum}")`);
      const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_CORETHEME_BOARDTYPE'
        + `&columns=SECURITY_CODE,SECURITY_NAME_ABBR,NEW_BOARD_CODE,BOARD_RANK`
        + `&pageSize=100&pageNumber=${page}&filter=${filter}`;
      const r = await fetchWithTimeout(url, 10000, H);
      const j = await r.json();
      const rows = (j && j.result && j.result.data) || [];
      if (!rows.length) break;
      for (const row of rows) {
        const raw = String(row.SECURITY_CODE || '');
        if (!/^\d{6}$/.test(raw)) continue;
        if (!/^(6|0|3|8|4|92)/.test(raw)) continue; // 只留 A 股，排除 B 股（900/200）
        const c = normCode(raw);
        if (c && !out.includes(c)) out.push(c);
        if (out.length >= max) break;
      }
    }
  } catch (e) { console.log('[BoardK] DC cons FAIL', e && e.message); }
  return out;
}

// 板块分时：东财 trends2 被限流时（实测整段 90.BKxxx 请求被重置），
// 用成分股的腾讯分时等权合成一条板块日内曲线（基准 1000）。
// 结果缓存 60 秒，避免 30s 刷新反复拉多只成分股分时。
const _boardMinCache = new Map(); // bk code -> { at, data }
async function fetchBoardMinute(code) {
  const hit = _boardMinCache.get(code);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  const boardNum = code.replace(/^bk/i, '').toUpperCase();
  boardConsLoad();
  let cons = _boardConsCache.get(code) || null;
  if (!cons) {
    const dc = await fetchBoardConstituentsDC(boardNum, 8);
    if (dc.length >= 3) { cons = dc; _boardConsCache.set(code, dc); boardConsSave(); }
  }
  if (!cons || !cons.length) return [];
  const picked = cons.slice(0, 8);
  const raw = [];
  for (const c of picked) {
    try {
      const m = await fetchMinute(c);
      if (m && m.length > 4) raw.push({ c, m });
    } catch (e) {}
  }
  if (raw.length < 2) return [];
  const maps = raw.map(({ c, m }) => ({
    c,
    base: m[0].p || 1,
    map: new Map(m.map(x => [x.t, x])),
  }));
  const times = Array.from(new Set(raw.flatMap(({ m }) => m.map(x => x.t)))).sort();
  const out = [];
  const last = {}; // c -> 最近一次归一化价格
  for (const t of times) {
    let sum = 0, n = 0, v = 0, a = 0;
    for (const it of maps) {
      const pt = it.map.get(t);
      if (pt) { last[it.c] = pt.p / it.base; v += pt.v || 0; a += pt.amount || 0; }
      if (last[it.c] != null) { sum += last[it.c]; n++; }
    }
    if (n) out.push({ t, p: (sum / n) * 1000, v, amount: a, avg: 0 });
  }
  _boardMinCache.set(code, { at: Date.now(), data: out });
  return out;
}

// 东财响应编码随网络/地域/CDN 变化（可能是 UTF-8 也可能是 GBK）：
// 若按 UTF-8 解出含替换符（说明原始字节不是合法 UTF-8，属 GBK），则改用 GBK 解码，避免板块名乱码。
function decodeEMBody(buf) {
  const utf8 = buf.toString('utf8');
  if (utf8.includes('�')) return new TextDecoder('gbk').decode(buf);
  return utf8;
}

function electronNetGetJSON(url, headers, timeoutMs) {
  let net;
  try { net = require('electron').net; } catch (e) { return Promise.reject(e); }
  if (!net || !net.request) return Promise.reject(new Error('electron.net unavailable'));
  return new Promise((resolve, reject) => {
    const req = net.request(url);
    if (headers) { for (const [k, v] of Object.entries(headers)) { if (v != null) req.setHeader(k, v); } }
    const chunks = [];
    req.on('response', res => {
      res.on('data', d => chunks.push(d));
      res.on('end', () => { try { resolve(JSON.parse(decodeEMBody(Buffer.concat(chunks)))); } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (timeoutMs) {
      let timedOut = false;
      const onTimeout = () => { if (timedOut) return; timedOut = true; try { req.abort(); } catch (e) {} reject(new Error('electron net timeout: ' + url)); };
      req.on('timeout', onTimeout); // Electron 的 net.ClientRequest 通过 'timeout' 事件通知，兜底必加
      // 旧版 API 可能提供 setTimeout(timeout, cb)，若可用也调用（cb 被忽略也无妨，上面事件已兜底）
      if (typeof req.setTimeout === 'function') { try { req.setTimeout(timeoutMs, onTimeout); } catch (e) {} }
    }
    req.end();
  });
}

function nodeHttpsGetJSON(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => { try { resolve(JSON.parse(decodeEMBody(Buffer.concat(chunks)))); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout: ' + url)); });
    req.setTimeout(timeoutMs);
  });
}

async function fetchGetJSON(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    return JSON.parse(decodeEMBody(Buffer.from(await r.arrayBuffer())));
  }
  finally { clearTimeout(t); }
}

// 原生 fetch 的 options 不支持 timeout 字段，必须走 AbortController。
// 早期代码写成 fetch(url, { timeout: 8000 }) 是空操作，远端无响应时会永久挂起，
// 导致调用方 await 永不返回、IPC 永远不 reply、界面冻死。这里统一替换。
async function fetchWithTimeout(url, timeoutMs, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: headers || {}, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

// electron.net 在部分 Electron 版本上 API 不全（如缺 setTimeout），首次失败即本会话永久跳过，避免每周期白试一次
let emNetBroken = false;
let emNetLogged = false;

// 先试 push2delay，失败回退 push2his / push2；每个主机按 electron.net → https → fetch 顺序重试（成功即返回，不双倍重试）
async function emGetJSON(path, query, headers, timeoutMs = 8000, validate, hosts = EM_HOSTS) {
  let lastErr;
  for (const host of hosts) {
    const url = `https://${host}${path}?${query}`;
    // electron.net 优先，但会话内若已知不可用则跳过（节省一次必败的网络尝试与错误日志）
    if (!emNetBroken) {
      try { const r = await electronNetGetJSON(url, headers, timeoutMs); console.log('[EM] OK', host, path.slice(0, 26)); if (!validate || validate(r)) return r; lastErr = new Error('EM validate failed: ' + host); }
      catch (e) {
        if (!emNetLogged) { console.log('[EM] electron.net 本会话不可用（' + e.message + '），改走 Node https'); emNetLogged = true; }
        emNetBroken = true; lastErr = e;
      }
    }
    try { const r = await nodeHttpsGetJSON(url, headers, timeoutMs); console.log('[EM] OK(https)', host, path.slice(0, 26)); if (!validate || validate(r)) return r; lastErr = new Error('EM validate failed: ' + host); }
    catch (e) { console.log('[EM] https FAIL', host, e.message); lastErr = e; }
    try { const r = await fetchGetJSON(url, headers, timeoutMs); console.log('[EM] OK(fetch)', host, path.slice(0, 26)); if (!validate || validate(r)) return r; lastErr = new Error('EM validate failed: ' + host); }
    catch (e) { console.log('[EM] fetch FAIL', host, e.message); lastErr = e; }
  }
  throw lastErr;
}

async function fetchQuotes(codes) {
  if (!codes || codes.length === 0) return '';
  // 腾讯 qt.gtimg.cn 单次批量超过约 60 个代码会静默截断（只返回部分），
  // 自选股多的用户会莫名缺数据 → 固定 55 个一组分块请求再拼接。
  const CHUNK = 55;
  const parts = [];
  for (let i = 0; i < codes.length; i += CHUNK) {
    const url = `https://qt.gtimg.cn/q=${codes.slice(i, i + CHUNK).join(',')}`;
    const resp = await fetchWithTimeout(url, 8000);
    const buf = Buffer.from(await resp.arrayBuffer());
    // 腾讯接口返回 GBK 编码，Node 22 内置 TextDecoder 支持 'gbk' 解码
    parts.push(new TextDecoder('gbk').decode(buf));
  }
  return parts.join(';');
}

// 腾讯接口每行格式：v_sh600519="1~贵州茅台~600519~价格~昨收~今开~...~涨跌~涨跌%"
function parseQuotes(text) {
  const result = [];
  if (!text) return result;
  const lines = text.split(';');
  for (const line of lines) {
    const m = line.match(/v_(\w+)="(.*)"/);
    if (!m) continue;
    const code = m[1];
    const f = m[2].split('~');
    if (f.length < 33 || !f[1]) continue; // 无效代码（名为空）
    let price = parseFloat(f[3]) || 0;
    const prevClose = parseFloat(f[4]) || 0;
    let change = parseFloat(f[31]) || 0;
    let changePct = parseFloat(f[32]) || 0;
    // 停牌/异常：现价为 0 但昨收有效 → 用昨收兜底展示，绝不给用户显示 0.00
    let suspended = false;
    if (!price && prevClose > 0) { price = prevClose; change = 0; changePct = 0; suspended = true; }
    result.push({
      code,
      name: f[1],
      price,
      prevClose,
      change,
      changePct,
      high: parseFloat(f[33]) || 0,
      low: parseFloat(f[34]) || 0,
      time: (f[30] || '').replace(/\s/g, ''),
      suspended,
    });
  }
  return result;
}

module.exports = {
  fetchQuotes, parseQuotes, fetchMinute, fetch5DayMinutes, fetchSuggest, fetchSuggestEM, fetchQuotesEM, fetchQuoteEMFallback, fetchMinuteEM, fetchMinutesEM, fetchKline, fetchRanking,
  fetchMarketSummary, fetchMarketTrend, fetchClistRaw, normCode,
  fetchIndicesGroups, fetchHotDetail, fetchSectorsFull, fetchEtfFull, buildMarketFull,
  fetchKlineSinaDaily, fetchBoardMinute
};

// 把内部代码映射成东方财富 secid（用于 trends2 / K线 / 板块）
function secidOf(code) {
  if (/^sh/.test(code)) return '1.' + code.slice(2);
  if (/^sz/.test(code)) return '0.' + code.slice(2);
  if (/^bj/.test(code)) return '0.' + code.slice(2);
  if (/^hk/.test(code)) return '116.' + code.slice(2);
  if (/^bk/i.test(code)) return '90.BK' + code.replace(/^bk/i, '').toUpperCase().replace(/^BK/, '');
  // 期货（SGX 新华富时 A50 等连续/主力合约，东财 MktNum=104）：腾讯 qt.gtimg.cn 无期货行情，统一走东财 secid 104.xxx
  // 同花顺 CN0W（主连）/ CN0Y 在东财体系里对应 CN00Y（当月连续），这里统一映射到东财支持的代码
  if (/^fu/i.test(code)) {
    const fut = code.slice(2).toUpperCase();
    if (/^CN0[YW]$/i.test(fut)) return '104.CN00Y';
    return '104.' + fut;
  }
  // 东财指数（中证/国证/东财 H 系列），secid 前缀 2
  if (/^[H9]\d+$/.test(code)) return '2.' + code;
  return '1.' + code.replace(/^\D+/, '');
}

// K线（蜡烛图）：个股/指数优先走腾讯 fqkline；板块、分钟K、年K 走东财专用接口。
// 当腾讯无数据时，回退到东财 kline。
async function fetchKline(code, period, limit = 320) {
  // klt: 东财 K线周期编码
  const KLT_MAP = {
    day: '101', week: '102', month: '103', year: '105',
    m5: '121', m15: '122', m30: '123', m60: '124', m120: '125'
  };
  const klt = KLT_MAP[period] || '101';

  async function fetchKlineEM() {
    const secid = secidOf(code);
    const query = `secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
      + `&klt=${klt}&fqt=1&end=20500101&lmt=${limit}&ut=fa5fd1943c7b386f172d6893dbfba10b`;
    // 东财 push2delay 对 K线接口返回 klines:[]（空），push2his 才有完整 K线数据；
    // 故 K线兜底优先 push2his，减少一次必败的 push2delay 尝试与日志噪音，并校验非空。
    const klineOk = (j) => {
      const d = (j && j.data) || {};
      const klines = d.klines || (d[secid] && d[secid].klines) || [];
      return Array.isArray(klines) && klines.length > 0;
    };
    try {
      const j = await emGetJSON('/api/qt/stock/kline/get', query, { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' }, 8000, klineOk, ['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com']);
      const d = (j && j.data) || {};
      const klines = d.klines || (d[secid] && d[secid].klines) || [];
      return klines.map(s => {
        const p = String(s).split(',');
        return { date: p[0], open: parseFloat(p[1]) || 0, close: parseFloat(p[2]) || 0, high: parseFloat(p[3]) || 0, low: parseFloat(p[4]) || 0, volume: parseFloat(p[5]) || 0 };
      }).filter(x => x.date);
    } catch (e) { console.error('[EM kline] ERROR', e); return []; }
  }

  // 板块 K线兜底：用板块成分股合成等权指数 K线
  // 东财官方板块 K线不可用时，取成交额靠前的成分股，按等权收益率滚动合成板块指数 OHLC。
  async function fetchKlineBoard(code, period, limit = 320) {
    const boardNum = code.replace(/^bk/i, '').toUpperCase();
    const key = code + '|' + period;
    const now = Date.now();
    // 合成结果缓存 5 分钟：避免 30s 的 K 线刷新反复拉 30 只成分股（既慢又容易被限流）
    const hit = _boardKCache.get(key);
    if (hit && now - hit.at < 300000) return hit.data;
    if (now - (_boardKFailAt.get(key) || 0) < 60000) return []; // 刚失败过，冷却 60s
    try {
      // 成分股列表：优先用落盘缓存（板块成分变动很慢），没有再请求东财
      boardConsLoad();
      let stockCodes = _boardConsCache.get(code) || null;
      if (!stockCodes) {
        // ① 东财数据中心（不受 push2 限流影响，稳定）
        const dc = await fetchBoardConstituentsDC(boardNum, 40);
        if (dc.length >= 3) { stockCodes = dc; _boardConsCache.set(code, dc); boardConsSave(); }
      }
      if (!stockCodes) {
        // ② push2 clist 回退：取成交额前 N 的成分股
        const maxCons = 30;
        try {
          const cons = await fetchClistRaw(`b:BK${boardNum}`, { pz: maxCons, fid: 'f6', fields: 'f12,f14,f6' });
          if (cons && cons.length >= 3) {
            const codes = cons.map(d => normCode(d.f12)).filter(Boolean);
            if (codes.length >= 3) { stockCodes = codes; _boardConsCache.set(code, codes); boardConsSave(); }
          }
        } catch (e) { /* 东财限流：走缓存或本次直接失败 */ }
      }
      if (!stockCodes || stockCodes.length < 3) {
        _boardKFailAt.set(key, now);
        console.log('[BoardK] no constituents (EM limited & no cache)', code);
        return [];
      }

      // 控制并发，避免一次请求过多把主进程卡死
      const batch = 6;
      const results = [];
      for (let i = 0; i < stockCodes.length; i += batch) {
        const slice = stockCodes.slice(i, i + batch);
        const part = await Promise.all(slice.map(async c => {
          try {
            const k = await fetchKline(c, period, limit);
            return { code: c, k: Array.isArray(k) ? k : [] };
          } catch (e) { return { code: c, k: [] }; }
        }));
        results.push(...part);
      }

      // 按日期聚合：把每只成分股当天的 OHLC 相对其 own close 的收益率做等权平均，
      // 再以基准日 1000 点滚动合成板块指数。这样形态与官方板块指数一致，不受个股绝对股价影响。
      const byDate = new Map();
      results.forEach(({ k }) => {
        if (!k || !k.length) return;
        // 按日期升序，便于计算相对前一天的 close 收益率
        const sorted = k.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
        sorted.forEach((d, idx) => {
          if (!d || !d.date) return;
          if (!byDate.has(d.date)) {
            byDate.set(d.date, { date: d.date, openRets: [], highRets: [], lowRets: [], closeRets: [], prevCloseRets: [], volumes: [] });
          }
          const b = byDate.get(d.date);
          const c = d.close || d.open || 1;
          b.openRets.push((d.open || c) / c - 1);
          b.highRets.push((d.high || c) / c - 1);
          b.lowRets.push((d.low || c) / c - 1);
          b.closeRets.push(0); // 当天 close 相对 own close 永远是 0，下面用 prevCloseRets 算滚动收益
          b.volumes.push(d.volume || 0);
          // 相对前一天 close 的收益率
          if (idx > 0) {
            const prevC = sorted[idx - 1].close || sorted[idx - 1].open || 1;
            b.prevCloseRets.push(c / prevC - 1);
          }
        });
      });

      const avgFn = (arr) => arr.length ? arr.reduce((a, c) => a + c, 0) / arr.length : 0;
      const days = Array.from(byDate.values())
        .filter(b => b.closeRets.length >= 3)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));

      const BASE = 1000;
      let idxClose = BASE;
      const avg = days.map((b, i) => {
        if (i > 0) {
          const dayRet = avgFn(b.prevCloseRets);
          idxClose = idxClose * (1 + dayRet);
        }
        const open = idxClose * (1 + avgFn(b.openRets));
        const high = idxClose * (1 + avgFn(b.highRets));
        const low = idxClose * (1 + avgFn(b.lowRets));
        return {
          date: b.date,
          open: parseFloat(open.toFixed(2)),
          high: parseFloat(high.toFixed(2)),
          low: parseFloat(low.toFixed(2)),
          close: parseFloat(idxClose.toFixed(2)),
          volume: Math.round(b.volumes.reduce((a, c) => a + c, 0)),
        };
      });

      if (avg.length) _boardKCache.set(key, { at: Date.now(), data: avg });
      console.log('[BoardK] synthesized', code, period, avg.length, 'days from', stockCodes.length, 'stocks');
      return avg;
    } catch (e) {
      _boardKFailAt.set(key, now);
      console.error('[BoardK] ERROR', code, e.message);
      return [];
    }
  }

  // 期货（fu 开头）：腾讯 ifzq 不支持期货 K线，直接走东财；避免先等一次腾讯空返。
  if (/^fu/i.test(code)) {
    return fetchKlineEM();
  }

  // 板块（bk 开头）：东财 push2delay K线返回空、push2his 网络不可达，改用成分股合成板块指数 K线
  if (/^bk/i.test(code)) {
    const em = await fetchKlineEM();
    if (em.length) return em;
    return fetchKlineBoard(code, period, limit);
  }

  // 年K：东财有完整多年年线（优先）；但用户网络常拦截东财，且腾讯 fqkline 的 year
  // 只返回当年 1 根（YTD），单根蜡烛看着像坏了。故东财取空时改用「腾讯月K 聚合成年K」
  // —— 腾讯月K 稳定可用，聚合后得到完整多年年线，不再是一根孤烛。
  if (period === 'year') {
    const em = await fetchKlineEM();
    if (em.length >= 2) return em;
    return fetchKlineYearFromMonths(code, limit);
  }

  // 分钟K：新浪接口（http://money.finance.sina.com.cn/.../CN_MarketData.getKLineData）
  // 对 A股/指数提供稳定的 5/15/30/60 分钟K；用户网络常拦截东财 push2his/push2，
  // 故优先新浪，新浪空再走东财，最后腾讯 mkline 兜底。
  if (/^m\d+$/.test(period)) {
    const sina = await fetchKlineSinaMinute(code, period, limit);
    if (sina.length) return sina;
    const em = await fetchKlineEM();
    if (em.length) return em;
    return fetchKlineTencentMkline(code, period, limit);
  }

  // day/week/month：腾讯 fqkline 优先（ifzq 主机 + web 主机各试一次），
  // 空则新浪（日/周/月三条 scale 均可用），最后东财兜底
  const p = (period === 'week' || period === 'month') ? period : 'day';
  const t = await fetchKlineTencentFq(code, p, limit);
  if (t.length) return t;
  const sinaScale = p === 'week' ? 1200 : p === 'month' ? 7200 : 240;
  const sina = await fetchKlineSinaDaily(code, sinaScale, Math.max(limit, 320));
  if (sina.length) return sina;
  console.log('[K fallback] tencent+sina empty, try EM', code, period);
  return fetchKlineEM();
}

// 腾讯 fqkline 解析（day/week/month/year 通用）。6 字段格式：code,period,start,end,count,fqtype
// （start/end 可空，但逗号占位不能少，否则腾讯报 param error 返回空）。
async function fetchKlineTencentFq(code, p, limit = 320) {
  // web.ifzq.gtimg.cn 会被腾讯 WAF 间歇性拦截（返回 501 跳转页，JSON 解析失败），
  // 表现就是「K线时好时坏 / 老是暂无K线数据」。不带 web. 的 ifzq.gtimg.cn 稳定得多，
  // 两个主机各试一次，任一生效即返回。
  const hosts = ['ifzq.gtimg.cn', 'web.ifzq.gtimg.cn'];
  const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' };
  for (const host of hosts) {
    const url = `https://${host}/appstock/app/fqkline/get?param=${code},${p},,,${limit},qfq`;
    try {
      const resp = await fetchWithTimeout(url, 8000, H);
      const obj = await resp.json();
      const node = obj && obj.data && (obj.data[code] || obj.data[code.toUpperCase()]);
      if (node) {
        const arr = node['qfq' + p] || node[p] || node.qfqday || node.day || [];
        if (Array.isArray(arr) && arr.length) {
          // 腾讯日K对科创板（sh688*）返回的成交量单位是"股"，主板/创业板是"手"。
          // 统一按"手"输出，避免科创板成交量被放大100倍，进而影响板块合成成交量。
          const isSTAR = /^sh688/i.test(code);
          const volUnit = isSTAR ? 0.01 : 1;
          return arr.map(it => ({
            date: String(it[0] || ''),
            open: parseFloat(it[1]) || 0,
            close: parseFloat(it[2]) || 0,
            high: parseFloat(it[3]) || 0,
            low: parseFloat(it[4]) || 0,
            volume: (parseFloat(it[5]) || 0) * volUnit,
          })).filter(d => d.date && !isNaN(d.close));
        }
      }
    } catch (e) { console.log('[K tencent fq]', host, 'FAIL', e && e.message); }
  }
  return [];
}

// 新浪日/周/月K兜底：scale=240 日线 / 1200 周线 / 7200 月线，单次最多 320 根。
// 腾讯 WAF 与东财限流同时命中时，这条链路通常仍可用，避免 K线弹窗直接「暂无数据」。
async function fetchKlineSinaDaily(code, scale, limit = 320) {
  const url = `http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=${scale}&ma=5&datalen=${limit}`;
  try {
    const resp = await fetchWithTimeout(url, 10000, { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' });
    const arr = await resp.json();
    if (!Array.isArray(arr) || !arr.length) return [];
    return arr.map(it => ({
      date: String(it.day || ''),
      open: parseFloat(it.open) || 0,
      close: parseFloat(it.close) || 0,
      high: parseFloat(it.high) || 0,
      low: parseFloat(it.low) || 0,
      volume: parseFloat(it.volume) || 0,
    })).filter(d => d.date && !isNaN(d.close));
  } catch (e) { console.log('[K sina fq] ERROR', e && e.message); return []; }
}

// 年K 兜底：腾讯月K 稳定可用，按月数据按年聚合为年线（open=首月开、close=末月收、
// high/low 取极值、volume 累加）。避免直接取腾讯 year 只剩当年 1 根的尴尬。
async function fetchKlineYearFromMonths(code, limit = 320) {
  const months = await fetchKlineTencentFq(code, 'month', limit);
  if (!months.length) return [];
  months.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const byYear = new Map();
  months.forEach(m => {
    const y = String(m.date || '').slice(0, 4);
    if (!y) return;
    if (!byYear.has(y)) {
      byYear.set(y, { date: y, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume || 0 });
    } else {
      const cur = byYear.get(y);
      cur.high = Math.max(cur.high, m.high);
      cur.low = Math.min(cur.low, m.low);
      cur.close = m.close;
      cur.volume += (m.volume || 0);
    }
  });
  return Array.from(byYear.values());
}

// 新浪分钟K线：A股/指数统一走新浪财经历史分钟K接口，支持 5/15/30/60 分。
// 120 分通过把 60 分数据两两合并得到（open=第一根, close=第二根, high/max, low/min, volume 求和）。
async function fetchKlineSinaMinute(code, period, limit = 320) {
  const SINA_SCALE = { m5: 5, m15: 15, m30: 30, m60: 60, m120: 60 };
  const scale = SINA_SCALE[period];
  if (!scale) return [];
  const url = `http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=${scale}&ma=5&datalen=${limit}`;
  try {
    const resp = await fetchWithTimeout(url, 10000, { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' });
    const arr = await resp.json();
    if (!Array.isArray(arr) || !arr.length) return [];
    const parsed = arr.map(it => ({
      date: String(it.day || ''),
      open: parseFloat(it.open) || 0,
      close: parseFloat(it.close) || 0,
      high: parseFloat(it.high) || 0,
      low: parseFloat(it.low) || 0,
      volume: parseFloat(it.volume) || 0,
    })).filter(d => d.date && !isNaN(d.close));
    // 120 分：由 60 分两两合并
    if (period === 'm120') {
      const merged = [];
      for (let i = 0; i + 1 < parsed.length; i += 2) {
        const a = parsed[i], b = parsed[i + 1];
        merged.push({
          date: b.date,
          open: a.open,
          close: b.close,
          high: Math.max(a.high, b.high),
          low: Math.min(a.low, b.low),
          volume: (a.volume || 0) + (b.volume || 0),
        });
      }
      return merged;
    }
    return parsed;
  } catch (e) { console.error('[K sina minute] ERROR', e); }
  return [];
}

// 腾讯分钟K线兜底：mkline 接口（web3.ifzq.gtimg.cn）支持 m5/m15/m30/m60/m120，
// 与 fqkline 同族，用户网络通常可达；用于东财被拦截时补全分钟K。返回结构与 fqkline 一致。
async function fetchKlineTencentMkline(code, period, limit = 320) {
  const url = `https://web3.ifzq.gtimg.cn/appstock/app/kline/mkline/get?param=${code},${period},,${limit}`;
  try {
    const resp = await fetchWithTimeout(url, 8000, { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' });
    const obj = await resp.json();
    const node = obj && obj.data && (obj.data[code] || obj.data[code.toUpperCase()]);
    if (node) {
      const arr = node[period] || node[period.toUpperCase()] || [];
      if (Array.isArray(arr) && arr.length) {
        // 分钟K同样：科创板（sh688*）成交量单位为"股"，其余为"手"
        const isSTAR = /^sh688/i.test(code);
        const volUnit = isSTAR ? 0.01 : 1;
        return arr.map(it => {
          const f = Array.isArray(it) ? it : String(it).split(',');
          const o = parseFloat(f[1]) || 0;
          const c = parseFloat(f[2]) || 0;
          const h = parseFloat(f[3]) || 0;
          const l = parseFloat(f[4]) || 0;
          // 部分源 high/low 字段顺序不一致，统一以 开/收/高/低 为准做合理性修正
          const hi = Math.max(o, c, h), lo = Math.min(o, c, l);
          return {
            date: String(f[0] || ''),
            open: o,
            close: c,
            high: hi,
            low: lo,
            volume: (parseFloat(f[5]) || 0) * volUnit,
          };
        }).filter(d => d.date && !isNaN(d.close));
      }
    }
  } catch (e) { console.error('[K tencent mkline] ERROR', e); }
  return [];
}

// 五日分时：腾讯 day/query（ifzq）返回最近 5 个交易日每分钟数据，
// data[code].data = [{ date:'20261029', data:['0930 1349.99 1486 200608514.00', ...] }, ...]
// 东财 trends2 现在经常被限流（连接被重置），仅作兜底。
async function fetch5DayMinutes(code) {
  if (!/^fu/i.test(code)) {
    try {
      const u = `https://ifzq.gtimg.cn/appstock/app/day/query?code=${code}`;
      const r = await fetchWithTimeout(u, 9000, { 'User-Agent': 'Mozilla/5.0' });
      const j = await r.json();
      const node = j && j.data && (j.data[code] || j.data[code.toUpperCase()]);
      const days = node && node.data;
      if (Array.isArray(days) && days.length) {
        const out = [];
        // 腾讯返回的顺序是「今天 → 更早」，图上要按时间从左到右，先反转为「更早 → 今天」
        for (const day of [...days].reverse()) {
          const raw = String(day && day.date || '');
          const date = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
          let prevV = 0, prevA = 0;
          for (const line of (day && day.data) || []) {
            const parts = String(line).trim().split(/\s+/);
            const hhmm = parts[0] || '';
            const price = parseFloat(parts[1]);
            if (isNaN(price)) continue;
            const cumV = parseFloat(parts[2]) || 0;
            const cumA = parseFloat(parts[3]) || 0;
            const dV = cumV >= prevV ? cumV - prevV : cumV;
            const dA = cumA >= prevA ? cumA - prevA : cumA;
            prevV = cumV; prevA = cumA;
            const t = hhmm.length === 4 ? `${date} ${hhmm.slice(0, 2)}:${hhmm.slice(2)}` : `${date} ${hhmm}`;
            out.push({
              t, p: price, v: dV, amount: dA,
              // 均价 = 累计成交额 / (累计成交量×100)，成交量单位是「手」
              avg: cumV > 0 ? cumA / (cumV * 100) : 0,
            });
          }
        }
        if (out.length >= 2) return out;
      }
    } catch (e) { console.log('[EM] 5day tencent FAIL', e && e.message); }
  }
  const secid = secidOf(code);
  const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' };
  const query = `secid=${encodeURIComponent(secid)}`
    + `&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13`
    + `&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ut=fa5fd1943c7b386f172d6893dbfba10b`
    + `&iscr=0&ndays=5`;
  // 关键修复：push2delay（延迟行情主机）会忽略 ndays 只回当日（实测 182 点/1 天），
  // 之前默认主机序 delay 优先且无校验，导致「五日分时看到的是当日」。
  // 现改为：历史能力强的 push2his/push2 优先 + validate 拒收单日数据让 emGetJSON 自动换主机；
  // 全部主机都只回当日时，退化为当日分时（有图总比空白强）。
  const dayCount = (j) => new Set(((j.data && j.data.trends) || []).map(s => String(s).split(',')[0].trim().slice(0, 10))).size;
  const parse = (j) => {
    const tr = (j.data && j.data.trends) || [];
    let prevV = 0, prevA = 0;
    return tr.map(s => {
      const p = String(s).split(',');
      const cumV = parseFloat(p[5]) || 0;
      const cumA = parseFloat(p[6]) || 0;
      const dV = cumV >= prevV ? cumV - prevV : cumV;
      const dA = cumA >= prevA ? cumA - prevA : cumA;
      prevV = cumV; prevA = cumA;
      return {
        t: (p[0] || '').trim(), // 保留完整日期时间，如 "2026-07-20 09:30"
        p: parseFloat(p[2]),
        v: dV,
        amount: dA,
        avg: parseFloat(p[7]) || 0,
      };
    }).filter(d => !isNaN(d.p));
  };
  try {
    const multiDay = await emGetJSON('/api/qt/stock/trends2/get', query, H, 8000,
      (j) => dayCount(j) >= 2, ['push2his.eastmoney.com', 'push2.eastmoney.com', 'push2delay.eastmoney.com']);
    return parse(multiDay);
  } catch (e) { /* 所有主机都只回当日（被限流/接口变更）→ 退化取当日 */ }
  try {
    const today = await emGetJSON('/api/qt/stock/trends2/get', query, H);
    return parse(today);
  } catch (e) { console.error('[EM 5day] ERROR', e && e.message); return []; }
}

// 行情榜单：4 个榜单（涨幅/跌幅/换手/成交额）分别由服务端按对应字段排序取 TopN，
// 这样每个榜单拿到的都是真实全市场的前列，客户端无需对不完整集合排序。
// 旧实现只按 f3 升序取 120 条（全是跌幅最大的票），导致涨幅/换手/成交额榜都显示错误。
// 东财 clist：po=0 降序、po=1 升序；fs 为沪深京全市场 A 股（含创业板/科创板/北交所）。
async function fetchRanking() {
  const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' };
  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
  const fields = 'f12,f14,f2,f3,f6,f8';
  const clistTop = async (fid, po, pz) => {
    const query = `pn=1&pz=${pz}&po=${po}&np=1&fltt=2&invt=2&fid=${fid}&fs=${fs}&fields=${fields}`;
    const j = await emGetJSON('/api/qt/clist/get', query, H);
    const list = (j && j.data && j.data.diff) || [];
    return list.map(d => {
      const num = String(d.f12 || '');
      const market = (num[0] === '6') ? 'sh' : (/^[84]/.test(num) || num.startsWith('920')) ? 'bj' : 'sz';
      const price = (typeof d.f2 === 'number') ? d.f2 : 0;
      const amount = (typeof d.f6 === 'number') ? d.f6 : 0;
      return {
        code: market + num,
        name: d.f14 || num,
        price: price,
        chgPct: (typeof d.f3 === 'number') ? d.f3 : 0,
        amount: amount,                                       // 成交额（元）
        turnover: (typeof d.f8 === 'number') ? d.f8 : 0,      // 换手率（%）
      };
    }).filter(x => x.code && x.price > 0 && x.amount > 0);   // 剔除停牌/退市（价或额为 0）
  };
  const [up, down, turn, amount] = await Promise.all([
    clistTop('f3', 1, 60),  // 涨幅榜：涨跌幅降序（po=1 降序）
    clistTop('f3', 0, 60),  // 跌幅榜：涨跌幅升序（po=0 升序）
    clistTop('f8', 1, 60),  // 换手榜：换手率降序
    clistTop('f6', 1, 60),  // 成交额榜：成交额降序
  ]);
  return { up, down, turn, amount };
}

// 多结果搜索：东方财富 suggest（返回多条候选，含股票/ETF/指数/港股，并带板块）
// 相比腾讯 smartbox 只回 1 条，这里能给出多个关键候选供用户挑选
async function fetchSuggestEM(keyword) {
  const kw = (keyword || '').trim();
  // 别名扩展：用户常搜短词（火电/水电/风电），但东财更完整的板块名是「火力发电/水力发电/风力发电」。
  // 同时发起主词与别名两次请求并合并，确保想搜的板块一定出现（例：搜「火电」也能拿到 BK1377 火力发电）。
  const ALIASES = { '火电': '火力发电', '水电': '水力发电', '风电': '风力发电', '核电': '核力发电', '光伏': '光伏发电' };
  const inputs = [kw];
  if (ALIASES[kw]) inputs.push(ALIASES[kw]);
  const allData = [];
  for (const inp of inputs) {
    try {
      const u = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(inp)}`
        + `&type=14&token=DXLTI1SneJxbGqmdrcvRpA==&count=50`;
      const resp = await fetchWithTimeout(u, 8000);
      const obj = await resp.json();
      const data = (obj && obj.QuotationCodeTable && obj.QuotationCodeTable.Data) || [];
      allData.push(...data);
    } catch (e) { /* 别名请求失败不影响主结果 */ }
  }
  const out = [];
  const seen = new Set();
  // 仅保留本组件能正确展示且有行情通道的品类；过滤海外/三板等噪声。
  // 东财 type=14 是全球 suggest，会混入美股/英股/债券/粉单/非A50期货等——这些本组件无通道，
  // 若放任加入会被映射成乱码代码（如 shPAIH7 / sh751264），导致该行长期「无价格、无分时」。
  const DROP = ['债券', '粉单', '英股', '法股', '德股', '日股', '韩股', '台股', '三板', '新三板', '新交所', '新加坡', '马来西亚', '泰国', '印度'];
  const PRIORITY = { '沪A': 0, '深A': 0, '京A': 0, '北交所': 0, '板块': 1, '港股': 2, '指数': 3, '基金': 4, 'ETF': 4, 'LOF': 4, '期货': 5, '美股': 6 };
  for (const d of allData) {
    const code = d.Code || '';
    const name = d.Name || '';
    const secName = d.SecurityTypeName || '';
    if (!code || !name) continue;
    if (seen.has(code)) continue; // 去重（东财偶发重复 + 主词/别名合并去重）
    seen.add(code);
    if (/^BK/i.test(code)) {
      // 板块（BKxxxx）：东方财富体系代码，搜索里可直接搜到并加入自选，走专门板块行情通道
      out.push({ code: 'bk' + code.replace(/^BK/i, ''), name, market: 'bk', type: secName || '板块' });
      continue;
    }
    // 东财指数：H 开头（H30184 等）或 MktNum=2 且代码以 9/H 开头（931743 等中证/国证指数）。
    // 这些指数不应加 sh/sz 前缀，内部保存原码，secid 走 2.xxx。
    if (/^H\d+$/i.test(code) || (String(d.MktNum) === '2' && /^[9H]\d+$/i.test(code))) {
      out.push({ code: code.toUpperCase(), name, market: 'zs', type: '指数' });
      continue;
    }
    // 期货：仅支持东财 SGX 新华富时 A50 连续/主力（代码形如 CN00Y / CN888Y，MktNum=104）。
    // 归入 fu 前缀，行情统一走东财 secid 104.xxx（见 secidOf）。其余期货（中金所 IF/IH/IC、MktNum=130 等）
    // 腾讯/东财均无稳定通道，直接丢弃，避免存成乱码代码后整行无数据。
    // 注意：同花顺 CN0W（主连）/ CN0Y 在东财体系里统一对应 CN00Y（当月连续），保存时统一映射到 fuCN00Y。
    const isA50 = /^CN\d*[YW]$/i.test(code) || (secName.includes('期货') && (d.MktNum === '104' || (d.JYS || '') === 'SGX'));
    if (isA50) {
      const a50Code = /^CN0[YW]$/i.test(code) ? 'CN00Y' : code;
      out.push({ code: 'fu' + a50Code, name, market: 'fu', type: '期货' });
      continue;
    }
    if (secName.includes('期货')) continue; // 非 A50 期货一律丢弃
    if (DROP.some(t => secName.includes(t))) continue; // 丢弃无通道的海外/债券/粉单等
    // 推断市场前缀：优先用东方财富返回的 MarketType（最准），否则按代码前缀兜底
    // MarketType: 1=沪 2=深 5=港 7=美 _TB=北交所 -1/6=场外/基金(一般不走行情)
    const mt = String(d.MarketType || '');
    let market;
    if (mt === '1') market = 'sh';
    else if (mt === '2') market = 'sz';
    else if (mt === '5' || secName.includes('港')) market = 'hk';
    else if (mt === '7') market = 'us';
    else if (mt === '_TB' || /^[84]/.test(code)) market = 'bj';
    else if (/^[36]/.test(code)) market = 'sh';
    else if (/^[03]/.test(code)) market = 'sz';
    else if (/^5/.test(code)) market = 'sh';
    else if (/^1/.test(code)) market = 'sz';
    else market = 'sh';
    if (!['sh', 'sz', 'hk', 'us', 'bj'].includes(market)) continue; // 仅保留有行情通道的市场
    const full = market + code;
    out.push({ code: full, name, market, type: secName });
  }
  // 板块/指数优先保留：先把所有板块与指数取出（一个都不截），其余按优先级补满，
  // 保证关键词搜到的板块全部可添加（用户要求「全板块都能添加」）；总条数上限放宽到 50，
  // 避免下拉列表「搜出来太少」（此前硬截 15 + 请求 count=20，导致常见词只回几十条且被砍到 15）。
  const isSector = (i) => /^bk/i.test(i.code) || i.type === '指数';
  const sectors = out.filter(isSector).sort((a, b) => ((PRIORITY[a.type] ?? 9) - (PRIORITY[b.type] ?? 9)));
  const others = out.filter(i => !isSector(i)).sort((a, b) => ((PRIORITY[a.type] ?? 9) - (PRIORITY[b.type] ?? 9)));
  return [...sectors, ...others].slice(0, 50);
}

// 东方财富行情（板块/指数/ETF/个股兜底）：push2delay 在多数被拦截网络中可用
// 统一用 ulist.np 批量取价，字段 f2现价 f3涨跌幅% f4涨跌额 f15高 f16低 f18昨收（直接为浮点数）
async function fetchQuotesEM(codes) {
  const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' };
  const f12ToCode = {};
  const secids = codes.map(code => {
    const num = code.replace(/^\D+/, '');
    f12ToCode[num.toUpperCase()] = code;
    f12ToCode[num.toLowerCase()] = code;
    if (/^bk/i.test(code)) {
      f12ToCode['BK' + num.toUpperCase()] = code;
      f12ToCode['bk' + num.toLowerCase()] = code;
    }
    const secid = secidOf(code);
    // 期货：secidOf 可能把 CN0W/CN0Y 映射到 CN00Y，需要把接口返回的 f12 也关联回原始 code
    if (/^fu/i.test(code)) {
      const mappedCode = secid.replace(/^104\./, '');
      f12ToCode[mappedCode.toUpperCase()] = code;
      f12ToCode[mappedCode.toLowerCase()] = code;
    }
    return secid;
  }).join(',');
  const out = [];

  const parseUlist = (j) => {
    const list = (j && j.data && j.data.diff) || [];
    return list.map(d => {
      const price = (typeof d.f2 === 'number') ? d.f2 : parseFloat(d.f2) || 0;
      if (!price) return null;
      const change = (typeof d.f4 === 'number') ? d.f4 : parseFloat(d.f4) || 0;
      const prevClose = (typeof d.f18 === 'number' && d.f18) ? d.f18 : (price - change);
      const f12 = String(d.f12 || '');
      return {
        code: f12ToCode[f12.toUpperCase()] || f12ToCode[f12.toLowerCase()] || f12,
        name: d.f14 || '',
        price,
        prevClose,
        change,
        changePct: (typeof d.f3 === 'number') ? d.f3 : parseFloat(d.f3) || 0,
        high: (typeof d.f15 === 'number') ? d.f15 : parseFloat(d.f15) || 0,
        low: (typeof d.f16 === 'number') ? d.f16 : parseFloat(d.f16) || 0,
        time: '',
      };
    }).filter(Boolean);
  };

  try {
    const query = `fltt=2&invt=2&fields=f12,f14,f2,f3,f4,f15,f16,f18&secids=${encodeURIComponent(secids)}`;
    const j = await emGetJSON('/api/qt/ulist.np/get', query, H, 8000);
    const r = parseUlist(j);
    if (r.length) { console.log('[EM prices] ulist len=', r.length); return r; }
  } catch (e) { console.error('[EM prices] ulist FAIL', e.message); }

  console.log('[EM prices] final len=', out.length);
  return out;
}

// 通用东财行情兜底：当腾讯（个股/指数/ETF）无数据时，直接用 fetchQuotesEM 走 ulist.np
async function fetchQuoteEMFallback(codes) {
  return fetchQuotesEM(codes);
}

// 东方财富板块当日分时走势（trends2 返回 09:30~15:00 每分钟）
// 每条格式：时间,开盘,收盘,最高,最低,成交量,成交额,均价 → 取收盘 p[2] 画分时更准
async function fetchMinuteEM(code) {
  const secid = secidOf(code);
  const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' };
  const query = `secid=${encodeURIComponent(secid)}`
    + `&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13`
    + `&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ut=fa5fd1943c7b386f172d6893dbfba10b`
    + `&iscr=0&ndays=1`;
  try {
    console.log('[EM minute] secid=', secid);
    const j = await emGetJSON('/api/qt/stock/trends2/get', query, H);
    const tr = (j.data && j.data.trends) || [];
    console.log('[EM minute] trendsLen=', tr.length);
    let prevV = 0, prevA = 0;
    return tr.map(s => {
      const p = String(s).split(',');
      const cumV = parseFloat(p[5]) || 0;
      const cumA = parseFloat(p[6]) || 0;
      const dV = cumV >= prevV ? cumV - prevV : cumV;
      const dA = cumA >= prevA ? cumA - prevA : cumA;
      prevV = cumV; prevA = cumA;
      return {
        t: (p[0] || '').slice(11),
        p: parseFloat(p[2]),
        v: dV,
        amount: dA,
        avg: parseFloat(p[7]) || 0,
      };
    }).filter(d => !isNaN(d.p));
  } catch (e) { console.error('[EM minute] ERROR', e); return []; }
}

// 东方财富板块当日分时走势（批量：并行单码请求；失败码留空不影响其它）
async function fetchMinutesEM(codes) {
  const out = {};
  await Promise.all(codes.map(async code => {
    out[code] = await fetchMinuteEM(code);
  }));
  return out; // { code: [{t,p}] }
}

// 分时走势：web.ifzq.gtimg.cn 返回当日每分钟价格序列
// 每行格式：时间 价格 累计成交量 累计成交额
async function fetchMinute(code) {
  // 腾讯 minute 接口不支持期货（fu 开头），会返回 HTML 错误页；直接返回空让调用方 fallback 东财
  if (/^fu/i.test(code)) return [];
  // 注意：web.ifzq.gtimg.cn 现在会被腾讯 WAF 拦截（返回 501 + 跳转页，JSON 解析必失败），
  // 必须用不带 web. 的 ifzq.gtimg.cn；休市后该接口仍返回上一交易日全天分时，可直接画图。
  const url = `https://ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`;
  const resp = await fetchWithTimeout(url, 8000);
  const obj = await resp.json();
  const node = obj && obj.data && (obj.data[code] || obj.data[code.toUpperCase()]);
  if (!node || !node.data || !Array.isArray(node.data.data)) return [];
  let prevV = 0, prevA = 0;
  return node.data.data.map(line => {
    const parts = String(line).split(/\s+/);
    const cumV = parseFloat(parts[2]) || 0;
    const cumA = parseFloat(parts[3]) || 0;
    const dV = cumV >= prevV ? cumV - prevV : cumV;
    const dA = cumA >= prevA ? cumA - prevA : cumA;
    prevV = cumV; prevA = cumA;
    return { t: parts[0] || '', p: parseFloat(parts[1]), v: dV, amount: dA };
  }).filter(d => !isNaN(d.p));
}

// 名称/代码搜索：smartbox.gtimg.cn 返回 v_hint="market~code~name~pinyin~type;..."
async function fetchSuggest(keyword) {
  const url = `https://smartbox.gtimg.cn/s3/?v=2&t=all&q=${encodeURIComponent(keyword)}`;
  const resp = await fetchWithTimeout(url, 8000);
  const buf = Buffer.from(await resp.arrayBuffer());
  const text = new TextDecoder('gbk').decode(buf);
  const m = text.match(/v_hint="([^"]*)"/);
  if (!m) return [];
  return m[1].split(';').map(seg => {
    const p = seg.split('~');
    if (p.length < 3) return null;
    const market = p[0], num = p[1], name = p[2];
    if (!market || !num || !name) return null;
    let code;
    if (market === 'hk') code = 'hk' + num;
    else if (market === 'sh' || market === 'sz' || market === 'bj') code = market + num;
    else code = num; // 未知市场回退为原代码
    return { code, name, market };
  }).filter(Boolean).slice(0, 12);
}

// 全市场 A 股实时行情（东方财富 clist），用于本地统计涨跌家数/成交额/分布
// f2=最新价 f3=涨跌幅 f4=涨跌额 f5=成交量 f6=成交额 f7=振幅 f8=换手率 f9=量比 f12=代码 f14=名称 f15=最高 f16=最低 f17=今开 f18=昨收
async function fetchMarketSummaryEM() {
  const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' };
  const fields = 'f2,f3,f4,f5,f6,f7,f8,f9,f12,f14,f15,f16,f17,f18,f100';
  // push2delay 每页上限 100，这里翻页拉全（沪深京全市场，含北交所，total≈5800）。
  // 北交所需 m:0+t:81+s:2048（仅 m:0+t:81 是北交所人气榜 Top100，非全量）。
  const diff = await fetchClistPages('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048', fields, { pz: 100, max: 8000, fid: 'f3' });
  return diff.map(d => ({
    code: String(d.f12 || ''),
    name: String(d.f14 || ''),
    price: (typeof d.f2 === 'number') ? d.f2 : (parseFloat(d.f2) || 0),
    chgPct: (typeof d.f3 === 'number') ? d.f3 : (parseFloat(d.f3) || 0),
    chg: (typeof d.f4 === 'number') ? d.f4 : (parseFloat(d.f4) || 0),
    volume: (typeof d.f5 === 'number') ? d.f5 : (parseFloat(d.f5) || 0),
    amount: (typeof d.f6 === 'number') ? d.f6 : (parseFloat(d.f6) || 0),
    amplitude: (typeof d.f7 === 'number') ? d.f7 : (parseFloat(d.f7) || 0),
    turnover: (typeof d.f8 === 'number') ? d.f8 : (parseFloat(d.f8) || 0),
    volumeRatio: (typeof d.f9 === 'number') ? d.f9 : (parseFloat(d.f9) || 0),
    industry: String(d.f100 || ''),
    high: (typeof d.f15 === 'number') ? d.f15 : (parseFloat(d.f15) || 0),
    low: (typeof d.f16 === 'number') ? d.f16 : (parseFloat(d.f16) || 0),
    open: (typeof d.f17 === 'number') ? d.f17 : (parseFloat(d.f17) || 0),
    prevClose: (typeof d.f18 === 'number') ? d.f18 : (parseFloat(d.f18) || 0),
  })).filter(x => x.code && x.code.length === 6 && /^[\d]{6}$/.test(x.code));
}

// 新浪全市场兜底：东财 clist 被限流/封禁时（实测会 ERR_EMPTY_RESPONSE / socket hang up），
// 新浪这个接口仍稳定可用；100 条/页，约 55 页、20 秒左右拉完全市场。
// 字段：symbol=sh600519 code=600519 trade=现价 settlement=昨收 changepercent=涨跌幅% amount=成交额(元)
async function fetchMarketSummarySina() {
  const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' };
  const BASE = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
  const out = [];
  const seen = new Set();
  for (let pn = 1; pn <= 80; pn++) {
    const url = `${BASE}?page=${pn}&num=100&sort=symbol&asc=1&node=hs_a&_s_r_a=page`;
    let rows = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchWithTimeout(url, 12000, H);
        const j = await r.json();
        if (Array.isArray(j)) { rows = j; break; }
      } catch (e) {
        if (attempt === 0) await new Promise(res => setTimeout(res, 600));
      }
    }
    if (!rows || rows.length === 0) break; // 空页 = 已拉完
    for (const d of rows) {
      const code = String(d.code || '').replace(/\D/g, '');
      if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        name: String(d.name || ''),
        price: parseFloat(d.trade) || 0,
        prevClose: parseFloat(d.settlement) || 0,
        chg: (typeof d.pricechange === 'number') ? d.pricechange : (parseFloat(d.pricechange) || 0),
        chgPct: (typeof d.changepercent === 'number') ? d.changepercent : (parseFloat(d.changepercent) || 0),
        volume: parseFloat(d.volume) || 0,
        amount: parseFloat(d.amount) || 0,
        high: parseFloat(d.high) || 0,
        low: parseFloat(d.low) || 0,
        open: parseFloat(d.open) || 0,
      });
    }
  }
  console.log('[EM] sina market len=', out.length);
  return out;
}

// 全市场快照入口：东财优先（一次翻页约 55 页），数据不完整或失败时走新浪兜底。
// 上层（main.js）还会再做一层「最近一次成功统计」磁盘缓存，三者叠加保证涨跌分布不空白。
async function fetchMarketSummary() {
  try {
    const em = await fetchMarketSummaryEM();
    if (em && em.length >= 4000) return em; // 只回了部分页 → 视为失败，改用新浪拉全
    console.log('[EM] market em incomplete len=', em && em.length);
  } catch (e) {
    console.log('[EM] market em FAIL', e.message);
  }
  return await fetchMarketSummarySina();
}

// 涨跌趋势：每分钟的上涨/下跌家数（东方财富）
// 东财没有公开免费的分钟级涨跌家数历史，这里用上证指数分时均价来模拟绘制趋势感；
// 更准的做法是在主进程每分钟基于 fetchMarketSummary 统计并缓存到内存。
async function fetchMarketTrend() {
  return null;
}

// ---------- 通用东财榜单/板块/ETF 抓取 ----------
// 用同一套 clist 接口按不同 fs（过滤串）拉取：人气榜、涨停板、行业/概念板块、ETF、板块成分股。
// 字段含义（部分）：f2=现价 f3=涨跌幅% f4=涨跌额 f6=成交额(元) f8=换手率% f9=量比
//   f12=代码 f14=名称 f15=最高 f16=最低 f17=今开 f18=昨收
//   f62=主力净流入(元) f104=涨速 f128=领涨股名称
// fs 示例：m:0+t:81(人气榜) m:0+t:9(涨停) m:90+t:2(行业板块) m:90+t:3(概念板块) m:1+t:5(场内基金/ETF) b:BK0735(板块成分股)
const CLIST_FIELDS = 'f2,f3,f4,f6,f8,f9,f12,f14,f15,f16,f17,f18,f62,f104,f128';

async function fetchClistRaw(fs, { pz = 500, po = 1, fid = 'f3', fields = CLIST_FIELDS } = {}) {
  const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' };
  // 注意 fs 含 , 与 : ，按现有 fetchMarketSummary 惯例不编码，直接拼进 query
  const query = `pn=1&pz=${pz}&po=${po}&np=1&fltt=2&invt=2&fid=${fid}&fs=${fs}&fields=${fields}`;
  const j = await emGetJSON('/api/qt/clist/get', query, H, 12000);
  return (j && j.data && j.data.diff) || [];
}

// 翻页抓取：push2delay 每页最多返回 100 条（实测 pz=8000 仍只回 100），
// 全市场 / ETF 板块等需要凑齐全部，这里按 data.total 自动翻页（限并发，避免爆量）。
async function fetchClistPages(fs, fields, { pz = 100, max = 8000, fid = 'f3' } = {}) {
  const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' };
  // host 上限为 100，分页的每页大小必须按 100 算，否则按传入 pz 算页数会少翻导致数据不全
  const ps = Math.min(pz || 100, 100);
  const query = (pn) => `pn=${pn}&pz=${ps}&po=1&np=1&fltt=2&invt=2&fid=${fid}&fs=${fs}&fields=${fields}`;
  let diff = [];
  let total = 0;
  try {
    const first = await emGetJSON('/api/qt/clist/get', query(1), H, 12000);
    diff = (first && first.data && first.data.diff) || [];
    total = (first && first.data && first.data.total) || diff.length;
  } catch (e) { console.error('[clistPages] first page FAIL', e.message); }
  if (total > diff.length && total <= max) {
    const pages = Math.ceil(total / ps);
    const tasks = [];
    for (let pn = 2; pn <= pages; pn++) tasks.push(pn);
    let qi = 0;
    const N = Math.min(6, tasks.length);
    const worker = async () => {
      while (qi < tasks.length) {
        const pn = tasks[qi++];
        try {
          const j = await emGetJSON('/api/qt/clist/get', query(pn), H, 12000);
          const d = (j && j.data && j.data.diff) || [];
          if (d.length) diff = diff.concat(d);
        } catch (e) { /* 单页失败忽略，不影响其它页 */ }
      }
    };
    await Promise.all(Array.from({ length: N }, () => worker()));
  }
  return diff;
}

// 把东财 f12 代码规范化为内部 code（A股/ETF → sh/sz/bj 前缀；板块 → bk 前缀；期货 → fu 前缀）
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
  if (digits.startsWith('920')) mkt = 'bj'; // 北交所新代码段 920xxx：'9' 开头但属北交所，误归沪市会导致腾讯/东财都查不到
  else if (first === '6' || first === '9' || first === '5') mkt = 'sh';
  else if (first === '8' || first === '4') mkt = 'bj';
  else mkt = 'sz'; // 0/3/1/2 等
  return mkt + digits;
}

// ---------- 指数分组（按同花顺/东财截图分组） ----------
const INDEX_GROUPS = [
  { key: 'china', name: '中国指数', codes: ['sh000001','sz399001','sz399006','sh000510','sh000985','sh000002'] },
  { key: 'market', name: '大盘指数', codes: ['sh000300','sh000905','sh000852','sh000906','sh000001','sh000698'] },
  { key: 'fifty', name: '50指数', codes: ['sh000016','sz399673','bj899050','sh000688','sz399850','sh000010'] },
  { key: 'hk', name: '港股指数', codes: ['hkHSI','hkHSTECH','hkHSCCI','hkHSCEI'] }
];

async function fetchIndicesGroups() {
  const allCodes = [...new Set(INDEX_GROUPS.flatMap(g => g.codes))];
  const hkCodes = allCodes.filter(c => /^hk/i.test(c));
  const emCodes = allCodes.filter(c => !/^hk/i.test(c));
  const map = {};
  // A股/ETF 类指数走东财 ulist.np（已验证 sh000001/sh000300 等可取到）
  if (emCodes.length) {
    try {
      const q = await fetchQuotesEM(emCodes);
      q.forEach(x => { map[x.code] = x; });
    } catch (e) { console.error('[indices] EM FAIL', e.message); }
  }
  // 港股指数东财 116.HSI 取不到，改走腾讯 hkHSI（已验证有数据）
  if (hkCodes.length) {
    try {
      const q = parseQuotes(await fetchQuotes(hkCodes));
      q.forEach(x => { if (x.name) map[x.code] = x; });
    } catch (e) { console.error('[indices] Tencent HK FAIL', e.message); }
  }
  return INDEX_GROUPS.map(g => ({
    key: g.key,
    name: g.name,
    items: g.codes.map(code => map[code] || { code, name: code.replace(/^\D+/, ''), price: 0, change: 0, changePct: 0 })
  }));
}

// ---------- 热榜（资金/活跃榜）详情 ----------
// 注：东财 clist 的 m:0+t:81 实为「新三板/NEEQ」（920xxx 等约 6846 只），并非 A股人气榜，
// 之前误用会导致热榜满是新三板股票。这里改为真实沪深A股全市场（含创业板/科创板），
// 热度列 = 真实成交额（亿元），按成交额或涨跌幅排序，数据真实可靠。
async function fetchHotDetail({ pz = 50, fid = 'f6' } = {}) {
  const fields = 'f2,f3,f4,f6,f8,f62,f12,f14';
  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
  const diff = await fetchClistRaw(fs, { pz, fid, fields });
  return diff.map(d => {
    const price = (typeof d.f2 === 'number') ? d.f2 : parseFloat(d.f2) || 0;
    const chgPct = (typeof d.f3 === 'number') ? d.f3 : parseFloat(d.f3) || 0;
    const amount = (typeof d.f6 === 'number') ? d.f6 : parseFloat(d.f6) || 0;
    // 热度 = 真实成交额（亿元），不再用含排名位置的虚假 proxy
    const heat = Math.round(amount / 1e8);
    return {
      code: normCode(d.f12),
      name: String(d.f14 || ''),
      price,
      chgPct,
      chg: (typeof d.f4 === 'number') ? d.f4 : parseFloat(d.f4) || 0,
      amount,
      turnover: (typeof d.f8 === 'number') ? d.f8 : parseFloat(d.f8) || 0,
      mainNet: (typeof d.f62 === 'number') ? d.f62 : parseFloat(d.f62) || 0, // 主力净流入(元)
      leading: '',
      leadingChgPct: 0,
      heat
    };
  }).filter(x => x.name);
}

// ---------- 板块完整字段 ----------
// f2 最新价 f3 涨跌幅 f4 涨跌额 f6 成交额 f8 换手率 f9 量比 f20 总市值 f102 今年涨跌幅 f104 涨速 f128 领涨股 f129 领涨股涨幅
const SECTOR_FIELDS = 'f2,f3,f4,f6,f8,f9,f12,f14,f20,f62,f102,f104,f128,f129';
async function fetchSectorsFull(type = 'industry', { pz = 100, fid = 'f3' } = {}) {
  const fs = type === 'concept' ? 'm:90+t:3' : 'm:90+t:2';
  // 翻页拉全（行业/概念板块实际各有数百个，单页会被 push2delay 卡在 100）
  const diff = await fetchClistPages(fs, SECTOR_FIELDS, { pz, max: 1500, fid });
  return diff.map(d => ({
    code: normCode(d.f12),
    name: String(d.f14 || ''),
    price: (typeof d.f2 === 'number') ? d.f2 : parseFloat(d.f2) || 0,
    chgPct: (typeof d.f3 === 'number') ? d.f3 : parseFloat(d.f3) || 0,
    chg: (typeof d.f4 === 'number') ? d.f4 : parseFloat(d.f4) || 0,
    amount: (typeof d.f6 === 'number') ? d.f6 : parseFloat(d.f6) || 0,
    turnover: (typeof d.f8 === 'number') ? d.f8 : parseFloat(d.f8) || 0,
    pe: (typeof d.f9 === 'number') ? d.f9 : parseFloat(d.f9) || 0, // 板块维度 f9 为市盈率或量比，展示为“估值/活跃度”
    marketCap: (typeof d.f20 === 'number') ? d.f20 : parseFloat(d.f20) || 0,
    mainNet: (typeof d.f62 === 'number') ? d.f62 : parseFloat(d.f62) || 0, // 主力净流入(元)
    ytd: (typeof d.f102 === 'number') ? d.f102 : parseFloat(d.f102) || 0,
    speed: (typeof d.f104 === 'number') ? d.f104 : parseFloat(d.f104) || 0,
    leading: String(d.f128 || ''),
    leadingChgPct: (typeof d.f129 === 'number') ? d.f129 : parseFloat(d.f129) || 0,
  })).filter(x => x.name);
}

// ---------- ETF 完整字段 ----------
// f2 最新价 f3 涨跌幅 f4 涨跌额 f5 成交量 f6 成交额 f8 换手率 f12 代码 f14 名称 f20 基金规模 f128 跟踪指数
const ETF_FIELDS = 'f2,f3,f4,f5,f6,f8,f12,f14,f20,f128';
// 东财 ETF 板块：b:MK0021（实测 1268 只真实 ETF，含规模 f20）
const ETF_FS = 'b:MK0021';
const ETF_CATEGORIES = {
  all: { name: '全部ETF', fs: ETF_FS },
  china: { name: '中概互联', fs: ETF_FS },
  hkmed: { name: '港股医疗', fs: ETF_FS },
  hkdiv: { name: '港股红利', fs: ETF_FS },
  gold: { name: '黄金ETF', fs: ETF_FS },
  cross: { name: '跨境ETF', fs: ETF_FS },
  other: { name: '其他ETF', fs: ETF_FS }
};
const ETF_KEYWORDS = {
  china: ['中概','互联','中国','CHINA','KWEB'],
  hkmed: ['港股医','港股药','医疗','医药'],
  hkdiv: ['港股红利','高股息','红利','dividend'],
  gold: ['黄金','gold','AU'],
  cross: ['跨境','港','美','德','日','越','沙特','新加坡','东南亚','法国','德国','亚太','全球'],
};
async function fetchEtfFull(category = 'all', { pz = 300, fid = 'f6' } = {}) {
  const cfg = ETF_CATEGORIES[category] || ETF_CATEGORIES.all;
  // 翻页拉全（b:MK0021 实际约 1268 只，单页会被 push2delay 卡在 100）
  const diff = await fetchClistPages(cfg.fs, ETF_FIELDS, { pz, max: 2000, fid });
  const all = diff.map(d => ({
    code: normCode(d.f12),
    name: String(d.f14 || ''),
    price: (typeof d.f2 === 'number') ? d.f2 : parseFloat(d.f2) || 0,
    chgPct: (typeof d.f3 === 'number') ? d.f3 : parseFloat(d.f3) || 0,
    chg: (typeof d.f4 === 'number') ? d.f4 : parseFloat(d.f4) || 0,
    volume: (typeof d.f5 === 'number') ? d.f5 : parseFloat(d.f5) || 0,
    amount: (typeof d.f6 === 'number') ? d.f6 : parseFloat(d.f6) || 0,
    turnover: (typeof d.f8 === 'number') ? d.f8 : parseFloat(d.f8) || 0,
    scale: (typeof d.f20 === 'number') ? d.f20 : parseFloat(d.f20) || 0,
    tracking: String(d.f128 || '')
  })).filter(x => x.name);
  if (category === 'all') return all;
  // “其他ETF” = 未被其它分类关键词命中的 ETF（补集），避免恒为空
  if (category === 'other') {
    const matched = new Set();
    for (const cat of Object.keys(ETF_KEYWORDS)) {
      const kws = ETF_KEYWORDS[cat] || [];
      if (!kws.length) continue;
      all.forEach(x => {
        const hay = (x.name + x.tracking).toUpperCase();
        if (kws.some(k => hay.includes(k.toUpperCase()))) matched.add(x.code);
      });
    }
    return all.filter(x => !matched.has(x.code));
  }
  const kws = ETF_KEYWORDS[category] || [];
  return all.filter(x => {
    const hay = (x.name + x.tracking).toUpperCase();
    return kws.some(k => hay.includes(k.toUpperCase()));
  });
}

// ---------- 涨跌分布完整统计（备用；主路径用 main.js 的 buildMarketSummary） ----------
// 涨停/跌停按板块涨跌幅限制判定（主板10%/创业板科创板20%/ST5%/北交所30%）
function limitPctOfQ(code, name) {
  const n = String(name || '');
  if (/^(?:\*?ST\b|\*ST)/i.test(n) || /^ST\s/i.test(n)) return 5;
  const c = String(code || '');
  if (/^8|^4|92/.test(c)) return 30;
  if (/^688|^689/.test(c)) return 20;
  if (/^30/.test(c)) return 20;
  return 10;
}
function buildMarketFull(list) {
  const up = list.filter(d => d.chgPct > 0).length;
  const down = list.filter(d => d.chgPct < 0).length;
  const flat = list.filter(d => d.chgPct === 0).length;
  const limitUp = list.filter(d => { const L = limitPctOfQ(d.code, d.name); return d.chgPct >= L - 0.10; }).length;
  const limitDown = list.filter(d => { const L = limitPctOfQ(d.code, d.name); return d.chgPct <= -L + 0.10; }).length;
  const amount = list.reduce((s, d) => s + d.amount, 0);
  const dist = {
    '>10%': 0, '7~10%': 0, '5~7%': 0, '3~5%': 0, '0~3%': 0,
    '0': 0, '0~-3%': 0, '-3~-5%': 0, '-5~-7%': 0, '-7~-10%': 0, '<-10%': 0
  };
  list.forEach(d => {
    const p = d.chgPct;
    if (p > 10) dist['>10%']++;
    else if (p > 7) dist['7~10%']++;
    else if (p > 5) dist['5~7%']++;
    else if (p > 3) dist['3~5%']++;
    else if (p > 0) dist['0~3%']++;
    else if (p === 0) dist['0']++;
    else if (p > -3) dist['0~-3%']++;
    else if (p > -5) dist['-3~-5%']++;
    else if (p > -7) dist['-5~-7%']++;
    else if (p > -10) dist['-7~-10%']++;
    else dist['<-10%']++;
  });
  return { up, down, flat, limitUp, limitDown, amount, distribution: dist };
}
