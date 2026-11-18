/**
 * @file 取数作业引擎：plan 预估（含 commands 预检）、游标推进（增量 since_id / 历史 max_id-1）、
 *       多形态归一化、去重入库、进度与环形日志、停止、任务落盘、订阅单轮执行。
 *
 * 关键不变量：
 * 1. 任何联网取数前必须先 `weibo.commands()` 预检；不支持即停，绝不盲请求。
 * 2. 历史分页 `max_id = min(返回 id) - 1`（必须减 1，否则死循环）。
 * 3. 全局同时只允许 1 个取数作业（含订阅），由 `runningId` 互斥。
 * @module server/fetcher
 */

import { BUILTIN_UNIT_PRICE, LIMITS, MODES } from './config.js';
import {
  AppError,
  clamp,
  fmtTime,
  log,
  normalizeText,
  parseRange,
  parseWeiboTime,
  taskLogLine,
  toInt,
} from './util.js';
import * as store from './store.js';
import * as weibo from './weibo.js';

/** 内存作业表：taskId → task。 */
const tasks = new Map();
/** 当前运行中的作业 ID（含订阅巡检占位），null 表示空闲。 */
let runningId = null;

/** 是否有取数作业在运行。 */
export function isRunning() {
  return runningId !== null;
}

/** 当前运行中作业的 ID（订阅占位时返回 null 语义上的 token）。 */
export function runningTaskId() {
  return runningId;
}

/* ------------------------------------------------------------------ *
 * 参数与预检
 * ------------------------------------------------------------------ */

/**
 * 归一化取数参数并做同步校验。
 * @param {object} input
 * @returns {{mode:string,meta:object,ownerType:string,ownerId:string,fromMs:number|null,toMs:number|null,limit:number|null,cursor:'incremental'|'history'}}
 */
export function normalizeParams(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const mode = String(raw.mode || '');
  const meta = MODES[mode];
  if (!meta) throw new AppError('INVALID_MODE', '请选择有效的内容模式', 400);
  const expectedOwnerType = meta.ownerKind === 'post' ? 'posts' : 'users';
  if (raw.ownerType && String(raw.ownerType) !== expectedOwnerType) {
    throw new AppError(
      'BAD_REQUEST',
      `「${meta.label}」只能归档到${expectedOwnerType === 'users' ? '用户' : '博文'}对象`,
      400
    );
  }
  const ownerId = String(raw.ownerId === undefined || raw.ownerId === null ? '' : raw.ownerId).trim();
  if (!/^\d{1,20}$/.test(ownerId)) {
    throw new AppError('INVALID_ID', '对象 ID 必须是 1~20 位数字', 400);
  }
  const { fromMs, toMs } = parseRange(raw);
  let limit = null;
  if (raw.limit !== undefined && raw.limit !== null && raw.limit !== '') {
    limit = clamp(toInt(raw.limit, LIMITS.defaultLimit), 1, LIMITS.maxLimit);
  }
  const cursor = raw.cursor === 'history' ? 'history' : 'incremental';
  return { mode, meta, ownerType: expectedOwnerType, ownerId, fromMs, toMs, limit, cursor };
}

/**
 * 命令预检：`GET /cli/commands/<group>/<action>`，必要时回退 other 接口（A2）。
 * @param {string} modeKey
 * @returns {Promise<{group:string,action:string,supported:boolean,flags:string[],unitPrice:number|null,fallback:boolean}>}
 */
export async function preflight(modeKey) {
  const meta = MODES[modeKey];
  if (!meta) throw new AppError('INVALID_MODE', '请选择有效的内容模式', 400);
  let result = await weibo.commands(meta.group, meta.action);
  let action = meta.action;
  let fallback = false;
  if (!result.supported && meta.fallback) {
    const alt = await weibo.commands(meta.fallback.group, meta.fallback.action);
    if (alt.supported) {
      result = alt;
      action = meta.fallback.action;
      fallback = true;
    }
  }
  return {
    group: meta.group,
    action,
    supported: Boolean(result.supported),
    flags: Array.isArray(result.flags) ? result.flags : [],
    unitPrice: result.unitPrice === null || result.unitPrice === undefined ? null : Number(result.unitPrice),
    fallback,
  };
}

/**
 * 当前模式单价（优先缓存的最新价目，回落内置保守值）。
 * @param {string} modeKey
 * @returns {number}
 */
export function unitPriceFor(modeKey) {
  const cfg = store.readConfig();
  const cached = Number(cfg.pricing ? cfg.pricing[modeKey] : NaN);
  if (Number.isFinite(cached) && cached > 0) return cached;
  const builtin = BUILTIN_UNIT_PRICE[modeKey];
  return Number.isFinite(builtin) ? builtin : 0.02;
}

/** 检查 flags 是否支持任一可用的翻页/定位参数。 */
function pickStrategy(cursor, flags) {
  const unknown = !flags || flags.length === 0;
  const has = (name) => unknown || flags.includes(name);
  if (cursor === 'incremental' && has('since_id')) return 'since';
  if (has('max_id')) return 'maxId';
  if (has('page')) return 'page';
  return null;
}

