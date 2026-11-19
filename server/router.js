/**
 * @file HTTP 路由与静态托管：`/api/*` → JSON（统一 `{ok,data}` / `{ok:false,error}`）、
 *       `/reports/<key>.html` → 只读托管 `data/reports/`、其余 → `web/`（无扩展名回落 index.html）。
 * @module server/router
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import {
  APP_NAME,
  BUILTIN_UNIT_PRICE,
  LIMITS,
  MAX_TEXT_LEN,
  MODES,
  PROJECT_ROOT,
  VERSION,
  WEB_DIR,
  modeList,
} from './config.js';
import { AppError, clamp, dayKey, log, parseRange, tail4, toInt } from './util.js';
import * as store from './store.js';
import * as weibo from './weibo.js';
import * as fetcher from './fetcher.js';
import * as search from './search.js';
import * as report from './report.js';
import * as exchange from './exchange.js';
import * as demo from './demo.js';
import * as scheduler from './scheduler.js';
import * as profiles from './profiles.js';

/** AppError 透出（各模块统一从这里取类型可以少一条 import）。 */
export { AppError };

/* ------------------------------------------------------------------ *
 * 响应封装
 * ------------------------------------------------------------------ */

/** 成功响应。 */
export function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}

/** 失败响应。 */
export function fail(res, status, code, message, details) {
  const error = { code: String(code), message: String(message) };
  if (details && typeof details === 'object') error.details = details;
  sendJson(res, status || 400, { ok: false, error });
}

/** 统一 JSON 输出（含安全头）。 */
function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

