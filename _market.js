// 相場データと分析（api/voice.js から使う。ファイル名が _ で始まるので、Vercelでは単独のAPIにならない）
//
// データの取得元:
//   1) Yahoo Finance（世界の株価指数・個別株・為替・金利・商品・暗号資産。キー不要）
//   2) Stooq（Yahooが取れないときの予備。日足のみ）
// 数値はすべてここで計算し、AIには計算済みの値だけを渡す（AIに暗算させない）

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DAY = 864e5;
const JST = 9 * 3600e3;

// ---------------------------------------------------------------- 表示名
const NAMES = {
  "^N225": "日経平均", "1306.T": "TOPIX連動ETF(1306)", "^GSPC": "S&P500", "^IXIC": "ナスダック総合", "^NDX": "ナスダック100",
  "^DJI": "NYダウ", "^SOX": "フィラデルフィア半導体(SOX)", "^RUT": "ラッセル2000", "^VIX": "VIX(恐怖指数)",
  "^STOXX50E": "ユーロ・ストックス50", "^GDAXI": "独DAX", "^FTSE": "英FTSE100", "^FCHI": "仏CAC40",
  "^HSI": "香港ハンセン", "000001.SS": "上海総合", "^KS11": "韓国KOSPI", "^TWII": "台湾加権", "^BSESN": "インドSENSEX",
  "USDJPY=X": "ドル円", "EURJPY=X": "ユーロ円", "EURUSD=X": "ユーロドル", "GBPJPY=X": "ポンド円", "AUDJPY=X": "豪ドル円",
  "CNY=X": "ドル人民元", "DX-Y.NYB": "ドル指数", "^TNX": "米10年債利回り", "^FVX": "米5年債利回り", "^IRX": "米13週債利回り", "^TYX": "米30年債利回り",
  "CL=F": "WTI原油", "BZ=F": "ブレント原油", "GC=F": "金(NY)", "SI=F": "銀(NY)", "HG=F": "銅", "NG=F": "天然ガス",
  "BTC-USD": "ビットコイン(ドル)", "ETH-USD": "イーサリアム(ドル)", "NIY=F": "日経平均先物(CME円建)",
};
const YIELD = new Set(["^TNX", "^FVX", "^IRX", "^TYX"]);

const OVERVIEW = {
  japan: ["^N225", "1306.T", "NIY=F"],
  us: ["^GSPC", "^IXIC", "^DJI", "^SOX", "^RUT", "^VIX"],
  europe: ["^STOXX50E", "^GDAXI", "^FTSE", "^FCHI"],
  asia: ["^HSI", "000001.SS", "^KS11", "^TWII", "^BSESN"],
  fx: ["USDJPY=X", "EURJPY=X", "EURUSD=X", "GBPJPY=X", "AUDJPY=X", "DX-Y.NYB"],
  rates: ["^IRX", "^FVX", "^TNX", "^TYX"],
  commodities: ["CL=F", "BZ=F", "GC=F", "SI=F", "HG=F", "NG=F"],
  crypto: ["BTC-USD", "ETH-USD"],
};
const REGION_JA = { japan: "日本", us: "米国", europe: "欧州", asia: "アジア", fx: "為替", rates: "米国債利回り", commodities: "商品", crypto: "暗号資産" };

const SECTORS = {
  us: [["XLK", "情報技術"], ["XLC", "通信サービス"], ["XLY", "一般消費財"], ["XLP", "生活必需品"], ["XLE", "エネルギー"], ["XLF", "金融"],
    ["XLV", "ヘルスケア"], ["XLI", "資本財"], ["XLB", "素材"], ["XLRE", "不動産"], ["XLU", "公益"]],
  japan: [["1617.T", "食品"], ["1618.T", "エネルギー資源"], ["1619.T", "建設・資材"], ["1620.T", "素材・化学"], ["1621.T", "医薬品"],
    ["1622.T", "自動車・輸送機"], ["1623.T", "鉄鋼・非鉄"], ["1624.T", "機械"], ["1625.T", "電機・精密"], ["1626.T", "情報通信・サービス"],
    ["1627.T", "電力・ガス"], ["1628.T", "運輸・物流"], ["1629.T", "商社・卸売"], ["1630.T", "小売"], ["1631.T", "銀行"],
    ["1632.T", "金融(除く銀行)"], ["1633.T", "不動産"]],
};

// ---------------------------------------------------------------- 取得
const cache = new Map();   // 同じデータを短時間に何度も取りに行かない（Vercelが温まっている間だけ有効）
function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = fn().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), p });
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return p;
}
async function fetchT(url, opt = {}, ms = 9000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opt, signal: ac.signal }); } finally { clearTimeout(timer); }
}

