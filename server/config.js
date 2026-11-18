/**
 * @file 全局常量：7 种内容模式 → CLI group/action 映射、价目表、错误码、上限、路径。
 *
 * 事实来源：docs/API-FACTS.md。此文件中的接口路径与参数名不得随业务代码改动。
 * @module server/config
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 应用版本号（/api/health 与前端顶栏展示）。 */
export const VERSION = '1.0.0';
/** 应用名称。 */
export const APP_NAME = 'Weibo Reader';
/** 监听主机：仅回环，绝不 0.0.0.0。 */
export const HOST = '127.0.0.1';
/** 监听端口，可用环境变量 PORT 覆盖。 */
export const PORT = Number(process.env.PORT || 7788);
/** 项目根目录（server/ 的上一级）。 */
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
/** 前端静态资源目录。 */
export const WEB_DIR = path.join(PROJECT_ROOT, 'web');
/**
 * 数据根目录：默认 `<project>/data`；测试或多实例可用环境变量
 * `WEIBO_READER_DATA_DIR` 覆盖（配置与数据一起隔离）。
 */
const ENV_DATA_DIR = process.env.WEIBO_READER_DATA_DIR
  ? path.resolve(process.env.WEIBO_READER_DATA_DIR)
  : '';
/** 默认数据根目录（data/config.json 固定存放在此，不随 settings.dataDir 迁移）。 */
export const DEFAULT_DATA_DIR = ENV_DATA_DIR || path.join(PROJECT_ROOT, 'data');
/** 账户与设置配置文件（含 token，只落本机）。 */
export const CONFIG_FILE = path.join(DEFAULT_DATA_DIR, 'config.json');

/** 微博开放平台 CLI 网关基址（实测，不可改）。 */
export const WEIBO_BASE = 'https://open.weibo.com/cli/api';
/** 设备码登录 client_id（实测值）。 */
export const CLIENT_ID = 'weibo-cli';
/** 设备名上报值。 */
export const DEVICE_NAME = 'weibo-reader-web';
/** 单次 HTTP 请求超时（毫秒）。 */
export const REQUEST_TIMEOUT_MS = 8000;
/** 设备码登录总超时（毫秒）。 */
export const DEVICE_TOTAL_TIMEOUT_MS = 600000;

/** 7 种内容模式枚举（顺序即 UI 下拉顺序）。 */
export const MODE_KEYS = Object.freeze([
  'both',
  'sent',
  'received',
  'mentions-comments',
  'mentions-posts',
  'user-posts',
  'post-comments',
]);

/**
 * 模式元数据表。
 *
 * - `group`/`action`：CLI 网关的接口定位（见 API-FACTS §5）。
 * - `fallback`：`user_timeline/biz` 404 时的回退接口（ARCH A2）。
 * - `ownerKind`：该模式归档在哪个对象下（`user` → data/users.json，`post` → data/posts.json）。
 * - `entity`：`comment`（评论）或 `status`（微博正文），决定响应归一化与字段映射。
 */
export const MODES = Object.freeze({
  both: {
    key: 'both',
    label: '发出和收到的评论',
    short: '发出+收到',
    group: 'comments',
    action: 'timeline/other',
    ownerKind: 'user',
    entity: 'comment',
    interactive: true,
  },
  sent: {
    key: 'sent',
    label: '发出的评论',
    short: '发出',
    group: 'comments',
    action: 'by_me/other',
    ownerKind: 'user',
    entity: 'comment',
    interactive: true,
  },
  received: {
    key: 'received',
    label: '收到的评论',
    short: '收到',
    group: 'comments',
    action: 'to_me/other',
    ownerKind: 'user',
    entity: 'comment',
    interactive: true,
  },
  'mentions-comments': {
    key: 'mentions-comments',
    label: '被 @ 的评论',
    short: '@我',
    group: 'comments',
    action: 'mentions/other',
    ownerKind: 'user',
    entity: 'comment',
    interactive: true,
  },
  'mentions-posts': {
    key: 'mentions-posts',
    label: '被 @ 的微博',
    short: '@微博',
    group: 'statuses',
    action: 'mentions/other',
    ownerKind: 'user',
    entity: 'status',
    interactive: false,
  },
  'user-posts': {
    key: 'user-posts',
    label: '用户微博',
    short: '微博',
    group: 'statuses',
    action: 'user_timeline/biz',
    fallback: { group: 'statuses', action: 'user_timeline/other' },
    ownerKind: 'user',
    entity: 'status',
    interactive: false,
  },
  'post-comments': {
    key: 'post-comments',
    label: '某条微博下的评论',
    short: '博文评论',
    group: 'comments',
    action: 'show/all',
    ownerKind: 'post',
    entity: 'comment',
    interactive: true,
  },
});