/** 纯文本输出（404/405 等）。 */
function sendText(res, status, text) {
  if (res.writableEnded) return;
  const body = `${text}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/** 统一异常 → 响应。 */
function respondError(res, err) {
  if (res.writableEnded || res.headersSent) {
    try {
      res.end();
    } catch {
      /* 忽略二次关闭 */
    }
    return;
  }
  if (err instanceof AppError) {
    fail(res, err.status || 400, err.code, err.message, err.details);
    return;
  }
  log('error', 'router', 'unhandled', { error: err instanceof Error ? err.stack || err.message : String(err) });
  fail(res, 500, 'IO_ERROR', '服务端内部错误，请查看终端日志');
}

/* ------------------------------------------------------------------ *
 * 请求体
 * ------------------------------------------------------------------ */

/** 读取并解析 JSON 请求体。 */
async function readBody(req) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.maxBodyBytes) throw new AppError('BAD_REQUEST', '请求体过大', 413);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('BAD_REQUEST', '请求体不是合法 JSON', 400);
  }
}

/* ------------------------------------------------------------------ *
 * 输入解析
 * ------------------------------------------------------------------ */

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 微博 mblogid（62 进制短链）→ 数字 mid。 */
export function mblogidToMid(mblogid) {
  const str = String(mblogid || '');
  if (!/^[0-9A-Za-z]{4,20}$/.test(str)) return '';
  let mid = '';
  for (let i = str.length - 4; i > -4; i -= 4) {
    const start = Math.max(0, i);
    const end = Math.min(str.length, i + 4);
    let n = 0;
    for (let j = start; j < end; j += 1) {
      const value = B62.indexOf(str[j]);
      if (value < 0) return '';
      n = n * 62 + value;
    }
    mid = i > 0 ? `${String(n).padStart(7, '0')}${mid}` : `${String(n)}${mid}`;
  }
  return mid;
}

/** 安全 decodeURIComponent。 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 解析用户输入：`weibo.com/u/123`、`weibo.com/昵称`、纯 UID。
 * @param {unknown} input
 * @returns {{uid?:string,screenName?:string}}
 */
export function parseUserInput(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) throw new AppError('INVALID_ID', '请输入微博主页链接、昵称或 UID', 400);
  if (/^\d{1,20}$/.test(raw)) return { uid: raw };

  let matched = /weibo\.(?:com|cn)\/u\/(\d{1,20})/i.exec(raw);
  if (matched) return { uid: matched[1] };

  matched = /weibo\.(?:com|cn)\/n\/([^/?#\s]+)/i.exec(raw);
  if (matched) return { screenName: safeDecode(matched[1]) };

  matched = /weibo\.(?:com|cn)\/(\d{1,20})(?:[/?#]|$)/i.exec(raw);
  if (matched) return { uid: matched[1] };

  matched = /weibo\.(?:com|cn)\/([^/?#\s]+)/i.exec(raw);
  if (matched) {
    const name = safeDecode(matched[1]);
    if (/^\d+$/.test(name)) return { uid: name };
    return { screenName: name };
  }
  throw new AppError('INVALID_ID', '无法从该链接识别 UID', 400);
}

/**
 * 解析博文输入：详情页链接（含 mblogid 短链）或微博 ID。
 * @param {unknown} input
 * @returns {{id:string,mId?:string,authorUid?:string,sourceUrl?:string}}
 */
export function parsePostInput(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) throw new AppError('INVALID_ID', '请输入微博详情页链接或微博 ID', 400);
  if (/^\d{1,20}$/.test(raw)) return { id: raw };

  let matched = /weibo\.(?:com|cn)\/(\d{1,20})\/([0-9A-Za-z]{4,20})/.exec(raw);
  if (matched) {
    const id = mblogidToMid(matched[2]);
    if (id) {
      return {
        id,
        mId: matched[2],
        authorUid: matched[1],
        sourceUrl: `https://weibo.com/${matched[1]}/${matched[2]}`,
      };
    }
  }

  matched = /(?:m\.)?weibo\.(?:com|cn)\/(?:detail|status)\/(\d{1,20})/i.exec(raw);
  if (matched) return { id: matched[1] };

  matched = /weibo\.(?:com|cn)\/(?:detail\/)?(\d{1,20})(?:[/?#]|$)/i.exec(raw);
  if (matched) return { id: matched[1] };

  matched = /[?&](?:mblogid|mid|id)=([0-9A-Za-z]{4,20})/.exec(raw);
  if (matched) {
    const rawValue = matched[1];
    if (/^\d{1,20}$/.test(rawValue)) return { id: rawValue };
    const id = mblogidToMid(rawValue);
    if (id) return { id, mId: rawValue };
  }

  throw new AppError('INVALID_ID', '无法从该链接识别微博 ID', 400);
}

/* ------------------------------------------------------------------ *
 * API 处理函数
 * ------------------------------------------------------------------ */

async function hHealth() {
  return { ok: true, app: APP_NAME, version: VERSION, node: process.version };
}

/** 余额 DTO（token 与账户细节脱敏）。 */
function balanceDto(cfg, forceStale) {
  if (!cfg.balance) return { value: null, atMs: null, stale: true, serviceKind: '' };
  const stale = forceStale || Date.now() - Number(cfg.balance.atMs) > 5 * 60 * 1000;
  return {
    value: cfg.balance.value,
    atMs: cfg.balance.atMs,
    stale,
    serviceKind: cfg.balance.serviceKind || '',
  };
}

async function hStatus() {
  const cfg = store.readConfig();
  return {
    demoMode: Boolean(cfg.settings.demoMode),
    loggedIn: Boolean(cfg.token),
    account: cfg.account,
    tokenTail4: tail4(cfg.token),
    balance: balanceDto(cfg, false),
    serviceKind: cfg.balance ? cfg.balance.serviceKind || '' : '',
    dataDir: store.getRoot(),
    counts: store.counts(),
    todayCredits: Math.round(store.todayCredits() * 100) / 100,
    pageSize: cfg.settings.pageSize,
    modes: modeList(),
    scheduler: scheduler.diagnostics(),
  };
}

async function hBalance(ctx) {
  const refresh = ctx.query.get('refresh') === '1';
  const cfg = store.readConfig();
  if (!refresh) return balanceDto(cfg, false);
  if (cfg.settings.demoMode || !cfg.token) return balanceDto(cfg, true);
  try {
    const info = await weibo.whoami();
    if (info.balance !== null) {
      store.writeConfig({
        balance: { value: info.balance, atMs: Date.now(), serviceKind: info.serviceKind || '' },
      });
    }
    return balanceDto(store.readConfig(), false);
  } catch (err) {
    log('warn', 'router', 'balance-refresh-failed', { error: err instanceof Error ? err.message : 'unknown' });
    return balanceDto(store.readConfig(), true);
  }
}

async function hDeviceStart() {
  return weibo.startDeviceAuth();
}

async function hDevicePoll(ctx) {
  const result = await weibo.pollDeviceAuth(ctx.params[0]);
  if (result.status === 'ready') {
    try {
      const info = await weibo.whoami();
      if (info.balance !== null) {
        store.writeConfig({
          balance: { value: info.balance, atMs: Date.now(), serviceKind: info.serviceKind || '' },
        });
      }
    } catch {
      /* 登录成功但余额读取失败：不阻断登录 */
    }
  }
  return result;
}

async function hDeviceCancel(ctx) {
  return weibo.cancelDeviceAuth(ctx.params[0]);
}

async function hTokenLogin(ctx) {
  const token = String((ctx.body && ctx.body.token) || '').trim();
  if (!token) throw new AppError('BAD_REQUEST', '请粘贴 access token', 400);
  const account = await weibo.persistLogin({ access_token: token });
  try {
    const info = await weibo.whoami();
    if (info.balance !== null) {
      store.writeConfig({ balance: { value: info.balance, atMs: Date.now(), serviceKind: info.serviceKind || '' } });
    }
  } catch {
    /* 余额失败不阻断 */
  }
  return { account };
}

async function hLogout() {
  weibo.logout();
  store.setDemoMode(true);
  // 退出后进入演示模式；若演示目录为空则自动补种子数据，避免落到全空界面
  if (store.listUsers().total === 0 && store.listPosts().total === 0) {
    demo.seed({ reset: false });
  }
  search.clearCache();
  return { demoMode: true };
}

/* --- 用户 --- */

async function hUsersList(ctx) {
  return store.listUsers({ q: ctx.query.get('q') || '', starred: ctx.query.get('starred') === '1' });
}

async function hUsersCreate(ctx) {
  const parsed = parseUserInput(ctx.body && ctx.body.input);
  let uid = parsed.uid || '';
  let screenName = parsed.screenName || '';
  if (!uid) {
    // 昵称 → UID 只能命中本地已收录的昵称：本工具不为此联网（避免在用户不知情时
    // 产生出站请求与潜在计费）。文案必须把这个限制与替代做法讲清楚，而不是笼统报错。
    const local = store.findUserByScreenName(screenName);
    if (!local) {
      throw new AppError(
        'INVALID_ID',
        `本地还没有昵称为「${screenName}」的用户，无法离线解析出 UID。` +
          '请改用主页链接里的数字 UID，例如 https://weibo.com/u/1234567890 ，或直接粘贴 1234567890。' +
          '（本工具不为昵称解析联网，以免在你不知情时产生请求；昵称可在首次取数后自动补全。）',
        400,
        { input: screenName, hint: 'weibo.com/u/<数字UID>' }
      );
    }
    uid = local.uid;
    screenName = local.screenName;
  }
  return store.addUser({ uid, screenName });
}

async function hUserGet(ctx) {
  const user = store.getUser(ctx.params[0]);
  if (!user) throw new AppError('NOT_FOUND', '该用户不在本地库中', 404);
  return user;
}

async function hUserPatch(ctx) {
  const body = ctx.body || {};
  const patch = {};
  if (typeof body.starred === 'boolean') patch.starred = body.starred;
  if (typeof body.remark === 'string') patch.remark = body.remark;
  return store.patchUser(ctx.params[0], patch);
}

async function hUserDelete(ctx) {
  return store.deleteUser(ctx.params[0], { purge: ctx.query.get('purge') === '1' });
}

/* --- 博文 --- */

async function hPostsList(ctx) {
  return store.listPosts({ q: ctx.query.get('q') || '', favorite: ctx.query.get('favorite') === '1' });
}

async function hPostsCreate(ctx) {
  const parsed = parsePostInput(ctx.body && ctx.body.input);
  return store.addPost({
    id: parsed.id,
    mId: parsed.mId || '',
    authorUid: parsed.authorUid || '',
    sourceUrl: parsed.sourceUrl || `https://m.weibo.cn/detail/${parsed.id}`,
  });
}

async function hPostGet(ctx) {
  const post = store.getPost(ctx.params[0]);
  if (!post) throw new AppError('NOT_FOUND', '该博文不在本地库中', 404);
  return { post, missingText: !post.text };
}

async function hPostPatch(ctx) {
  const body = ctx.body || {};
  const patch = {};
  if (typeof body.favorite === 'boolean') patch.favorite = body.favorite;
  if (typeof body.text === 'string') {
    // P0-15 手工补录正文：空串/纯空白无意义（会让人误以为「已补」），直接拒绝；
    // 超长按记录层同一上限截断并打标，避免把整库撑大。
    const trimmed = body.text.replace(/\r\n|\r/g, '\n').trim();
    if (!trimmed) {
      throw new AppError('BAD_REQUEST', '正文不能为空或纯空白', 400);
    }
    if (trimmed.length > MAX_TEXT_LEN) {
      patch.text = trimmed.slice(0, MAX_TEXT_LEN);
      patch.textTruncated = true;
    } else {
      patch.text = trimmed;
      patch.textTruncated = false;
    }
  }
  if (typeof body.textTruncated === 'boolean' && patch.text === undefined) {
    patch.textTruncated = body.textTruncated;
  }
  return store.patchPost(ctx.params[0], patch);
}

async function hPostDelete(ctx) {
  return store.deletePost(ctx.params[0], { purge: ctx.query.get('purge') === '1' });
}

/* --- 记录与已读 --- */

async function hRecords(ctx) {
  const ownerType = store.assertOwnerType(ctx.params[0]);
  const ownerId = ctx.params[1];
  const mode = ctx.query.get('mode') || '';
  if (mode && !MODES[mode]) throw new AppError('INVALID_MODE', '未知内容模式', 400);
  const { fromMs, toMs } = parseRange({
    fromMs: ctx.query.get('fromMs'),
    toMs: ctx.query.get('toMs'),
  });
  const unreadOnly = ctx.query.get('unread') === '1';
  const page = Math.max(1, toInt(ctx.query.get('page'), 1));
  const pageSize = clamp(toInt(ctx.query.get('pageSize'), store.getSettings().pageSize), 1, 200);

  const entry = ownerType === 'users' ? store.getUser(ownerId) : store.getPost(ownerId);
  if (!entry) {
    throw new AppError('NOT_FOUND', ownerType === 'users' ? '该用户不在本地库中' : '该博文不在本地库中', 404);
  }

  let all = store.readRecords(ownerType, ownerId, {
    mode: mode || undefined,
    fromMs,
    toMs,
    unread: unreadOnly,
  });

  // 按「对方用户」关键字过滤：昵称 / UID（发出评论时对方=原微博作者，收到/被@时对方=记录作者）
  const q = String(ctx.query.get('q') || '').trim().toLowerCase();
  if (q) {
    all = all.filter((r) => {
      const haystack = [
        r.author, r.authorUid, r.postAuthor, r.postAuthorUid,
      ].map((v) => String(v || '')).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }

  const items = all.slice((page - 1) * pageSize, page * pageSize);
  // 不传 mode 时（用户详情「全部」视图）也要算 gap：store.gaps 的 mode 为空时
  // 会读取该对象全部模式的记录，得到「所有模式下都没有记录」的日段。
  const gaps = store.gaps(ownerType, ownerId, mode || '', fromMs, toMs);

  return {
    items,
    total: all.length,
    page,
    pageSize,
    stats: entry.stats,
    timeline: store.timeline(all),
    gaps,
    owner: { ownerType, ownerId, label: ownerType === 'users' ? entry.screenName : entry.text },
    modes: modeList().filter((m) => (ownerType === 'users' ? m.ownerKind === 'user' : m.ownerKind === 'post')),
    missingText: ownerType === 'posts' ? !entry.text : false,
  };
}

async function hOwnerRead(ctx) {
  const ownerType = store.assertOwnerType(ctx.params[0]);
  const ownerId = ctx.params[1];
  const body = ctx.body || {};
  let ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id) : null;
  if (!ids) {
    if (!body.all) throw new AppError('BAD_REQUEST', '请指定 ids 数组，或传 all=true 按分组标记已读', 400);
    const mode = body.mode && MODES[body.mode] ? body.mode : undefined;
    ids = store.readRecords(ownerType, ownerId, { mode, unread: true }).map((r) => String(r.recordId));
  }
  return store.markRead(ownerType, ownerId, ids);
}

/* --- 取数 --- */

async function hFetchPlan(ctx) {
  return fetcher.plan(ctx.body || {});
}

async function hFetchStart(ctx) {
  return fetcher.startTask(ctx.body || {});
}

async function hFetchTask(ctx) {
  return fetcher.getTask(ctx.params[0]);
}

async function hFetchTaskList(ctx) {
  return { items: fetcher.listTasks(clamp(toInt(ctx.query.get('limit'), 20), 1, 200)) };
}

async function hFetchStop(ctx) {
  return fetcher.stopTask(ctx.params[0]);
}

/* --- 搜索 --- */

async function hSearch(ctx) {
  return search.search(ctx.body || {});
}

/* --- 报告 --- */

async function hReportCreate(ctx) {
  const body = ctx.body || {};
  const result = report.generate({
    ownerType: body.ownerType,
    ownerId: body.ownerId,
    limit: body.limit,
    fromMs: body.fromMs,
    toMs: body.toMs,
  });
  report.cleanupReports();
  return result;
}

async function hReportMeta(ctx) {
  return report.meta(ctx.params[0]);
}

async function hReportRead(ctx) {
  const ids = Array.isArray(ctx.body && ctx.body.ids) ? ctx.body.ids : [];
  if (ids.length === 0) throw new AppError('BAD_REQUEST', 'ids 不能为空', 400);
  return report.markReportRead(ctx.params[0], ids);
}

async function hReportOpen(ctx) {
  const meta = report.meta(ctx.params[0]);
  const filePath = store.reportFilePath(ctx.params[0]);
  if (!fs.existsSync(filePath)) throw new AppError('NOT_FOUND', '报告文件不存在，请重新生成', 404);
  const platform = process.platform;
  const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', filePath] : [filePath];
  execFile(cmd, args, (err) => {
    if (err) log('warn', 'router', 'report-open-failed', { error: err.message });
  });
  return { opened: true, path: meta.path, url: meta.url };
}

/* --- 订阅 --- */

/** 订阅对外 DTO（补 status 字段）。 */
function subDto(sub) {
  let status = 'active';
  if (!sub.enabled) {
    // 只有「预算耗尽导致的自动暂停」才算 budget-exhausted（次日会自动恢复）；
    // 用户手动暂停一律显示 paused，避免误报「明日自动恢复」。
    status = sub.pauseReason === 'budget' && sub.lastResult === 'budget' ? 'budget-exhausted' : 'paused';
  }
  return {
    ...sub,
    status,
    intervalMinutes:
      sub.intervalMode === 'fixed'
        ? sub.fixedMinutes
        : [1, 3, 5, 10, 15, 30][Math.min(sub.step || 0, 5)],
  };
}

async function hSubsList() {
  return { items: store.listSubscriptions().map(subDto) };
}

async function hSubsCreate(ctx) {
  const body = ctx.body || {};
  const ownerType = store.assertOwnerType(body.ownerType);
  const ownerId = String(body.ownerId || '');
  if (!/^\d{1,20}$/.test(ownerId)) throw new AppError('INVALID_ID', '对象 ID 必须是 1~20 位数字', 400);
  if (!MODES[body.mode]) throw new AppError('INVALID_MODE', '请选择有效的内容模式', 400);
  const owner = ownerType === 'users' ? store.getUser(ownerId) : store.getPost(ownerId);
  if (!owner) throw new AppError('NOT_FOUND', '对象不在本地库中', 404);
  const sub = store.addSubscription({
    ownerType,
    ownerId,
    ownerLabel: ownerType === 'users' ? owner.screenName : `博文 ${ownerId}`,
    mode: body.mode,
    perRoundLimit: clamp(toInt(body.perRoundLimit, LIMITS.pageCount), 1, LIMITS.maxLimit),
    dailyCreditsBudget: Math.max(0.01, Number(body.dailyCreditsBudget) || 1),
    intervalMode: body.intervalMode === 'fixed' ? 'fixed' : 'auto',
    fixedMinutes: clamp(toInt(body.fixedMinutes, 30), 1, 1440),
    enabled: body.enabled !== false,
  });
  return { subscription: subDto(sub) };
}

async function hSubsPatch(ctx) {
  const body = ctx.body || {};
  const patch = {};
  for (const key of ['enabled', 'perRoundLimit', 'dailyCreditsBudget', 'intervalMode', 'fixedMinutes']) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (patch.enabled === true) {
    patch.nextRunAtMs = Date.now() + 60000;
    patch.lastResult = '';
  }
  const updated = store.patchSubscription(ctx.params[0], patch);
  return { subscription: subDto(updated) };
}

async function hSubsDelete(ctx) {
  return store.deleteSubscription(ctx.params[0]);
}

async function hSubsResetBudget(ctx) {
  // 显式用户动作：清 pauseReason 并恢复（无论此前是 user 还是 budget 暂停）
  const updated = store.patchSubscription(ctx.params[0], {
    spentToday: 0,
    enabled: true,
    pauseReason: '',
    step: 0,
    todayKey: dayKey(Date.now()),
    lastResult: '',
    nextRunAtMs: Date.now() + 60000,
  });
  return { subscription: subDto(updated) };
}

async function hSubsLogs(ctx) {
  const limit = clamp(toInt(ctx.query.get('limit'), LIMITS.subLogKeep), 1, LIMITS.subLogKeep);
  const all = store.readSubLogs(LIMITS.subLogKeep);
  const onlyId = ctx.params[0] === 'all' ? '' : ctx.params[0];
  const items = all.filter((row) => !onlyId || row.subId === onlyId).slice(0, limit);
  return { items };
}

/* --- 设置 / 价目 --- */

async function hSettingsGet() {
  const cfg = store.readConfig();
  return {
    settings: { ...cfg.settings, dataDir: store.getRoot() },
    configuredDataDir: cfg.settings.dataDir || '',
    account: cfg.account,
    loggedIn: Boolean(cfg.token),
    tokenTail4: tail4(cfg.token),
    dataDir: store.getRoot(),
    version: VERSION,
  };
}

async function hSettingsPatch(ctx) {
  const body = ctx.body || {};
  if (fetcher.isRunning()) {
    throw new AppError('CONFLICT', '有取数任务正在运行，请先停止后再修改设置', 409);
  }
  if (typeof body.dataDir === 'string' && body.dataDir.trim()) {
    store.setDataDir(body.dataDir);
    search.clearCache();
  }
  if (body.pageSize !== undefined) {
    store.writeConfig({ settings: { pageSize: clamp(toInt(body.pageSize, 20), 5, 200) } });
  }
  if (body.reportMaxRecords !== undefined) {
    store.writeConfig({
      settings: { reportMaxRecords: clamp(toInt(body.reportMaxRecords, LIMITS.defaultReportMax), 1, LIMITS.maxReportRecords) },
    });
  }
  if (typeof body.demoMode === 'boolean') {
    store.setDemoMode(body.demoMode);
    search.clearCache();
    if (body.demoMode && store.listUsers().total === 0 && store.listPosts().total === 0) {
      demo.seed({ reset: false });
    }
  }
  return hSettingsGet();
}

async function hPricing(ctx) {
  const refresh = ctx.query.get('refresh') === '1';
  const initial = store.readConfig();
  if (refresh && !initial.settings.demoMode && initial.token) {
    try {
      const { pricing, source } = await weibo.refreshPricing();
      if (source === 'api' && Object.keys(pricing).length > 0) {
        store.writeConfig({ pricing, pricingAtMs: Date.now() });
      }
    } catch (err) {
      log('warn', 'router', 'pricing-refresh-failed', { error: err instanceof Error ? err.message : 'unknown' });
    }
  }
  const cfg = store.readConfig();
  const unitPriceByMode = {};
  for (const key of Object.keys(BUILTIN_UNIT_PRICE)) {
    const cached = Number(cfg.pricing ? cfg.pricing[key] : NaN);
    unitPriceByMode[key] = Number.isFinite(cached) && cached > 0 ? cached : BUILTIN_UNIT_PRICE[key];
  }
  return {
    unitPriceByMode,
    fetchedAtMs: cfg.pricingAtMs,
    source: cfg.pricingAtMs ? 'api' : 'builtin',
    modes: modeList().map((m) => ({ key: m.key, label: m.label })),
  };
}

/* --- 导入导出 / 演示 --- */

/** 用户资料缓存（展示页专用；只读，不触发微博请求）。 */
async function hProfiles() {
  return { items: profiles.loadProfiles() };
}

/* --- 展示页发布（导出静态快照 → 上传 COS） --- */

const SHOWCASE_COS_CONF = process.env.SHOWCASE_COS_CONF || '/home/admin/.cos.conf';
const SHOWCASE_COOKIE_FILE =
  process.env.SHOWCASE_COOKIE_FILE || '/home/admin/IdolGallary/backend/weibo_cookies.json';

let showcasePublishing = false;

/** 以子进程方式执行 tools/ 下的 Node 脚本，收集输出。 */
function runNodeScript(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd: PROJECT_ROOT, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err && err.killed ? '执行超时被终止' : '',
        });
      }
    );
  });
}

