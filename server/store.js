/**
 * @file 存储层：路径解析与安全校验、原子写、JSON/JSONL 读写、recordId 生成、去重入库、
 *       已读覆盖层、gap 计算、订阅/任务/日志/报告索引、数据目录切换。
 *
 * 设计要点（ARCH §1 关键取舍）：
 * 1. 记录层 append-only：只追加分片 JSONL，永不重写历史行。
 * 2. 已读状态写覆盖层 `_read.json`，`isUnread = !(recordId in _read)`。
 * 3. `data/config.json` 固定存放在默认数据根，不随 `settings.dataDir` 迁移（避免自举问题）。
 * @module server/store
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  CONFIG_FILE,
  DEFAULT_DATA_DIR,
  DIRS,
  LIMITS,
  MODE_KEYS,
  MODES,
  REPORT_KEY_RE,
  VERSION,
} from './config.js';
import {
  AppError,
  ID_RE,
  cloneJson,
  dayKey,
  dayStartMs,
  monthKey,
  pinyinCompare,
  sha1hex,
  todayKey,
} from './util.js';

/** @typedef {{recordCount:number,unreadCount:number,byMode:Record<string,number>}} Stats */

/* ------------------------------------------------------------------ *
 * 基础 IO
 * ------------------------------------------------------------------ */

/** 递归创建目录（幂等）。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 读 JSON；文件缺失或损坏返回 fallback。 */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * `fs.renameSync` 的 Windows 友好封装：遇瞬时锁（EPERM/EBUSY/EACCES）重试。
 *
 * Windows 上杀毒软件 / 搜索索引器会短暂占用刚写入的文件，此时 rename 会抛 EPERM。
 * 这类错误是瞬时的，退避重试几次即可成功；不重试会让一次普通的设置保存或数据入账
 * 变成 500（实测在 Windows Defender 开启时概率不低）。
 * @param {string} from
 * @param {string} to
 * @param {number} [attempts=5]
 */
function renameWithRetry(from, to, attempts = 5) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      lastError = err;
      const code = err && err.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      // 极短的同步退避：单次操作最多多花 ~30ms，可接受的代价换稳定性
      const until = Date.now() + 5 * (i + 1);
      while (Date.now() < until) {
        /* 同步忙等，避免引入异步把调用方改成 async */
      }
    }
  }
  try {
    fs.rmSync(from, { force: true });
  } catch {
    /* 清理临时文件失败不影响错误抛出 */
  }
  throw lastError;
}

/** 原子写 JSON：先写临时文件再 rename，断电不留半文件。 */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameWithRetry(tmp, file);
}

/** 原子写纯文本。 */
export function writeText(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  renameWithRetry(tmp, file);
}

/** 追加 JSONL 行。 */
export function appendLines(file, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  ensureDir(path.dirname(file));
  const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  fs.appendFileSync(file, text, 'utf8');
}

/** 读 JSONL；逐行容错（坏行跳过）。 */
export function readLines(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* 忽略损坏行，避免单行坏数据阻断整库读取 */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 配置文件（token / 账户 / 余额 / 价目 / 设置）
 * ------------------------------------------------------------------ */

/** 默认配置结构。 */
function defaultConfig() {
  return {
    version: 1,
    token: null,
    refreshToken: null,
    tokenExpiresAt: null,
    account: null,
    balance: null,
    pricing: {},
    pricingAtMs: null,
    settings: {
      dataDir: '',
      pageSize: LIMITS.defaultPageSize,
      demoMode: false,
      reportMaxRecords: LIMITS.defaultReportMax,
      logLevel: 'info',
    },
  };
}

/** 归一化配置文件，补齐缺省字段。 */
function normalizeConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== 'object') return base;
  const out = { ...base, ...raw };
  out.version = Number(out.version) || 1;
  out.token = typeof out.token === 'string' && out.token ? out.token : null;
  out.refreshToken = typeof out.refreshToken === 'string' && out.refreshToken ? out.refreshToken : null;
  out.tokenExpiresAt = numOrNull(out.tokenExpiresAt);
  out.account = out.account && typeof out.account === 'object' ? out.account : null;
  out.balance =
    out.balance && Number.isFinite(Number(out.balance.value))
      ? {
          value: Number(out.balance.value),
          atMs: Number(out.balance.atMs) || 0,
          serviceKind: out.balance.serviceKind ? String(out.balance.serviceKind) : '',
        }
      : null;
  out.pricing = out.pricing && typeof out.pricing === 'object' ? out.pricing : {};
  out.pricingAtMs = numOrNull(out.pricingAtMs);
  const s = out.settings && typeof out.settings === 'object' ? out.settings : {};
  out.settings = {
    dataDir: typeof s.dataDir === 'string' ? s.dataDir : '',
    pageSize: Number(s.pageSize) > 0 ? Math.trunc(Number(s.pageSize)) : LIMITS.defaultPageSize,
    demoMode: Boolean(s.demoMode),
    reportMaxRecords: Number(s.reportMaxRecords) > 0 ? Math.trunc(Number(s.reportMaxRecords)) : LIMITS.defaultReportMax,
    logLevel: typeof s.logLevel === 'string' ? s.logLevel : 'info',
  };
  return out;
}

let cfgCache = null;
let cfgCacheMtime = -1;

/**
 * 读取配置（返回深拷贝，调用方可安全修改）。
 * @returns {ReturnType<typeof defaultConfig>}
 */
export function readConfig() {
  let stat = null;
  try {
    stat = fs.statSync(CONFIG_FILE);
  } catch {
    stat = null;
  }
  if (!stat) {
    cfgCache = defaultConfig();
    cfgCacheMtime = -1;
    return cloneJson(cfgCache);
  }
  if (cfgCache && cfgCacheMtime === stat.mtimeMs) return cloneJson(cfgCache);
  cfgCache = normalizeConfig(readJson(CONFIG_FILE, null));
  cfgCacheMtime = stat.mtimeMs;
  return cloneJson(cfgCache);
}

/**
 * 合并写入配置（浅合顶层 + 深合 settings）。
 * @param {object} patch
 * @returns {object} 写入后的完整配置
 */
