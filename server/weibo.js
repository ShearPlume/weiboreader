/**
 * @file 微博开放平台 CLI 网关客户端：fetch 封装、错误分类、设备码三连、whoami、
 *       命令元数据预检、invoke 调用、多形态响应归一化、令牌持久化。
 *
 * 事实来源：docs/API-FACTS.md —— 路径、请求体字段、错误语义一律以该文档为准。
 * @module server/weibo
 */

import {
  CLIENT_ID,
  DEVICE_NAME,
  DEVICE_TOTAL_TIMEOUT_MS,
  MODES,
  MODE_KEYS,
  REQUEST_TIMEOUT_MS,
  WEIBO_BASE,
} from './config.js';
import { AppError, randomId, toInt } from './util.js';
import { readConfig, writeConfig } from './store.js';

/** 设备码会话（device_code 只存服务端内存，绝不回传前端）。 */
const deviceSessions = new Map();

/** 从配置中读 token（可能为 null）。 */
export function getToken() {
  const token = readConfig().token;
  return token && typeof token === 'string' ? token : null;
}

/** 当前是否演示模式。 */
export function isDemoMode() {
  return Boolean(readConfig().settings.demoMode);
}

/**
 * 取「可发起真实取数请求」的令牌；演示模式或未登录直接抛错（保证零付费请求）。
 * @returns {string}
 */
export function requireLiveToken() {
  const cfg = readConfig();
  if (cfg.settings.demoMode) {
    throw new AppError('DEMO_MODE', '演示模式下不会发起真实接口请求（零付费保护）', 400);
  }
  if (!cfg.token) {
    throw new AppError('UNAUTHORIZED', '请先登录微博账号', 401);
  }
  return cfg.token;
}

/** 从响应里提取人类可读的错误信息。 */
function extractMessage(json, text) {
  if (json && typeof json === 'object') {
    const candidates = [json.error_description, json.error, json.message, json.msg, json.detail];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  const raw = String(text || '').trim();
  return raw ? raw.slice(0, 300) : '接口返回未知错误';
}

/** HTTP 状态码 → 业务错误（API-FACTS §6）。 */
function classify(status, json, text) {
  const upstreamMessage = extractMessage(json, text);
  const lower = upstreamMessage.toLowerCase();
  const upstreamCode = json && typeof json === 'object' ? String(json.error || '') : '';
  const details = { status, upstream: json && typeof json === 'object' ? json : null };

  if (status === 401) {
    return new AppError('TOKEN_INVALID', '登录已失效，请重新授权', 401, details);
  }
  if (status === 402) {
    return new AppError('INSUFFICIENT_CREDITS', `账户 credits 不足：${upstreamMessage}`, 402, details);
  }
  if (status === 429) {
    return new AppError('RATE_LIMITED', `请求过于频繁，请稍后重试：${upstreamMessage}`, 429, details);
  }
  if (/insufficient|budget|quota|balance/i.test(lower)) {
    return new AppError('INSUFFICIENT_CREDITS', `额度不足：${upstreamMessage}`, 402, details);
  }
  if (upstreamCode === 'slow_down') {
    return new AppError('RATE_LIMITED', '授权轮询过快，需要降低频率', 429, details);
  }
  if (upstreamCode === 'authorization_pending') {
    return new AppError('UNAUTHORIZED', '等待用户在浏览器中确认授权', 400, details);
  }
  if (status === 403) {
    return new AppError('UNAUTHORIZED', `无访问权限：${upstreamMessage}`, 403, details);
  }
  if (status === 404) {
    return new AppError('NOT_FOUND', `接口不存在：${upstreamMessage}`, 404, details);
  }
  return new AppError('UPSTREAM_ERROR', `接口调用失败（HTTP ${status}）：${upstreamMessage}`, 502, details);
}

/**
 * 统一 HTTP 请求（JSON in / JSON out，8 秒超时）。
 * @param {string} pathname 以 `/` 开头的网关路径
 * @param {{method?:string,body?:object|null,token?:string|null,timeoutMs?:number}} [options]
 * @returns {Promise<any>}
 */
export async function httpJson(pathname, options = {}) {
  const method = options.method || 'GET';
  const body = options.body === undefined ? null : options.body;
  const token = options.token || null;
  const timeoutMs = toInt(options.timeoutMs, REQUEST_TIMEOUT_MS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json' };
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${WEIBO_BASE}${pathname}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR');
    if (isAbort) {
      throw new AppError('UPSTREAM_ERROR', `接口请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络后重试`, 504);
    }
    throw new AppError('UPSTREAM_ERROR', `无法连接微博开放平台：${err && err.message ? err.message : '网络错误'}`, 502);
  }
  clearTimeout(timer);

  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) throw classify(res.status, json, text);
  if (json === null) {
    if (!text) return {};
    throw new AppError('UPSTREAM_ERROR', '接口返回非 JSON 内容，无法解析', 502);
  }
  return json;
}

