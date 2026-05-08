import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const API_TOKEN = "fa5fd1943c7b386f172d6893dbfba10b";
const SEARCH_TOKEN = "D43BF722C8F8913DDBCD4201D3CC4EBE";
const QUOTE_FIELDS = [
  "f43", "f44", "f45", "f46", "f47", "f48", "f50", "f51", "f52",
  "f57", "f58", "f60", "f86", "f116", "f117", "f162", "f167",
  "f168", "f169", "f170", "f171"
].join(",");
const KLINE_FIELDS_1 = "f1,f2,f3,f4,f5,f6";
const KLINE_FIELDS_2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";
const ACTIONABLE_LABELS = new Set(["风控优先", "分批止盈", "高位控仓", "理想买点", "低吸观察"]);

const CONFIG_PATH = process.env.ALERT_CONFIG || "alert-config.json";
const STATE_DIR = process.env.ALERT_STATE_DIR || ".alert-state";
const STATE_PATH = path.join(STATE_DIR, "state.json");
const DRY_RUN = process.env.DRY_RUN === "true" || process.argv.includes("--dry-run");
const FORCE_ALERT = process.env.FORCE_ALERT === "true" || process.argv.includes("--force");

async function main() {
  const config = await readConfig();
  const now = new Date();
  const state = await readState();
  const stocks = Array.isArray(config.stocks) && config.stocks.length
    ? config.stocks.filter((stock) => stock && stock.enabled !== false)
    : [{ query: "605305", targetPe: 22, safetyMargin: 12, planSize: 30 }];

  if (config.checkMarketHours !== false && !FORCE_ALERT && !isTradingWindow(now)) {
    console.log(`Skip outside A-share trading window: ${formatChinaTime(now)}`);
    await writeState(state);
    return;
  }

  const alerts = [];
  for (const stockConfig of stocks) {
    try {
      const analysis = await analyzeStock(stockConfig);
      console.log(`${analysis.name} ${analysis.code}: ${analysis.status.label}, price ${fmtPrice(analysis.price)}, RSI ${fmtOne(analysis.rsiNow)}`);
      if (!ACTIONABLE_LABELS.has(analysis.status.label)) continue;
      if (!shouldSendAlert(state, analysis, stockConfig, config, now)) continue;
      alerts.push(analysis);
    } catch (error) {
      console.error(`Failed to check ${stockConfig.query || stockConfig.code || stockConfig.name || "unknown"}: ${error.message}`);
    }
  }

  if (!alerts.length) {
    console.log("No actionable buy/sell alerts.");
    await writeState(state);
    return;
  }

  const title = `A股买卖点提醒 ${formatChinaTime(now)}`;
  const body = alerts.map(formatAlert).join("\n\n---\n\n");
  const sent = await sendWeChat(title, body);

  if (sent) {
    for (const alert of alerts) {
      const key = alertKey(alert);
      state.alerts[key] = {
        sentAt: now.toISOString(),
        label: alert.status.label,
        price: alert.price,
        code: alert.code,
        name: alert.name
      };
    }
  }

  await writeState(state);
}

async function readConfig() {
  const raw = await readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

async function readState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const state = JSON.parse(raw);
    if (!state.alerts || typeof state.alerts !== "object") state.alerts = {};
    return state;
  } catch {
    return { alerts: {} };
  }
}

async function writeState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function analyzeStock(stockConfig) {
  const stock = await resolveStock(stockConfig);
  const [quotePayload, klinePayload] = await Promise.all([
    fetchJson(quoteUrl(stock.secid)),
    fetchJson(klineUrl(stock.secid))
  ]);
  const quote = parseQuote(quotePayload, stock);
  const klines = parseKlines(klinePayload);
  const indicators = buildIndicators(quote, klines, {
    targetPe: Number(stockConfig.targetPe) || 22,
    safetyMargin: Number(stockConfig.safetyMargin) || 12,
    planSize: Number(stockConfig.planSize) || 30
  });

  if (!indicators) {
    throw new Error("No enough kline data for indicators");
  }

  return {
    ...stock,
    ...quote,
    ...indicators
  };
}

