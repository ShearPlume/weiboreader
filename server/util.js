/**
 * @file 通用工具：错误类型、ID/模式/日期校验、HTML 转义、时间格式化、文本归一化、日志。
 * @module server/util
 */

import crypto from 'node:crypto';

/** 业务异常：由 router 统一转换为 `{ok:false,error:{code,message}}`。 */
export class AppError extends Error {
  /**
   * @param {string} code 错误码（见 config.ERROR_CODES）。
   * @param {string} message 中文人话文案。
   * @param {number} [status=400] HTTP 状态码。
   * @param {object|null} [details=null] 附加信息（不回传敏感内容）。
   */
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (details && typeof details === 'object') this.details = details;
  }
}

/** UID / 微博 ID 的合法形态：1~20 位纯数字（微博 ID 可能超过 2^53，故一律字符串）。 */
export const ID_RE = /^\d{1,20}$/;

/** 判断是否为合法数字 ID 字符串。 */
export function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

/**
 * 校验 ID，非法抛 INVALID_ID。
 * @param {unknown} value 待校验值
 * @param {string} [field='id'] 字段名，用于错误文案
 * @returns {string} 规范化后的 ID 字符串
 */
export function assertId(value, field = 'ID') {
  const str = value === null || value === undefined ? '' : String(value).trim();
  if (!ID_RE.test(str)) {
    throw new AppError('INVALID_ID', `${field} 必须是 1~20 位数字`, 400);
  }
  return str;
}

/**
 * HTML 转义（& < > " '）。所有进入 HTML 的文本必须经过它。
 * @param {unknown} value
 * @returns {string}
 */
export function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 先转义再把换行渲染为 `<br>`，保留纯文本语义。
 * @param {unknown} value
 * @returns {string}
 */