/* ------------------------------------------------------------------ *
 * 设备码登录（OAuth Device Authorization Grant）
 * ------------------------------------------------------------------ */

/**
 * 申请设备码。
 * @returns {Promise<{authId:string,userCode:string,verificationUrl:string,interval:number,expiresIn:number}>}
 */
export async function startDeviceAuth() {
  const payload = await httpJson('/oauth/device/code', {
    method: 'POST',
    body: { client_id: CLIENT_ID, device_name: DEVICE_NAME },
  });
  const deviceCode = payload && payload.device_code ? String(payload.device_code) : '';
  const userCode = payload && payload.user_code ? String(payload.user_code) : '';
  const verificationUri = payload && payload.verification_uri ? String(payload.verification_uri) : '';
  if (!deviceCode || !userCode || !verificationUri) {
    throw new AppError('UPSTREAM_ERROR', '设备码申请返回缺少必要字段，请稍后重试', 502);
  }
  const interval = Math.max(3, toInt(payload.interval, 5));
  const expiresIn = Math.max(60, toInt(payload.expires_in, 600));
  const authId = randomId('auth');
  deviceSessions.set(authId, {
    deviceCode,
    interval,
    expiresAtMs: Date.now() + expiresIn * 1000,
    createdAtMs: Date.now(),
  });
  const joiner = verificationUri.includes('?') ? '&' : '?';
  return {
    authId,
    userCode,
    verificationUrl: `${verificationUri}${joiner}user_code=${encodeURIComponent(userCode)}`,
    interval,
    expiresIn,
  };
}

/** 取设备码会话（供前端展示当前轮询间隔）。 */
export function getDeviceSession(authId) {
  return deviceSessions.get(String(authId || '')) || null;
}

/** 取消设备码会话。 */
export function cancelDeviceAuth(authId) {
  const key = String(authId || '');
  const existed = deviceSessions.delete(key);
  return { cancelled: existed };
}

/**
 * 轮询令牌（一次调用 = 一次轮询，由前端按 interval 驱动）。
 * 成功后立即校验 userinfo 并落盘 token，响应绝不包含 token。
 * @param {string} authId
 * @returns {Promise<{status:'pending'|'slow_down'|'ready'|'expired'|'error',interval?:number,account?:object,message?:string}>}
 */
export async function pollDeviceAuth(authId) {
  const key = String(authId || '');
  const session = deviceSessions.get(key);
  if (!session) {
    throw new AppError('NOT_FOUND', '授权会话不存在或已取消，请重新发起登录', 404);
  }
  if (Date.now() > session.expiresAtMs) {
    deviceSessions.delete(key);
    return { status: 'expired', message: '设备码已过期，请重新发起登录' };
  }

  let payload;
  try {
    payload = await httpJson('/oauth/token', {
      method: 'POST',
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: session.deviceCode,
        client_id: CLIENT_ID,
      },
    });
  } catch (err) {
    const upstreamCode = err && err.details && err.details.upstream ? String(err.details.upstream.error || '') : '';
    if (upstreamCode === 'authorization_pending') {
      return { status: 'pending', interval: session.interval };
    }
    if (upstreamCode === 'slow_down') {
      session.interval = Math.min(30, session.interval + 5);
      return { status: 'slow_down', interval: session.interval };
    }
    if (err instanceof AppError && (err.code === 'TOKEN_INVALID' || err.code === 'UNAUTHORIZED')) {
      // 未确认也会走 401，需要再看是否带 OAuth 错误码
      if (!upstreamCode) return { status: 'pending', interval: session.interval };
    }
    return { status: 'error', message: err instanceof AppError ? err.message : '授权失败，请重试' };
  }

  const accessToken = payload && payload.access_token ? String(payload.access_token) : '';
  if (!accessToken) {
    return { status: 'error', message: '授权响应缺少 access_token' };
  }
  const account = await persistLogin({
    access_token: accessToken,
    refresh_token: payload.refresh_token ? String(payload.refresh_token) : null,
    expires_in: toInt(payload.expires_in, 0),
  });
  deviceSessions.delete(key);
  return { status: 'ready', account, interval: session.interval };
}