/* ------------------------------------------------------------------ *
 * plan
 * ------------------------------------------------------------------ */

/**
 * 预估：单价、credits、本地复用、阻塞原因、游标。
 * @param {object} input
 * @returns {Promise<object>}
 */
export async function plan(input) {
  const p = normalizeParams(input);
  const owner = p.ownerType === 'users' ? store.getUser(p.ownerId) : store.getPost(p.ownerId);
  if (!owner) {
    throw new AppError('NOT_FOUND', p.ownerType === 'users' ? '该用户不在本地库中' : '该博文不在本地库中', 404);
  }
  const cfg = store.readConfig();
  const balance = cfg.balance && Number.isFinite(Number(cfg.balance.value)) ? Number(cfg.balance.value) : null;
  const reusedLocal = store.countLocal(p.ownerType, p.ownerId, p.mode, p.fromMs, p.toMs);
  const limit = p.limit === null ? LIMITS.defaultLimit : p.limit;
  const willFetch = Math.min(limit, LIMITS.maxLimit);

  let unitPrice = unitPriceFor(p.mode);
  let priceSource = cfg.pricing && Number.isFinite(Number(cfg.pricing[p.mode])) ? 'api' : 'builtin';
  const commandsInfo = [];
  let blocked = null;

  if (cfg.settings.demoMode) {
    blocked = { code: 'DEMO_MODE', message: '演示模式下不会发起真实取数（零付费保护）' };
  } else if (!cfg.token) {
    blocked = { code: 'UNAUTHORIZED', message: '请先登录微博账号后再取数' };
  }

  if (!blocked) {
    try {
      const pre = await preflight(p.mode);
      commandsInfo.push({ group: pre.group, action: pre.action, supported: pre.supported, flags: pre.flags });
      if (!pre.supported) {
        blocked = { code: 'UNSUPPORTED_COMMAND', message: `接口 ${pre.group}/${pre.action} 不存在或当前不可用` };
      } else {
        if (pre.unitPrice !== null && Number.isFinite(pre.unitPrice)) {
          unitPrice = pre.unitPrice;
          priceSource = 'api';
        }
        if (!pickStrategy(p.cursor, pre.flags)) {
          blocked = { code: 'UNSUPPORTED_COMMAND', message: '该接口不支持 since_id / max_id / page，无法安全翻页' };
        }
      }
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'UPSTREAM_ERROR';
      blocked = { code, message: err instanceof Error ? err.message : '接口预检失败' };
    }
  }

  const estimateCredits = Math.round(willFetch * unitPrice * 100) / 100;
  if (!blocked && balance !== null && estimateCredits > balance) {
    blocked = {
      code: 'INSUFFICIENT_CREDITS',
      message: `预估消耗 ${estimateCredits.toFixed(2)} credits，剩余 ${balance.toFixed(2)}，还差 ${(
        estimateCredits - balance
      ).toFixed(2)}`,
    };
  }

  const cursor =
    p.cursor === 'history'
      ? { maxId: null }
      : { sinceId: store.maxSourceId(p.ownerType, p.ownerId, p.mode) };

  return {
    mode: p.mode,
    modeLabel: p.meta.label,
    ownerType: p.ownerType,
    ownerId: p.ownerId,
    cursor: p.cursor,
    unitPrice,
    priceSource,
    estimateCredits,
    // 两个口径都明确给全，不在服务端伪造「新增」精度：
    // - reusedLocal：请求日期区间内本地**已有**的记录数（可能被复用、不再计费）
    // - newEstimateUpperBound：本次**最多**会新拉取的条数（= 拉取上限，保守上限）
    //
    // 不能用 `willFetch - reusedLocal` 相减：两者口径不同（前者是本轮拉取上限，
    // 后者是整个区间的存量），limit=10 / reusedLocal=16 时会算出「新增 0」这种
    // 误导性结果，而实际仍会付费拉取至多 10 条。
    reusedLocal,
    newEstimateUpperBound: willFetch,
    willFetch,
    balance,
    fromMs: p.fromMs,
    toMs: p.toMs,
    limit: p.limit,
    blocked,
    commands: commandsInfo,
    sinceCursor: cursor.sinceId || null,
    demoMode: Boolean(cfg.settings.demoMode),
  };
}

/* ------------------------------------------------------------------ *
 * 记录归一化
 * ------------------------------------------------------------------ */

/**
 * 取第一个非空字符串。
 *
 * 明确跳过对象/数组：历史 bug 是 `String({...})` 得到 `"[object Object]"` 后被当成
 * 合法 ID 存进归档（如 `reply_comment` 是对象而非字符串时）。所有调用点因此受益。
 */
function pickStr(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue; // 对象/数组不可直接字符串化
    const str = String(value).trim();
    if (str && str !== 'undefined' && str !== 'null' && str !== '[object Object]') return str;
  }
  return '';
}