async function resolveStock(stockConfig) {
  if (stockConfig.secid && stockConfig.code) {
    return {
      secid: stockConfig.secid,
      code: stockConfig.code,
      name: stockConfig.name || stockConfig.code
    };
  }

  const query = String(stockConfig.query || stockConfig.code || stockConfig.name || "").trim();
  if (!query) throw new Error("Missing stock query");
  const payload = await fetchJson(stockSearchUrl(query));
  const rows = payload && payload.QuotationCodeTable && Array.isArray(payload.QuotationCodeTable.Data)
    ? payload.QuotationCodeTable.Data
    : [];
  const result = pickStockResult(rows, query);
  if (!result) throw new Error(`Stock not found: ${query}`);

  const code = String(result.Code || result.UnifiedCode || query).trim();
  return {
    secid: result.QuoteID || fallbackSecid(code),
    code,
    name: result.Name || stockConfig.name || code
  };
}

function quoteUrl(secid) {
  return `https://push2.eastmoney.com/api/qt/stock/get?ut=${API_TOKEN}&invt=2&fltt=2&secid=${secid}&fields=${encodeURIComponent(QUOTE_FIELDS)}`;
}

function klineUrl(secid) {
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?ut=${API_TOKEN}&fields1=${encodeURIComponent(KLINE_FIELDS_1)}&fields2=${encodeURIComponent(KLINE_FIELDS_2)}&secid=${secid}&klt=101&fqt=1&beg=20250101&end=20500101&lmt=260`;
}

function stockSearchUrl(query) {
  const callback = `search_${Date.now()}`;
  return `https://searchapi.eastmoney.com/api/suggest/get?cb=${callback}&input=${encodeURIComponent(query)}&type=14&token=${SEARCH_TOKEN}&count=8`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "Referer": "https://quote.eastmoney.com/",
      "User-Agent": "Mozilla/5.0 zhongji-united-dashboard-alert"
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  return parseJsonOrJsonp(text);
}

function parseJsonOrJsonp(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^[\w$]+\(([\s\S]*)\);?$/);
  return JSON.parse(match ? match[1] : trimmed);
}

function pickStockResult(rows, query) {
  const normalized = query.replace(/\.(SH|SZ|BJ)$/i, "").trim().toUpperCase();
  const candidates = rows.filter((row) => row && (row.QuoteID || row.Code || row.UnifiedCode));
  const exactCode = candidates.find((row) => String(row.Code || row.UnifiedCode || "").toUpperCase() === normalized);
  const exactName = candidates.find((row) => String(row.Name || "").trim() === query.trim());
  const aStock = candidates.find((row) => row.Classify === "AStock" && (row.QuoteID || row.Code));
  return exactCode || exactName || aStock || candidates[0] || null;
}

function fallbackSecid(code) {
  if (!code) return "";
  if (code.startsWith("6")) return `1.${code}`;
  return `0.${code}`;
}

function parseQuote(payload, stock) {
  const data = payload && payload.data ? payload.data : {};
  const price = toNum(data.f43);
  const prevClose = toNum(data.f60);
  return {
    price,
    high: toNum(data.f44),
    low: toNum(data.f45),
    open: toNum(data.f46),
    volume: toNum(data.f47),
    amount: toNum(data.f48),
    turnover: toNum(data.f50),
    upLimit: toNum(data.f51),
    downLimit: toNum(data.f52),
    code: data.f57 || stock.code,
    name: data.f58 || stock.name,
    prevClose,
    timestamp: data.f86 ? new Date(Number(data.f86) * 1000) : new Date(),
    marketCap: toNum(data.f116 || data.f117),
    pe: toNum(data.f162),
    pb: toNum(data.f167),
    volumeRatio: toNum(data.f168),
    change: toNum(data.f169) ?? (Number.isFinite(price) && Number.isFinite(prevClose) ? price - prevClose : null),
    changePct: toNum(data.f170) ?? (Number.isFinite(price) && Number.isFinite(prevClose) ? (price / prevClose - 1) * 100 : null),
    amplitude: toNum(data.f171)
  };
}