/**
 * 校验并保存 token：先 userinfo 成功才落盘，失败不覆盖旧 token。
 * @param {{access_token:string,refresh_token?:string|null,expires_in?:number}} tokenPayload
 * @returns {Promise<object>} 账户快照
 */
export async function persistLogin(tokenPayload) {
  const token = String(tokenPayload.access_token || '');
  if (!token) throw new AppError('TOKEN_INVALID', 'token 为空，无法保存', 400);
  let info;
  try {
    info = await userinfo(token);
  } catch (err) {
    if (err instanceof AppError) {
      throw new AppError('TOKEN_INVALID', `token 校验失败：${err.message}（旧的登录状态已保留）`, 400);
    }
    throw new AppError('TOKEN_INVALID', 'token 校验失败（旧的登录状态已保留）', 400);
  }
  const account = {
    uid: String(info.uid || ''),
    screenName: String(info.screenName || ''),
    avatarUrl: String(info.avatarUrl || ''),
    verified: Boolean(info.verified),
  };
  const expiresIn = toInt(tokenPayload.expires_in, 0);
  writeConfig({
    token,
    refreshToken: tokenPayload.refresh_token || null,
    tokenExpiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    account,
    settings: { demoMode: false },
  });
  return account;
}

/**
 * 用 refresh_token 换新 access_token（CLI 的 access token 默认 30 分钟有效）。
 * 成功返回新 token，失败返回 null（交给上层提示重新授权）。
 */
export async function refreshAccessToken() {
  const cfg = readConfig();
  const refreshToken = cfg.refreshToken;
  if (!refreshToken) return null;
  try {
    const payload = await httpJson('/oauth/token', {
      method: 'POST',
      body: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      },
    });
    const token = payload && payload.access_token ? String(payload.access_token) : '';
    if (!token) return null;
    const expiresIn = toInt(payload.expires_in, 0);
    writeConfig({
      token,
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : refreshToken,
      tokenExpiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    });
    return token;
  } catch {
    return null;
  }
}

/** 带自动续期的受保护请求：快过期先续，401 再续一次后重试。 */
async function withTokenRetry(fn) {
  let token = getToken();
  if (!token) return fn(token);
  const cfg = readConfig();
  if (cfg.tokenExpiresAt && cfg.tokenExpiresAt - Date.now() < 90 * 1000) {
    const fresh = await refreshAccessToken();
    if (fresh) token = fresh;
  }
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof AppError && (err.code === 'TOKEN_INVALID' || err.code === 'UNAUTHORIZED')) {
      const fresh = await refreshAccessToken();
      if (fresh) return await fn(fresh);
    }
    throw err;
  }
}

/** 清除登录态（保留全部本地数据），并切回演示模式。 */
export function logout() {
  writeConfig({
    token: null,
    refreshToken: null,
    tokenExpiresAt: null,
    account: null,
    settings: { demoMode: true },
  });
  return { demoMode: true };
}

/**
 * `GET /oauth/userinfo` → 统一账户结构。
 * @param {string} [token]
 */
export async function userinfo(token) {
  const payload = token
    ? await httpJson('/oauth/userinfo', { token })
    : await withTokenRetry((t) => httpJson('/oauth/userinfo', { token: t }));
  const user = (payload && (payload.user || payload.data || payload)) || {};
  return {
    uid: String(user.uid || user.id || user.idstr || ''),
    screenName: String(user.screen_name || user.screenName || user.name || ''),
    avatarUrl: String(user.profile_image_url || user.avatar_large || user.avatarUrl || ''),
    verified: Boolean(user.verified),
    raw: payload,
  };
}

/**
 * `GET /cli/whoami` → 余额与账户状态（不产生费用）。
 * @param {string} [token]
 * @returns {Promise<{balance:number|null,serviceKind:string,serviceTitle:string,username:string}>}
 */
export async function whoami(token) {
  const payload = token
    ? await httpJson('/cli/whoami', { token })
    : await withTokenRetry((t) => httpJson('/cli/whoami', { token: t }));
  const user = (payload && payload.user) || {};
  const serviceStatus = (payload && payload.service_status) || {};
  const balance = Number(user.balance);
  return {
    balance: Number.isFinite(balance) ? balance : null,
    serviceKind: String(serviceStatus.kind || ''),
    serviceTitle: String(serviceStatus.title || ''),
    username: String(user.username || ''),
  };
}