/** 取第一个纯数字字符串（游标计算用）。 */
function pickNumeric(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const str = String(value).trim();
    if (/^\d{1,25}$/.test(str)) return str;
  }
  return '';
}

/** 抽取配图外链（不下载）。 */
function extractPictures(item) {
  const lists = [item.pic_urls, item.pics, item.pic_infos ? Object.values(item.pic_infos) : null];
  const urls = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const pic of list) {
      if (typeof pic === 'string') {
        if (/^https?:\/\//.test(pic)) urls.push({ url: pic });
        continue;
      }
      if (pic && typeof pic === 'object') {
        const candidate = pickStr(
          pic.large && pic.large.url,
          pic.url,
          pic.bmiddle_pic,
          pic.thumbnail_pic,
          pic.bmiddle && pic.bmiddle.url
        );
        if (candidate && /^https?:\/\//.test(candidate)) urls.push({ url: candidate });
      }
    }
    if (urls.length > 0) break;
  }
  if (urls.length === 0) return null;
  return { total: urls.length, items: urls.slice(0, 9) };
}

/**
 * 把接口原始条目归一化为归档记录（多形态容错，但不猜测结构）。
 * @param {string} modeKey
 * @param {object} item
 * @param {string} ownerType
 * @param {string} ownerId
 * @returns {object|null}
 */
export function mapRecord(modeKey, item, ownerType, ownerId) {
  const meta = MODES[modeKey];
  if (!meta || !item || typeof item !== 'object') return null;
  const user = item.user || item.author || {};
  const authorUid = pickStr(user.idstr, user.id, item.uid);
  const author = pickStr(user.screen_name, user.name, user.nickname);
  const rawId = pickStr(item.idstr, item.id, item.mid, item.id_str, item.mblogid, item.comment_id);
  const numericId = pickNumeric(item.idstr, item.id, item.mid, item.id_str);

  let ms = parseWeiboTime(item.created_at);
  if (!Number.isFinite(ms)) ms = parseWeiboTime(item.createdAt);
  if (!Number.isFinite(ms)) ms = parseWeiboTime(item.created_timestamp);
  if (!Number.isFinite(ms)) ms = parseWeiboTime(item.time);
  if (!Number.isFinite(ms) || !ms) ms = Date.now();

  const normalized = normalizeText(pickStr(item.text, item.content, item.raw_text), 2000);
  const pictures = extractPictures(item);

  const isStatus = meta.entity === 'status';
  // 评论携带的原微博可能�?`status`，也可能�?`weibo`（实测两种都会出现）
  const related = isStatus ? null : item.status || item.weibo || item.retweeted_status || null;
  // 评论所属原微博的作者：发出评论时就是「评论给谁」，收到/被@时也用于展示上下文
  const relatedUser = related && related.user && typeof related.user === 'object' ? related.user : null;
  const postAuthorUid = pickStr(
    relatedUser && relatedUser.idstr,
    relatedUser && relatedUser.id,
    related && related.uid
  );
  const postAuthor = pickStr(relatedUser && relatedUser.screen_name, relatedUser && relatedUser.name);
  const postId = isStatus
    ? pickStr(item.idstr, item.id, item.mid)
    : pickStr(related && related.idstr, related && related.id, related && related.mid, item.status_id);
  const mblogid = pickStr(item.mblogid, item.mid);
  const postUrl = postId
    ? isStatus && /^[A-Za-z0-9]{4,}$/.test(mblogid) && authorUid
      ? `https://weibo.com/${authorUid}/${mblogid}`
      : `https://m.weibo.cn/detail/${postId}`
    : '';

  const recordId = store.makeRecordId(ownerType, ownerId, modeKey, rawId || numericId, {
    authorUid,
    ms,
    text: normalized.text,
  });

  // 互动方向：发出 / 收到 / 提及 / 评论者，用于列表展示「发给谁 / 来自谁」
  let direction = '';
  if (modeKey === 'sent') direction = 'sent';
  else if (modeKey === 'received') direction = 'received';
  else if (modeKey === 'mentions-comments' || modeKey === 'mentions-posts') direction = 'mention';
  else if (modeKey === 'post-comments') direction = 'commenter';
  else if (modeKey === 'both') direction = String(authorUid) === String(ownerId) ? 'sent' : 'received';
  else if (modeKey === 'user-posts') direction = 'self';

  /** @type {Record<string, unknown>} */
  const record = {
    recordId,
    sourceRef: rawId,
    sourceId: numericId,
    mode: modeKey,
    type: meta.label,
    group: modeKey,
    author,
    authorUid,
    postAuthor,
    postAuthorUid,
    direction,
    time: fmtTime(ms),
    ms,
    text: normalized.text,
    textTruncated: normalized.textTruncated,
    postId,
    postUrl,
    source: 'api',
    fetchedAtMs: Date.now(),
  };

  const rootId = pickStr(item.rootid, item.root_id, related && related.idstr);
  if (rootId) record.rootId = rootId;
  // reply_comment 在真实响应里是对象（回复的那条评论），必须取其 id 字段，
  // 否则会被 String() 成 "[object Object]"。
  const replyComment = item.reply_comment && typeof item.reply_comment === 'object' ? item.reply_comment : null;
  const replyId = pickStr(
    replyComment && replyComment.idstr,
    replyComment && replyComment.id,
    replyComment && replyComment.mid,
    item.reply_idstr,
    item.reply_id
  );
  if (replyId) record.replyId = replyId;
  const replyAuthor = pickStr(
    replyComment && replyComment.user && replyComment.user.screen_name,
    item.reply_comment_author,
    item.reply_author
  );
  if (replyAuthor) record.replyAuthor = replyAuthor;
  const likes = Number(item.like_count !== undefined ? item.like_count : item.attitudes_count);
  if (Number.isFinite(likes)) record.likes = likes;
  if (pictures) record.pictures = pictures;

  return record;
}