async function hShowcaseStatus() {
  return {
    cosConf: { path: SHOWCASE_COS_CONF, exists: fs.existsSync(SHOWCASE_COS_CONF) },
    cookieFile: { path: SHOWCASE_COOKIE_FILE, exists: fs.existsSync(SHOWCASE_COOKIE_FILE) },
    showcaseUrl: '/fakeaccount/',
    busy: showcasePublishing,
  };
}

async function hShowcasePublish(ctx) {
  if (showcasePublishing) throw new AppError('CONFLICT', '已有发布任务在运行，请稍候', 409);
  const body = ctx.body || {};
  const mode = ['all', 'data', 'static'].includes(body.mode) ? body.mode : 'all';
  const refresh = ['incremental', 'full', 'none'].includes(body.refresh)
    ? body.refresh
    : body.withProfiles
      ? 'incremental'
      : 'none';
  const uid = String(body.uid || '').trim();
  if (uid && !/^\d{1,20}$/.test(uid)) throw new AppError('INVALID_ID', '账号 UID 不合法', 400);
  if (!fs.existsSync(SHOWCASE_COS_CONF)) {
    throw new AppError('IO_ERROR', `未找到 COS 配置文件：${SHOWCASE_COS_CONF}`, 500, {
      hint: '通过环境变量 SHOWCASE_COS_CONF 指定 coscmd 配置文件',
    });
  }

  showcasePublishing = true;
  const steps = [];
  try {
    if (refresh !== 'none' && !body.dryRun) {
      if (fs.existsSync(SHOWCASE_COOKIE_FILE)) {
        const profileArgs = [
          path.join(PROJECT_ROOT, 'tools', 'fetch-profiles.mjs'),
          '--cookie-file',
          SHOWCASE_COOKIE_FILE,
          '--authors',
          '--delay',
          '400',
        ];
        // full：重新拉取所有资料并覆盖头像；incremental：只补缺失/过期的
        if (refresh === 'full') profileArgs.push('--force');
        steps.push({ step: 'profiles', ...(await runNodeScript(profileArgs, 540000)) });
      } else {
        steps.push({
          step: 'profiles',
          code: -1,
          stdout: '',
          stderr: `未找到 cookie 文件：${SHOWCASE_COOKIE_FILE}（已跳过资料/头像刷新）`,
        });
      }
    }

    const args = [
      path.join(PROJECT_ROOT, 'tools', 'publish-showcase.mjs'),
      '--cos-conf',
      SHOWCASE_COS_CONF,
      '--mode',
      mode,
    ];
    if (uid) args.push('--uid', uid);
    if (body.dryRun) args.push('--dry-run');
    if (body.skipAvatars) args.push('--skip-avatars');
    steps.push({ step: 'publish', ...(await runNodeScript(args, 300000)) });
  } finally {
    showcasePublishing = false;
  }
  return { steps, refresh, mode };
}