/* ------------------------------------------------------------------ *
 * 命令元数据与 invoke
 * ------------------------------------------------------------------ */

/** 提取 flags 名称集合（兼容字符串 / 对象两种形态）。 */
export function flagNames(flags) {
  const out = new Set();
  if (!Array.isArray(flags)) return out;
  for (const flag of flags) {
    if (typeof flag === 'string') {
      const name = flag.replace(/^-+/, '').trim();
      if (name) out.add(name);
      continue;
    }
    if (flag && typeof flag === 'object') {
      for (const candidate of [flag.name, flag.flag, flag.long, flag.key]) {
        if (typeof candidate === 'string' && candidate.trim()) out.add(candidate.replace(/^-+/, '').trim());
      }
      if (Array.isArray(flag.aliases)) {
        for (const alias of flag.aliases) {
          if (typeof alias === 'string' && alias.trim()) out.add(alias.replace(/^-+/, '').trim());
        }
      }
    }
  }
  return out;
}

/** 从命令元数据里抽 unit_price（仅当 configured 且币种为 credits）。 */
function extractUnitPrice(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const command = Array.isArray(payload.commands) ? payload.commands[0] : payload.command || payload;
  const pricing = (command && command.pricing) || payload.pricing || null;
  if (!pricing || typeof pricing !== 'object') return null;
  if (pricing.configured === false) return null;
  const currency = String(pricing.currency || '').toLowerCase();
  if (currency && currency !== 'credit' && currency !== 'credits') return null;
  const raw = Number(pricing.unit_price !== undefined ? pricing.unit_price : pricing.unitPrice);
  if (!Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

/**
 * 预检命令是否存在并读取支持的参数（API-FACTS §7 硬性约束：不预检不发付费请求）。
 * @param {string} group
 * @param {string} action
 * @returns {Promise<{supported:boolean,group:string,action:string,flags:string[],unitPrice:number|null,priceType:string,reason?:string}>}
 */
export async function commands(group, action) {
  const pathname = `/cli/commands/${encodeURIComponent(String(group))}/${encodeURIComponent(String(action))}`;
  let payload;
  try {
    payload = await withTokenRetry((t) => httpJson(pathname, { token: t }));
  } catch (err) {
    if (err instanceof AppError && err.details && err.details.status === 404) {
      return {
        supported: false,
        group: String(group),
        action: String(action),
        flags: [],
        unitPrice: null,
        priceType: '',
        reason: '接口不存在',
      };
    }
    throw err;
  }
  const command = Array.isArray(payload && payload.commands) ? payload.commands[0] : payload && payload.command;
  const flags = flagNames(command && command.flags ? command.flags : payload && payload.flags);
  return {
    supported: true,
    group: String(group),
    action: String(action),
    flags: [...flags],
    unitPrice: extractUnitPrice(payload),
    priceType: String((command && command.price_type) || (payload && payload.price_type) || ''),
  };
}

/**
 * 调用业务接口（会产生 credits 消耗）。
 * @param {{group:string,action:string,args:object}} params
 * @returns {Promise<any>} 原始响应
 */
export async function invoke(params) {
  requireLiveToken();
  const group = String(params.group || '');
  const action = String(params.action || '');
  if (!group || !action) throw new AppError('UNSUPPORTED_COMMAND', '缺少接口定位（group/action）', 400);
  return withTokenRetry((token) => httpJson('/cli/invoke', {
    method: 'POST',
    body: { group, action, args: params.args && typeof params.args === 'object' ? params.args : {} },
    token,
  }));
}

/**
 * 服务端执行失败判定。
 *
 * 真实响应形如 `{ success, command, result, meta:{ outcome, billing } }`，
 * 失败时往往是 `success:false` + `error:{code,message}`，此时**仍然返回 HTTP 200**。
 * 若不先拦住，就会被当成「结构无法识别」，把「只能查自己」这类可行动的错误信息丢掉，
 * 用户只看到一句「未找到记录数组」，还白白被计费。
 * @param {any} payload
 * @returns {string} 错误信息；无错误返回空串
 */
export function upstreamError(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : null;
  const failedOutcomes = new Set(['failed', 'error', 'denied', 'not_executed']);
  const outcome = meta && typeof meta.outcome === 'string' ? meta.outcome.trim().toLowerCase() : '';
  if (outcome && failedOutcomes.has(outcome)) {
    return `服务端未确认请求成功执行（outcome=${outcome}）`;
  }
  const err = payload.error || (payload.data && payload.data.error);
  if (payload.success === false || (payload.data && payload.data.success === false) || err) {
    if (err && typeof err === 'object') {
      const message = String(err.message || err.code || '未知服务端错误');
      // 「只能查自己」是当前授权方式下最常见的拒绝原因，补一句可操作的中文提示
      if (/restricted to the current user/i.test(message)) {
        return '该接口只能读取当前登录账号自己的数据（接口提示：不能查询其他用户）。请改用当前登录账号的 UID。';
      }
      return message;
    }
    if (typeof err === 'string' && err) return err;
    return String(payload.message || '服务端返回失败（success=false）');
  }
  return '';
}

/**
 * 多形态归一化：按官方 CLI 的 `InvokeResponse`（`{result, meta}`）逐层下探。
 *
 * 真实结构（实测 `comments by_me/other`）：
 * `{ success, command, result:{ comments:[...], total_number, next_cursor }, meta:{ billing } }`
 * ——记录数组藏在 `result.comments`，比早期假设多一层，因此候选容器必须包含 `result`。
 *
 * 归一化失败抛 UPSTREAM_ERROR（不猜测结构）；若其实是服务端错误，抛其真实信息。
 * @param {any} payload
 * @param {'comments'|'statuses'|string} [kindHint] 记录类型，用于决定优先查找的字段名
 * @returns {object[]}
 */
export function normalizeList(payload, kindHint = 'comments') {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') {
    throw new AppError('UPSTREAM_ERROR', '接口返回结构无法识别（非对象）', 502);
  }
  const failure = upstreamError(payload);
  if (failure) throw new AppError('UPSTREAM_ERROR', failure, 502);

  // 候选容器：官方 CLI 把数据放在 result；也兼容其它包裹形态
  const containers = [payload, payload.data, payload.result, payload.response, payload.data && payload.data.data];
  const primary = kindHint === 'statuses' ? ['statuses', 'items', 'list', 'data'] : ['comments', 'items', 'list', 'data'];
  const fallback = ['comments', 'statuses', 'items', 'list', 'data', 'results', 'records', 'rows'];

  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const key of primary) {
      if (Array.isArray(container[key])) return container[key];
    }
    for (const key of fallback) {
      if (Array.isArray(container[key])) return container[key];
    }
  }
  // 兜底：任一子对象里的数组（仍不猜测单条结构）
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const value of Object.values(container)) {
      if (Array.isArray(value)) return value;
    }
  }
  if (payload.id || payload.idstr || payload.mid) return [payload];
  throw new AppError(
    'UPSTREAM_ERROR',
    `接口返回结构无法识别（未找到记录数组）。顶层键：${Object.keys(payload).join('、') || '空'}`,
    502
  );
}