function parseKlines(payload) {
  const lines = payload && payload.data && Array.isArray(payload.data.klines) ? payload.data.klines : [];
  return lines.map((line) => {
    const parts = line.split(",");
    return {
      date: parts[0],
      open: toNum(parts[1]),
      close: toNum(parts[2]),
      high: toNum(parts[3]),
      low: toNum(parts[4]),
      volume: toNum(parts[5]),
      amount: toNum(parts[6]),
      amplitude: toNum(parts[7]),
      changePct: toNum(parts[8]),
      change: toNum(parts[9]),
      turnover: toNum(parts[10])
    };
  }).filter((item) => Number.isFinite(item.close));
}

function buildIndicators(quote, klines, settings) {
  const merged = mergeQuoteIntoKlines(klines, quote);
  if (!merged.length) return null;

  const closes = merged.map((item) => item.close);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const rsi14 = rsiSeries(closes, 14);
  const price = Number.isFinite(quote.price) ? quote.price : merged[merged.length - 1].close;
  const recent20 = merged.slice(-20);
  const recent60 = merged.slice(-60);
  const high20 = Math.max(...recent20.map((item) => item.high));
  const low20 = Math.min(...recent20.map((item) => item.low));
  const high60 = Math.max(...recent60.map((item) => item.high));
  const low60 = Math.min(...recent60.map((item) => item.low));
  const atr = calcAtr(merged, 14) || price * 0.035;
  const ma20Now = lastValid(ma20);
  const ma60Now = lastValid(ma60);
  const trendSupport = Math.max(Number.isFinite(ma20Now) ? ma20Now : low20, low20);
  const deepSupport = Math.max(Number.isFinite(ma60Now) ? ma60Now : low60, low60);
  const buyLow = round(Math.max(deepSupport, trendSupport - atr * 0.65));
  const buyHigh = round(trendSupport + atr * 0.25);
  const stopLoss = round(Math.min(low20, deepSupport) - atr * 0.45);
  const pe = quote.pe;
  const eps = Number.isFinite(pe) && pe > 0 ? price / pe : null;
  const fairLowPe = Math.max(14, settings.targetPe - 4);
  const fairMidPe = (fairLowPe + settings.targetPe) / 2;
  const fairLow = Number.isFinite(eps) ? round(eps * fairLowPe) : null;
  const fairMid = Number.isFinite(eps) ? round(eps * fairMidPe) : null;
  const fairHigh = Number.isFinite(eps) ? round(eps * settings.targetPe) : null;
  const valuationBuy = Number.isFinite(fairMid) ? round(fairMid * (1 - settings.safetyMargin / 100)) : null;
  const idealBuy = round(Math.min(
    Number.isFinite(valuationBuy) ? valuationBuy : buyLow,
    Number.isFinite(buyLow) ? buyLow : price
  ));
  const resistance1 = round(Math.max(high20, price + atr * 0.8));
  const resistance2 = round(Math.max(high60, Number.isFinite(fairHigh) ? fairHigh : high60));
  const rsiNow = lastValid(rsi14);
  const rsiPrev = lastValid(rsi14, 1);
  const status = getStatus({ price, rsiNow, rsiPrev, buyLow, buyHigh, idealBuy, stopLoss, resistance1, ma20Now });

  return {
    price,
    rsiNow,
    rsiPrev,
    rsiDiff: Number.isFinite(rsiNow) && Number.isFinite(rsiPrev) ? rsiNow - rsiPrev : null,
    ma20Now,
    ma60Now,
    high20,
    low20,
    high60,
    low60,
    atr,
    buyLow,
    buyHigh,
    idealBuy,
    stopLoss,
    resistance1,
    resistance2,
    fairLow,
    fairMid,
    fairHigh,
    valuationBuy,
    settings,
    status,
    upsideToResistance: pctRoom(resistance1, price),
    upsideToFairHigh: pctRoom(fairHigh, price),
    downsideToStop: pctRoom(stopLoss, price)
  };
}

function mergeQuoteIntoKlines(klines, quote) {
  if (!quote || !Number.isFinite(quote.price) || !klines.length) return klines.slice();
  const merged = klines.slice();
  const quoteDate = formatChinaDate(quote.timestamp);
  const last = { ...merged[merged.length - 1] };
  if (last.date === quoteDate) {
    last.close = quote.price;
    if (Number.isFinite(quote.open)) last.open = quote.open;
    if (Number.isFinite(quote.high)) last.high = quote.high;
    if (Number.isFinite(quote.low)) last.low = quote.low;
    if (Number.isFinite(quote.volume)) last.volume = quote.volume;
    if (Number.isFinite(quote.amount)) last.amount = quote.amount;
    if (Number.isFinite(quote.changePct)) last.changePct = quote.changePct;
    if (Number.isFinite(quote.change)) last.change = quote.change;
    if (Number.isFinite(quote.turnover)) last.turnover = quote.turnover;
    merged[merged.length - 1] = last;
  }
  return merged;
}