/** 返回模式列表（数组，顺序同 MODE_KEYS）。 */
export function modeList() {
  return MODE_KEYS.map((k) => MODES[k]);
}

/** 按 key 取模式元数据，未命中返回 null。 */
export function getMode(key) {
  return MODES[key] || null;
}

/** 内置保守价目表（credits/条）；预检拿到真实单价后覆盖（ARCH A3）。 */
export const BUILTIN_UNIT_PRICE = Object.freeze({
  both: 0.02,
  sent: 0.02,
  received: 0.02,
  'mentions-comments': 0.02,
  'mentions-posts': 0.05,
  'user-posts': 0.05,
  'post-comments': 0.02,
});

/** 订阅自动退避阶梯（分钟）。 */
export const BACKOFF_MINUTES = Object.freeze([1, 3, 5, 10, 15, 30]);

/** 统一错误码枚举。 */
export const ERROR_CODES = Object.freeze([
  'BAD_REQUEST',
  'INVALID_ID',
  'INVALID_MODE',
  'INVALID_DATE_RANGE',
  'NOT_FOUND',
  'CONFLICT',
  'UNAUTHORIZED',
  'TOKEN_INVALID',
  'INSUFFICIENT_CREDITS',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'UNSUPPORTED_COMMAND',
  'TASK_NOT_FOUND',
  'TASK_NOT_RUNNING',
  'TASK_BUSY',
  'UNSAFE_PATH',
  'DEMO_MODE',
  'IO_ERROR',
]);

/** 各类上限与默认值。 */
export const LIMITS = Object.freeze({
  /** 单次任务最多翻页数。 */
  maxPages: 200,
  /** 单页请求条数上限（微博侧通常 ≤100）。 */
  pageCount: 100,
  /** 估算用的默认条数上限。 */
  defaultLimit: 500,
  /** 用户可填写的条数上限。 */
  maxLimit: 5000,
  /** 任务日志环形缓冲行数。 */
  logBuffer: 500,
  /** 订阅日志保留行数。 */
  subLogKeep: 200,
  /** 列表默认分页大小。 */
  defaultPageSize: 20,
  /** 报告默认记录上限。 */
  defaultReportMax: 1000,
  /** 报告记录硬上限。 */
  maxReportRecords: 5000,
  /** 请求体最大字节数。 */
  maxBodyBytes: 32 * 1024 * 1024,
  /** 连续无新增页数阈值（历史分页防空转）。 */
  noNewPageStop: 3,
  /** 搜索 LRU 缓存的对象数。 */
  searchLruOwners: 8,
  /** 调度 tick 间隔（毫秒）。 */
  schedulerIntervalMs: 30000,
});

/** 记录正文最大长度（超出截断并标记）。 */
export const MAX_TEXT_LEN = 2000;

/** 数据目录内的固定子目录名。 */
export const DIRS = Object.freeze({
  records: 'records',
  reports: 'reports',
  logs: 'logs',
  exports: 'exports',
  demo: 'demo',
});

/** 订阅日志的 result 枚举。 */
export const SUB_RESULTS = Object.freeze(['ok', 'no-new', 'budget', 'error']);

/** 报告文件名白名单（/reports/<key>.html 只读托管时校验）。 */
export const REPORT_KEY_RE = /^[a-z]+-\d+$/;
