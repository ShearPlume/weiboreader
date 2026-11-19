/**
 * @file 前端公共层：接口封装、错误码→中文文案、时间格式化、DOM 工具、loading 态、
 *       全局状态（status）与 hash 导航（视图之间共享，避免循环依赖）。
 * @module web/js/api
 */

/** 业务错误（携带后端错误码与 HTTP 状态）。 */
export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {object} [details]
   */
  constructor(code, message, status = 0, details = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

/** 错误码 → 中文人话（兜底文案，后端一般已给出更具体的 message）。 */
export const ERR_TEXT = {
  BAD_REQUEST: '请求参数不正确',
  INVALID_ID: '无法识别该 ID 或链接',
  INVALID_MODE: '内容模式不正确',
  INVALID_DATE_RANGE: '日期范围不正确',
  NOT_FOUND: '没有找到对应数据',
  CONFLICT: '操作冲突，请稍后重试',
  UNAUTHORIZED: '需要登录后才能使用',
  TOKEN_INVALID: '登录已失效，请重新授权',
  INSUFFICIENT_CREDITS: '额度不足',
  RATE_LIMITED: '请求过于频繁',
  UPSTREAM_ERROR: '微博接口异常',
  UNSUPPORTED_COMMAND: '该接口不支持当前参数',
  TASK_NOT_FOUND: '任务不存在或已被清理',
  TASK_NOT_RUNNING: '任务已结束',
  TASK_BUSY: '已有取数任务在运行中',
  UNSAFE_PATH: '路径不安全，已拒绝访问',
  DEMO_MODE: '演示模式下不可用',
  IO_ERROR: '本地读写失败',
  NETWORK: '无法连接本地服务',
};

/**
 * 当前页面的部署基路径（以 `/` 结尾）：
 * 本地是 `/`，部署到 `/fakeadmin/` 时自动变成 `/fakeadmin/`。
 * 仅用于把 `/api/*`、`/reports/*` 这类站内绝对路径挂到子路径下。
 */
const API_BASE = (() => {
  if (typeof window === 'undefined') return '/';
  const { pathname } = window.location;
  if (pathname.endsWith('/')) return pathname;
  if (/\.[a-z0-9]+$/i.test(pathname)) return pathname.replace(/[^/]*$/, '');
  return `${pathname}/`;
})();

/** 站内绝对路径挂到部署基路径（`/reports/x.html` → `/fakeadmin/reports/x.html`）。 */
export function assetUrl(pathname) {
  const value = String(pathname || '');
  if (!value.startsWith('/') || API_BASE === '/') return value;
  return API_BASE.replace(/\/$/, '') + value;
}

/**
 * 调用本地 API（统一 `{ok,data}` 包裹）。
 * 传入 `/api/...` 时会自动加部署前缀；展示页传入的完整路径不受影响。
 * @param {string} pathname
 * @param {{method?:string,body?:unknown}} [options]
 * @returns {Promise<any>} data
 */
export async function api(pathname, options = {}) {
  const method = options.method || 'GET';
  const init = { method, headers: {}, cache: 'no-store' };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const target = String(pathname).startsWith('/api/')
    ? `${API_BASE}api/${String(pathname).slice('/api/'.length)}`
    : pathname;
  let response;
  // 跨海链路偶发 reset / Basic Auth 首次并行请求 401：GET 重试一次；
  // 401 在服务端尚未执行，任何方法都可安全重试一次。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(target, init);
    } catch {
      if (attempt === 0 && method === 'GET') {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw new ApiError('NETWORK', '无法连接本地服务，请确认终端里的 node 进程仍在运行', 0);
    }
    if (response.status === 401 && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    break;
  }
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok || !payload || payload.ok !== true) {
    const error = (payload && payload.error) || {};
    const code = error.code || 'HTTP_ERROR';
    const message =
      error.message || ERR_TEXT[code] || `请求失败（HTTP ${response.status}），请稍后重试`;
    throw new ApiError(code, message, response.status, error.details);
  }
  return payload.data;
}

/* ------------------------------------------------------------------ *
 * 全局状态（顶栏余额 / 演示横幅 / 数据目录）
 * ------------------------------------------------------------------ */

const state = { status: null, error: null };
const statusListeners = new Set();

/** 取上一次 status 快照。 */
export function getStatus() {
  return state.status;
}

/**
 * 订阅 status 变化。
 * @param {(status:object|null, error:Error|null)=>void} listener
 * @returns {()=>void} 取消订阅
 */
export function onStatus(listener) {
  statusListeners.add(listener);
  try {
    listener(state.status, state.error);
  } catch {
    /* 忽略监听器内部异常 */
  }
  return () => statusListeners.delete(listener);
}

/** 重新拉取 /api/status 并广播。 */
export async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    state.error = null;
  } catch (err) {
    state.error = err;
  }
  for (const listener of statusListeners) {
    try {
      listener(state.status, state.error);
    } catch {
      /* 忽略 */
    }
  }
  return state.status;
}

/** 切换视图（hash 路由）。 */
export function navigate(hash) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) {
    window.dispatchEvent(new Event('hashchange'));
    return;
  }
  location.hash = target;
}

/* ------------------------------------------------------------------ *
 * 格式化
 * ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:mm` */
export function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `YYYY-MM-DD HH:mm:ss` */
export function fmtTimeSec(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  return `${fmtTime(n)}:${pad2(d.getSeconds())}`;
}

/** `YYYY-MM-DD` */
export function fmtDay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 毫秒 → `<input type="date">` 值。 */
export function toDateInput(ms) {
  return fmtDay(ms);
}