export function escText(value) {
  return esc(value).replace(/\r\n|\r|\n/g, '<br>');
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 展示串 `YYYY-MM-DD HH:mm`（本地时区）。 */
export function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 展示串 `YYYY-MM-DD HH:mm:ss`（日志与报告用）。 */
export function fmtTimeSec(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${fmtTime(ms)}:${pad2(d.getSeconds())}`;
}

/** 本地日键 `YYYY-MM-DD`。 */
export function dayKey(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地年月分片键 `YYYYMM`。 */
export function monthKey(ms) {
  if (!Number.isFinite(ms)) return '000000';
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}`;
}

/** 某毫秒时间戳所在本地日的 00:00:00.000。 */
export function dayStartMs(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 某毫秒时间戳所在本地日的 23:59:59.999。 */
export function dayEndMs(ms) {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** 今天的日键。 */
export function todayKey() {
  return dayKey(Date.now());
}

/**
 * 解析 `YYYY-MM-DD` 为本地 00:00:00.000；也接受数字/数字串毫秒。
 * @param {unknown} value
 * @returns {number|null} 解析失败返回 null
 */
export function parseDayStart(value) {
  return parseDateValue(value, 'start');
}

/**
 * 解析 `YYYY-MM-DD` 为本地 23:59:59.999（「包含所选当天」）。
 * @param {unknown} value
 * @returns {number|null} 解析失败返回 null
 */
export function parseDayEnd(value) {
  return parseDateValue(value, 'end');
}

/**
 * @param {unknown} value
 * @param {'start'|'end'} edge
 * @returns {number|null}
 */
export function parseDateValue(value, edge) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return edge === 'end' ? value : value;
  }
  const raw = String(value).trim();
  if (raw === '') return null;
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000; // 秒级时间戳
  if (/^\d{13}$/.test(raw)) return Number(raw);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const date = new Date(y, mo - 1, d, 0, 0, 0, 0);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return edge === 'end' ? dayEndMs(date.getTime()) : date.getTime();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 统一解析并校验日期区间。
 * @param {{fromMs?:unknown,toMs?:unknown}} input
 * @returns {{fromMs:number|null,toMs:number|null}}
 */
export function parseRange(input) {
  const fromRaw = input ? input.fromMs : null;
  const toRaw = input ? input.toMs : null;
  const fromMs = parseDayStart(fromRaw);
  const toMs = parseDayEnd(toRaw);
  if (fromRaw && fromMs === null) {
    throw new AppError('INVALID_DATE_RANGE', '起始日期格式不正确，应为 YYYY-MM-DD', 400);
  }
  if (toRaw && toMs === null) {
    throw new AppError('INVALID_DATE_RANGE', '结束日期格式不正确，应为 YYYY-MM-DD', 400);
  }
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw new AppError('INVALID_DATE_RANGE', '起始日期不能晚于结束日期', 400);
  }
  return { fromMs, toMs };
}

/** sha1 十六进制摘要。 */
export function sha1hex(input) {
  return crypto.createHash('sha1').update(String(input), 'utf8').digest('hex');
}

/** 生成 `prefix_<ts>_<rand6>` 形式的短 ID。 */
export function randomId(prefix = 'id') {
  const rand = crypto.randomBytes(4).toString('hex').slice(0, 6);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** 只保留尾 4 位（token 展示脱敏）。 */
export function tail4(token) {
  if (!token || typeof token !== 'string') return '';
  return token.length <= 4 ? token : token.slice(-4);
}

/** 数值裁剪。 */
export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 宽松取整数（默认回落到 def）。 */
export function toInt(value, def = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.trunc(n);
}

/** 睡眠。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 中文拼音序比较（保证列表「按昵称排序」稳定）。 */
export function pinyinCompare(a, b) {
  return String(a === null || a === undefined ? '' : a).localeCompare(
    String(b === null || b === undefined ? '' : b),
    'zh-Hans-CN'
  );
}

/** 去掉 HTML 标签与常见实体，得到纯文本。 */
export function stripHtml(input) {
  return String(input === null || input === undefined ? '' : input)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 评论文本归一化：去「回复 @某人：」前缀、去标签、保留换行、压缩空行、截断。
 * @param {unknown} raw 原始文本
 * @param {number} maxLen 最大长度
 * @returns {{text:string,textTruncated:boolean}}
 */
export function normalizeText(raw, maxLen = 2000) {
  let text = stripHtml(raw).replace(/\r\n|\r/g, '\n');
  text = text.replace(/^\s*回复\s*@[^\s:：]+\s*[:：]\s*/, '');
  text = text.replace(/^\s*Repost\s*@[^\s:：]+\s*[:：]\s*/i, '');
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > maxLen) {
    return { text: text.slice(0, maxLen), textTruncated: true };
  }
  return { text, textTruncated: false };
}

/**
 * 解析微博 `created_at` 字段（形如 `Wed Nov 17 14:35:44 +0800 2026`）为毫秒。
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseWeiboTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const raw = String(value).trim();
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  const native = Date.parse(raw);
  if (Number.isFinite(native)) return native;
  const m = /([A-Za-z]{3})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([+-]\d{4})\s+(\d{4})/.exec(raw);
  if (!m) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const month = months[m[2]];
  if (month === undefined) return null;
  const day = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  const ss = Number(m[6]);
  const tz = m[7];
  const year = Number(m[8]);
  const sign = tz[0] === '-' ? -1 : 1;
  const offsetMin = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const utc = Date.UTC(year, month, day, hh, mi, ss);
  return utc - offsetMin * 60000;
}

/**
 * 统一日志行：`[YYYY-MM-DD HH:mm:ss] LEVEL module event key=value …`
 * @param {'info'|'warn'|'error'} level
 * @param {string} module
 * @param {string} event
 * @param {Record<string,unknown>} [kv]
 * @returns {string} 生成的日志行
 */
export function log(level, module, event, kv = {}) {
  const parts = [`[${fmtTimeSec(Date.now())}]`, String(level || 'info').toUpperCase(), module, event];
  for (const [key, value] of Object.entries(kv)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  const line = parts.join(' ');
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return line;
}

/** 任务面板用的紧凑日志行：`[HH:mm:ss] 消息`。 */
export function taskLogLine(message) {
  const t = fmtTimeSec(Date.now());
  return `[${t.slice(11)}] ${message}`;
}

/**
 * 深拷贝（仅 JSON 安全数据，用于把配置对象交给调用方随便改）。
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function cloneJson(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