/**
 * 从响应中取服务端返回的真实扣费（credits）。
 * `meta.billing.deducted` 是权威值，比按条数估算更准。
 * @param {any} payload
 * @returns {number|null}
 */
export function billedCredits(payload) {
  const billing = payload && payload.meta && payload.meta.billing;
  if (!billing || typeof billing !== 'object') return null;
  const value = Number(billing.deducted);
  return Number.isFinite(value) ? value : null;
}

/**
 * 刷新价目表：逐模式预检取 unit_price（失败不覆盖已有缓存）。
 * @returns {Promise<{pricing:Record<string,number>,source:'api'|'builtin'}>}
 */
export async function refreshPricing() {
  /** @type {Record<string,number>} */
  const pricing = {};
  let source = 'builtin';
  const seen = new Map();
  for (const key of MODE_KEYS) {
    const mode = MODES[key];
    const cacheKey = `${mode.group}/${mode.action}`;
    let result = seen.get(cacheKey);
    if (!result) {
      try {
        result = await commands(mode.group, mode.action);
      } catch (err) {
        result = { supported: false, unitPrice: null };
      }
      seen.set(cacheKey, result);
    }
    if (result.unitPrice !== null && Number.isFinite(result.unitPrice)) {
      pricing[key] = result.unitPrice;
      source = 'api';
    }
  }
  return { pricing, source };
}

/** 清理全部设备码会话（进程退出/测试用）。 */
export function clearDeviceSessions() {
  deviceSessions.clear();
}

/** 设备码会话总量（诊断用）。 */
export function deviceSessionCount() {
  return deviceSessions.size;
}

/** 设备码总超时（前端倒计时用）。 */
export const DEVICE_TIMEOUT_MS = DEVICE_TOTAL_TIMEOUT_MS;