/**
 * 严格数字转换：`null` / `undefined` / `''` / 非有限数 一律返回 null。
 *
 * 为什么必须有它：`Number(null) === 0`，若直接用 `Number.isFinite(Number(v))` 判断，
 * 「余额未知（null）」会被误判为「0 credits」并渲染出「剩余 0」的假数据。
 * 注意 0 是合法值（本方法保留 0），只有空值与非数字被归为 null。
 * @param {unknown} value
 * @returns {number|null}
 */
export function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 数字展示（最多两位小数，去掉多余 0）；空值显示 `—` 而不是 0。 */
export function fmtNum(value, digits = 2) {
  const n = numOrNull(value);
  if (n === null) return '—';
  const fixed = n.toFixed(digits);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

/** 相对时间描述。 */
export function fmtRelative(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const diff = Date.now() - n;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff >= 0 ? '刚刚' : '即将';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} 分钟${diff >= 0 ? '前' : '后'}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} 小时${diff >= 0 ? '前' : '后'}`;
  return fmtTime(n);
}

/* ------------------------------------------------------------------ *
 * 转义与 DOM
 * ------------------------------------------------------------------ */

/**
 * HTML 转义（所有拼进模板的用户数据必须过它）。
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

/** 转义 + 换行保留（配合 `white-space: pre-wrap` 无需 `<br>`）。 */
export function escText(value) {
  return esc(value);
}

/** 关键词高亮（结果文本先整体转义，再包裹命中片段）。 */
export function highlight(text, terms) {
  const source = String(text === null || text === undefined ? '' : text);
  const keywords = (terms || []).map((t) => String(t).trim()).filter(Boolean);
  if (keywords.length === 0) return esc(source);
  const escapedTerms = keywords
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
  let out = '';
  let lastIndex = 0;
  for (const matched of source.matchAll(pattern)) {
    out += esc(source.slice(lastIndex, matched.index));
    out += `<mark>${esc(matched[0])}</mark>`;
    lastIndex = matched.index + matched[0].length;
  }
  out += esc(source.slice(lastIndex));
  return out;
}

/** 由 HTML 字符串创建元素。 */
export function html(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(markup).trim();
  return tpl.content.firstElementChild;
}

/** 清空节点。 */
export function clearNode(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

/** querySelector 简写。 */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/** querySelectorAll → 数组。 */
export function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

/* ------------------------------------------------------------------ *
 * 交互反馈
 * ------------------------------------------------------------------ */

/**
 * 轻提示。
 * @param {string} message
 * @param {'info'|'ok'|'warn'|'error'} [kind]
 * @param {number} [durationMs]
 */
export function toast(message, kind = 'info', durationMs = 3200) {
  const wrap = document.getElementById('toastWrap');
  if (!wrap) return;
  const node = html(`<div class="toast ${kind === 'info' ? '' : kind}">${esc(message)}</div>`);
  wrap.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, durationMs);
}

/**
 * 按钮 loading 态（防重复提交）。
 * @param {HTMLButtonElement|null} button
 * @param {boolean} busy
 * @param {string} [busyText]
 */
export function setBusy(button, busy, busyText = '处理中…') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent || '';
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

/** 防抖。 */
export function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** 统一的错误条 DOM。 */
export function errorBar(err, onRetry) {
  const code = err && err.code ? err.code : 'ERROR';
  const message = err && err.message ? err.message : '未知错误';
  const node = html(
    `<div class="error-bar"><span class="err-code">${esc(code)}</span><span>${esc(message)}</span></div>`
  );
  if (typeof onRetry === 'function') {
    const retry = html('<button class="btn btn-sm" type="button">重试</button>');
    retry.addEventListener('click', () => {
      node.remove();
      onRetry();
    });
    node.appendChild(retry);
  }
  return node;
}

/** 骨架屏。 */
export function skeleton(rows = 3) {
  let markup = '<div class="card">';
  for (let i = 0; i < rows; i += 1) markup += '<div class="skeleton sk-card"></div>';
  markup += '</div>';
  return html(markup);
}

/**
 * 确认对话框（Promise 化）。
 * @param {{title:string,desc?:string,okText?:string,danger?:boolean}} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog(options) {
  return new Promise((resolve) => {
    const mask = html(`<div class="modal-mask">
      <div class="modal">
        <h3>${esc(options.title)}</h3>
        ${options.desc ? `<div class="modal-desc">${esc(options.desc)}</div>` : ''}
        <div class="modal-actions">
          <button class="btn" type="button" data-act="cancel">取消</button>
          <button class="btn ${options.danger ? 'btn-danger' : 'btn-primary'}" type="button" data-act="ok">${esc(
      options.okText || '确定'
    )}</button>
        </div>
      </div>
    </div>`);

    const close = (value) => {
      mask.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
    };
    mask.addEventListener('click', (event) => {
      const act = event.target.closest('[data-act]');
      if (act) {
        close(act.dataset.act === 'ok');
        return;
      }
      if (event.target === mask) close(false);
    });
    document.addEventListener('keydown', onKey);
    document.getElementById('modalRoot').appendChild(mask);
  });
}

/** 复制到剪贴板（失败时降级为提示）。 */
export async function copyText(text, tip = '已复制') {
  const value = String(text === null || text === undefined ? '' : text);
  try {
    await navigator.clipboard.writeText(value);
    toast(tip, 'ok');
  } catch {
    toast(`复制失败，请手动选择：${value}`, 'warn', 6000);
  }
}

/** 兜底：时间范围展示。 */
export function rangeText(fromMs, toMs) {
  if (!fromMs && !toMs) return '全部时间';
  return `${fromMs ? fmtTime(fromMs) : '不限'} ~ ${toMs ? fmtTime(toMs) : '不限'}`;
}
