// JARVIS サーバー側
//  POST /api/voice  … 入力(文字 or 録音) → AIが必要に応じて道具(天気・検索・予定・タイマー等)を使って返答
//  GET  /api/voice  … 使える機能の一覧（画面のパネル表示用）
//
// 入力(JSON):
//   { text } または { audio: base64, mime }
//   history: [{role, content}]  … 直近の会話
//   state:   { memories:[], memos:[], alarms:[{id,kind,label,at}] } … 画面側で保存している情報
// 出力(JSON):
//   { heard, reply, actions:[...], tools:[...] }
//   actions は画面側で実行するもの（タイマー設定・メモ保存など）

const market = require("./_market.js");

const GROQ = "https://api.groq.com/openai/v1";
const REASONING = process.env.GROQ_REASONING_EFFORT || "medium";   // low / medium / high（高いほど深く考えるが遅い）
const TZ = "Asia/Tokyo";
const JST_OFFSET = 9 * 3600e3;
const DAY = 864e5;

const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || "openai/gpt-oss-120b";
const FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || "llama-3.3-70b-versatile";
const SEARCH_MODEL = process.env.GROQ_SEARCH_MODEL || "groq/compound-mini";
const STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";
const USER_NAME = process.env.USER_NAME || "";
const USER_PROFILE = process.env.USER_PROFILE || "";
const DEFAULT_LOCATION = process.env.DEFAULT_LOCATION || "Fukui";
const ICS_URL = process.env.GCAL_ICS_URL || "";

// Whisperが無音のときに出しがちな定型文（無視する）
const STT_JUNK = [/ご視聴ありがとうございました/, /チャンネル登録/, /^(\s|[。、.])*$/, /^ありがとうございました。?$/];

// ======================================================================
// 時刻ヘルパー（すべて日本時間で扱う）
// ======================================================================
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
function jst(ms) {
  const d = new Date(ms + JST_OFFSET);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), w: d.getUTCDay() };
}
const p2 = (n) => String(n).padStart(2, "0");
function fmtDate(ms) { const t = jst(ms); return `${t.mo}月${t.d}日(${WEEK[t.w]})`; }
function fmtTime(ms) { const t = jst(ms); return `${t.h}:${p2(t.mi)}`; }
function fmtFull(ms) { return `${fmtDate(ms)} ${fmtTime(ms)}`; }
function isoDate(ms) { const t = jst(ms); return `${t.y}-${p2(t.mo)}-${p2(t.d)}`; }
// "YYYY-MM-DD" → その日の0時(JST)のms
function dayStart(s) { const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - JST_OFFSET : NaN; }

// ======================================================================
// Groq 呼び出し
// ======================================================================
async function groqChat(key, body) {
  const r = await fetch(`${GROQ}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Groq ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// メインモデルで失敗したら予備モデルで再挑戦
async function chat(key, messages, tools, noTools) {
  const models = [CHAT_MODEL, FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr;
  for (const model of models) {
    const body = { model, messages, temperature: 0.3, max_completion_tokens: 3500 };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = noTools ? "none" : "auto"; }
    if (/gpt-oss/.test(model)) body.reasoning_effort = REASONING;
    try {
      const j = await groqChat(key, body);
      return (j.choices && j.choices[0] && j.choices[0].message) || {};
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function transcribe(key, buf, mime) {
  const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), `voice.${ext}`);
  form.append("model", STT_MODEL);
  form.append("language", "ja");
  form.append("prompt", "ジャービス、");
  form.append("response_format", "json");
  const r = await fetch(`${GROQ}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!r.ok) throw new Error("文字起こしに失敗しました: " + (await r.text()).slice(0, 200));
  let t = ((await r.json()).text || "").trim().replace(/^ジャービス[、,\s]*/, "");
  if (STT_JUNK.some((re) => re.test(t))) t = "";
  return t;
}