export function writeConfig(patch) {
  const current = readConfig();
  const next = { ...current, ...(patch || {}) };
  if (patch && patch.settings) next.settings = { ...current.settings, ...patch.settings };
  if (patch && patch.balance === null) next.balance = null;
  const normalized = normalizeConfig(next);
  writeJson(CONFIG_FILE, normalized);
  cfgCache = normalized;
  try {
    cfgCacheMtime = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch {
    cfgCacheMtime = -1;
  }
  return cloneJson(normalized);
}

/** 读取设置项。 */
export function getSettings() {
  return readConfig().settings;
}

/** 基础数据目录（不含 demo 子目录）。 */
export function baseDataDir() {
  const dir = getSettings().dataDir;
  return dir ? path.resolve(dir) : DEFAULT_DATA_DIR;
}

/**
 * 当前生效的数据根：演示模式时指向 `<base>/demo`，与真实数据天然隔离。
 * @returns {string} 绝对路径
 */
export function getRoot() {
  const cfg = readConfig();
  const base = baseDataDir();
  return cfg.settings.demoMode ? path.join(base, DIRS.demo) : base;
}

/** 确保数据根下所有必需目录存在。 */
export function ensureDirs() {
  const root = getRoot();
  ensureDir(root);
  ensureDir(path.join(root, DIRS.records, 'users'));
  ensureDir(path.join(root, DIRS.records, 'posts'));
  ensureDir(path.join(root, DIRS.reports));
  ensureDir(path.join(root, DIRS.logs));
  ensureDir(path.join(root, DIRS.exports));
}

/**
 * 安全拼接路径：`resolve` 后必须仍位于 root 之内，否则抛 UNSAFE_PATH。
 * @param {string} root 根目录
 * @param {...string} parts 子路径片段
 * @returns {string} 绝对路径
 */
export function safeJoin(root, ...parts) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, ...parts.map((p) => String(p)));
  if (target !== rootResolved && !target.startsWith(`${rootResolved}${path.sep}`)) {
    throw new AppError('UNSAFE_PATH', '路径越界，已拒绝访问', 400);
  }
  return target;
}

/**
 * 校验 ownerType。
 * @param {unknown} ownerType
 * @returns {'users'|'posts'}
 */
export function assertOwnerType(ownerType) {
  const value = String(ownerType || '');
  if (value !== 'users' && value !== 'posts') {
    throw new AppError('BAD_REQUEST', '对象类型必须是 users 或 posts', 400);
  }
  return value;
}

/** ownerType 对应的主键字段名。 */
export function ownerKeyField(ownerType) {
  return assertOwnerType(ownerType) === 'users' ? 'uid' : 'id';
}

/* ------------------------------------------------------------------ *
 * 用户 / 博文索引
 * ------------------------------------------------------------------ */

/**
 * 宽松数字转换：null / undefined / '' / 非数字 / 非正数统一返回 null。
 * 时间戳字段不可能为 0（1970），因此 0 也归为「未设置」，避免 `Number(null) === 0` 写脏数据。
 * @param {unknown} value
 * @returns {number|null}
 */
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** 空统计。 */
export function emptyStats() {
  return { recordCount: 0, unreadCount: 0, byMode: {} };
}

function normalizeStats(raw) {
  const out = emptyStats();
  if (raw && typeof raw === 'object') {
    out.recordCount = Number.isFinite(Number(raw.recordCount)) ? Math.max(0, Math.trunc(Number(raw.recordCount))) : 0;
    out.unreadCount = Number.isFinite(Number(raw.unreadCount)) ? Math.max(0, Math.trunc(Number(raw.unreadCount))) : 0;
    if (raw.byMode && typeof raw.byMode === 'object') {
      for (const [k, v] of Object.entries(raw.byMode)) {
        const n = Number(v);
        if (MODE_KEYS.includes(k) && Number.isFinite(n)) out.byMode[k] = Math.max(0, Math.trunc(n));
      }
    }
  }
  return out;
}

function usersFile() {
  return safeJoin(getRoot(), 'users.json');
}

function postsFile() {
  return safeJoin(getRoot(), 'posts.json');
}

function readUsersDoc() {
  const raw = readJson(usersFile(), null);
  const users = raw && Array.isArray(raw.users) ? raw.users : [];
  return {
    version: 1,
    users: users
      .filter((u) => u && ID_RE.test(String(u.uid || '')))
      .map((u) => ({
        uid: String(u.uid),
        screenName: String(u.screenName || `用户${u.uid}`),
        avatarUrl: String(u.avatarUrl || ''),
        remark: String(u.remark || ''),
        starred: Boolean(u.starred),
        addedAtMs: Number(u.addedAtMs) || 0,
        lastFetchedAtMs: numOrNull(u.lastFetchedAtMs),
        stats: normalizeStats(u.stats),
      })),
  };
}

function readPostsDoc() {
  const raw = readJson(postsFile(), null);
  const posts = raw && Array.isArray(raw.posts) ? raw.posts : [];
  return {
    version: 1,
    posts: posts
      .filter((p) => p && ID_RE.test(String(p.id || '')))
      .map((p) => ({
        id: String(p.id),
        mId: p.mId ? String(p.mId) : null,
        authorUid: String(p.authorUid || ''),
        author: String(p.author || ''),
        text: String(p.text || ''),
        textTruncated: Boolean(p.textTruncated),
        createdAtMs: numOrNull(p.createdAtMs),
        sourceUrl: String(p.sourceUrl || ''),
        favorite: Boolean(p.favorite),
        addedAtMs: Number(p.addedAtMs) || 0,
        lastFetchedAtMs: numOrNull(p.lastFetchedAtMs),
        stats: normalizeStats(p.stats),
      })),
  };
}

function writeUsersDoc(doc) {
  writeJson(usersFile(), { version: 1, users: doc.users });
}

function writePostsDoc(doc) {
  writeJson(postsFile(), { version: 1, posts: doc.posts });
}

/**
 * 列出用户（按星标置顶 + 拼音序）。
 * @param {{q?:string,starred?:boolean}} [opts]
 */