function getStatus(data) {
  const rsiTrend = Number.isFinite(data.rsiNow) && Number.isFinite(data.rsiPrev) ? data.rsiNow - data.rsiPrev : 0;

  if (Number.isFinite(data.stopLoss) && data.price <= data.stopLoss) {
    return {
      label: "风控优先",
      tone: "red",
      text: `跌破风控线 ${fmtPrice(data.stopLoss)}，波段仓先退出，等待重新站回关键均线。`
    };
  }

  if (Number.isFinite(data.resistance1) && data.price >= data.resistance1 * 0.985) {
    return {
      label: "分批止盈",
      tone: "red",
      text: `接近第一压力 ${fmtPrice(data.resistance1)}，若RSI继续走弱，适合降低波段仓。`
    };
  }

  if (Number.isFinite(data.rsiNow) && data.rsiNow >= 70) {
    return {
      label: "高位控仓",
      tone: "amber",
      text: "RSI进入超买区，冲高不追，优先看分批兑现和回踩确认。"
    };
  }

  if (Number.isFinite(data.idealBuy) && data.price <= data.idealBuy && data.rsiNow <= 45 && rsiTrend >= 0) {
    return {
      label: "理想买点",
      tone: "green",
      text: `价格进入理想买点 ${fmtPrice(data.idealBuy)} 附近，等待分时企稳后分批。`
    };
  }

  if (Number.isFinite(data.buyHigh) && data.price <= data.buyHigh && data.rsiNow < 55) {
    return {
      label: "低吸观察",
      tone: "green",
      text: `价格靠近回踩区 ${fmtPrice(data.buyLow)}-${fmtPrice(data.buyHigh)}，适合小仓试错。`
    };
  }

  if (Number.isFinite(data.ma20Now) && data.price >= data.ma20Now && data.rsiNow >= 45 && data.rsiNow < 68) {
    return {
      label: "持有观察",
      tone: "blue",
      text: "价格仍在趋势支撑上方，等待突破压力或回踩到买区。"
    };
  }

  return {
    label: "等待确认",
    tone: "amber",
    text: "当前没有清晰买卖触发，优先等待价格回到买区或放量突破。"
  };
}

function shouldSendAlert(state, analysis, stockConfig, config, now) {
  if (FORCE_ALERT) return true;
  const key = alertKey(analysis);
  const last = state.alerts[key];
  if (!last || !last.sentAt) return true;

  const cooldownMinutes = Number(stockConfig.cooldownMinutes || config.cooldownMinutes) || 120;
  const minutesSinceLast = (now.getTime() - Date.parse(last.sentAt)) / 60000;
  if (minutesSinceLast >= cooldownMinutes) return true;

  if (Number.isFinite(last.price) && Number.isFinite(analysis.price)) {
    const priceMovePct = Math.abs(analysis.price / last.price - 1) * 100;
    if (priceMovePct >= 1.5) return true;
  }

  console.log(`Skip duplicate alert for ${analysis.name} ${analysis.status.label}; cooldown ${Math.round(minutesSinceLast)}/${cooldownMinutes} min.`);
  return false;
}

function alertKey(analysis) {
  return `${analysis.secid}:${analysis.status.label}`;
}

function formatAlert(item) {
  return [
    `### ${item.name} ${item.code} - ${item.status.label}`,
    item.status.text,
    "",
    `现价：${fmtPrice(item.price)}（${fmtSigned(item.change)} / ${fmtPct(item.changePct)}）`,
    `RSI14：${fmtOne(item.rsiNow)}（${trendWord(item.rsiNow, item.rsiPrev)} ${fmtSigned(item.rsiDiff)}）`,
    `理想买点：${fmtPrice(item.idealBuy)}，回踩区：${fmtPrice(item.buyLow)}-${fmtPrice(item.buyHigh)}`,
    `第一压力：${fmtPrice(item.resistance1)}，估值上沿：${fmtPrice(item.fairHigh)}，风控线：${fmtPrice(item.stopLoss)}`,
    `空间：到压力 ${fmtPct(item.upsideToResistance)} / 到估值 ${fmtPct(item.upsideToFairHigh)} / 到风控 ${fmtPct(item.downsideToStop)}`,
    "",
    "仅作规则化提醒，不构成投资建议。"
  ].join("\n");
}