// ======================================================================
// 道具（ツール）
// ======================================================================
function toolDefs() {
  const fn = (name, description, properties = {}, required = []) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  });
  const SYM = "銘柄コード。日本株は証券コード＋.T（例: 7203.T）、米国株はティッカー（例: NVDA）、指数は ^N225 / ^GSPC / ^IXIC / ^DJI / ^SOX、為替は USDJPY=X、金利は ^TNX、商品は GC=F / CL=F、暗号資産は BTC-USD。分からなければ先に search_symbol";
  const list = [
    fn("get_market_overview", "世界の市況を一覧で取得する（主要株価指数・為替・米国債利回り・商品・暗号資産の現在値と前日比）。「今日の相場は？」「世界の市場どう？」に使う。", {
      region: { type: "string", description: "all / japan / us / europe / asia / fx / rates / commodities / crypto（カンマ区切りで複数可）。省略時は all" },
    }),
    fn("get_quotes", "指定した銘柄・指数・為替などの現在値と前日比を取得する（最大12件）。", {
      symbols: { type: "array", items: { type: "string" }, description: SYM },
    }, ["symbols"]),
    fn("analyze_stock", "個別銘柄・指数・為替のテクニカル分析を行う（騰落率、移動平均と乖離・傾き、パーフェクトオーダー、RSI、MACD、ボリンジャー、ATR、ボラティリティ、52週高安、出来高、指数との相関・ベータ、日本株は押し目買い手法のチャート条件チェック）。", {
      symbol: { type: "string", description: SYM },
    }, ["symbol"]),
    fn("get_fundamentals", "個別株の財務・バリュエーション（時価総額、PER、PBR、配当利回り、配当性向、成長率、利益率、ROE、負債、アナリスト目標株価、次回決算日など）を取得する。", {
      symbol: { type: "string", description: SYM },
    }, ["symbol"]),
    fn("compare_assets", "複数の銘柄・指数・為替を比較する（期間騰落率、ボラティリティ、最大下落率、RSI、相互の相関）。", {
      symbols: { type: "array", items: { type: "string" }, description: "2〜6件。" + SYM },
      period: { type: "string", description: "1d / 1w / 1m / 3m / 6m / 1y / ytd（省略時 3m）" },
    }, ["symbols"]),
    fn("get_sector_performance", "業種（セクター）別の騰落率ランキングを取得する。どの業種が強い・弱いかを見るときに使う。", {
      market: { type: "string", description: "us（S&P500セクター）または japan（TOPIX-17業種）" },
      period: { type: "string", description: "1d / 1w / 1m / 3m / 6m / 1y / ytd（省略時 1d）" },
    }, ["market"]),
    fn("search_symbol", "会社名・指数名から銘柄コードを調べる。", {
      query: { type: "string", description: "会社名など（英語名の方が見つかりやすい。例: Toyota, Lasertec）" },
    }, ["query"]),
    fn("get_watchlist", "ユーザーのウォッチリスト全銘柄の現在値と前日比を取得する。"),
    fn("add_watchlist", "ウォッチリストに銘柄を追加する。", {
      symbols: { type: "array", items: { type: "string" }, description: SYM },
    }, ["symbols"]),
    fn("remove_watchlist", "ウォッチリストから銘柄を外す。", {
      keyword: { type: "string", description: "銘柄コードか名前の一部。全部なら「全部」" },
    }, ["keyword"]),
    fn("set_price_alert", "価格アラートを登録する（指定の価格を上回った/下回ったら声で知らせる。画面を開いている間、約2分ごとに確認）。", {
      symbol: { type: "string", description: SYM },
      condition: { type: "string", enum: ["above", "below"], description: "above=以上になったら / below=以下になったら" },
      price: { type: "number", description: "基準の価格" },
    }, ["symbol", "condition", "price"]),
    fn("cancel_price_alert", "価格アラートを取り消す。", {
      keyword: { type: "string", description: "銘柄コードか名前の一部。全部なら「全部」" },
    }, ["keyword"]),
    fn("get_weather", "天気・気温・降水確率を調べる。傘が要るか、服装の相談などにも使う。", {
      location: { type: "string", description: `地名をローマ字/英語で（例: Fukui, Kumamoto, Obama, Tokyo, Honolulu）。省略時は ${DEFAULT_LOCATION}` },
      country_code: { type: "string", description: "国コード（日本ならJP。海外なら US など）。省略時はJP" },
      days: { type: "integer", description: "何日先まで（1〜7）。省略時は3" },
    }),
    fn("web_search", "最新情報をWebで調べる。ニュース、株価・為替、営業時間、制度や商品の最新情報など、知識が古い可能性があるものは必ずこれを使う。", {
      query: { type: "string", description: "調べたい内容（日本語でよい）" },
    }, ["query"]),
    fn("calculate", "計算をする（四則演算・べき乗・%）。金額や利回りの計算は暗算せずこれを使う。", {
      expression: { type: "string", description: "数式。例: (1200000*0.03)/12, 2^10" },
    }, ["expression"]),
    fn("set_timer", "タイマーをセットする（〇分後に知らせる）", {
      seconds: { type: "integer", description: "何秒後か" },
      label: { type: "string", description: "タイマーの名前（例: パスタ）。省略可" },
    }, ["seconds"]),
    fn("set_reminder", "指定した日時に声で知らせるリマインダーを登録する（この画面を開いている間に知らせる）", {
      datetime: { type: "string", description: "日本時間の日時 YYYY-MM-DDTHH:MM（例: 2026-10-18T09:30）" },
      message: { type: "string", description: "知らせる内容" },
    }, ["datetime", "message"]),
    fn("cancel_alarm", "タイマーやリマインダーを取り消す", {
      keyword: { type: "string", description: "取り消すものの名前の一部。全部消すなら「全部」" },
    }, ["keyword"]),
    fn("remember", "ユーザーについて今後も覚えておくべきこと（好み・家族・決まりごと等）を記憶する。ユーザーに「覚えて」と言われたとき使う。", {
      fact: { type: "string", description: "覚える内容（短い一文）" },
    }, ["fact"]),
    fn("forget", "記憶していることを忘れる", {
      keyword: { type: "string", description: "忘れる内容の一部。全部なら「全部」" },
    }, ["keyword"]),
    fn("add_memo", "メモ・ToDo・買い物リストに追加する", {
      text: { type: "string", description: "メモの内容" },
    }, ["text"]),
    fn("delete_memo", "メモを消す（完了したToDoなど）", {
      keyword: { type: "string", description: "消すメモの一部。全部なら「全部」" },
    }, ["keyword"]),
  ];
  if (ICS_URL) {
    list.push(fn("get_calendar", "Googleカレンダーの予定を調べる。今日・明日・今週の予定、空いている時間などを聞かれたら使う。", {
      date_from: { type: "string", description: "開始日 YYYY-MM-DD（日本時間）" },
      date_to: { type: "string", description: "終了日 YYYY-MM-DD（この日を含む）" },
    }, ["date_from"]));
  }
  return list;
}