export function listUsers(opts = {}) {
  const doc = readUsersDoc();
  const q = String(opts.q || '').trim().toLowerCase();
  let items = doc.users;
  if (q) {
    items = items.filter(
      (u) => u.screenName.toLowerCase().includes(q) || u.uid.includes(q) || u.remark.toLowerCase().includes(q)
    );
  }
  if (opts.starred) items = items.filter((u) => u.starred);
  items = [...items].sort((a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    return pinyinCompare(a.screenName, b.screenName);
  });
  return { items: cloneJson(items), total: items.length };
}

/** 取单个用户，不存在返回 null。 */
export function getUser(uid) {
  const id = String(uid || '');
  const found = readUsersDoc().users.find((u) => u.uid === id);
  return found ? cloneJson(found) : null;
}

/** 按昵称精确匹配用户（昵称解析兜底，0 credits）。 */
export function findUserByScreenName(screenName) {
  const name = String(screenName || '').trim();
  if (!name) return null;
  const found = readUsersDoc().users.find((u) => u.screenName === name);
  return found ? cloneJson(found) : null;
}

/**
 * 新增用户；已存在则更新可获取的展示字段并返回 created:false。
 * @param {{uid:string,screenName?:string,avatarUrl?:string,starred?:boolean}} payload
 */
export function addUser(payload) {
  const uid = String(payload && payload.uid ? payload.uid : '');
  if (!ID_RE.test(uid)) throw new AppError('INVALID_ID', 'UID 必须是 1~20 位数字', 400);
  const doc = readUsersDoc();
  const found = doc.users.find((u) => u.uid === uid);
  if (found) {
    let changed = false;
    if (payload.screenName && payload.screenName !== found.screenName) {
      found.screenName = String(payload.screenName);
      changed = true;
    }
    if (payload.avatarUrl && payload.avatarUrl !== found.avatarUrl) {
      found.avatarUrl = String(payload.avatarUrl);
      changed = true;
    }
    if (changed) writeUsersDoc(doc);
    return { user: cloneJson(found), created: false };
  }
  const user = {
    uid,
    screenName: String(payload.screenName || `用户${uid}`),
    avatarUrl: String(payload.avatarUrl || ''),
    remark: '',
    starred: Boolean(payload.starred),
    addedAtMs: Date.now(),
    lastFetchedAtMs: null,
    stats: emptyStats(),
  };
  doc.users.push(user);
  writeUsersDoc(doc);
  return { user: cloneJson(user), created: true };
}

/**
 * 更新用户可编辑字段。
 * @param {string} uid
 * @param {{starred?:boolean,remark?:string,screenName?:string,avatarUrl?:string,lastFetchedAtMs?:number}} patch
 */
export function patchUser(uid, patch) {
  const id = String(uid || '');
  const doc = readUsersDoc();
  const found = doc.users.find((u) => u.uid === id);
  if (!found) throw new AppError('NOT_FOUND', '该用户不在本地库中', 404);
  if (patch && typeof patch.starred === 'boolean') found.starred = patch.starred;
  if (patch && typeof patch.remark === 'string') found.remark = patch.remark;
  if (patch && typeof patch.screenName === 'string' && patch.screenName) found.screenName = patch.screenName;
  if (patch && typeof patch.avatarUrl === 'string') found.avatarUrl = patch.avatarUrl;
  if (patch && Number.isFinite(Number(patch.lastFetchedAtMs))) found.lastFetchedAtMs = Number(patch.lastFetchedAtMs);
  writeUsersDoc(doc);
  return cloneJson(found);
}

/**
 * 删除用户；purge=true 时同时删除其记录目录。
 * @returns {{deleted:boolean,recordsRemoved:number}}
 */
export function deleteUser(uid, opts = {}) {
  const id = String(uid || '');
  const doc = readUsersDoc();
  const idx = doc.users.findIndex((u) => u.uid === id);
  if (idx === -1) throw new AppError('NOT_FOUND', '该用户不在本地库中', 404);
  const target = doc.users[idx];
  let recordsRemoved = 0;
  if (opts.purge) {
    recordsRemoved = purgeRecords('users', id);
  } else {
    recordsRemoved = Number(target.stats && target.stats.recordCount) || 0;
  }
  doc.users.splice(idx, 1);
  writeUsersDoc(doc);
  return { deleted: true, recordsRemoved };
}

/** 列出博文。 */
export function listPosts(opts = {}) {
  const doc = readPostsDoc();
  const q = String(opts.q || '').trim().toLowerCase();
  let items = doc.posts;
  if (q) {
    items = items.filter(
      (p) =>
        p.text.toLowerCase().includes(q) ||
        p.id.includes(q) ||
        p.author.toLowerCase().includes(q) ||
        p.authorUid.includes(q)
    );
  }
  if (opts.favorite) items = items.filter((p) => p.favorite);
  items = [...items].sort((a, b) => (b.createdAtMs || b.addedAtMs || 0) - (a.createdAtMs || a.addedAtMs || 0));
  return { items: cloneJson(items), total: items.length };
}

/** 取单条博文，不存在返回 null。 */
export function getPost(id) {
  const key = String(id || '');
  const found = readPostsDoc().posts.find((p) => p.id === key);
  return found ? cloneJson(found) : null;
}

/**
 * 新增博文（仅创建记录，不自动取评论）。
 * @param {{id:string,mId?:string|null,authorUid?:string,author?:string,text?:string,createdAtMs?:number|null,sourceUrl?:string}} payload
 */
export function addPost(payload) {
  const id = String(payload && payload.id ? payload.id : '');
  if (!ID_RE.test(id)) throw new AppError('INVALID_ID', '微博 ID 必须是 1~20 位数字', 400);
  const doc = readPostsDoc();
  const found = doc.posts.find((p) => p.id === id);
  if (found) {
    let changed = false;
    const fields = ['mId', 'authorUid', 'author', 'text', 'sourceUrl'];
    for (const f of fields) {
      if (payload[f] && payload[f] !== found[f]) {
        found[f] = String(payload[f]);
        changed = true;
      }
    }
    if (changed) writePostsDoc(doc);
    return { post: cloneJson(found), created: false };
  }
  const post = {
    id,
    mId: payload.mId ? String(payload.mId) : null,
    authorUid: String(payload.authorUid || ''),
    author: String(payload.author || ''),
    text: String(payload.text || ''),
    textTruncated: Boolean(payload.textTruncated),
    createdAtMs: numOrNull(payload.createdAtMs),
    sourceUrl: String(payload.sourceUrl || ''),
    favorite: false,
    addedAtMs: Date.now(),
    lastFetchedAtMs: null,
    stats: emptyStats(),
  };
  doc.posts.push(post);
  writePostsDoc(doc);
  return { post: cloneJson(post), created: true };
}