/* ------------------------------------------------------------------ *
 * 博文正文回填（P0-15）
 * ------------------------------------------------------------------ */

/**
 * 从取数响应里收集「可能是原微博对象」的候选（宽松多形态兜底，拿不到就算了）。
 *
 * 微博评论类接口常把原微博挂在评论项的 `status`（或 `weibo`）里，也有接口把原微博
 * 直接放在顶层 `status` 或 `statuses[]` 中。这里全部收进来，交给 id 精确匹配，
 * 不做任何猜测性结构推断。
 * @param {any} payload 接口原始响应
 * @param {object[]} list 已归一化的条目数组
 * @returns {object[]}
 */
function collectOriginalPostCandidates(payload, list) {
  const out = [];
  const push = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value);
  };
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    push(payload.status);
    push(payload.weibo);
    if (Array.isArray(payload.statuses)) for (const item of payload.statuses) push(item);
    // 真实响应里数据在 result 层，原微博可能挂在 result.status / result.statuses
    for (const container of [payload.data, payload.result, payload.response]) {
      if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
      push(container.status);
      push(container.weibo);
      if (Array.isArray(container.statuses)) for (const item of container.statuses) push(item);
    }
  }
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    push(item.status);
    push(item.weibo);
  }
  return out;
}

/** 候选对象的任一 ID 是否命中目标博文（数字 ID 或 mblogid 短链）。 */
function candidateMatchesPost(candidate, postId, postMid) {
  const ids = [candidate.idstr, candidate.id, candidate.mid, candidate.id_str, candidate.mblogid]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => String(value));
  if (ids.includes(String(postId))) return true;
  if (postMid && ids.includes(String(postMid))) return true;
  return false;
}

/**
 * 尽力从响应中回填当前博文的正文（P0-15「可单独补取正文」的自动路径）。
 *
 * 规则：
 * 1. 只对 `ownerType === 'posts'` 生效 —— 只有此时「当前 owner」就是目标博文。
 * 2. **仅在 `post.text` 为空时写入**，绝不覆盖用户手工粘贴的正文。
 * 3. 响应里找不到原微博对象是常态（不同接口返回结构不同），此时静默跳过、不报错。
 *
 * @param {any} payload 接口原始响应
 * @param {object[]} list 已归一化条目
 * @param {string} postId 目标博文 ID
 * @param {(msg:string)=>void} [pushLog] 任务日志回调
 * @returns {string|null} 回填的正文；未回填返回 null
 */