// ---------------- 天気（Open-Meteo：無料・キー不要） ----------------
const WMO = {
  0: "快晴", 1: "晴れ", 2: "晴れ時々くもり", 3: "くもり", 45: "霧", 48: "霧", 51: "弱い霧雨", 53: "霧雨", 55: "強い霧雨",
  56: "着氷性の霧雨", 57: "着氷性の霧雨", 61: "小雨", 63: "雨", 65: "強い雨", 66: "着氷性の雨", 67: "着氷性の雨",
  71: "小雪", 73: "雪", 75: "大雪", 77: "霧雪", 80: "にわか雨", 81: "にわか雨", 82: "激しいにわか雨",
  85: "にわか雪", 86: "強いにわか雪", 95: "雷雨", 96: "ひょうを伴う雷雨", 99: "ひょうを伴う激しい雷雨",
};
async function geocode(name, cc) {
  const tries = [name, name.replace(/(-?shi|-?city|-?machi|-?cho|市|町|村|県|府)$/i, "")];
  for (const q of tries) {
    if (!q || q.length < 2) continue;
    for (const code of [cc, ""]) {
      const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=ja&format=json${code ? `&countryCode=${code}` : ""}`;
      const r = await fetch(u);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.results && j.results.length) return j.results[0];
    }
  }
  return null;
}
async function getWeather(a) {
  const name = (a.location || DEFAULT_LOCATION).trim();
  const place = await geocode(name, (a.country_code || "JP").toUpperCase());
  if (!place) return `「${name}」の場所が見つかりませんでした。`;
  const days = Math.max(1, Math.min(7, a.days || 3));
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation` +
    `&hourly=precipitation_probability,weather_code,temperature_2m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=auto&forecast_days=${days}&wind_speed_unit=ms`;
  const r = await fetch(u);
  if (!r.ok) return "天気の取得に失敗しました。";
  const w = await r.json();
  const c = w.current || {};
  const lines = [`場所: ${place.name}${place.admin1 ? `（${place.admin1}）` : ""}`];
  lines.push(`現在: ${WMO[c.weather_code] || "不明"}、気温${c.temperature_2m}℃（体感${c.apparent_temperature}℃）、風速${c.wind_speed_10m}m/s`);
  // この先12時間の降水確率
  if (w.hourly && w.hourly.time) {
    const nowIdx = Math.max(0, w.hourly.time.findIndex((t) => t >= (c.time || "")));
    const seg = [];
    for (let i = nowIdx; i < Math.min(nowIdx + 12, w.hourly.time.length); i += 3) {
      seg.push(`${w.hourly.time[i].slice(11, 13)}時 ${w.hourly.precipitation_probability[i]}%`);
    }
    if (seg.length) lines.push(`この先の降水確率: ${seg.join(" / ")}`);
  }
  const dl = w.daily || {};
  (dl.time || []).forEach((t, i) => {
    lines.push(`${t}: ${WMO[dl.weather_code[i]] || "不明"}、最高${dl.temperature_2m_max[i]}℃ 最低${dl.temperature_2m_min[i]}℃、降水確率${dl.precipitation_probability_max[i]}%`);
  });
  return lines.join("\n");
}

// ---------------- Web検索（Groq Compound：検索込みのモデル） ----------------
async function webSearch(key, a) {
  try {
    const j = await groqChat(key, {
      model: SEARCH_MODEL,
      messages: [
        { role: "system", content: `今日は${isoDate(Date.now())}（日本時間）。Webを検索し、質問への答えを日本語で簡潔に（要点8行以内）まとめる。金融・相場の話題では、数値・発表日時・どの時点の情報かを必ず明記し、推測で数字を書かない。古い情報しか見つからない場合はそう書く。最後に主な出典サイト名を書く。` },
        { role: "user", content: String(a.query || "").slice(0, 300) },
      ],
      max_completion_tokens: 700,
    });
    return ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "検索結果がありませんでした。").slice(0, 2500);
  } catch (e) {
    return "検索に失敗しました: " + String(e.message || e).slice(0, 200);
  }
}

// ---------------- 計算（安全な式だけ） ----------------
function calculate(a) {
  let ex = String(a.expression || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[×xX]/g, "*").replace(/[÷]/g, "/").replace(/,/g, "").replace(/\^/g, "**").replace(/（/g, "(").replace(/）/g, ")");
  ex = ex.replace(/(\d+(?:\.\d+)?)%/g, "($1/100)");
  if (!/^[\d+\-*/().\s]+$/.test(ex) || ex.length > 200) return "計算できない式です。";
  try {
    const v = Function(`"use strict";return (${ex});`)();
    if (typeof v !== "number" || !isFinite(v)) return "計算結果が数値になりませんでした。";
    return `${a.expression} = ${Math.round(v * 1e6) / 1e6}`;
  } catch (_) { return "計算できない式です。"; }
}

// ---------------- 予定（GoogleカレンダーのiCal非公開URL） ----------------
function unfold(text) { return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, ""); }
function unesc(s) { return s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1"); }
function parseIcsDate(val, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(val.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || /VALUE=DATE(?!-)/.test(params || "")) {
    return { ms: Date.UTC(+y, +mo - 1, +d) - JST_OFFSET, allDay: true };
  }
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  // Z付きはUTC。それ以外（TZID付き含む）は日本時間とみなす
  return { ms: z ? utc : utc - JST_OFFSET, allDay: false };
}
function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text).split("\n")) {
    if (line === "BEGIN:VEVENT") { cur = { exdates: new Set() }; continue; }
    if (line === "END:VEVENT") { if (cur && cur.start != null) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const left = line.slice(0, i), val = line.slice(i + 1);
    const [name, ...ps] = left.split(";");
    const params = ps.join(";");
    switch (name) {
      case "SUMMARY": cur.summary = unesc(val); break;
      case "LOCATION": cur.location = unesc(val); break;
      case "UID": cur.uid = val; break;
      case "STATUS": cur.status = val; break;
      case "RRULE": cur.rrule = Object.fromEntries(val.split(";").map((kv) => kv.split("="))); break;
      case "DTSTART": { const t = parseIcsDate(val, params); if (t) { cur.start = t.ms; cur.allDay = t.allDay; } break; }
      case "DTEND": { const t = parseIcsDate(val, params); if (t) cur.end = t.ms; break; }
      case "EXDATE": val.split(",").forEach((v) => { const t = parseIcsDate(v, params); if (t) cur.exdates.add(t.ms); }); break;
      case "RECURRENCE-ID": { const t = parseIcsDate(val, params); if (t) cur.recurId = t.ms; break; }
    }
  }
  return events;
}
const BYDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
function expandEvent(ev, from, to) {
  const dur = (ev.end != null ? ev.end : ev.start + (ev.allDay ? DAY : 3600e3)) - ev.start;
  const out = [];
  if (!ev.rrule) { if (ev.start < to && ev.start + dur > from) out.push(ev.start); return out; }
  const r = ev.rrule, freq = r.FREQ, interval = +r.INTERVAL || 1;
  const count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? (parseIcsDate(r.UNTIL) || { ms: Infinity }).ms : Infinity;
  const L = new Date(ev.start + JST_OFFSET);
  let n = 0, i0 = 0;
  // 回数指定がない毎日・毎週は、範囲の手前まで一気に飛ばす
  if (count === Infinity && (freq === "DAILY" || freq === "WEEKLY")) {
    const step = (freq === "DAILY" ? 1 : 7) * interval * DAY;
    i0 = Math.max(0, Math.floor((from - ev.start - dur) / step) - 1);
  }
  for (let i = i0; i < i0 + 3000; i++) {
    let cands = [];
    if (freq === "DAILY") cands = [ev.start + i * interval * DAY];
    else if (freq === "WEEKLY") {
      const days = r.BYDAY ? r.BYDAY.split(",").map((d) => BYDAYS.indexOf(d.slice(-2))).filter((d) => d >= 0) : [L.getUTCDay()];
      const weekStart = ev.start - L.getUTCDay() * DAY + i * interval * 7 * DAY;
      cands = days.sort((a, b) => a - b).map((d) => weekStart + d * DAY).filter((t) => t >= ev.start);
    } else if (freq === "MONTHLY") {
      const base = new Date(Date.UTC(L.getUTCFullYear(), L.getUTCMonth() + i * interval, 1, L.getUTCHours(), L.getUTCMinutes()));
      const nth = r.BYDAY && /^(-?\d)(\w\w)$/.exec(r.BYDAY);
      if (nth) { // 例: 第2火曜(2TU)・最終金曜(-1FR)
        const wd = BYDAYS.indexOf(nth[2]), k = +nth[1];
        const y = base.getUTCFullYear(), mo = base.getUTCMonth();
        let d;
        if (k > 0) { const first = new Date(Date.UTC(y, mo, 1)).getUTCDay(); d = 1 + ((wd - first + 7) % 7) + (k - 1) * 7; }
        else { const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(); const lw = new Date(Date.UTC(y, mo, lastDay)).getUTCDay(); d = lastDay - ((lw - wd + 7) % 7) + (k + 1) * 7; }
        const dt = new Date(Date.UTC(y, mo, d, L.getUTCHours(), L.getUTCMinutes()));
        if (dt.getUTCMonth() === mo) cands = [dt.getTime() - JST_OFFSET];
      } else {
        base.setUTCDate(L.getUTCDate());
        if (base.getUTCDate() === L.getUTCDate()) cands = [base.getTime() - JST_OFFSET];
      }
      cands = cands.filter((t) => t >= ev.start);
    } else if (freq === "YEARLY") {
      const dt = new Date(L); dt.setUTCFullYear(L.getUTCFullYear() + i * interval);
      if (dt.getUTCDate() === L.getUTCDate()) cands = [dt.getTime() - JST_OFFSET];
    } else break;
    let stop = false;
    for (const t of cands) {
      if (t > until || n >= count || t >= to) { stop = true; break; }
      n++;
      if (t + dur > from && !ev.exdates.has(t)) out.push(t);
    }
    if (stop) break;
  }
  return out;
}
async function getCalendar(a) {
  if (!ICS_URL) return "カレンダーは未接続です。";
  const today = dayStart(isoDate(Date.now()));
  const from = isNaN(dayStart(a.date_from)) ? today : dayStart(a.date_from);
  let to = isNaN(dayStart(a.date_to)) ? from + DAY : dayStart(a.date_to) + DAY;
  if (to <= from) to = from + DAY;
  if (to - from > 31 * DAY) to = from + 31 * DAY;
  const r = await fetch(ICS_URL);
  if (!r.ok) return "カレンダーの取得に失敗しました。";
  const events = parseIcs(await r.text());
  const overridden = new Set(events.filter((e) => e.recurId != null).map((e) => `${e.uid}|${e.recurId}`));
  const items = [];
  for (const ev of events) {
    if (ev.status === "CANCELLED") continue;
    const dur = (ev.end != null ? ev.end : ev.start + (ev.allDay ? DAY : 3600e3)) - ev.start;
    for (const t of expandEvent(ev, from, to)) {
      if (ev.rrule && overridden.has(`${ev.uid}|${t}`)) continue;
      items.push({ t, end: t + dur, ev });
    }
  }
  items.sort((x, y) => x.t - y.t);
  const range = `${fmtDate(from)}〜${fmtDate(to - 1)}`;
  if (!items.length) return `${range} の予定はありません。`;
  return `${range} の予定（${items.length}件）:\n` + items.slice(0, 40).map(({ t, end, ev }) => {
    const when = ev.allDay ? `${fmtDate(t)} 終日` : `${fmtDate(t)} ${fmtTime(t)}〜${fmtTime(end)}`;
    return `${when} ${ev.summary || "(無題)"}${ev.location ? `（${ev.location}）` : ""}`;
  }).join("\n");
}