function normalizeSymbol(s) {
  let x = String(s || "").trim().replace(/[　\s]+/g, "").replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!x) return "";
  if (/^\d{4}$/.test(x) || /^\d{3}[A-Za-z]$/.test(x)) return x.toUpperCase() + ".T";      // 7203 → 7203.T、130A → 130A.T
  if (/^[A-Za-z]{6}$/.test(x) && /(JPY|USD|EUR|GBP|AUD|CNY|CHF|CAD|NZD)$/i.test(x)) return x.toUpperCase() + "=X";   // USDJPY → USDJPY=X
  return x.toUpperCase().replace(/\.T$/i, ".T");
}

async function yahooChart(symbol, range, interval = "1d") {
  let lastErr = "";
  for (const host of ["query1", "query2"]) {
    const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%7Csplit`;
    let r;
    try { r = await fetchT(url, { headers: { "User-Agent": UA, Accept: "application/json" } }); } catch (e) { lastErr = String(e.message || e); continue; }
    if (r.status === 404) throw new Error(`銘柄「${symbol}」が見つかりません`);
    if (!r.ok) { lastErr = `Yahoo ${r.status}`; continue; }
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res) { if (j && j.chart && j.chart.error) throw new Error(`銘柄「${symbol}」が見つかりません`); lastErr = "Yahoo empty"; continue; }
    const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
    const ts = res.timestamp || [];
    const rows = ts.map((t, i) => ({ t: t * 1000, o: q.open && q.open[i], h: q.high && q.high[i], l: q.low && q.low[i], c: q.close && q.close[i], v: (q.volume && q.volume[i]) || 0 }))
      .filter((x) => x.c != null && isFinite(x.c));
    if (!rows.length && res.meta && res.meta.regularMarketPrice == null) { lastErr = "no rows"; continue; }
    return { symbol, meta: res.meta || {}, rows, source: "Yahoo Finance" };
  }
  throw new Error(lastErr || "Yahoo error");
}

const STOOQ_MAP = { "^N225": "^nkx", "^GSPC": "^spx", "^DJI": "^dji", "^IXIC": "^ndq", "^NDX": "^ndx", "^GDAXI": "^dax", "^FTSE": "^ukx",
  "^FCHI": "^cac", "^HSI": "^hsi", "000001.SS": "^shc", "^KS11": "^kospi", "^TNX": "10usy.b", "^FVX": "5usy.b", "^TYX": "30usy.b",
  "CL=F": "cl.f", "BZ=F": "cb.f", "GC=F": "gc.f", "SI=F": "si.f", "HG=F": "hg.f", "NG=F": "ng.f", "BTC-USD": "btcusd", "ETH-USD": "ethusd", "DX-Y.NYB": "dx.f" };
function toStooq(sym) {
  if (STOOQ_MAP[sym]) return STOOQ_MAP[sym];
  let m;
  if ((m = /^(\d{4}|\d{3}[A-Z])\.T$/.exec(sym))) return m[1].toLowerCase() + ".jp";
  if ((m = /^([A-Z]{6})=X$/.exec(sym))) return m[1].toLowerCase();
  if (/^[A-Z][A-Z.\-]{0,6}$/.test(sym)) return sym.toLowerCase().replace(".", "-") + ".us";
  return null;
}
const RANGE_DAYS = { "5d": 10, "1mo": 35, "3mo": 100, "6mo": 190, "1y": 370, "2y": 740, "5y": 1830, ytd: 370 };
async function stooqDaily(symbol, range) {
  const s = toStooq(symbol);
  if (!s) throw new Error("予備データ源に対応していない銘柄です");
  const d2 = new Date(), d1 = new Date(Date.now() - (RANGE_DAYS[range] || 370) * DAY);
  const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const r = await fetchT(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d&d1=${ymd(d1)}&d2=${ymd(d2)}`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Stooq ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  if (!/^Date,/i.test(lines[0] || "")) throw new Error("Stooq: データなし");
  const rows = lines.slice(1).map((ln) => {
    const [d, o, h, l, c, v] = ln.split(",");
    const [y, mo, dd] = d.split("-").map(Number);
    return { t: Date.UTC(y, mo - 1, dd), o: +o, h: +h, l: +l, c: +c, v: +(v || 0) };
  }).filter((x) => isFinite(x.c) && x.c > 0);
  if (!rows.length) throw new Error("Stooq: データなし");
  const last = rows[rows.length - 1];
  const currency = /\.jp$/.test(s) ? "JPY" : /\.us$/.test(s) ? "USD" : /jpy$/.test(s) ? "JPY" : "";
  return { symbol, meta: { symbol, currency, regularMarketPrice: last.c, regularMarketTime: last.t / 1000, gmtoffset: 0, _daily: true }, rows, source: "Stooq（日足終値）" };
}

// 日足を取る（Yahoo → だめならStooq）
function getSeries(symbol, range = "1y") {
  return cached(`s|${symbol}|${range}`, 60e3, async () => {
    try { return await yahooChart(symbol, range); }
    catch (e) {
      if (/見つかりません/.test(e.message)) throw e;
      try { return await stooqDaily(symbol, range); }
      catch (e2) { throw new Error(`価格を取得できませんでした（${e.message} / ${e2.message}）`); }
    }
  });
}

// ---------------------------------------------------------------- 数値の整形
function fmtNum(v, digits) {
  if (v == null || !isFinite(v)) return "-";
  const a = Math.abs(v);
  const d = digits != null ? digits : a >= 1000 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  return Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
}
const sign = (v) => (v > 0 ? "+" : v < 0 ? "−" : "±");
function fmtPct(v, d = 2) { return v == null || !isFinite(v) ? "-" : `${sign(v)}${Math.abs(v).toFixed(d)}%`; }
function fmtChg(v, digits) { return v == null || !isFinite(v) ? "-" : `${sign(v)}${fmtNum(Math.abs(v), digits)}`; }
function fmtBig(v) {
  if (v == null || !isFinite(v)) return "-";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + "兆";
  if (a >= 1e8) return (v / 1e8).toFixed(1) + "億";
  if (a >= 1e4) return (v / 1e4).toFixed(1) + "万";
  return fmtNum(v, 0);
}
function fmtJst(ms) {
  const d = new Date(ms + JST);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
function fmtDay(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`; }

// ---------------------------------------------------------------- 現在値
function quoteFrom(series) {
  const { meta, rows } = series;
  const off = (meta.gmtoffset || 0) * 1000;
  const last = rows[rows.length - 1];
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : last && last.c;
  const mt = meta.regularMarketTime ? meta.regularMarketTime * 1000 : last ? last.t : Date.now();
  const dayKey = (t) => Math.floor((t + off) / DAY);
  let prev = null;
  if (rows.length >= 2) prev = dayKey(last.t) === dayKey(mt) ? rows[rows.length - 2].c : last.c;
  else prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
  const change = prev ? price - prev : null;
  const changePct = prev ? (change / prev) * 100 : null;
  return {
    symbol: series.symbol,
    name: NAMES[series.symbol] || meta.longName || meta.shortName || series.symbol,
    price, prev, change, changePct,
    currency: meta.currency || "",
    exchange: meta.fullExchangeName || meta.exchangeName || "",
    time: mt,
    daily: !!meta._daily,
    dayHigh: meta.regularMarketDayHigh, dayLow: meta.regularMarketDayLow, volume: meta.regularMarketVolume,
    source: series.source,
  };
}
async function getQuote(symbol) {
  const s = normalizeSymbol(symbol);
  return quoteFrom(await getSeries(s, "1mo"));
}
function quoteLine(q) {
  const unit = YIELD.has(q.symbol) ? "%" : q.currency && !/=X$|^\^|DX-Y/.test(q.symbol) ? ` ${q.currency}` : "";
  const when = q.daily ? `${fmtDay(q.time).slice(5)}終値（${q.source}）` : `${fmtJst(q.time)}時点`;
  return `${q.name}（${q.symbol}）: ${fmtNum(q.price)}${unit}  前日比 ${fmtChg(q.change)}（${fmtPct(q.changePct)}）  ${when}`;
}

async function quotesText(symbols) {
  const list = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))].slice(0, 12);
  if (!list.length) return "銘柄が指定されていません。";
  const res = await Promise.all(list.map((s) => getQuote(s).then(quoteLine).catch((e) => `${s}: 取得失敗（${e.message}）`)));
  return res.join("\n") + "\n出典: Yahoo Finance（日本株は約20分遅れの場合あり。取れない銘柄はStooqの日足終値で代替）";
}

async function overviewText(region) {
  const keys = !region || region === "all" ? Object.keys(OVERVIEW) : String(region).split(/[,\s]+/).filter((k) => OVERVIEW[k]);
  if (!keys.length) return "地域の指定が不正です（japan, us, europe, asia, fx, rates, commodities, crypto, all）。";
  const blocks = await Promise.all(keys.map(async (k) => {
    const lines = await Promise.all(OVERVIEW[k].map((s) => getQuote(s).then(quoteLine).catch(() => `${NAMES[s] || s}: 取得失敗`)));
    return `■${REGION_JA[k]}\n${lines.join("\n")}`;
  }));
  return blocks.join("\n") + "\n出典: Yahoo Finance。時刻は日本時間。前日比は直近営業日の終値との比較。";
}

// ---------------------------------------------------------------- 指標の計算
function sma(a, n, end = a.length) { if (end < n) return null; let s = 0; for (let i = end - n; i < end; i++) s += a[i]; return s / n; }
function emaSeries(a, n) {
  const k = 2 / (n + 1), out = new Array(a.length).fill(null);
  if (a.length < n) return out;
  let e = sma(a, n, n); out[n - 1] = e;
  for (let i = n; i < a.length; i++) { e = a[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function rsi(a, n = 14) {
  if (a.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function macd(a) {
  const e12 = emaSeries(a, 12), e26 = emaSeries(a, 26);
  const line = a.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
  const valid = line.filter((x) => x != null);
  if (valid.length < 9) return null;
  const sig = emaSeries(valid, 9);
  const n = valid.length;
  let cross = null;   // 直近10日以内のクロス
  for (let i = n - 1; i >= Math.max(1, n - 10); i--) {
    if (sig[i] == null || sig[i - 1] == null) break;
    const now = valid[i] - sig[i], before = valid[i - 1] - sig[i - 1];
    if (now > 0 && before <= 0) { cross = { type: "ゴールデンクロス", ago: n - 1 - i }; break; }
    if (now < 0 && before >= 0) { cross = { type: "デッドクロス", ago: n - 1 - i }; break; }
  }
  return { line: valid[n - 1], signal: sig[n - 1], hist: valid[n - 1] - sig[n - 1], cross };
}
function stdev(a) { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); }
function atr(rows, n = 14) {
  if (rows.length <= n) return null;
  const tr = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], p = rows[i - 1].c;
    const h = r.h != null ? r.h : r.c, l = r.l != null ? r.l : r.c;
    tr.push(Math.max(h - l, Math.abs(h - p), Math.abs(l - p)));
  }
  let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}
function logReturns(a) { const r = []; for (let i = 1; i < a.length; i++) r.push(Math.log(a[i] / a[i - 1])); return r; }
function annVol(a, n) { if (a.length < n + 1) return null; return stdev(logReturns(a.slice(-(n + 1)))) * Math.sqrt(252) * 100; }
function maxDrawdown(a) { let peak = -Infinity, dd = 0; for (const x of a) { peak = Math.max(peak, x); dd = Math.min(dd, x / peak - 1); } return dd * 100; }
function retN(a, n) { return a.length > n ? (a[a.length - 1] / a[a.length - 1 - n] - 1) * 100 : null; }
function slope(a, n, lag = 5) { const now = sma(a, n), before = sma(a, n, a.length - lag); return now != null && before != null ? ((now / before) - 1) * 100 : null; }

// 日付をそろえて日次リターンの相関・ベータを出す
function alignReturns(rowsA, rowsB) {
  const key = (t) => Math.floor(t / DAY);
  const mb = new Map(rowsB.map((r) => [key(r.t), r.c]));
  const pairs = rowsA.map((r) => [r.c, mb.get(key(r.t))]).filter((p) => p[1] != null);
  const ra = [], rb = [];
  for (let i = 1; i < pairs.length; i++) { ra.push(pairs[i][0] / pairs[i - 1][0] - 1); rb.push(pairs[i][1] / pairs[i - 1][1] - 1); }
  return [ra, rb];
}
function corrBeta(ra, rb) {
  const n = ra.length; if (n < 30) return null;
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (ra[i] - ma) * (rb[i] - mb); va += (ra[i] - ma) ** 2; vb += (rb[i] - mb) ** 2; }
  return { corr: cov / Math.sqrt(va * vb), beta: cov / vb, n };
}

// ---------------------------------------------------------------- 個別銘柄のテクニカル分析
async function analyzeText(symbolIn) {
  const symbol = normalizeSymbol(symbolIn);
  const isJp = /\.T$/.test(symbol);
  const bench = isJp ? "^N225" : /=X$|-USD$|=F$|^\^/.test(symbol) ? null : "^GSPC";
  const [series, bseries] = await Promise.all([getSeries(symbol, "2y"), bench ? getSeries(bench, "2y").catch(() => null) : null]);
  const q = quoteFrom(series);
  const rows = series.rows;
  const c = rows.map((r) => r.c);
  if (c.length < 30) return `${q.name}: 価格データが少なすぎて分析できません（${c.length}日分）。`;
  // 当日の途中の値が日足に入っていない場合に備え、最新値で最後の終値を置き換え
  if (q.price != null && Math.abs(c[c.length - 1] - q.price) / q.price > 1e-6) c[c.length - 1] = q.price;
  const p = c[c.length - 1];
  const y1 = c.slice(-252), r1 = rows.slice(-252);
  const vols = rows.map((r) => r.v || 0);

  const m = { 5: sma(c, 5), 25: sma(c, 25), 75: sma(c, 75), 200: sma(c, 200) };
  const s = { 5: slope(c, 5, 3), 25: slope(c, 25), 75: slope(c, 75), 200: slope(c, 200, 10) };
  const dev = (n) => (m[n] ? (p / m[n] - 1) * 100 : null);
  const r14 = rsi(c, 14);
  const md = macd(c);
  const bbM = sma(c, 20), bbS = stdev(c.slice(-20));
  const bbU = bbM + 2 * bbS, bbL = bbM - 2 * bbS;
  const pctB = (p - bbL) / (bbU - bbL) * 100;
  const a14 = atr(rows, 14);
  const hi52 = Math.max(...r1.map((r) => (r.h != null ? r.h : r.c))), lo52 = Math.min(...r1.map((r) => (r.l != null ? r.l : r.c)));
  const hi20 = Math.max(...rows.slice(-20).map((r) => (r.h != null ? r.h : r.c))), lo20 = Math.min(...rows.slice(-20).map((r) => (r.l != null ? r.l : r.c)));
  const hi60 = Math.max(...rows.slice(-60).map((r) => (r.h != null ? r.h : r.c))), lo60 = Math.min(...rows.slice(-60).map((r) => (r.l != null ? r.l : r.c)));
  const v20 = vols.slice(-21, -1).reduce((x, y) => x + y, 0) / 20;
  const vLast = vols[vols.length - 1];
  const turnover20 = rows.slice(-20).reduce((x, r) => x + r.c * (r.v || 0), 0) / 20;
  const yearStart = (() => { const yy = new Date(rows[rows.length - 1].t).getUTCFullYear(); const i = rows.findIndex((r) => new Date(r.t).getUTCFullYear() === yy); return i > 0 ? c[i - 1] : c[i]; })();

  let rel = null;
  if (bseries) {
    const [ra, rb] = alignReturns(r1, bseries.rows.slice(-260));
    rel = corrBeta(ra, rb);
    const bc = bseries.rows.map((r) => r.c);
    rel && (rel.bench = NAMES[bench], rel.ex3m = retN(c, 63) - retN(bc, 63), rel.ex1y = retN(c, 252) - retN(bc, 252));
  }

  // トレンド判定
  const po = m[5] > m[25] && m[25] > m[75];
  const poDown = m[5] < m[25] && m[25] < m[75];
  let trend = "もみ合い（方向感なし）";
  if (p > m[25] && m[25] > m[75] && s[25] > 0) trend = "上昇トレンド";
  else if (p < m[25] && m[25] < m[75] && s[25] < 0) trend = "下降トレンド";
  if (m[200]) trend += p > m[200] ? "（200日線より上：長期も上向き圏）" : "（200日線より下：長期は弱い圏）";

  const L = [];
  L.push(`【${q.name}（${symbol}）テクニカル分析】 ${q.daily ? fmtDay(q.time) + "終値" : fmtJst(q.time) + "時点"} / ${series.source}`);
  L.push(`現在値 ${fmtNum(p)} ${q.currency}  前日比 ${fmtChg(q.change)}（${fmtPct(q.changePct)}）`);
  L.push(`騰落率: 1週 ${fmtPct(retN(c, 5))} / 1カ月 ${fmtPct(retN(c, 21))} / 3カ月 ${fmtPct(retN(c, 63))} / 6カ月 ${fmtPct(retN(c, 126))} / 1年 ${fmtPct(retN(c, 252))} / 年初来 ${fmtPct((p / yearStart - 1) * 100)}`);
  L.push(`判定: ${trend}`);
  L.push(`移動平均（値・傾き・乖離）: 5日 ${fmtNum(m[5])}（${fmtPct(s[5])}・${fmtPct(dev(5))}） / 25日 ${fmtNum(m[25])}（${fmtPct(s[25])}・${fmtPct(dev(25))}） / 75日 ${fmtNum(m[75])}（${fmtPct(s[75])}・${fmtPct(dev(75))}）` + (m[200] ? ` / 200日 ${fmtNum(m[200])}（${fmtPct(s[200])}・${fmtPct(dev(200))}）` : " / 200日 データ不足"));
  L.push(`並び: ${po ? "5日>25日>75日（上昇のパーフェクトオーダー）" : poDown ? "5日<25日<75日（下降のパーフェクトオーダー）" : "混在"}`);
  L.push(`RSI(14): ${fmtNum(r14, 1)}${r14 >= 70 ? "（買われすぎ圏）" : r14 <= 30 ? "（売られすぎ圏）" : ""}`);
  if (md) L.push(`MACD: ${fmtNum(md.line)} / シグナル ${fmtNum(md.signal)} / ヒストグラム ${fmtChg(md.hist)}${md.cross ? `（${md.cross.ago === 0 ? "本日" : md.cross.ago + "日前"}に${md.cross.type}）` : ""}`);
  L.push(`ボリンジャー(20日±2σ): 上限 ${fmtNum(bbU)} / 中心 ${fmtNum(bbM)} / 下限 ${fmtNum(bbL)}  位置 ${fmtNum(pctB, 0)}%（0%=下限, 100%=上限）`);
  L.push(`値動きの大きさ: ATR(14) ${fmtNum(a14)}（株価の${fmtNum(a14 / p * 100, 2)}%）、年率ボラティリティ 20日 ${fmtNum(annVol(c, 20), 1)}% / 60日 ${fmtNum(annVol(c, 60), 1)}%、1年の最大下落率 ${fmtPct(maxDrawdown(y1), 1)}`);
  L.push(`高値・安値: 52週 ${fmtNum(hi52)}〜${fmtNum(lo52)}（高値まで ${fmtPct((hi52 / p - 1) * 100)}、安値から ${fmtPct((p / lo52 - 1) * 100)}） / 60日 ${fmtNum(hi60)}〜${fmtNum(lo60)} / 20日 ${fmtNum(hi20)}〜${fmtNum(lo20)}`);
  if (v20 > 0) L.push(`出来高: 直近 ${fmtBig(vLast)} / 20日平均 ${fmtBig(v20)}（${fmtNum(vLast / v20, 2)}倍）、20日平均売買代金 ${fmtBig(turnover20)}${q.currency === "JPY" ? "円" : " " + q.currency}`);
  if (rel) L.push(`${rel.bench}との関係(1年): 相関 ${fmtNum(rel.corr, 2)}、ベータ ${fmtNum(rel.beta, 2)}、超過リターン 3カ月 ${fmtPct(rel.ex3m)} / 1年 ${fmtPct(rel.ex1y)}`);

  if (isJp) {
    const ok = (b) => (b == null ? "－" : b ? "○" : "×");
    const c1 = p > m[5], c2 = po, c3 = s[5] > 0 && s[25] > 0 && s[75] > 0, c4 = v20 ? v20 >= 1e6 : null;
    L.push(`チャート条件チェック（押し目買い手法）: 5日線より上 ${ok(c1)} / パーフェクトオーダー ${ok(c2)} / 5・25・75日線が上向き ${ok(c3)} / 出来高100万株以上(20日平均) ${ok(c4)}`);
    const nearMA = [5, 25].map((n) => `${n}日線まで ${fmtPct((m[n] / p - 1) * 100)}`).join("、");
    L.push(`押し目の目安: ${nearMA}${po && dev(25) != null && dev(25) <= 3 ? "（上昇基調の中で25日線に近い＝押し目圏）" : ""}。需給（信用倍率・貸借倍率・回転日数）はこのデータには無いので、必要なら web_search で確認`);
  }
  return L.join("\n");
}

// ---------------------------------------------------------------- 財務・バリュエーション（Yahoo）
let crumbCache = null;
async function getCrumb() {
  if (crumbCache && Date.now() - crumbCache.at < 3600e3) return crumbCache;
  const r1 = await fetchT("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const raw = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [r1.headers.get("set-cookie")];
  const cookie = raw.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
  const r2 = await fetchT("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || /[<{\s]/.test(crumb)) throw new Error("認証情報を取得できません");
  crumbCache = { cookie, crumb, at: Date.now() };
  return crumbCache;
}
const rawv = (o) => (o == null ? null : typeof o === "number" ? o : o.raw != null ? o.raw : null);
async function fundamentalsText(symbolIn) {
  const symbol = normalizeSymbol(symbolIn);
  try {
    const { cookie, crumb } = await getCrumb();
    const mods = "price,summaryDetail,defaultKeyStatistics,financialData,calendarEvents,assetProfile";
    const r = await fetchT(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${mods}&crumb=${encodeURIComponent(crumb)}`,
      { headers: { "User-Agent": UA, Cookie: cookie, Accept: "application/json" } });
    if (r.status === 401) crumbCache = null;
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    const j = await r.json();
    const R = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
    if (!R) throw new Error("データなし");
    const pr = R.price || {}, sd = R.summaryDetail || {}, ks = R.defaultKeyStatistics || {}, fd = R.financialData || {}, ce = R.calendarEvents || {}, ap = R.assetProfile || {};
    const cur = pr.currency || "";
    const pct = (o) => { const v = rawv(o); return v == null ? null : `${(v * 100).toFixed(2)}%`; };
    const num = (o, d = 2) => { const v = rawv(o); return v == null ? null : fmtNum(v, d); };
    const big = (o) => { const v = rawv(o); return v == null ? null : fmtBig(v) + (cur === "JPY" ? "円" : " " + cur); };
    const date = (o) => { const v = rawv(o); return v == null ? null : fmtDay(v * 1000); };
    const items = [
      ["業種", [ap.sector, ap.industry].filter(Boolean).join(" / ") || null],
      ["時価総額", big(pr.marketCap || sd.marketCap)],
      ["PER(実績)", num(sd.trailingPE)], ["PER(予想)", num(sd.forwardPE || ks.forwardPE)], ["PBR", num(ks.priceToBook)],
      ["EV/EBITDA", num(ks.enterpriseToEbitda)], ["EPS(実績)", num(ks.trailingEps)], ["EPS(予想)", num(ks.forwardEps)],
      ["配当利回り", pct(sd.dividendYield) || pct(sd.trailingAnnualDividendYield)], ["1株配当", num(sd.dividendRate || sd.trailingAnnualDividendRate)],
      ["配当性向", pct(sd.payoutRatio)], ["権利落ち日", date(sd.exDividendDate || ce.exDividendDate)],
      ["売上成長率(前年比)", pct(fd.revenueGrowth)], ["利益成長率(前年比)", pct(fd.earningsGrowth)],
      ["営業利益率", pct(fd.operatingMargins)], ["純利益率", pct(fd.profitMargins)], ["ROE", pct(fd.returnOnEquity)],
      ["負債資本倍率(D/E, %)", num(fd.debtToEquity, 1)], ["現金", big(fd.totalCash)], ["有利子負債", big(fd.totalDebt)], ["フリーCF", big(fd.freeCashflow)],
      ["ベータ", num(sd.beta || ks.beta)],
      ["アナリスト目標株価(平均)", num(fd.targetMeanPrice)], ["目標株価レンジ", rawv(fd.targetLowPrice) != null ? `${num(fd.targetLowPrice)}〜${num(fd.targetHighPrice)}` : null],
      ["アナリスト評価", fd.recommendationKey ? `${fd.recommendationKey}（${rawv(fd.numberOfAnalystOpinions) || "?"}人）` : null],
      ["次回決算予定", ce.earnings && ce.earnings.earningsDate && ce.earnings.earningsDate.length ? ce.earnings.earningsDate.map(date).filter(Boolean).join("〜") : null],
      ["空売り比率(浮動株)", pct(ks.shortPercentOfFloat)], ["機関投資家保有比率", pct(ks.heldPercentInstitutions)],
    ].filter(([, v]) => v);
    if (!items.length) throw new Error("項目なし");
    return `【${pr.longName || pr.shortName || symbol}（${symbol}）財務・バリュエーション】 出典: Yahoo Finance\n` + items.map(([k, v]) => `${k}: ${v}`).join("\n") +
      "\n※日本株は項目が欠けたり更新が遅いことがある。会社予想・最新決算の内容は web_search で確認すること。";
  } catch (e) {
    return `財務データを取得できませんでした（${e.message}）。web_search で「${symbol} PER PBR 配当利回り 決算」などを調べて補ってください。`;
  }
}