/** 更新博文可编辑字段。 */
export function patchPost(id, patch) {
  const key = String(id || '');
  const doc = readPostsDoc();
  const found = doc.posts.find((p) => p.id === key);
  if (!found) throw new AppError('NOT_FOUND', '该博文不在本地库中', 404);
  if (patch && typeof patch.favorite === 'boolean') found.favorite = patch.favorite;
  if (patch && typeof patch.text === 'string') found.text = patch.text;
  if (patch && typeof patch.textTruncated === 'boolean') found.textTruncated = patch.textTruncated;
  if (patch && Number.isFinite(Number(patch.lastFetchedAtMs))) found.lastFetchedAtMs = Number(patch.lastFetchedAtMs);
  writePostsDoc(doc);
  return cloneJson(found);
}

/** 删除博文。 */
export function deletePost(id, opts = {}) {
  const key = String(id || '');
  const doc = readPostsDoc();
  const idx = doc.posts.findIndex((p) => p.id === key);
  if (idx === -1) throw new AppError('NOT_FOUND', '该博文不在本地库中', 404);
  const target = doc.posts[idx];
  const recordsRemoved = opts.purge
    ? purgeRecords('posts', key)
    : Number(target.stats && target.stats.recordCount) || 0;
  doc.posts.splice(idx, 1);
  writePostsDoc(doc);
  return { deleted: true, recordsRemoved };
}

/**
 * 删除某对象的全部记录目录。
 * @returns {number} 被删除的记录条数
 */
export function purgeRecords(ownerType, ownerId) {
  const dir = recordsDir(ownerType, ownerId);
  const count = countAllRecords(ownerType, ownerId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    throw new AppError('IO_ERROR', '删除记录目录失败', 500);
  }
  shardCache.clear();
  return count;
}

/* ------------------------------------------------------------------ *
 * 记录层
 * ------------------------------------------------------------------ */

/** 分片 ID 缓存：file → {mtimeMs, size, ids}。 */
const shardCache = new Map();

/**
 * 记录目录：`<root>/records/<ownerType>/<ownerId>/`
 * @param {string} ownerType
 * @param {string} ownerId
 * @returns {string}
 */
export function recordsDir(ownerType, ownerId) {
  const type = assertOwnerType(ownerType);
  const id = String(ownerId || '');
  if (!ID_RE.test(id)) throw new AppError('INVALID_ID', '对象 ID 必须是 1~20 位数字', 400);
  return safeJoin(getRoot(), DIRS.records, type, id);
}

/** 已读覆盖层文件路径。 */
function overlayFile(ownerType, ownerId) {
  return safeJoin(recordsDir(ownerType, ownerId), '_read.json');
}

/**
 * 生成稳定唯一的 recordId：`sha1(ownerType:ownerId:mode:sourceId)` 前 16 位。
 * 无来源 ID 时退化用 `mode|authorUid|ms|text前80`，保证同一微博重复拉到同一 recordId。
 * @param {string} ownerType
 * @param {string} ownerId
 * @param {string} mode
 * @param {string} sourceId 来源微博/评论 ID（可为空）
 * @param {{authorUid?:string,ms?:number,text?:string}} [fallback]
 * @returns {string} 16 位 hex
 */
export function makeRecordId(ownerType, ownerId, mode, sourceId, fallback = {}) {
  const sid = String(sourceId || '').trim();
  const seed = sid
    ? `${ownerType}:${ownerId}:${mode}:${sid}`
    : `${ownerType}:${ownerId}:${mode}:h:${fallback.authorUid || ''}|${fallback.ms || 0}|${String(
        fallback.text || ''
      ).slice(0, 80)}`;
  return sha1hex(seed).slice(0, 16);
}

/** 读取分片内的 recordId 集合（带 mtime 缓存）。 */
function loadShardIds(file) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }
  const cached = shardCache.get(file);
  if (stat && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.ids;
  const ids = new Set();
  if (stat) {
    for (const row of readLines(file)) {
      if (row && row.recordId) ids.add(String(row.recordId));
    }
  }
  shardCache.set(file, { mtimeMs: stat ? stat.mtimeMs : 0, size: stat ? stat.size : -1, ids });
  return ids;
}

/**
 * 读取某对象**某模式下全部年月分片**的 recordId 并集（去重必须跨分片）。
 *
 * 为什么不能只看目标月分片：`recordId` 由「来源微博 ID」决定，而分片键取 `ms`。
 * 同一条微博若两次归一化得到不同的 `ms`（上游 `created_at` 抖动，或某次解析失败
 * 回落到 `Date.now()`），就会落进不同年月分片 —— 只按目标月去重会把它重复入库，
 * 并让未读数被重复计数。
 *
 * 缓存签名 = 各分片的 `mtime:size` 拼接，任一写入即失效。
 * @param {string} dir 对象记录目录
 * @param {string} mode 内容模式
 * @returns {Set<string>} 该模式下已入库的全部 recordId
 */
function loadModeIds(dir, mode) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return new Set();
  }
  const prefix = `${mode}_`;
  const shards = names.filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl')).sort();
  const parts = [];
  for (const name of shards) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      parts.push(`${name}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${name}:?`);
    }
  }
  const cacheKey = `mode:${dir}|${mode}`;
  const signature = parts.join('|');
  const cached = shardCache.get(cacheKey);
  if (cached && cached.signature === signature) return cached.ids;

  const ids = new Set();
  for (const name of shards) {
    for (const id of loadShardIds(path.join(dir, name))) ids.add(id);
  }
  shardCache.set(cacheKey, { signature, ids });
  return ids;
}