// ---------------- 画面側で実行する道具 ----------------
function matchList(list, keyword) {
  const k = String(keyword || "").trim();
  if (!k) return [];
  if (/^(全部|すべて|全て|all)$/i.test(k)) return list.slice();
  return list.filter((x) => String(x).includes(k));
}
function parseWhen(s) {
  s = String(s || "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - JST_OFFSET;
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) { // 時刻だけ → 今日（過ぎていれば明日）
    let t = dayStart(isoDate(Date.now())) + (+m[1]) * 3600e3 + (+m[2]) * 60e3;
    if (t <= Date.now()) t += DAY;
    return t;
  }
  return NaN;
}

const asList = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,、\s]+/) : []).map(String).filter(Boolean);

async function runTool(key, name, a, ctx) {
  switch (name) {
    case "get_market_overview": return market.overviewText(a.region || "all");
    case "get_quotes": return market.quotesText(asList(a.symbols));
    case "analyze_stock": return market.analyzeText(a.symbol);
    case "get_fundamentals": return market.fundamentalsText(a.symbol);
    case "compare_assets": return market.compareText(asList(a.symbols), a.period || "3m");
    case "get_sector_performance": return market.sectorsText(a.market === "japan" ? "japan" : "us", a.period || "1d");
    case "search_symbol": return market.searchSymbolText(a.query);
    case "get_watchlist": {
      if (!ctx.watchlist.length) return "ウォッチリストは空です。";
      return market.quotesText(ctx.watchlist);
    }
    case "add_watchlist": {
      const syms = asList(a.symbols).map(market.normalizeSymbol).filter((s) => s && !ctx.watchlist.includes(s));
      if (!syms.length) return "追加する銘柄がありません（すでに登録済みかもしれません）。";
      const checked = await Promise.all(syms.map((s) => market.getQuote(s).then((q) => ({ s, name: q.name })).catch(() => null)));
      const ok = checked.filter(Boolean);
      const bad = syms.filter((s) => !ok.find((x) => x.s === s));
      if (ok.length) { ctx.actions.push({ type: "watch_add", symbols: ok.map((x) => x.s) }); ctx.watchlist.push(...ok.map((x) => x.s)); }
      return (ok.length ? `追加しました: ${ok.map((x) => `${x.name}(${x.s})`).join("、")}` : "") + (bad.length ? ` 見つからなかった銘柄: ${bad.join("、")}` : "");
    }
    case "remove_watchlist": {
      const hit = matchList(ctx.watchlist, market.normalizeSymbol(a.keyword) || a.keyword).concat(matchList(ctx.watchlist, a.keyword));
      const uniq = [...new Set(hit)];
      if (!uniq.length) return "該当する銘柄はウォッチリストにありません。";
      ctx.actions.push({ type: "watch_remove", symbols: uniq });
      return `外しました: ${uniq.join("、")}`;
    }
    case "set_price_alert": {
      const s = market.normalizeSymbol(a.symbol);
      const price = +a.price;
      if (!s || !(price > 0)) return "銘柄か価格が正しくありません。";
      let q;
      try { q = await market.getQuote(s); } catch (e) { return `銘柄を確認できませんでした（${e.message}）。`; }
      const cond = a.condition === "below" ? "below" : "above";
      const already = cond === "above" ? q.price >= price : q.price <= price;
      ctx.actions.push({ type: "price_alert", symbol: s, name: q.name, cond, price });
      return `${q.name}(${s}) が ${market.fmtNum(price)} ${cond === "above" ? "以上" : "以下"}になったら知らせるよう登録しました。現在値は ${market.fmtNum(q.price)}。` +
        (already ? "（すでに条件を満たしているので、次の確認ですぐ鳴ります）" : "");
    }
    case "cancel_price_alert": {
      const k = String(a.keyword || "").trim();
      const all = /^(全部|すべて|全て|all)$/i.test(k);
      const ns = market.normalizeSymbol(k);
      const hit = ctx.priceAlerts.filter((x) => all || x.symbol === ns || x.symbol.includes(k.toUpperCase()) || String(x.name || "").includes(k));
      if (!hit.length) return "該当する価格アラートはありません。";
      ctx.actions.push({ type: "cancel_price_alert", ids: hit.map((x) => x.id) });
      return `${hit.length}件の価格アラートを取り消しました。`;
    }
    case "get_weather": return getWeather(a);
    case "web_search": return webSearch(key, a);
    case "calculate": return calculate(a);
    case "get_calendar": return getCalendar(a);
    case "set_timer": {
      const sec = Math.round(+a.seconds);
      if (!(sec > 0 && sec <= 86400)) return "タイマーは1秒〜24時間で指定してください。";
      ctx.actions.push({ type: "timer", seconds: sec, label: String(a.label || "").slice(0, 40) });
      return `タイマーを設定しました（${fmtFull(Date.now() + sec * 1000)} に終了）。`;
    }
    case "set_reminder": {
      const t = parseWhen(a.datetime);
      if (isNaN(t)) return "日時が読み取れませんでした。";
      if (t <= Date.now()) return "その日時はもう過ぎています。";
      ctx.actions.push({ type: "reminder", at: t, label: String(a.message || "").slice(0, 80) });
      return `リマインダーを ${fmtFull(t)} に登録しました。画面を開いている間に声でお知らせします。`;
    }
    case "cancel_alarm": {
      const k = String(a.keyword || "").trim();
      const all = /^(全部|すべて|全て|all)$/i.test(k);
      const hit = ctx.alarms.filter((x) => all || String(x.label || "").includes(k) || (x.kind === "timer" && /タイマー/.test(k) && ctx.alarms.filter((y) => y.kind === "timer").length === 1));
      if (!hit.length) return "該当するタイマー・リマインダーはありません。";
      ctx.actions.push({ type: "cancel", ids: hit.map((x) => x.id) });
      return `${hit.length}件取り消しました。`;
    }
    case "remember": {
      const f = String(a.fact || "").trim().slice(0, 200);
      if (!f) return "覚える内容が空です。";
      ctx.actions.push({ type: "remember", text: f });
      return "記憶しました。";
    }
    case "forget": {
      const hit = matchList(ctx.memories, a.keyword);
      if (!hit.length) return "該当する記憶はありません。";
      ctx.actions.push({ type: "forget", texts: hit });
      return `${hit.length}件の記憶を消しました。`;
    }
    case "add_memo": {
      const t = String(a.text || "").trim().slice(0, 200);
      if (!t) return "メモが空です。";
      ctx.actions.push({ type: "memo_add", text: t });
      return "メモしました。";
    }
    case "delete_memo": {
      const hit = matchList(ctx.memos, a.keyword);
      if (!hit.length) return "該当するメモはありません。";
      ctx.actions.push({ type: "memo_delete", texts: hit });
      return `${hit.length}件のメモを消しました。`;
    }
    default: return "不明な道具です。";
  }
}