// ---------------------------------------------------------------- 比較・セクター
const PERIOD_N = { "1d": 1, "1w": 5, "1m": 21, "3m": 63, "6m": 126, "1y": 252 };
const PERIOD_JA = { "1d": "1日", "1w": "1週間", "1m": "1カ月", "3m": "3カ月", "6m": "6カ月", "1y": "1年", ytd: "年初来" };
function periodReturn(c, rows, period) {
  if (period === "ytd") {
    const yy = new Date(rows[rows.length - 1].t).getUTCFullYear();
    const i = rows.findIndex((r) => new Date(r.t).getUTCFullYear() === yy);
    const base = i > 0 ? c[i - 1] : c[0];
    return (c[c.length - 1] / base - 1) * 100;
  }
  return retN(c, PERIOD_N[period] || 21);
}
async function compareText(symbolsIn, period = "3m") {
  const syms = [...new Set((symbolsIn || []).map(normalizeSymbol).filter(Boolean))].slice(0, 6);
  if (syms.length < 2) return "比較には2銘柄以上を指定してください。";
  if (!PERIOD_N[period] && period !== "ytd") period = "3m";
  const data = await Promise.all(syms.map((s) => getSeries(s, "2y").then((x) => x).catch((e) => ({ symbol: s, err: e.message }))));
  const ok = data.filter((d) => !d.err);
  const L = [`【比較（${PERIOD_JA[period]}）】`];
  for (const d of data) {
    if (d.err) { L.push(`${d.symbol}: 取得失敗（${d.err}）`); continue; }
    const q = quoteFrom(d), c = d.rows.map((r) => r.c);
    if (q.price != null) c[c.length - 1] = q.price;
    L.push(`${q.name}（${d.symbol}）: 騰落率 ${fmtPct(periodReturn(c, d.rows, period))}、年率ボラ(60日) ${fmtNum(annVol(c, 60), 1)}%、1年最大下落 ${fmtPct(maxDrawdown(c.slice(-252)), 1)}、RSI ${fmtNum(rsi(c), 1)}、現在値 ${fmtNum(q.price)} ${q.currency}`);
  }
  if (ok.length >= 2) {
    L.push("日次リターンの相関(1年):");
    for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
      const cb = corrBeta(...alignReturns(ok[i].rows.slice(-252), ok[j].rows.slice(-260)));
      L.push(`  ${ok[i].symbol} × ${ok[j].symbol}: ${cb ? fmtNum(cb.corr, 2) : "-"}`);
    }
  }
  return L.join("\n");
}
async function sectorsText(market = "us", period = "1d") {
  const list = SECTORS[market] || SECTORS.us;
  if (!PERIOD_N[period] && period !== "ytd") period = "1d";
  const rows = await Promise.all(list.map(async ([sym, ja]) => {
    try {
      const d = await getSeries(sym, period === "ytd" || period === "1y" ? "2y" : "1y");
      const q = quoteFrom(d); const c = d.rows.map((r) => r.c);
      if (q.price != null) c[c.length - 1] = q.price;
      const r = period === "1d" ? q.changePct : periodReturn(c, d.rows, period);
      return { ja, sym, r };
    } catch (_) { return { ja, sym, r: null }; }
  }));
  if (rows.every((x) => x.r == null)) return "業種別のデータを取得できませんでした。web_search で補ってください。";
  rows.sort((a, b) => (b.r == null ? -1e9 : b.r) - (a.r == null ? -1e9 : a.r));
  return `【${market === "japan" ? "日本（TOPIX-17業種ETF）" : "米国（S&P500セクターETF）"} 業種別騰落率・${PERIOD_JA[period]}】\n` +
    rows.map((x, i) => `${i + 1}. ${x.ja}（${x.sym}）${fmtPct(x.r)}`).join("\n") + "\n出典: Yahoo Finance";
}

// ---------------------------------------------------------------- 銘柄検索
async function searchSymbolText(query) {
  const q = String(query || "").trim();
  if (!q) return "検索語が空です。";
  try {
    const r = await fetchT(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&lang=ja-JP&region=JP`,
      { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    const j = await r.json();
    const qs = (j.quotes || []).filter((x) => x.symbol);
    if (!qs.length) return `「${q}」に当たる銘柄が見つかりません。日本株なら4桁の証券コード＋.T（例: 7203.T）で指定できます。`;
    return qs.map((x) => `${x.symbol}: ${x.longname || x.shortname || ""}（${x.exchDisp || x.exchange || ""}・${x.typeDisp || x.quoteType || ""}）`).join("\n");
  } catch (e) {
    return `銘柄検索に失敗しました（${e.message}）。日本株は証券コード＋.T、米国株はティッカーで指定してください。`;
  }
}

module.exports = {
  normalizeSymbol, getQuote, quotesText, overviewText, analyzeText, fundamentalsText, compareText, sectorsText, searchSymbolText,
  fmtNum, fmtPct, NAMES, OVERVIEW,
  _calc: { sma, emaSeries, rsi, macd, atr, annVol, maxDrawdown, retN, corrBeta, alignReturns, quoteFrom },
};