/** 追加后刷新分片缓存状态。 */
function refreshShardCache(file, ids) {  try {
    const stat = fs.statSync(file);
    shardCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ids });
  } catch {
    shardCache.delete(file);
  }
}

/**
 * 追加记录（按 `ms` 的本地年月分片，append-only）。
 * @param {string} ownerType
 * @param {string} ownerId
 * @param {string} mode
 * @param {Array<object>} items 已归一化的记录
 * @returns {{added:number,reused:number,addedItems:object[]}}
 */
export function appendRecords(ownerType, ownerId, mode, items) {
  const meta = MODES[mode];
  if (!meta) throw new AppError('INVALID_MODE', `未知内容模式：${mode}`, 400);
  if (!Array.isArray(items) || items.length === 0) return { added: 0, reused: 0, addedItems: [] };
  const dir = recordsDir(ownerType, ownerId);
  ensureDir(dir);

  /** @type {Map<string, object[]>} 分片年月 → 行 */
  const byMonth = new Map();
  for (const item of items) {
    const ms = Number(item && item.ms);
    const ym = monthKey(Number.isFinite(ms) ? ms : Date.now());
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(item);
  }

  // 去重集合取自**该模式下全部年月分片**的并集（跨分片），避免同一条记录
  // 因 ms 落在不同月份而被重复入库。集合随写随更新，同批内重复也能被拦住。
  const knownIds = loadModeIds(dir, mode);

  let added = 0;
  const addedItems = [];
  for (const [ym, rows] of byMonth) {
    const file = safeJoin(dir, `${mode}_${ym}.jsonl`);
    const fresh = [];
    for (const row of rows) {
      const recordId = String(row && row.recordId ? row.recordId : '');
      if (!recordId || knownIds.has(recordId)) continue;
      knownIds.add(recordId);
      fresh.push(row);
      added += 1;
      addedItems.push(row);
    }
    if (fresh.length > 0) {
      appendLines(file, fresh);
      refreshShardCache(file, loadShardIds(file));
    }
  }
  // 分片已变，让模式级并集缓存在下次调用时重建
  shardCache.delete(`mode:${dir}|${mode}`);

  const reused = items.length - added;
  if (added > 0) {
    patchStats(ownerType, ownerId, { recordCount: added, unreadCount: added, byMode: { [mode]: added } });
  }
  return { added, reused, addedItems };
}

/**
 * 读取记录（默认按 ms 倒序，附 isUnread）。
 * @param {string} ownerType
 * @param {string} ownerId
 * @param {{mode?:string|string[],fromMs?:number|null,toMs?:number|null,unread?:boolean}} [opts]
 * @returns {object[]}
 */
export function readRecords(ownerType, ownerId, opts = {}) {
  const dir = recordsDir(ownerType, ownerId);
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const wanted = opts.mode ? (Array.isArray(opts.mode) ? opts.mode : [opts.mode]) : MODE_KEYS;
  const overlay = readOverlay(ownerType, ownerId);
  const hasRead = (id) => Object.prototype.hasOwnProperty.call(overlay.recordIds, id);
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const mode = wanted.find((m) => file.startsWith(`${m}_`));
    if (!mode) continue;
    for (const rec of readLines(path.join(dir, file))) {
      if (!rec || typeof rec !== 'object') continue;
      const ms = Number(rec.ms) || 0;
      if (opts.fromMs !== undefined && opts.fromMs !== null && ms < opts.fromMs) continue;
      if (opts.toMs !== undefined && opts.toMs !== null && ms > opts.toMs) continue;
      const unread = !hasRead(String(rec.recordId || ''));
      if (opts.unread && !unread) continue;
      out.push({ ...rec, ms, isUnread: unread });
    }
  }
  out.sort((a, b) => b.ms - a.ms || String(b.recordId).localeCompare(String(a.recordId)));
  return out;
}

/** 统计某对象全部记录条数（不读内容，只数行）。 */
export function countAllRecords(ownerType, ownerId) {
  const dir = recordsDir(ownerType, ownerId);
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    total += readLines(path.join(dir, file)).length;
  }
  return total;
}

/** 统计某模式下（可限定区间）的本地记录条数。 */
export function countLocal(ownerType, ownerId, mode, fromMs, toMs) {
  return readRecords(ownerType, ownerId, { mode, fromMs, toMs }).length;
}

/**
 * 本地该对象+模式的最大来源数字 ID（增量游标 since_id）。
 * @returns {string|null}
 */
export function maxSourceId(ownerType, ownerId, mode) {
  const recs = readRecords(ownerType, ownerId, { mode });
  let max = null;
  for (const rec of recs) {
    const sid = String(rec.sourceId || '');
    if (!/^\d{1,25}$/.test(sid)) continue;
    if (max === null || BigInt(sid) > BigInt(max)) max = sid;
  }
  return max;
}

/** 读已读覆盖层。 */
export function readOverlay(ownerType, ownerId) {
  const raw = readJson(overlayFile(ownerType, ownerId), null);
  const out = { version: 1, recordIds: {} };
  if (!raw || typeof raw !== 'object') return out;
  const src = raw.recordIds && typeof raw.recordIds === 'object' ? raw.recordIds : raw;
  for (const [key, value] of Object.entries(src)) {
    if (key === 'version' || key === 'recordIds') continue;
    if (!key) continue;
    out.recordIds[key] = Number(value) || 0;
  }
  return out;
}

/**
 * 标记已读（覆盖层合并写），并同步索引里的未读缓存。
 * @param {string} ownerType
 * @param {string} ownerId
 * @param {string[]} ids
 * @returns {{marked:number,unreadTotal:number}}
 */
export function markRead(ownerType, ownerId, ids) {
  const overlay = readOverlay(ownerType, ownerId);
  const now = Date.now();
  let marked = 0;
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = typeof raw === 'string' ? raw : String(raw || '');
    if (!id) continue;
    if (Object.prototype.hasOwnProperty.call(overlay.recordIds, id)) continue;
    overlay.recordIds[id] = now;
    marked += 1;
  }
  if (marked > 0) {
    const dir = recordsDir(ownerType, ownerId);
    ensureDir(dir);
    writeJson(safeJoin(dir, '_read.json'), overlay);
    patchStats(ownerType, ownerId, { unreadCount: -marked });
  }
  const entry = ownerType === 'users' ? getUser(ownerId) : getPost(ownerId);
  const unreadTotal = entry && entry.stats ? entry.stats.unreadCount : 0;
  return { marked, unreadTotal };
}