// ======================================================================
// 返答の後処理（読み上げに向かない記号を除く）
// ======================================================================
const DETAIL_MARK = "【詳細】";
function stripCommon(s) {
  return String(s || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/【\d+†[^】]*】/g, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "");
}
// 読み上げる部分（記号を落とす）
function cleanSpeech(s) {
  return stripCommon(s).replace(/[*_#`>|]/g, "").replace(/^\s*[-・]\s*/gm, "").replace(/\n{2,}/g, "\n").trim();
}
// 画面に出す詳細（改行や「・」は残す）
function cleanDetail(s) {
  return stripCommon(s).replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "■").replace(/^\s*[-*]\s+/gm, "・").replace(/\|/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function splitReply(raw) {
  const text = String(raw || "");
  const i = text.indexOf(DETAIL_MARK);
  if (i >= 0) return { speech: cleanSpeech(text.slice(0, i)), detail: cleanDetail(text.slice(i + DETAIL_MARK.length)) };
  const speech = cleanSpeech(text);
  if (speech.length <= 260) return { speech, detail: "" };
  // 長すぎるときは、最初の数文だけ読み上げて全文は画面へ
  const sents = speech.match(/[^。！？!?]+[。！？!?]*/g) || [speech];
  let head = "";
  for (const s of sents) { if ((head + s).length > 200) break; head += s; }
  return { speech: (head || speech.slice(0, 200)) + " 詳しくは画面に出しています。", detail: cleanDetail(text) };
}
// 旧名（テスト用に残す）
const cleanReply = cleanSpeech;

function systemPrompt(state) {
  const now = Date.now();
  const lines = [
    "あなたの名前はジャービス。ユーザー専属のAI秘書で、世界の金融市場・株式・為替・金利・商品の分析を得意とする、機関投資家レベルのマーケットアナリストです。",
    USER_NAME ? `ユーザーの呼び方: ${USER_NAME}` : "",
    USER_PROFILE ? `ユーザーについて: ${USER_PROFILE}` : "",
    "",
    "【正確さのルール（最優先）】",
    "価格・騰落率・指標・財務の数値は、必ず道具（get_quotes / get_market_overview / analyze_stock / get_fundamentals / compare_assets / get_sector_performance / web_search）の結果に書かれた値だけを使う。自分の記憶の数値は使わない。結果に無い数値は「データが取れていません」と言う。",
    "数値を言うときは、どの時点のデータか（例: 10月17日15時時点）を添える。日本株のデータは約20分遅れのことがある。",
    "事実（データ）と見立て（解釈）をはっきり分け、見立てには根拠にした指標を言う。",
    "ニュース、決算内容、材料、経済指標の結果や予定、日銀・FRBの動き、需給（信用倍率など）は web_search で日付つきで裏取りする。",
    "相場の背景を説明するときは、データ（get_quotes等）と材料（web_search）の両方を確かめてから答える。",
    "売買を断定的に勧めない。代わりに、強気・弱気それぞれのシナリオと、注目すべき価格水準（移動平均・高値安値など）や条件を示す。",
    "円換算や損益など、計算が必要なものは calculate を使う。",
    "",
    "【分析の進め方】",
    "「今日の相場は」→ get_market_overview と、必要に応じて web_search（今日の相場の主な材料）。",
    "個別銘柄 → analyze_stock（テクニカル）と get_fundamentals（バリュエーション）、材料は web_search。日本株は押し目買い手法のチャート条件チェックの結果も伝える。",
    "「〜と比べて」→ compare_assets。「どの業種が強い」→ get_sector_performance。",
    "銘柄コードが分からないときは search_symbol。日本株は 4桁コード＋.T。",
    "",
    "【返答の形式】",
    "声で会話しているので、最初に、読み上げ用の結論を自然な話し言葉で2〜4文で言う（記号・箇条書き・URLを使わない。数値は要点の2〜3個まで）。",
    `分析や数値の多い質問では、そのあと改行して「${DETAIL_MARK}」と書き、その下に画面表示用の詳細レポートを書く。詳細レポートは「・」で始まる短い行の箇条書きで、数値・根拠・シナリオ・注目水準・リスク・データの時点と出典をまとめる。マークダウンの表や太字は使わない。`,
    "雑談や短い用事（タイマー、メモ等）では詳細レポートは不要。",
    "音声認識の誤変換が混じるので、銘柄名などは意味が通るように汲み取る（例:「エヌビディア」→NVDA、「ドル円」→USDJPY=X、「日経」→^N225）。",
    "",
    "【その他の道具】",
    "タイマー、リマインダー、メモ、記憶、ウォッチリスト、価格アラートは、頼まれたら道具で実行し、実行したことを短く伝える。",
    ICS_URL ? "予定を聞かれたら get_calendar を使う（読むだけ）。" : "カレンダーは未接続。予定を聞かれたら、未接続だと伝える。",
    "分からないこと・できないことは正直に言う。",
    "",
    `現在の日時（日本時間）: ${fmtFull(now)}（${isoDate(now)}）`,
    "参考: 東証は平日9:00〜11:30・12:30〜15:30。米国市場は日本時間で夜23:30〜翌6:00（米国夏時間中は22:30〜翌5:00）。",
    `天気の既定の場所: ${DEFAULT_LOCATION}`,
  ];
  const wl = (state.watchlist || []).slice(0, 50);
  lines.push("", wl.length ? `【ウォッチリスト】${wl.join("、")}` : "【ウォッチリスト】なし");
  const pa = (state.priceAlerts || []).slice(0, 30);
  if (pa.length) lines.push("【価格アラート】", ...pa.map((x) => `・${x.name || x.symbol}(${x.symbol}) ${x.price} ${x.cond === "below" ? "以下" : "以上"}`));
  const mem = (state.memories || []).slice(-60);
  if (mem.length) lines.push("", "【ユーザーについて記憶していること】", ...mem.map((m) => `・${m}`));
  const memos = (state.memos || []).slice(-40);
  lines.push("", memos.length ? "【メモ・ToDo】" : "【メモ・ToDo】なし", ...memos.map((m) => `・${m}`));
  const al = (state.alarms || []).slice(0, 20);
  if (al.length) {
    lines.push("", "【動いているタイマー・リマインダー】",
      ...al.map((x) => `・${x.kind === "timer" ? "タイマー" : "リマインダー"}「${x.label || "名前なし"}」${fmtFull(x.at)} 終了（残り${Math.max(0, Math.round((x.at - now) / 60000))}分）`));
  }
  return lines.filter((l) => l !== null).join("\n");
}

// ======================================================================
// 本体
// ======================================================================
async function handler(req, res) {
  const pass = process.env.APP_PASSCODE;
  const authed = !pass || req.headers["x-passcode"] === pass;

  if (req.method === "GET") {
    const qs = (req.query && req.query.quote) || (new URL(req.url || "/", "http://x").searchParams.get("quote"));
    if (qs) {
      // 画面上部のティッカー・価格アラート用の軽い取得
      if (!authed) return res.status(401).json({ error: "合言葉が違います" });
      const syms = String(qs).split(",").map(market.normalizeSymbol).filter(Boolean).slice(0, 20);
      const quotes = await Promise.all(syms.map((s) => market.getQuote(s).then((q) => ({
        symbol: q.symbol, name: q.name, price: q.price, change: q.change, changePct: q.changePct, currency: q.currency, time: q.time,
      })).catch((e) => ({ symbol: s, error: String(e.message || e) }))));
      return res.status(200).json({ quotes });
    }
    return res.status(200).json({ ok: true, calendar: !!ICS_URL, search: true, weather: true, market: true, model: CHAT_MODEL });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: "GROQ_API_KEY が未設定です" });
  if (!authed) return res.status(401).json({ error: "合言葉が違います" });

  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};

    let heard = "";
    if (typeof body.audio === "string" && body.audio) {
      const buf = Buffer.from(body.audio, "base64");
      if (buf.length < 1000) return res.status(400).json({ error: "音声が短すぎます" });
      heard = await transcribe(key, buf, String(body.mime || "audio/webm"));
    } else if (typeof body.text === "string") {
      heard = body.text.trim().slice(0, 1000);
    } else {
      return res.status(400).json({ error: "入力が不正です" });
    }
    if (!heard) return res.status(200).json({ heard: "", reply: "", actions: [], tools: [] });

    const st = body.state || {};
    const state = {
      memories: (Array.isArray(st.memories) ? st.memories : []).map((x) => String(x).slice(0, 200)),
      memos: (Array.isArray(st.memos) ? st.memos : []).map((x) => String(x).slice(0, 200)),
      alarms: (Array.isArray(st.alarms) ? st.alarms : []).filter((x) => x && x.id && +x.at).map((x) => ({ id: String(x.id), kind: x.kind === "timer" ? "timer" : "reminder", label: String(x.label || "").slice(0, 80), at: +x.at })),
      watchlist: (Array.isArray(st.watchlist) ? st.watchlist : []).map((x) => market.normalizeSymbol(x)).filter(Boolean).slice(0, 50),
      priceAlerts: (Array.isArray(st.priceAlerts) ? st.priceAlerts : []).filter((x) => x && x.id && x.symbol).map((x) => ({
        id: String(x.id), symbol: String(x.symbol), name: String(x.name || "").slice(0, 60), cond: x.cond === "below" ? "below" : "above", price: +x.price,
      })).slice(0, 30),
    };
    const history = (Array.isArray(body.history) ? body.history : []).slice(-8).map((m) => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      content: String((m && m.content) || "").slice(0, m && m.role === "assistant" ? 1800 : 600),
    }));

    const tools = toolDefs();
    const messages = [{ role: "system", content: systemPrompt(state) }, ...history, { role: "user", content: heard }];
    const ctx = { actions: [], alarms: state.alarms, memories: state.memories, memos: state.memos, watchlist: state.watchlist.slice(), priceAlerts: state.priceAlerts };
    const used = [];
    let reply = "";

    for (let step = 0; step < 6; step++) {
      const msg = await chat(key, messages, tools, false);
      const calls = msg.tool_calls || [];
      if (!calls.length) { reply = msg.content || ""; break; }
      messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments || "{}" } })) });
      const results = await Promise.all(calls.map(async (c) => {
        let args = {};
        try { args = JSON.parse(c.function.arguments || "{}") || {}; } catch (_) {}
        used.push(c.function.name);
        try { return await runTool(key, c.function.name, args, ctx); }
        catch (e) { return "道具の実行に失敗しました: " + String(e.message || e).slice(0, 200); }
      }));
      calls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, content: String(results[i]) }));
    }
    if (!reply) {
      const msg = await chat(key, messages, tools, true);
      reply = msg.content || "すみません、うまくまとめられませんでした。";
    }

    const { speech, detail } = splitReply(reply);
    return res.status(200).json({ heard, reply: speech, detail, actions: ctx.actions, tools: [...new Set(used)] });
  } catch (e) {
    return res.status(500).json({ error: "サーバーエラー", detail: String(e.message || e).slice(0, 300) });
  }
}

module.exports = handler;
// テスト用
module.exports._internal = { parseIcs, expandEvent, calculate, parseWhen, cleanReply, splitReply, systemPrompt, runTool, getCalendar };