function backfillPostText(payload, list, postId, pushLog) {
  const post = store.getPost(postId);
  if (!post) return null;
  // 已有正文（用户粘贴或此前回填过）→ 不覆盖
  if (String(post.text || '').trim()) return null;
  const postMid = post.mId ? String(post.mId) : '';
  for (const candidate of collectOriginalPostCandidates(payload, list)) {
    if (!candidateMatchesPost(candidate, postId, postMid)) continue;
    const raw = pickStr(candidate.text, candidate.content, candidate.raw_text);
    if (!raw) continue;
    const normalized = normalizeText(raw, 2000);
    if (!normalized.text) continue;
    store.patchPost(postId, { text: normalized.text, textTruncated: normalized.textTruncated });
    if (typeof pushLog === 'function') {
      pushLog(`回填正文 postId=${postId} chars=${normalized.text.length}`);
    }
    return normalized.text;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 执行引擎
 * ------------------------------------------------------------------ */

/**
 * 执行一次取数（plan 之后的实际翻页）。
 * @param {ReturnType<typeof normalizeParams>} p
 * @param {{
 *   pushLog:(msg:string,level?:string)=>void,
 *   onProgress:(patch:object)=>void,
 *   shouldStop:()=>boolean,
 * }} ctx
 * @returns {Promise<{status:string,reason:string,pages:number,returned:number,added:number,reused:number,credits:number,initialBalance:number|null,finalBalance:number|null}>}
 */
async function execute(p, ctx) {
  const pushLog = typeof ctx.pushLog === 'function' ? ctx.pushLog : () => {};
  const onProgress = typeof ctx.onProgress === 'function' ? ctx.onProgress : () => {};
  const shouldStop = typeof ctx.shouldStop === 'function' ? ctx.shouldStop : () => false;

  const pre = await preflight(p.mode);
  if (!pre.supported) {
    throw new AppError('UNSUPPORTED_COMMAND', `接口 ${pre.group}/${pre.action} 不存在或当前不可用`, 400);
  }
  const strategy = pickStrategy(p.cursor, pre.flags);
  if (!strategy) {
    throw new AppError('UNSUPPORTED_COMMAND', '该接口不支持 since_id / max_id / page，无法安全翻页', 400);
  }
  const supports = (name) => pre.flags.length === 0 || pre.flags.includes(name);
  const unitPrice = pre.unitPrice !== null && Number.isFinite(pre.unitPrice) ? pre.unitPrice : unitPriceFor(p.mode);

  pushLog(
    `预检通过：${pre.group}/${pre.action}（${
      pre.fallback ? '已回退到 other 接口' : '主接口'
    }），单价 ${unitPrice} credits/条，翻页策略 ${strategy}`
  );
  if (pre.fallback) pushLog('提示：user_timeline/biz 不可用，已回退到 statuses/user_timeline/other');

  let initialBalance = null;
  try {
    const info = await weibo.whoami();
    initialBalance = info.balance;
    if (initialBalance !== null) onProgress({ balance: initialBalance });
    pushLog(`当前账户余额 ${initialBalance === null ? '未知' : initialBalance} credits`);
  } catch (err) {
    pushLog(`读取账户余额失败（忽略，继续取数）：${err instanceof Error ? err.message : '未知错误'}`, 'warn');
  }

  let sinceId = p.cursor === 'incremental' ? store.maxSourceId(p.ownerType, p.ownerId, p.mode) : null;
  if (p.cursor === 'incremental') {
    pushLog(sinceId ? `增量起点 since_id=${sinceId}` : '本地无历史记录，增量将从最新一页开始');
  }
  let maxId = null;
  let pages = 0;
  let returned = 0;
  let added = 0;
  let reused = 0;
  let credits = 0;
  let zeroPages = 0;
  let status = 'success';
  let reason = '';

  while (true) {
    if (shouldStop()) {
      status = 'stopped';
      reason = '用户手动停止，已落盘数据保留';
      break;
    }
    if (pages >= LIMITS.maxPages) {
      reason = `已达单次最多 ${LIMITS.maxPages} 页上限`;
      break;
    }
    if (p.limit !== null && returned >= p.limit) {
      reason = `已达条数上限 ${p.limit}`;
      break;
    }
    if (initialBalance !== null && initialBalance - credits <= 0) {
      reason = `余额跌破预估（已花 ${credits.toFixed(2)}，余额 ${initialBalance.toFixed(2)}），已自动停止`;
      break;
    }

    const remaining = p.limit === null ? LIMITS.pageCount : Math.max(1, p.limit - returned);
    const count = Math.max(1, Math.min(LIMITS.pageCount, remaining));

    const args = {};
    if (supports('count')) args.count = count;
    if (supports('uid')) args.uid = p.ownerId;
    if (p.mode === 'post-comments') {
      const post = store.getPost(p.ownerId);
      const pid = post && (post.mId || post.id) ? String(post.mId || post.id) : p.ownerId;
      if (supports('id')) args.id = pid;
      else if (supports('mid')) args.mid = pid;
      else throw new AppError('UNSUPPORTED_COMMAND', '该接口无法定位博文（缺少 id 参数）', 400);
    }
    if (strategy === 'since') {
      if (sinceId) args.since_id = sinceId;
    } else if (strategy === 'maxId') {
      if (maxId) args.max_id = maxId;
    } else {
      args.page = pages + 1;
    }

    let payload;
    try {
      payload = await weibo.invoke({ group: pre.group, action: pre.action, args });
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'UPSTREAM_ERROR';
      if (code === 'TOKEN_INVALID' || code === 'INSUFFICIENT_CREDITS' || code === 'DEMO_MODE' || code === 'UNAUTHORIZED') {
        status = 'failed';
        reason = err instanceof Error ? err.message : '接口拒绝请求';
        break;
      }
      pushLog(`第 ${pages + 1} 页请求失败，重试一次：${err instanceof Error ? err.message : '未知错误'}`, 'warn');
      try {
        payload = await weibo.invoke({ group: pre.group, action: pre.action, args });
      } catch (err2) {
        status = 'failed';
        reason = `第 ${pages + 1} 页请求失败：${err2 instanceof Error ? err2.message : '未知错误'}`;
        break;
      }
    }

    let list;
    try {
      // 传入记录类型：微博类优先找 statuses，评论类优先找 comments
      list = weibo.normalizeList(payload, p.meta.entity === 'status' ? 'statuses' : 'comments');
    } catch (err) {
      status = 'failed';
      reason = `第 ${pages + 1} 页响应无法归一化：${err instanceof Error ? err.message : '未知结构'}`;
      pushLog(reason, 'error');
      break;
    }

    pages += 1;
    returned += list.length;
    // 优先用服务端返回的真实扣费；拿不到才退回“条数 × 单价”估算
    const billed = weibo.billedCredits(payload);
    credits += billed === null ? list.length * unitPrice : billed;

    const toStore = [];
    let oldestMs = null;
    let minId = null;
    let maxSrcId = null;
    let outOfRange = 0;
    for (const item of list) {
      const record = mapRecord(p.mode, item, p.ownerType, p.ownerId);
      if (!record) continue;
      if (oldestMs === null || record.ms < oldestMs) oldestMs = record.ms;
      if (record.sourceId) {
        if (minId === null || BigInt(record.sourceId) < BigInt(minId)) minId = record.sourceId;
        if (maxSrcId === null || BigInt(record.sourceId) > BigInt(maxSrcId)) maxSrcId = record.sourceId;
      }
      // 关键：接口按「返回条数」计费，钱已经花了。落在日期范围外的记录若直接丢弃，
      // 等于白付钱（实测一次 199 条里有 93 条因此被丢，浪费 279 credits）。
      // 因此全部入库保底，仅统计数量用于提示；展示时再由 UI 按范围过滤。
      if ((p.fromMs !== null && record.ms < p.fromMs) || (p.toMs !== null && record.ms > p.toMs)) {
        outOfRange += 1;
      }
      toStore.push(record);
    }

    const stored = store.appendRecords(p.ownerType, p.ownerId, p.mode, toStore);
    added += stored.added;
    reused += stored.reused;
    if (outOfRange > 0) {
      pushLog(
        `本页有 ${outOfRange} 条落在所选日期范围外，已一并保存（接口按返回条数计费，丢弃不会退费）`,
        'warn'
      );
    }

    // 用户昵称回填：`users show/biz` 只允许查本人，无法用它补全他人昵称，
    // 因此改为从取回的记录里取作者名（数据已在手，零额外成本）。
    // 即使本轮是增量且返回 0 条，也从本地已有记录里补一次，让历史数据自愈。
    if (p.ownerType === 'users') {
      const owner = store.getUser(p.ownerId);
      if (owner && (!owner.screenName || /^用户\d+$/.test(owner.screenName))) {
        let named = toStore.find((r) => r.authorUid === p.ownerId && r.author);
        if (!named) {
          try {
            // readRecords 直接返回记录数组（不是 {items}）
            const local = store.readRecords('users', p.ownerId, { page: 1, pageSize: 50 });
            named = (Array.isArray(local) ? local : local.items || []).find(
              (r) => r.authorUid === p.ownerId && r.author
            );
          } catch {
            /* 读本地失败则跳过回填 */
          }
        }
        if (named) {
          try {
            store.patchUser(p.ownerId, { screenName: named.author });
          } catch {
            /* 回填失败不影响取数结果 */
          }
        }
      }
    }

    // P0-15：博文维度取数时，尽力从响应里回填缺失正文（拿不到就跳过，不算失败）
    if (p.ownerType === 'posts') {
      backfillPostText(payload, list, p.ownerId, (message) => pushLog(message));
    }

    pushLog(
      `第 ${pages} 页：返回 ${list.length} 条，入库新增 ${stored.added}，复用 ${stored.reused}，累计消耗 ${credits.toFixed(
        2
      )} credits`
    );
    onProgress({
      page: pages,
      returned,
      added,
      reused,
      credits: Math.round(credits * 100) / 100,
      balance: initialBalance === null ? null : Math.max(0, initialBalance - credits),
    });

    if (list.length === 0) {
      reason = '接口返回 0 条，无更多数据';
      break;
    }
    if (p.limit !== null && returned >= p.limit) {
      reason = `已达条数上限 ${p.limit}`;
      break;
    }
    if (p.fromMs !== null && oldestMs !== null && oldestMs < p.fromMs) {
      reason = '已翻到早于起始日期的记录';
      break;
    }

    if (stored.added === 0) zeroPages += 1;
    else zeroPages = 0;
    if (zeroPages >= LIMITS.noNewPageStop) {
      reason = `连续 ${LIMITS.noNewPageStop} 页无新增，停止以避免重复计费`;
      break;
    }

    if (strategy === 'since') {
      const next = maxSrcId || sinceId;
      if (!next) {
        reason = '响应缺少可用微博 ID，无法推进 since_id';
        break;
      }
      if (next === sinceId) {
        reason = '增量已到最新（since_id 未推进）';
        break;
      }
      sinceId = next;
    } else if (strategy === 'maxId') {
      if (!minId) {
        reason = '响应缺少可用微博 ID，无法推进 max_id';
        break;
      }
      const next = (BigInt(minId) - 1n).toString();
      if (maxId !== null && next === maxId) {
        reason = 'max_id 连续未变化，停止以避免死循环';
        break;
      }
      maxId = next;
    } else if (supports('page') && list.length === 0) {
      reason = '分页已到底';
      break;
    }
  }

  let finalBalance = null;
  try {
    const info = await weibo.whoami();
    finalBalance = info.balance;
  } catch {
    finalBalance = initialBalance === null ? null : Math.max(0, initialBalance - credits);
  }

  // 诚实记账：接口真实扣费以余额变化为准。归一化失败时我们拿不到 billing，
  // 但服务端已经按返回条数扣了钱（实测每次 294 credits）。若只报“消耗 0”，
  // 用户会以为没花钱而反复重试。这里用余额差额兜底，确保账面与实际一致。
  if (finalBalance !== null && initialBalance !== null) {
    const actualSpent = initialBalance - finalBalance;
    if (actualSpent > credits + 0.001) {
      pushLog(
        `注意：本次实际扣费 ${actualSpent.toFixed(2)} credits（高于按入库条数估算的 ${credits.toFixed(
          2
        )}），差额可能来自接口返回但未被解析的条目`,
        'warn'
      );
      credits = actualSpent;
    }
  }

  if (added > 0) store.touchFetchedAt(p.ownerType, p.ownerId);
  if (!reason) reason = '完成';
  pushLog(`结束：${status}，${reason}（新增 ${added} / 复用 ${reused}，消耗 ${credits.toFixed(2)} credits）`);

  return {
    status,
    reason,
    pages,
    returned,
    added,
    reused,
    credits: Math.round(credits * 100) / 100,
    initialBalance,
    finalBalance,
  };
}

/* ------------------------------------------------------------------ *
 * 作业表
 * ------------------------------------------------------------------ */

/** 任务日志入环形缓冲（上限 500 行）。 */
function pushTaskLog(task, message, level = 'info') {
  const line = taskLogLine(message);
  task.logs.push(line);
  if (task.logs.length > LIMITS.logBuffer) task.logs.splice(0, task.logs.length - LIMITS.logBuffer);
  if (level === 'error') log('error', 'fetcher', 'task', { taskId: task.taskId, message });
  else if (level === 'warn') log('warn', 'fetcher', 'task', { taskId: task.taskId, message });
}

/** 清理过旧任务（只保留最近 50 个内存作业）。 */
function pruneTasks() {
  if (tasks.size <= 50) return;
  const finished = [...tasks.values()]
    .filter((t) => t.status !== 'running')
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
  while (tasks.size > 50 && finished.length > 0) {
    const victim = finished.shift();
    tasks.delete(victim.taskId);
  }
}

/**
 * 启动异步取数任务（立即返回 taskId）。
 * @param {object} input 同 plan
 * @returns {{taskId:string}}
 */
export function startTask(input) {
  if (runningId) {
    throw new AppError('TASK_BUSY', '已有取数任务正在运行，请等待其结束或先停止', 409);
  }
  const p = normalizeParams(input);
  const cfg = store.readConfig();
  if (cfg.settings.demoMode) throw new AppError('DEMO_MODE', '演示模式下不会发起真实取数（零付费保护）', 400);
  if (!cfg.token) throw new AppError('UNAUTHORIZED', '请先登录微博账号后再取数', 401);

  const taskId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  /** @type {any} */
  const task = {
    taskId,
    status: 'running',
    params: p,
    progress: {
      page: 0,
      returned: 0,
      added: 0,
      reused: 0,
      credits: 0,
      balance: cfg.balance && Number.isFinite(Number(cfg.balance.value)) ? Number(cfg.balance.value) : null,
    },
    logs: [],
    canStop: true,
    reason: '',
    startedAtMs: Date.now(),
    finishedAtMs: null,
    stopped: false,
  };
  tasks.set(taskId, task);
  pruneTasks();
  runningId = taskId;
  pushTaskLog(task, `任务开始：${p.meta.label} · ${p.ownerType}/${p.ownerId} · ${p.cursor === 'history' ? '历史分页' : '增量更新'}`);
  if (p.fromMs || p.toMs) {
    pushTaskLog(task, `范围：${p.fromMs ? fmtTime(p.fromMs) : '不限'} ~ ${p.toMs ? fmtTime(p.toMs) : '不限'}`);
  }
  if (p.limit !== null) pushTaskLog(task, `条数上限：${p.limit}`);

  const ctx = {
    pushLog: (message, level) => pushTaskLog(task, message, level),
    onProgress: (patch) => Object.assign(task.progress, patch),
    shouldStop: () => task.stopped === true,
  };

  // 异步执行，不阻塞 HTTP 响应
  void (async () => {
    let summary;
    try {
      summary = await execute(p, ctx);
    } catch (err) {
      summary = {
        status: 'failed',
        reason: err instanceof Error ? err.message : '取数失败',
        pages: task.progress.page,
        returned: task.progress.returned,
        added: task.progress.added,
        reused: task.progress.reused,
        credits: task.progress.credits,
        initialBalance: task.progress.balance,
        finalBalance: task.progress.balance,
      };
      pushTaskLog(task, summary.reason, 'error');
    } finally {
      task.status = summary && summary.status ? summary.status : 'failed';
      task.reason = (summary && summary.reason) || '未知原因';
      task.canStop = false;
      task.finishedAtMs = Date.now();
      task.progress.page = summary ? summary.pages : task.progress.page;
      task.progress.returned = summary ? summary.returned : task.progress.returned;
      task.progress.added = summary ? summary.added : task.progress.added;
      task.progress.reused = summary ? summary.reused : task.progress.reused;
      task.progress.credits = summary ? summary.credits : task.progress.credits;
      task.progress.balance = summary && summary.finalBalance !== null ? summary.finalBalance : task.progress.balance;
      runningId = null;
      try {
        store.appendTask({
          taskId: task.taskId,
          mode: p.mode,
          ownerType: p.ownerType,
          ownerId: p.ownerId,
          startedAtMs: task.startedAtMs,
          finishedAtMs: task.finishedAtMs,
          status: task.status,
          returned: task.progress.returned,
          added: task.progress.added,
          reused: task.progress.reused,
          creditsSpent: task.progress.credits,
          initialBalance: summary ? summary.initialBalance : null,
          finalBalance: summary ? summary.finalBalance : null,
          reason: task.reason,
        });
      } catch (err) {
        log('error', 'fetcher', 'appendTask-failed', { taskId: task.taskId, error: err instanceof Error ? err.message : 'x' });
      }
    }
  })();

  return { taskId };
}

/**
 * 查询任务状态（前端 1s 轮询）。
 * @param {string} taskId
 */
export function getTask(taskId) {
  const task = tasks.get(String(taskId || ''));
  if (!task) throw new AppError('TASK_NOT_FOUND', '任务不存在或已被清理', 404);
  return {
    taskId: task.taskId,
    status: task.status,
    progress: { ...task.progress },
    logs: [...task.logs],
    canStop: task.status === 'running' && task.canStop,
    reason: task.reason,
    startedAtMs: task.startedAtMs,
    finishedAtMs: task.finishedAtMs,
    params: {
      mode: task.params.mode,
      modeLabel: task.params.meta.label,
      ownerType: task.params.ownerType,
      ownerId: task.params.ownerId,
      cursor: task.params.cursor,
    },
  };
}

/**
 * 请求停止任务（已落盘数据保留）。
 * @param {string} taskId
 */
export function stopTask(taskId) {
  const task = tasks.get(String(taskId || ''));
  if (!task) throw new AppError('TASK_NOT_FOUND', '任务不存在或已被清理', 404);
  if (task.status !== 'running') throw new AppError('TASK_NOT_RUNNING', '任务已结束，无需停止', 409);
  task.stopped = true;
  task.canStop = false;
  pushTaskLog(task, '收到停止请求，将在当前页结束后停止');
  return { stopping: true };
}

/** 最近任务列表（读 tasks.jsonl）。 */
export function listTasks(limit = 20) {
  return store.readTasks(limit);
}

/**
 * 启动时兜底：把没有 finishedAtMs 的任务补一条 interrupted（P1-02）。
 * @returns {number} 补写的条数
 */
export function markInterruptedTasks() {
  const rows = store.readTasks(200);
  let count = 0;
  for (const row of rows) {
    if (!row || row.finishedAtMs) continue;
    store.appendTask({
      ...row,
      finishedAtMs: Date.now(),
      status: 'interrupted',
      reason: row.reason || '进程退出导致中断，已落盘数据保留',
    });
    count += 1;
  }
  return count;
}

/**
 * 订阅巡检单轮执行（与手动取数共享全局并发锁）。
 * @param {object} sub 订阅对象
 * @returns {Promise<object|null>} null 表示因并发锁被跳过
 */
export async function runSubscription(sub) {
  const cfg = store.readConfig();
  if (cfg.settings.demoMode || !cfg.token) return null;
  if (runningId) return null;
  const placeholder = `sub_${sub.id}_${Date.now()}`;
  runningId = placeholder;
  const lines = [];
  try {
    const p = normalizeParams({
      mode: sub.mode,
      ownerType: sub.ownerType,
      ownerId: sub.ownerId,
      limit: sub.perRoundLimit,
      cursor: 'incremental',
    });
    const summary = await execute(p, {
      pushLog: (message) => lines.push(taskLogLine(message)),
      onProgress: () => {},
      shouldStop: () => false,
    });
    return { ...summary, logs: lines };
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : '订阅取数失败',
      pages: 0,
      returned: 0,
      added: 0,
      reused: 0,
      credits: 0,
      initialBalance: null,
      finalBalance: null,
      logs: lines,
    };
  } finally {
    runningId = null;
  }
}

/** 释放并发锁（测试或异常兜底）。 */
export function __resetRunning() {
  runningId = null;
}

/** 清空内存作业表（测试用）。 */
export function __clearTasks() {
  tasks.clear();
  runningId = null;
}

/** 重新导出归一化器，便于单测直接调用。 */
export { weibo };