/**
 * 计算出未读记录 ID 列表（报告用）。
 * @returns {string[]}
 */
export function unreadRecordIds(ownerType, ownerId, records) {
  const overlay = readOverlay(ownerType, ownerId);
  const out = [];
  for (const rec of records) {
    const id = String(rec.recordId || '');
    if (!id) continue;
    if (!Object.prototype.hasOwnProperty.call(overlay.recordIds, id)) out.push(id);
  }
  return out;
}

/**
 * gap 待补区间：本地已有记录日之外的连续日段。
 * @param {string} ownerType
 * @param {string} ownerId
 * @param {string} mode
 * @param {number|null} fromMs
 * @param {number|null} toMs
 * @returns {Array<{startDay:string,endDay:string,days:number,startMs:number,endMs:number,limit:number}>}
 */
export function gaps(ownerType, ownerId, mode, fromMs, toMs) {
  const records = readRecords(ownerType, ownerId, { mode });
  if (records.length === 0) return [];
  const days = new Set(records.map((r) => dayKey(r.ms)).filter(Boolean));
  const earliest = records.reduce((min, r) => (r.ms < min ? r.ms : min), records[0].ms);
  const latest = records.reduce((max, r) => (r.ms > max ? r.ms : max), records[0].ms);
  const startMs = fromMs !== null && fromMs !== undefined ? dayStartMs(fromMs) : dayStartMs(earliest);
  const endMs = toMs !== null && toMs !== undefined ? dayStartMs(toMs) : dayStartMs(Math.max(latest, Date.now()));
  if (startMs > endMs) return [];

  const out = [];
  let runStart = null;
  let runEnd = null;
  let cursor = startMs;
  let guard = 0;
  while (cursor <= endMs && guard < 5000) {
    guard += 1;
    const key = dayKey(cursor);
    if (!days.has(key)) {
      if (runStart === null) runStart = cursor;
      runEnd = cursor;
    } else if (runStart !== null) {
      out.push(buildGap(runStart, runEnd));
      runStart = null;
      runEnd = null;
    }
    const next = new Date(cursor);
    next.setDate(next.getDate() + 1);
    cursor = next.getTime();
  }
  if (runStart !== null) out.push(buildGap(runStart, runEnd));
  return out;
}

/** 组装单个 gap 对象。 */
function buildGap(startMs, endMs) {
  const days = Math.max(1, Math.round((dayStartMs(endMs) - dayStartMs(startMs)) / 86400000) + 1);
  return {
    startDay: dayKey(startMs),
    endDay: dayKey(endMs),
    days,
    startMs: dayStartMs(startMs),
    endMs: endMs,
    limit: Math.min(2000, Math.max(80, days * 80)),
  };
}

/** 按日聚合时间轴：[{day,count,unread,ms}]（升序）。 */
export function timeline(records) {
  /** @type {Map<string,{day:string,count:number,unread:number,ms:number}>} */
  const map = new Map();
  for (const rec of records) {
    const key = dayKey(rec.ms);
    if (!key) continue;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { day: key, count: 0, unread: 0, ms: dayStartMs(rec.ms) };
      map.set(key, bucket);
    }
    bucket.count += 1;
    if (rec.isUnread) bucket.unread += 1;
  }
  return [...map.values()].sort((a, b) => a.ms - b.ms);
}

/**
 * 增量修改索引里的统计缓存。
 * @param {string} ownerType
 * @param {string} ownerId
 * @param {{recordCount?:number,unreadCount?:number,byMode?:Record<string,number>}} delta
 */
function patchStats(ownerType, ownerId, delta) {
  if (ownerType === 'users') {
    const doc = readUsersDoc();
    const found = doc.users.find((u) => u.uid === String(ownerId));
    if (!found) return;
    found.stats = normalizeStats(found.stats);
    found.stats.recordCount = Math.max(0, found.stats.recordCount + (delta.recordCount || 0));
    found.stats.unreadCount = Math.max(0, found.stats.unreadCount + (delta.unreadCount || 0));
    for (const [mode, n] of Object.entries(delta.byMode || {})) {
      found.stats.byMode[mode] = Math.max(0, (found.stats.byMode[mode] || 0) + n);
    }
    writeUsersDoc(doc);
    return;
  }
  const doc = readPostsDoc();
  const found = doc.posts.find((p) => p.id === String(ownerId));
  if (!found) return;
  found.stats = normalizeStats(found.stats);
  found.stats.recordCount = Math.max(0, found.stats.recordCount + (delta.recordCount || 0));
  found.stats.unreadCount = Math.max(0, found.stats.unreadCount + (delta.unreadCount || 0));
  for (const [mode, n] of Object.entries(delta.byMode || {})) {
    found.stats.byMode[mode] = Math.max(0, (found.stats.byMode[mode] || 0) + n);
  }
  writePostsDoc(doc);
}

/** 记录入账后更新「最近取数时间」。 */
export function touchFetchedAt(ownerType, ownerId) {
  const now = Date.now();
  if (ownerType === 'users') patchUser(ownerId, { lastFetchedAtMs: now });
  else patchPost(ownerId, { lastFetchedAtMs: now });
}

/**
 * 从记录层重建对象统计（导入后校正用）。
 * @returns {Stats}
 */
export function recomputeStats(ownerType, ownerId) {
  const records = readRecords(ownerType, ownerId, {});
  const stats = emptyStats();
  for (const rec of records) {
    stats.recordCount += 1;
    if (rec.isUnread) stats.unreadCount += 1;
    const mode = String(rec.mode || '');
    if (MODE_KEYS.includes(mode)) stats.byMode[mode] = (stats.byMode[mode] || 0) + 1;
  }
  if (ownerType === 'users') {
    const doc = readUsersDoc();
    const found = doc.users.find((u) => u.uid === String(ownerId));
    if (found) {
      found.stats = stats;
      writeUsersDoc(doc);
    }
  } else {
    const doc = readPostsDoc();
    const found = doc.posts.find((p) => p.id === String(ownerId));
    if (found) {
      found.stats = stats;
      writePostsDoc(doc);
    }
  }
  return stats;
}