async function sendWeChat(title, body) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] ${title}\n${body}`);
    return false;
  }

  let sent = false;
  if (process.env.SERVERCHAN_SENDKEY) {
    await sendServerChan(process.env.SERVERCHAN_SENDKEY, title, body);
    sent = true;
  }

  if (process.env.WECHAT_WEBHOOK) {
    await sendWeCom(process.env.WECHAT_WEBHOOK, title, body);
    sent = true;
  }

  if (!sent) {
    console.log("No SERVERCHAN_SENDKEY or WECHAT_WEBHOOK secret configured; alert generated but not sent.");
  }

  return sent;
}

async function sendServerChan(sendKey, title, body) {
  const url = sendKey.startsWith("http") ? sendKey : `https://sctapi.ftqq.com/${sendKey}.send`;
  const form = new URLSearchParams({ title, desp: body });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: form
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ServerChan HTTP ${response.status}: ${text.slice(0, 200)}`);
  try {
    const payload = JSON.parse(text);
    const code = payload.errno ?? payload.code;
    if (Number(code) !== 0) throw new Error(payload.errmsg || payload.message || text);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
  console.log("ServerChan alert sent.");
}

async function sendWeCom(webhook, title, body) {
  const content = clip(`**${title}**\n\n${body}`, 3900);
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { content }
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`WeCom HTTP ${response.status}: ${text.slice(0, 200)}`);
  const payload = JSON.parse(text);
  if (Number(payload.errcode) !== 0) throw new Error(payload.errmsg || text);
  console.log("WeCom alert sent.");
}

function sma(values, period) {
  const result = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

function rsiSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  result[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const up = Math.max(delta, 0);
    const down = Math.max(-delta, 0);
    avgGain = ((avgGain * (period - 1)) + up) / period;
    avgLoss = ((avgLoss * (period - 1)) + down) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }

  return result;
}

function lastValid(series, offset = 0) {
  let found = 0;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(series[i])) {
      if (found === offset) return series[i];
      found += 1;
    }
  }
  return null;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function calcAtr(klines, period = 14) {
  if (klines.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < klines.length; i += 1) {
    const item = klines[i];
    const prev = klines[i - 1];
    ranges.push(Math.max(
      item.high - item.low,
      Math.abs(item.high - prev.close),
      Math.abs(item.low - prev.close)
    ));
  }
  return average(ranges.slice(-period));
}

function isTradingWindow(date) {
  const parts = chinaParts(date);
  if (parts.day === 0 || parts.day === 6) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return (minutes >= 9 * 60 + 25 && minutes <= 11 * 60 + 35)
    || (minutes >= 12 * 60 + 55 && minutes <= 15 * 60 + 5);
}

function chinaParts(date) {
  const chinaDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: chinaDate.getUTCFullYear(),
    month: chinaDate.getUTCMonth() + 1,
    dayOfMonth: chinaDate.getUTCDate(),
    day: chinaDate.getUTCDay(),
    hour: chinaDate.getUTCHours(),
    minute: chinaDate.getUTCMinutes(),
    second: chinaDate.getUTCSeconds()
  };
}

function formatChinaDate(date) {
  const parts = chinaParts(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.dayOfMonth)}`;
}

function formatChinaTime(date) {
  const parts = chinaParts(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.dayOfMonth)} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

function trendWord(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return "等待";
  const diff = current - previous;
  if (diff > 1) return "走强";
  if (diff < -1) return "走弱";
  return "横盘";
}

function pctRoom(target, price) {
  if (!Number.isFinite(target) || !Number.isFinite(price) || price === 0) return null;
  return (target / price - 1) * 100;
}

function toNum(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmtPrice(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function fmtOne(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "--";
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function fmtSigned(value) {
  if (!Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function clip(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 20)}\n\n...内容已截断` : text;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