async function hExport(ctx) {
  const payload = exchange.buildExport();
  const body = JSON.stringify(payload, null, 2);
  const filename = `weibo-reader-export-${dayKey(Date.now())}.json`;
  ctx.res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  ctx.res.end(body);
  return undefined;
}

async function hImport(ctx) {
  const body = ctx.body || {};
  const payload = body.payload !== undefined ? body.payload : body;
  const result = exchange.importPayload(payload);
  search.clearCache();
  return result;
}

async function hDemoSeed(ctx) {
  const reset = Boolean(ctx.body && ctx.body.reset);
  const result = demo.seed({ reset });
  search.clearCache();
  return result;
}

/* ------------------------------------------------------------------ *
 * 路由表
 * ------------------------------------------------------------------ */

const ROUTES = [
  ['GET', /^\/api\/health$/, hHealth],
  ['GET', /^\/api\/status$/, hStatus],
  ['GET', /^\/api\/account\/balance$/, hBalance],

  ['POST', /^\/api\/auth\/device$/, hDeviceStart],
  ['GET', /^\/api\/auth\/device\/([^/]+)$/, hDevicePoll],
  ['DELETE', /^\/api\/auth\/device\/([^/]+)$/, hDeviceCancel],
  ['POST', /^\/api\/auth\/token$/, hTokenLogin],
  ['POST', /^\/api\/auth\/logout$/, hLogout],

  ['GET', /^\/api\/users$/, hUsersList],
  ['POST', /^\/api\/users$/, hUsersCreate],
  ['GET', /^\/api\/users\/([^/]+)$/, hUserGet],
  ['PATCH', /^\/api\/users\/([^/]+)$/, hUserPatch],
  ['DELETE', /^\/api\/users\/([^/]+)$/, hUserDelete],

  ['GET', /^\/api\/posts$/, hPostsList],
  ['POST', /^\/api\/posts$/, hPostsCreate],
  ['GET', /^\/api\/posts\/([^/]+)$/, hPostGet],
  ['PATCH', /^\/api\/posts\/([^/]+)$/, hPostPatch],
  ['DELETE', /^\/api\/posts\/([^/]+)$/, hPostDelete],

  ['GET', /^\/api\/owners\/([^/]+)\/([^/]+)\/records$/, hRecords],
  ['POST', /^\/api\/owners\/([^/]+)\/([^/]+)\/read$/, hOwnerRead],

  ['POST', /^\/api\/fetch\/plan$/, hFetchPlan],
  ['GET', /^\/api\/fetch\/tasks$/, hFetchTaskList],
  ['POST', /^\/api\/fetch\/tasks$/, hFetchStart],
  ['GET', /^\/api\/fetch\/tasks\/([^/]+)$/, hFetchTask],
  ['POST', /^\/api\/fetch\/tasks\/([^/]+)\/stop$/, hFetchStop],

  ['POST', /^\/api\/search$/, hSearch],

  ['POST', /^\/api\/reports$/, hReportCreate],
  ['GET', /^\/api\/reports\/([^/]+)$/, hReportMeta],
  ['POST', /^\/api\/reports\/([^/]+)\/read$/, hReportRead],
  ['POST', /^\/api\/reports\/([^/]+)\/open$/, hReportOpen],

  ['GET', /^\/api\/subscriptions$/, hSubsList],
  ['POST', /^\/api\/subscriptions$/, hSubsCreate],
  ['GET', /^\/api\/subscriptions\/([^/]+)\/logs$/, hSubsLogs],
  ['PATCH', /^\/api\/subscriptions\/([^/]+)$/, hSubsPatch],
  ['DELETE', /^\/api\/subscriptions\/([^/]+)$/, hSubsDelete],
  ['POST', /^\/api\/subscriptions\/([^/]+)\/reset-budget$/, hSubsResetBudget],

  ['GET', /^\/api\/settings$/, hSettingsGet],
  ['PATCH', /^\/api\/settings$/, hSettingsPatch],
  ['GET', /^\/api\/pricing$/, hPricing],

  ['GET', /^\/api\/profiles$/, hProfiles],
  ['GET', /^\/api\/showcase\/status$/, hShowcaseStatus],
  ['POST', /^\/api\/showcase\/publish$/, hShowcasePublish],

  ['GET', /^\/api\/exchange\/export$/, hExport],
  ['POST', /^\/api\/exchange\/import$/, hImport],

  ['POST', /^\/api\/demo\/seed$/, hDemoSeed],
];