/** 列出记录目录下存在的 ownerId。 */
export function listRecordOwnerIds(ownerType) {
  const type = assertOwnerType(ownerType);
  let entries = [];
  try {
    entries = fs.readdirSync(safeJoin(getRoot(), DIRS.records, type), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name);
}

/* ------------------------------------------------------------------ *
 * 订阅
 * ------------------------------------------------------------------ */

function subsFile() {
  return safeJoin(getRoot(), 'subscriptions.json');
}

function readSubsDoc() {
  const raw = readJson(subsFile(), null);
  const items = raw && Array.isArray(raw.items) ? raw.items : [];
  return {
    version: 1,
    items: items
      .filter((s) => s && typeof s.id === 'string' && ID_RE.test(String(s.ownerId || '')))
      .map((s) => ({
        id: String(s.id),
        ownerType: s.ownerType === 'posts' ? 'posts' : 'users',
        ownerId: String(s.ownerId),
        ownerLabel: String(s.ownerLabel || ''),
        mode: MODES[s.mode] ? s.mode : 'both',
        enabled: Boolean(s.enabled),
        intervalMode: s.intervalMode === 'fixed' ? 'fixed' : 'auto',
        fixedMinutes: Number(s.fixedMinutes) > 0 ? Math.trunc(Number(s.fixedMinutes)) : 30,
        perRoundLimit: Number(s.perRoundLimit) > 0 ? Math.trunc(Number(s.perRoundLimit)) : LIMITS.pageCount,
        dailyCreditsBudget: Number(s.dailyCreditsBudget) > 0 ? Number(s.dailyCreditsBudget) : 1,
        spentToday: Number(s.spentToday) || 0,
        todayKey: typeof s.todayKey === 'string' ? s.todayKey : todayKey(),
        step: Math.max(0, Math.trunc(Number(s.step) || 0)),
        nextRunAtMs: Number(s.nextRunAtMs) || Date.now(),
        lastRunAtMs: numOrNull(s.lastRunAtMs),
        lastResult: typeof s.lastResult === 'string' ? s.lastResult : '',
        /**
         * 暂停原因：`'' | 'user' | 'budget'`。
         *
         * 必须区分二者：日切（`scheduler.rollDay`）只恢复 `pauseReason==='budget'`
         * 的订阅；`'user'` 是用户显式意图，跨日必须保持暂停 —— 否则用户手动暂停的
         * 订阅会在次日自动恢复并按 1 分钟间隔开始巡检，已登录真实账号时会意外扣 credits。
         */
        pauseReason: s.pauseReason === 'user' || s.pauseReason === 'budget' ? s.pauseReason : '',
        createdAtMs: Number(s.createdAtMs) || Date.now(),
      })),
  };
}

function writeSubsDoc(doc) {
  writeJson(subsFile(), { version: 1, items: doc.items });
}

/** 列出全部订阅。 */
export function listSubscriptions() {
  return cloneJson(readSubsDoc().items);
}

/** 取单个订阅，不存在返回 null。 */
export function getSubscription(id) {
  const found = readSubsDoc().items.find((s) => s.id === String(id || ''));
  return found ? cloneJson(found) : null;
}

/** 新增订阅。 */
export function addSubscription(payload) {
  const doc = readSubsDoc();
  const item = {
    id: payload.id || `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ownerType: assertOwnerType(payload.ownerType),
    ownerId: String(payload.ownerId),
    ownerLabel: String(payload.ownerLabel || ''),
    mode: MODES[payload.mode] ? payload.mode : 'both',
    enabled: payload.enabled !== false,
    intervalMode: payload.intervalMode === 'fixed' ? 'fixed' : 'auto',
    fixedMinutes: Number(payload.fixedMinutes) > 0 ? Math.trunc(Number(payload.fixedMinutes)) : 30,
    perRoundLimit: Number(payload.perRoundLimit) > 0 ? Math.trunc(Number(payload.perRoundLimit)) : LIMITS.pageCount,
    dailyCreditsBudget: Number(payload.dailyCreditsBudget) > 0 ? Number(payload.dailyCreditsBudget) : 1,
    spentToday: 0,
    todayKey: todayKey(),
    step: 0,
    nextRunAtMs: Date.now() + 60000,
    lastRunAtMs: null,
    lastResult: '',
    pauseReason: '',
    createdAtMs: Date.now(),
  };
  doc.items.push(item);
  writeSubsDoc(doc);
  return cloneJson(item);
}

/**
 * 更新订阅字段。
 *
 * `enabled` 与 `pauseReason` 的联动规则：**只要 patch 里显式出现 `enabled` 键，
 * 就视为用户意图**，据此改写 `pauseReason`：
 * - `enabled:false` → `pauseReason='user'`（日切不恢复）
 * - `enabled:true`  → `pauseReason=''`（恢复启用）
 *
 * 判据用「键是否出现」而非「值是否变化」：对已因预算耗尽暂停的订阅再发一次
 * `{enabled:false}`，若按「值变化」判断则 `pauseReason` 会保留 `'budget'`，
 * 次日 `rollDay` 就会把它自动恢复 —— 用户明确要求暂停的意图被忽略。
 *
 * 调度器与 `reset-budget` 会显式传 `pauseReason`，该显式值在最后统一应用，
 * 因此不受上述推断影响，也不依赖 patch 对象的键顺序。
 */
export function patchSubscription(id, patch) {
  const doc = readSubsDoc();
  const found = doc.items.find((s) => s.id === String(id || ''));
  if (!found) throw new AppError('NOT_FOUND', '订阅不存在', 404);
  const numeric = ['fixedMinutes', 'perRoundLimit', 'dailyCreditsBudget', 'spentToday', 'step', 'nextRunAtMs', 'lastRunAtMs'];
  /** @type {string|undefined} */
  let pauseReasonOverride;
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'id' || key === 'createdAtMs') continue;
    if (key === 'pauseReason') {
      pauseReasonOverride = value === 'user' || value === 'budget' ? value : '';
      continue;
    }
    if (key === 'enabled') {
      const next = Boolean(value);
      found.enabled = next;
      // 键出现即代表用户意图；`pauseReason` 键不出现时不会被本行影响
      found.pauseReason = next ? '' : 'user';
      continue;
    }
    if (key === 'intervalMode') {
      found.intervalMode = value === 'fixed' ? 'fixed' : 'auto';
      continue;
    }
    if (key === 'ownerLabel' || key === 'lastResult' || key === 'todayKey') {
      found[key] = String(value === null || value === undefined ? '' : value);
      continue;
    }
    if (numeric.includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) found[key] = n;
      continue;
    }
  }
  if (pauseReasonOverride !== undefined) found.pauseReason = pauseReasonOverride;
  writeSubsDoc(doc);
  return cloneJson(found);
}

/** 删除订阅。 */
export function deleteSubscription(id) {
  const doc = readSubsDoc();
  const idx = doc.items.findIndex((s) => s.id === String(id || ''));
  if (idx === -1) throw new AppError('NOT_FOUND', '订阅不存在', 404);
  doc.items.splice(idx, 1);
  writeSubsDoc(doc);
  return { deleted: true };
}

/* ------------------------------------------------------------------ *
 * 任务与日志
 * ------------------------------------------------------------------ */

/** 追加一条任务记录到 tasks.jsonl。 */
export function appendTask(task) {
  appendLines(safeJoin(getRoot(), 'tasks.jsonl'), [task]);
}

/** 读取最近 N 条任务（新→旧）。 */
export function readTasks(limit = 20) {
  const rows = readLines(safeJoin(getRoot(), 'tasks.jsonl'));
  return rows.slice(-Math.max(1, limit)).reverse();
}

/** 追加订阅日志并裁剪到最近 200 行。 */
export function appendSubLog(row) {
  const file = safeJoin(getRoot(), DIRS.logs, 'subscriptions.jsonl');
  const rows = readLines(file);
  rows.push(row);
  const kept = rows.slice(-LIMITS.subLogKeep);
  writeText(file, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return kept.length;
}

/** 读取订阅日志（新→旧）。 */
export function readSubLogs(limit = LIMITS.subLogKeep) {
  const rows = readLines(safeJoin(getRoot(), DIRS.logs, 'subscriptions.jsonl'));
  return rows.slice(-Math.max(1, limit)).reverse();
}

/* ------------------------------------------------------------------ *
 * 报告索引
 * ------------------------------------------------------------------ */

function reportIndexFile() {
  return safeJoin(getRoot(), DIRS.reports, 'index.json');
}

/** 读报告索引。 */
export function readReportIndex() {
  const raw = readJson(reportIndexFile(), null);
  const reports = raw && raw.reports && typeof raw.reports === 'object' ? raw.reports : {};
  return { version: 1, reports };
}

/** 更新（新增/覆盖）一条报告元信息。 */
export function updateReportIndex(key, meta) {
  const doc = readReportIndex();
  doc.reports[String(key)] = meta;
  writeJson(reportIndexFile(), doc);
  return doc.reports[String(key)];
}

/** 删除报告索引项。 */
export function removeReportIndex(key) {
  const doc = readReportIndex();
  delete doc.reports[String(key)];
  writeJson(reportIndexFile(), doc);
}

/**
 * 报告文件绝对路径（白名单 + 路径穿越双重校验）。
 * @param {string} key 形如 `users-123`
 * @returns {string}
 */
export function reportFilePath(key) {
  const clean = String(key || '').replace(/\.html$/i, '');
  if (!REPORT_KEY_RE.test(clean)) throw new AppError('UNSAFE_PATH', '报告标识非法', 400);
  return safeJoin(getRoot(), DIRS.reports, `${clean}.html`);
}

/** 报告目录绝对路径。 */
export function reportsDir() {
  return safeJoin(getRoot(), DIRS.reports);
}

/* ------------------------------------------------------------------ *
 * 汇总与设置
 * ------------------------------------------------------------------ */

/** 全局计数：用户数、博文数、未读总数。 */
export function counts() {
  const users = readUsersDoc().users;
  const posts = readPostsDoc().posts;
  const unread = users.reduce((sum, u) => sum + u.stats.unreadCount, 0) + posts.reduce((sum, p) => sum + p.stats.unreadCount, 0);
  return { users: users.length, posts: posts.length, unread };
}

/** 今日已花 credits（由 tasks.jsonl 汇总）。 */
export function todayCredits() {
  const start = dayStartMs(Date.now());
  const rows = readTasks(1000);
  return rows
    .filter((row) => Number(row.finishedAtMs) >= start)
    .reduce((sum, row) => sum + (Number(row.creditsSpent) || 0), 0);
}

/**
 * 验证目录可写（写读删一次探针）。
 * @param {string} dir
 * @returns {boolean}
 */
export function isWritableDir(dir) {
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * 切换数据目录（不可写则拒绝且不改动配置）。
 * @param {string} target
 * @returns {object} 更新后的 settings
 */
export function setDataDir(target) {
  const raw = String(target || '').trim();
  if (!raw) throw new AppError('BAD_REQUEST', '数据目录不能为空', 400);
  const resolved = path.resolve(raw);
  if (!isWritableDir(resolved)) {
    throw new AppError('IO_ERROR', `目录不可写：${resolved}`, 400);
  }
  writeConfig({ settings: { dataDir: resolved } });
  shardCache.clear();
  ensureDirs();
  return getSettings();
}

/** 设置演示模式。 */
export function setDemoMode(enabled) {
  writeConfig({ settings: { demoMode: Boolean(enabled) } });
  shardCache.clear();
  ensureDirs();
  return getSettings();
}

/** 便于测试注入根目录（仅测试用，生产不调用）。 */
export function __clearShardCache() {
  shardCache.clear();
}

/** 版本号透出（测试与健康检查用）。 */
export const STORE_VERSION = VERSION;