/* ------------------------------------------------------------------ *
 * 分流
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 处理 `/api/*`。 */
async function handleApi(req, res, pathname) {
  const method = (req.method || 'GET').toUpperCase();
  const body = await readBody(req);
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const ctx = { req, res, url, body, params: [], query: url.searchParams };
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const matched = pattern.exec(pathname);
    if (!matched) continue;
    ctx.params = matched.slice(1).map((v) => safeDecode(String(v)));
    const data = await handler(ctx);
    if (!res.writableEnded) ok(res, data === undefined ? null : data);
    return;
  }
  fail(res, 404, 'NOT_FOUND', `未找到接口：${method} ${pathname}`);
}

/** 只读托管 `/reports/<key>.html`。 */
function serveReportFile(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }
  const name = safeDecode(pathname.slice('/reports/'.length));
  if (!/^[a-z]+-\d+\.html$/.test(name)) {
    sendText(res, 404, '报告不存在');
    return;
  }
  let file;
  try {
    file = store.safeJoin(store.reportsDir(), name);
  } catch {
    sendText(res, 404, '报告不存在');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendText(res, 404, '报告不存在');
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** 托管 `web/`。 */
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }
  const hasExtension = /\.[a-z0-9]+$/i.test(pathname);
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!hasExtension) rel = 'index.html';
  let file;
  try {
    file = store.safeJoin(WEB_DIR, rel);
  } catch {
    sendText(res, 400, '非法路径');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (hasExtension) {
      sendText(res, 404, 'Not Found');
      return;
    }
    file = path.join(WEB_DIR, 'index.html');
    if (!fs.existsSync(file)) {
      sendText(res, 404, 'Not Found');
      return;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * 顶层请求处理。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handle(req, res) {
  let pathname = '/';
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    pathname = safeDecode(url.pathname);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname.replace(/\/+$/, '') || '/api');
      return;
    }
    if (pathname.startsWith('/avatar/')) {
      profiles.serveAvatar(req, res, pathname);
      return;
    }
    if (pathname.startsWith('/reports/')) {
      serveReportFile(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    respondError(res, err);
  }
}
