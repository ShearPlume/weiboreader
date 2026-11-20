/**
 * @file 微博通知界面模拟展示页（showcase.html 专用）。
 *
 * 仅用本地归档数据（/api/owners/users/:uid/records）还原微博「消息」相关界面：
 * 消息首页、@我的、评论、赞、我（账号切换）。全程只读，不发起取数、不改变未读状态，
 * 与后台管理页（index.html）互不影响。
 * @module web/js/showcase
 */

import { api, esc } from './api.js';

/** 展示页记住上次选中的账号。 */
const STORAGE_KEY = 'weibo-showcase-uid-v2';

/** 部署基路径：本地为 `/`，部署到子路径（如 /fakeaccount/）时自动适配。 */
const BASE = (() => {
  const { pathname } = window.location;
  if (pathname.endsWith('/')) return pathname;
  if (/\.[a-z0-9]+$/i.test(pathname)) return pathname.replace(/[^/]*$/, '');
  return `${pathname}/`;
})();
const IS_DEPLOYED = BASE !== '/';

// <base> 指向 COS 时，root-relative 的 /api 也会解析到 COS；API 必须显式使用站点 origin。
const API_ROOT = `${window.location.origin}${BASE}`;

// 通过 COS 直链打开的旧主屏图标：跳回站点，避免校验/API 跨域或 404。
if (/\.myqcloud\.com$/i.test(window.location.hostname)) {
  window.location.replace(`https://idolgallery.xyz/fakeaccount/${window.location.hash}`);
}

/** 静态资源根：线上由 <base> 指向 COS 广州，本地退回同源。 */
const STATIC_BASE = new URL('.', document.baseURI);
const USE_STATIC = IS_DEPLOYED || STATIC_BASE.origin !== window.location.origin;

function staticUrl(pathname) {
  return new URL(pathname, STATIC_BASE).href;
}

/** 优先读 CDN 上的静态 JSON 快照；本地开发或未发布时返回 null，由调用方回落 API。 */
async function fetchStatic(pathname) {
  if (!USE_STATIC) return null;
  try {
    const response = await fetch(staticUrl(pathname), { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
/** 单次读取的记录条数上限（服务端 pageSize 上限 200）。 */
const PAGE_SIZE = 200;
/** 卡片列表最多渲染条数，避免一次插入上千节点。 */
const MAX_CARDS = 100;

/** 「@我的」下拉筛选项。 */
const AT_OPTIONS = [
  { key: 'all-posts', label: '所有微博', modes: ['mentions-posts'] },
  { key: 'follow-posts', label: '关注人的微博', modes: ['mentions-posts'] },
  { key: 'origin-posts', label: '原创微博', modes: ['mentions-posts'], filter: (rec) => !String(rec.text || '').includes('//@') },
  { key: 'group-comments', label: '@ 我的评论', heading: true },
  { key: 'all-comments', label: '所有评论', modes: ['mentions-comments'] },
  { key: 'follow-comments', label: '关注人的评论', modes: ['mentions-comments'] },
];

/** 「评论」下拉筛选项。 */
const COMMENT_OPTIONS = [
  { key: 'all', label: '所有评论', modes: ['received'] },
  { key: 'follow', label: '关注人的', modes: ['received'] },
  { key: 'mine', label: '我发出的', modes: ['sent'] },
];

const OPTIONS = { at: AT_OPTIONS, comments: COMMENT_OPTIONS };

/** 内联图标（无外链、无字体依赖）。 */
const ICON = {
  back: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4.5 7.5 12 15 19.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  caret: '<svg class="i i-caret" viewBox="0 0 12 7" aria-hidden="true"><path d="M1.5 1.5 6 6l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  chev: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5 15.5 12 9 18.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  search:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  chat: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.6C4 4.2 5.2 3 6.6 3h10.8C18.8 3 20 4.2 20 5.6v7.2c0 1.4-1.2 2.6-2.6 2.6H10l-4.4 3.1c-.6.4-1.3 0-1.3-.6L4 5.6Z" fill="currentColor"/></svg>',
  thumb:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 10.4V21H4.9A1.9 1.9 0 0 1 3 19.1v-6.8c0-1 .9-1.9 1.9-1.9h3.6Zm2 0 3.4-6.2a1.2 1.2 0 0 1 2.2.4l.3 1.6c.1.6.1 1.2-.1 1.8l-.5 1.6h4.2c1.3 0 2.2 1.1 2 2.3l-1 6.1a2.6 2.6 0 0 1-2.6 2.2H8.5V10.4Z" fill="currentColor"/></svg>',
  compose:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 12.8V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="m14.2 4.6 5.2 5.2M19.6 8.9 12 16.5l-4.1.9.9-4.1 7.6-7.6a1.9 1.9 0 0 1 2.7 0l.5.5a1.9 1.9 0 0 1 0 2.7Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  forward:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 5.5 20 12l-7 6.5v-3.4c-5 0-8.1 1.4-9.8 4.1C3.9 12.7 6.8 9 13 8.6V5.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  reply:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 5.4C4.5 4.1 5.6 3 6.9 3h10.2c1.3 0 2.4 1.1 2.4 2.4v6.6c0 1.3-1.1 2.4-2.4 2.4h-6.7l-4 2.8c-.6.4-1.4 0-1.4-.7V5.4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  home: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m3.6 10.4 8.4-7 8.4 7V20c0 .6-.4 1-1 1h-5v-5.6h-4.8V21h-5c-.6 0-1-.4-1-1v-9.6Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  video:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.6" y="4.8" width="18.8" height="14.4" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 9.1 15.6 12 10 14.9V9.1Z" fill="currentColor"/></svg>',
  discover:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m17 17 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  message:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.6" y="4.6" width="18.8" height="14.8" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m3.6 7.2 8.4 5.4 8.4-5.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  me: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4.6 20.2c.8-3.8 3.7-5.8 7.4-5.8s6.6 2 7.4 5.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  check:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  likeEmpty:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 10.4V21H4.9A1.9 1.9 0 0 1 3 19.1v-6.8c0-1 .9-1.9 1.9-1.9h3.6Zm2 0 3.4-6.2a1.2 1.2 0 0 1 2.2.4l.3 1.6c.1.6.1 1.2-.1 1.8l-.5 1.6h4.2c1.3 0 2.2 1.1 2 2.3l-1 6.1a2.6 2.6 0 0 1-2.6 2.2H8.5V10.4Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  album:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="8.2" cy="9.4" r="1.5" fill="currentColor"/><path d="m3.6 16.6 5.2-4.6 3.9 3.3 2.6-2.2 5.1 3.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  star: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.4 2.7 5.5 6 .9-4.4 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.3 9.8l6-.9L12 3.4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  clock:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.6V12l3 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  inbox:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13.5 6.2 5.8A2 2 0 0 1 8.1 4.4h7.8a2 2 0 0 1 1.9 1.4L20 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M4 13.5h4l1 2h6l1-2h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  wallet:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.6A2.6 2.6 0 0 1 6.6 5H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6.6A2.6 2.6 0 0 1 4 16.4V7.6Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M4.3 8.2h13.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="16.6" cy="13.2" r="1.2" fill="currentColor"/></svg>',
  bag: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 8h13l1 11a2 2 0 0 1-2 2.2H6.5A2 2 0 0 1 4.5 19L5.5 8Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8.4 8V6.4a3.6 3.6 0 0 1 7.2 0V8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  bulb:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 18h5.6M10.2 21h3.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12 3a6.2 6.2 0 0 0-3.6 11.2c.6.5.9 1.2.9 2h5.4c0-.8.3-1.5.9-2A6.2 6.2 0 0 0 12 3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  calendar:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="14.5" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.8 9.6h16.4M8 3.6v3.4M16 3.6v3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  personAdd:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.8 20c.7-3.6 3.2-5.5 6.2-5.5 2 0 3.8.9 4.8 2.6M18 14.5v5M15.5 17h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  scan: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3.5H5.5a2 2 0 0 0-2 2V8M16 3.5h2.5a2 2 0 0 1 2 2V8M8 20.5H5.5a2 2 0 0 1-2-2V16M16 20.5h2.5a2 2 0 0 0 2-2V16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M3.5 12h17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  gear: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  expand: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  compress: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** 底部导航配置。 */
const TABS = [
  { key: 'home', label: '首页', icon: ICON.home },
  { key: 'video', label: '视频', icon: ICON.video },
  { key: 'discover', label: '发现', icon: ICON.discover },
  { key: 'messages', label: '消息', icon: ICON.message, badge: true },
  { key: 'me', label: '我', icon: ICON.me },
];

const state = {
  users: [],
  profiles: {},
  invite: null,
  uid: null,
  route: 'messages',
  menu: null,
  option: { at: 'all-posts', comments: 'all' },
  unread: null,
  cache: new Map(),
  seq: 0,
};

const el = { navbar: null, screen: null, tabbar: null, overlay: null, tip: null, fsBtn: null };
let tipTimer = null;

/* ------------------------------------------------------------------ *
 * 数据层：全部走本地只读接口
 * ------------------------------------------------------------------ */

async function loadUsers() {
  const staticDoc = await fetchStatic('users.json');
  if (staticDoc && Array.isArray(staticDoc.items)) return staticDoc.items;
  const data = await api(`${API_ROOT}api/users`);
  return Array.isArray(data && data.items) ? data.items : [];
}

/** 读取用户资料（头像/简介/粉丝数）：优先 CDN 快照，缺失时回落本地 API。 */
async function loadProfiles() {
  const staticDoc = await fetchStatic('profiles.json');
  if (staticDoc && staticDoc.items && typeof staticDoc.items === 'object') return staticDoc.items;
  try {
    const data = await api(`${API_ROOT}api/profiles`);
    return data && data.items && typeof data.items === 'object' ? data.items : {};
  } catch {
    return {};
  }
}

/** 读取某账号某模式的记录：优先 CDN 静态快照，缺失时回落本地 API（同参数只请求一次）。 */
function records(uid, mode) {
  const key = `${uid}:${mode}`;
  if (!state.cache.has(key)) {
    const apiUrl = `${API_ROOT}api/owners/users/${encodeURIComponent(uid)}/records?mode=${encodeURIComponent(mode)}&pageSize=${PAGE_SIZE}`;
    const pending = (async () => {
      const staticDoc = await fetchStatic(`records/${encodeURIComponent(uid)}/${encodeURIComponent(mode)}.json`);
      if (staticDoc && Array.isArray(staticDoc.items)) return staticDoc;
      try {
        return await api(apiUrl);
      } catch (err) {
        const wrapped = new Error(err && err.message ? err.message : '数据读取失败');
        wrapped.detail = new URL(apiUrl, window.location.origin).href;
        throw wrapped;
      }
    })().catch((err) => {
      state.cache.delete(key);
      throw err;
    });
    state.cache.set(key, pending);
  }
  return state.cache.get(key);
}

async function itemsOf(uid, mode) {
  const data = await records(uid, mode);
  return Array.isArray(data && data.items) ? data.items : [];
}

/** 某模式的未读数：静态快照直接带 unread，回落到 API 时才额外查一次。 */
async function unreadTotal(uid, mode) {
  const doc = await records(uid, mode);
  if (doc && doc.unread !== undefined && Number.isFinite(Number(doc.unread))) return Number(doc.unread);
  const url = `${API_ROOT}api/owners/users/${encodeURIComponent(uid)}/records?mode=${encodeURIComponent(mode)}&unread=1&pageSize=1`;
  const data = await api(url);
  return Number(data && data.total) || 0;
}

/* ------------------------------------------------------------------ *
 * 展示工具
 * ------------------------------------------------------------------ */

/** 由 UID/昵称生成稳定的头像色相。 */
function hueOf(seed) {
  let hue = 0;
  for (const ch of String(seed || 'weibo')) hue = (hue * 31 + ch.codePointAt(0)) % 360;
  return hue;
}

/**
 * 头像：优先用 data/profiles.json 缓存的真实头像，加载失败由全局 error 监听隐藏，
 * 退化为昵称首字 + 稳定色相。seed 通常是 UID。
 */
function avatarHtml(name, seed, size, urlOverride = '') {
  const label = String(name || '微').trim().slice(0, 1) || '微';
  const fontSize = Math.max(12, Math.round(size * 0.4));
  const uid = String(seed || '');
  const profile = state.profiles[uid] || {};
  // 头像走静态根（线上 <base> 指向 COS 广州，本地为同源），版本号用于刷新缓存
  const hasAvatar = Boolean(urlOverride || profile.avatarUrl) && /^\d{1,20}$/.test(uid);
  const file = profile.avatarFile || `${uid}.jpg`;
  const version = profile.fetchedAtMs ? `?v=${profile.fetchedAtMs}` : '';
  const src = staticUrl(`avatar/${file}`) + version;
  const img = hasAvatar
    ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '';
  return `<span class="avatar" style="--h:${hueOf(seed || name)};width:${size}px;height:${size}px;font-size:${fontSize}px" aria-hidden="true">${esc(label)}${img}</span>`;
}

/** 账号头像：资料缓存 > 归档 avatarUrl > 首字。 */
function userAvatar(user, size) {
  return avatarHtml(user && user.screenName, user && user.uid, size, user && user.avatarUrl);
}

/** 移动端同标签页跳转便于唤起微博 App，桌面端新开标签页。 */
const IS_MOBILE = /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(navigator.userAgent);
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const IS_STANDALONE =
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function externalLinkAttrs(href) {
  const value = String(href || '');
  if (!value) return '';
  // 独立窗口里用 _blank：不要在 PWA 自己的 webview 里打开微博，
  // 否则 iOS 从应用内浏览器返回时会把 webview 高度改小，底部出现空白。
  return `href="${esc(value)}" target="_blank" rel="noopener"`;
}

/** 用户主页（m.weibo.cn 在手机上可唤起微博 App）。 */
function profileHref(uid) {
  const value = String(uid || '');
  return /^\d{1,20}$/.test(value) ? `https://m.weibo.cn/u/${value}` : '';
}

/** 原微博链接（不带 cid），作为评论被删/隐藏时的兜底入口。 */
function recordPostHref(record) {
  const postId = String(record.postId || '');
  return postId ? `https://m.weibo.cn/detail/${postId}` : String(record.postUrl || '');
}

/** 记录对应的原微博/评论：顶层评论用 sourceId，回复用 rootId 定位到所在评论线程。 */
function recordHref(record) {
  const postId = String(record.postId || '');
  if (!postId) return String(record.postUrl || '');
  const isStatus = record.mode === 'mentions-posts' || record.mode === 'user-posts';
  if (isStatus) return `https://m.weibo.cn/detail/${postId}`;
  const cid = String(record.rootId || record.sourceId || '');
  return /^\d{1,20}$/.test(cid)
    ? `https://m.weibo.cn/detail/${postId}?cid=${cid}`
    : `https://m.weibo.cn/detail/${postId}`;
}

/** 头像外层加主页链接；没有 UID 时退回纯头像。 */
function avatarLink(uid, inner) {
  const href = profileHref(uid);
  return href ? `<a class="avatar-link" ${externalLinkAttrs(href)} aria-label="打开主页">${inner}</a>` : inner;
}

function feedTime(ms) {
  const value = Number(ms) || 0;
  if (!value) return '';
  const date = new Date(value);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (date.getFullYear() === now.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 转义后把 @昵称 高亮、换行还原为 <br>（纯文本语义）。 */
function richText(text) {
  return esc(text)
    .replace(/@([^\s@:：,，。!！?？、]{1,30})/g, '<span class="at">@$1</span>')
    .replace(/\n/g, '<br>');
}

function snippet(text, max = 60) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function countText(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

/* ------------------------------------------------------------------ *
 * 渲染：框架（导航栏 / 底部栏 / 下拉菜单）
 * ------------------------------------------------------------------ */

function currentRoute() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').trim().split('?')[0];
  return Object.prototype.hasOwnProperty.call(SCREENS, raw) ? raw : 'messages';
}

function activeTab() {
  const route = state.route;
  if (route === 'messages' || route === 'at' || route === 'comments' || route === 'likes') return 'messages';
  return route;
}

function renderNavbar() {
  el.navbar.className = 'navbar';
  if (state.route === 'messages') {
    el.navbar.classList.add('navbar-main');
    el.navbar.innerHTML = `
      <button class="nav-side" type="button" data-nav="discover">发现群</button>
      <div class="nav-tabs">
        <button class="nav-tab" type="button" data-nav="home">动态</button>
        <button class="nav-tab active" type="button">消息</button>
      </div>
      <div class="nav-side nav-right">
        <button class="icon-btn" type="button" data-demo aria-label="发起聊天">${ICON.compose}</button>
      </div>`;
    return;
  }

  if (state.route === 'at' || state.route === 'comments') {
    const kind = state.route;
    const options = OPTIONS[kind];
    const active = options.find((opt) => opt.key === state.option[kind]) || options.find((opt) => !opt.heading);
    el.navbar.innerHTML = `
      <button class="nav-back" type="button" data-nav="messages" aria-label="返回">${ICON.back}</button>
      <button class="nav-title-btn${state.menu === kind ? ' open' : ''}" type="button" data-menu="${kind}">
        ${esc(active.label)}${ICON.caret}
      </button>
      <button class="nav-right-text" type="button" data-demo>设置</button>`;
    return;
  }

  if (state.route === 'me') {
    const user = state.users.find((item) => item.uid === state.uid);
    el.navbar.classList.add('navbar-me');
    el.navbar.innerHTML = `
      <span class="me-nav-name">${esc((user && user.screenName) || '我')}</span>
      <div class="me-nav-icons">
        <button class="me-nav-btn" type="button" data-demo aria-label="添加好友">${ICON.personAdd}<i class="me-nav-dot"></i></button>
        <button class="me-nav-btn" type="button" data-demo aria-label="扫一扫">${ICON.scan}</button>
        <button class="me-nav-btn" type="button" data-demo aria-label="设置">${ICON.gear}<i class="me-nav-dot"></i></button>
      </div>`;
    return;
  }

  const titles = { likes: '赞', home: '首页', video: '视频', discover: '发现' };
  const title = titles[state.route] || '消息';
  const back = state.route === 'likes' ? `<button class="nav-back" type="button" data-nav="messages" aria-label="返回">${ICON.back}</button>` : '';
  el.navbar.innerHTML = `${back}<span class="nav-title-btn">${esc(title)}</span>`;
}

function menuHtml(kind) {
  const options = OPTIONS[kind];
  const rows = options
    .map((opt) => {
      if (opt.heading) return `<div class="menu-label">${esc(opt.label)}</div>`;
      const active = state.option[kind] === opt.key ? ' active' : '';
      return `<button class="menu-item${active}" type="button" data-opt="${kind}:${opt.key}">${esc(opt.label)}</button>`;
    })
    .join('');
  return `<div class="menu" role="menu">${rows}</div>`;
}

function renderOverlay() {
  if (!state.menu) {
    el.overlay.innerHTML = '';
    return;
  }
  el.overlay.innerHTML = `<div class="scrim" data-close-menu></div>${menuHtml(state.menu)}`;
}

function renderTabbar() {
  const active = activeTab();
  const unread = state.unread ? Number(state.unread.at || 0) + Number(state.unread.comments || 0) : 0;
  el.tabbar.innerHTML = TABS.map((tab) => {
    const isActive = tab.key === active ? ' active' : '';
    const badge = tab.badge && unread > 0 ? `<span class="tab-badge">${unread > 99 ? '99+' : unread}</span>` : '';
    return `<button class="tab${isActive}" type="button" data-nav="${tab.key}">${tab.icon}<span>${tab.label}</span>${badge}</button>`;
  }).join('');
}

/* ------------------------------------------------------------------ *
 * 渲染：各页面
 * ------------------------------------------------------------------ */

function skeletonHtml() {
  const row = '<div class="sk-row"><span class="sk-avatar"></span><span class="sk-lines"><i></i><i></i></span></div>';
  return row.repeat(6);
}

function emptyHtml(icon, title, text, action = '') {
  return `<div class="empty"><div class="empty-ico">${icon}</div><h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
}

/** 后台管理入口：仅本地开发时显示；线上展示页不部署后台。 */
function adminLinkHtml(label) {
  if (IS_DEPLOYED) return '';
  return `<a class="link-out" href="/">${esc(label)}</a>`;
}

function adminButtonHtml(label, href) {
  if (IS_DEPLOYED) return `<button class="me-task-btn" type="button" data-demo>${esc(label)}</button>`;
  return `<a class="me-task-btn" href="${href}">${esc(label)}</a>`;
}

function noUsersHtml() {
  return `<div class="empty">
    <div class="empty-ico">${ICON.me}</div>
    <h2>还没有归档账号</h2>
    <p>先在后台管理中添加微博账号并取数，这里就会出现对应的通知界面。</p>
    ${adminLinkHtml('打开后台管理')}
  </div>`;
}

function errorHtml(err) {
  const message = err && err.message ? err.message : '本地数据读取失败';
  const detail = err && err.detail ? `<div class="error-detail">${esc(err.detail)}</div>` : '';
  return `<div class="error-box">
    <div>${esc(message)}</div>
    ${detail}
    <div class="error-actions">
      <button type="button" data-retry>重试</button>
      <button type="button" data-hard-refresh>强制刷新</button>
    </div>
  </div>`;
}

function catRow(kind, label, count, route) {
  const icon = kind === 'at' ? '<b>@</b>' : kind === 'comment' ? ICON.chat : ICON.thumb;
  const badge = count > 0 ? `<span class="cat-count">${count > 99 ? '99+' : count}</span>` : '';
  return `<button class="cat-row" type="button" data-nav="${route}">
    <span class="cat-ico cat-${kind}">${icon}</span>
    <span class="cat-label">${esc(label)}</span>
    ${badge}
    <span class="chev">${ICON.chev}</span>
  </button>`;
}

function chatRow(chat) {
  const dot = chat.unread ? '<span class="chat-dot"></span>' : '';
  return `<button class="chat-row" type="button" data-demo>
    ${avatarHtml(chat.name, chat.uid, 48)}
    <span class="chat-main">
      <span class="chat-line"><span class="chat-name">${esc(chat.name)}</span><span class="chat-time">${esc(feedTime(chat.ms))}</span></span>
      <span class="chat-line"><span class="chat-snippet">${esc(snippet(chat.text, 48))}</span>${dot}</span>
    </span>
  </button>`;
}

/** 把互动记录按作者聚合为「会话」列表（保留每位作者的最新一条）。 */
function buildChats(list) {
  const seen = new Set();
  const chats = [];
  for (const rec of list.slice().sort((a, b) => b.ms - a.ms)) {
    const key = rec.authorUid || rec.author || rec.recordId;
    if (seen.has(key)) continue;
    seen.add(key);
    chats.push({
      name: rec.author || '微博用户',
      uid: rec.authorUid || key,
      text: rec.text,
      ms: rec.ms,
      unread: Boolean(rec.isUnread),
    });
    if (chats.length >= 10) break;
  }
  return chats;
}

async function buildMessages() {
  const uid = state.uid;
  const [posts, comments, received, unreadPosts, unreadComments, unreadReceived] = await Promise.all([
    itemsOf(uid, 'mentions-posts'),
    itemsOf(uid, 'mentions-comments'),
    itemsOf(uid, 'received'),
    unreadTotal(uid, 'mentions-posts'),
    unreadTotal(uid, 'mentions-comments'),
    unreadTotal(uid, 'received'),
  ]);
  state.unread = { at: unreadPosts + unreadComments, comments: unreadReceived };
  const chats = buildChats([...posts, ...comments, ...received]);
  const chatList = chats.length ? `<div class="chat-list">${chats.map(chatRow).join('')}</div>` : '';
  return `
    <div class="search">${ICON.search}<span>搜索聊天记录、群号</span></div>
    <div class="cat-list">
      ${catRow('at', '@ 我的', state.unread.at, 'at')}
      ${catRow('comment', '评论', state.unread.comments, 'comments')}
      ${catRow('like', '赞', 0, 'likes')}
    </div>
    ${chatList}
    <p class="page-note">本地归档模拟展示：会话由互动记录的作者聚合而成，点击不会发送任何消息。</p>`;
}

function subText(rec, kind) {
  if (kind !== 'comments') return '@了你';
  if (rec.mode === 'sent') return rec.replyAuthor ? `回复了 ${rec.replyAuthor}` : '我发出的评论';
  return '评论了你的微博';
}

function mediaHtml(rec) {
  const pictures = rec.pictures && Array.isArray(rec.pictures.items) ? rec.pictures.items : [];
  if (!pictures.length) return '';
  const thumbs = pictures
    .slice(0, 3)
    .map(
      (pic) =>
        `<span class="thumb"><span class="thumb-ph">图</span><img src="${esc(pic && pic.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`
    )
    .join('');
  return `<div class="media">${thumbs}</div>`;
}

function cardHtml(rec, kind) {
  const name = rec.author || '微博用户';
  const media = mediaHtml(rec);
  const likes = Number(rec.likes) > 0 ? ` ${Number(rec.likes)}` : '';
  const linkAttrs = externalLinkAttrs(recordHref(rec));
  const postHref = recordPostHref(rec);
  const isComment = rec.mode !== 'mentions-posts' && rec.mode !== 'user-posts';
  const postLink =
    isComment && postHref ? `<a class="act" ${externalLinkAttrs(postHref)}>原微博</a>` : '';
  return `<article class="card">
    ${avatarLink(rec.authorUid, avatarHtml(name, rec.authorUid || name, 44))}
    <div class="card-main">
      <div class="card-head"><a class="card-name" ${linkAttrs}>${esc(name)}</a></div>
      <div class="card-sub"><span>${esc(subText(rec, kind))}</span><span>·</span><span>${esc(feedTime(rec.ms))}</span></div>
      <div class="card-body">
        <a class="card-text" ${linkAttrs}>${richText(rec.text)}</a>
        ${media}
      </div>
      <div class="actions">
        <button class="act" type="button" data-demo>${ICON.forward}转发</button>
        <button class="act" type="button" data-demo>${ICON.reply}回复</button>
        <button class="act" type="button" data-demo>${ICON.thumb}赞${likes}</button>
        ${postLink}
        <button class="act-dots" type="button" data-demo aria-label="更多">⋯</button>
      </div>
    </div>
  </article>`;
}

async function buildFeed(kind) {
  const options = OPTIONS[kind];
  const active = options.find((opt) => opt.key === state.option[kind]) || options.find((opt) => !opt.heading);
  const lists = await Promise.all(active.modes.map((mode) => itemsOf(state.uid, mode)));
  let list = lists.flat();
  if (typeof active.filter === 'function') list = list.filter(active.filter);
  list.sort((a, b) => b.ms - a.ms);
  if (!list.length) {
    // 「收到/被@」为空时给出可切换的替代筛选，避免只看到空页
    const action =
      kind === 'comments' && state.option.comments !== 'mine'
        ? '<button class="link-out" type="button" data-opt="comments:mine">查看「我发出的」评论</button>'
        : '';
    const text = kind === 'comments' ? '该账号还没有归档「收到的评论」。' : '换一个筛选条件试试。';
    return emptyHtml(ICON.chat, '暂无通知', text, action);
  }
  const shown = list.slice(0, MAX_CARDS);
  const rest = list.length > MAX_CARDS ? `<p class="page-note">仅展示最近 ${MAX_CARDS} 条，共 ${list.length} 条。</p>` : '';
  return `<div class="feed">${shown.map((rec) => cardHtml(rec, kind)).join('')}</div>${rest}`;
}

function buildLikes() {
  return emptyHtml(ICON.likeEmpty, '暂无新的赞', '本地归档不包含点赞通知数据，这里仅还原界面。');
}

function acctRow(user) {
  const active = user.uid === state.uid;
  const stats = user.stats || {};
  return `<button class="acct-row${active ? ' active' : ''}" type="button" data-switch="${esc(user.uid)}">
    ${userAvatar(user, 44)}
    <span class="acct-main">
      <span class="acct-name">${esc(user.screenName || '未命名账号')}</span>
      <span class="acct-uid">UID ${esc(user.uid)} · 归档 ${countText(stats.recordCount)} 条</span>
    </span>
    ${active ? `<span class="acct-check">${ICON.check}</span>` : ''}
  </button>`;
}

/** 「我」页常用入口（与微博个人主页布局一致，点击均为演示提示）。 */
const ME_GRID = [
  { icon: 'album', label: '我的相册' },
  { icon: 'star', label: '赞/收藏' },
  { icon: 'clock', label: '浏览记录' },
  { icon: 'inbox', label: '草稿箱' },
  { icon: 'wallet', label: '我的钱包' },
  { icon: 'bag', label: '微博购订单' },
  { icon: 'bulb', label: '创作中心' },
  { icon: 'calendar', label: '广告中心' },
];

function statText(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return n.toLocaleString('zh-CN');
}

function numCell(value, label) {
  return `<div class="me-num"><b>${esc(statText(value))}</b><span>${esc(label)}</span></div>`;
}

function dateTimeText(ms) {
  const value = Number(ms) || 0;
  if (!value) return '';
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}-`;
  return `${year}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function taskCell(title, sub, action) {
  return `<div class="me-task-cell">
    <div class="me-task-text">
      <div class="me-task-title">${esc(title)}</div>
      <div class="me-task-sub">${esc(sub)}</div>
    </div>
    ${action}
  </div>`;
}

async function buildMe() {
  const user = state.users.find((item) => item.uid === state.uid);
  if (!user) return noUsersHtml();
  const profile = state.profiles[String(user.uid)] || null;
  const stats = user.stats || {};
  const recordCount = Number(stats.recordCount) || 0;
  const unread = Number(stats.unreadCount) || 0;
  const modeCount = Object.keys(stats.byMode || {}).length;

  const [notifyPosts, notifyComments, received, sent] = await Promise.all([
    itemsOf(state.uid, 'mentions-posts'),
    itemsOf(state.uid, 'mentions-comments'),
    itemsOf(state.uid, 'received'),
    itemsOf(state.uid, 'sent'),
  ]);
  const all = [...notifyPosts, ...notifyComments, ...received, ...sent].sort((a, b) => b.ms - a.ms);
  const chats = buildChats(all).slice(0, 10);
  const latest = all[0] || null;

  const identity = `
    <div class="me-identity">
      <span class="me-avatar">${userAvatar(user, 76)}</span>
      <div class="me-id-text">
        <div class="me-name-row">
          <h1 class="me-name">${esc((profile && profile.screenName) || user.screenName || '未命名账号')}</h1>
          <span class="me-badge">已归档</span>
          ${profile && profile.verified ? '<span class="me-verify">V</span>' : ''}
        </div>
        <p class="me-bio">简介：${esc((profile && profile.description) || '暂无简介')}</p>
        <button class="me-chip" type="button" data-nav="messages">${ICON.message}共 ${statText(recordCount)} 条互动 ›</button>
      </div>
    </div>`;

  const banner = `
    <div class="me-banner">
      <div class="me-banner-main">
        <div class="me-banner-title">本地归档 · 数据只在本机</div>
        <div class="me-banner-sub">浏览、搜索、报告均不产生 credits</div>
      </div>
      <button class="me-banner-btn" type="button" data-nav="messages">
        通知中心${unread > 0 ? `<i class="me-banner-dot">${unread > 99 ? '99+' : unread}</i>` : ''}
      </button>
    </div>`;

  const recent = latest
    ? `<div class="me-recent">
        <span class="me-recent-thumb">${avatarHtml(latest.author, latest.authorUid, 30)}</span>
        <span class="me-recent-text">最近归档：${esc(snippet(latest.text, 20))}</span>
        <button class="me-recent-close" type="button" data-demo aria-label="关闭">×</button>
      </div>`
    : '';

  const statsRow = `<div class="me-stat-row">
    ${numCell(profile ? profile.statuses : null, '微博')}
    ${numCell(profile ? profile.friends : null, '关注')}
    ${numCell(profile ? profile.followers : null, '粉丝')}
    ${numCell(recordCount, '归档')}
  </div>`;

  const grid = `<div class="me-card me-grid">
    ${ME_GRID.map(
      (item) =>
        `<button class="me-grid-item" type="button" data-demo><span class="me-grid-ico">${ICON[item.icon]}</span><span>${esc(item.label)}</span></button>`
    ).join('')}
  </div>`;

  const tasks = `<div class="me-card me-task">
    <div class="me-task-row">
      ${taskCell('通知中心', `未读 ${unread} 条 · 共 ${recordCount} 条`, '<button class="me-task-btn" type="button" data-nav="messages">查看</button>')}
      ${taskCell('最近取数', `上次更新 ${dateTimeText(user.lastFetchedAtMs) || '—'}`, adminButtonHtml('去取数', '/#/fetch'))}
    </div>
    <div class="me-task-row">
      ${taskCell('本地报告', '导出离线 HTML 报告', adminButtonHtml('去生成', '/#/users'))}
      ${taskCell('账号切换', `共 ${state.users.length} 个归档账号`, '<button class="me-task-btn" type="button" data-scroll="meAccounts">切换</button>')}
    </div>
  </div>`;

  const overview = `<div class="me-card me-overview">
    <div class="me-card-head"><h2>归档概览</h2>${IS_DEPLOYED ? '' : '<a href="/">查看详情 ›</a>'}</div>
    <div class="me-stat-row">
      ${numCell(recordCount, '互动总数')}
      ${numCell(unread, '未读')}
      ${numCell(modeCount, '通知类型')}
      ${numCell(state.users.length, '账号')}
    </div>
  </div>`;

  const visits = chats.length
    ? `<div class="me-card me-visits">
        <div class="me-card-head"><h2>最近互动</h2><button type="button" data-nav="messages">查看更多 ›</button></div>
        <div class="me-visits-scroll">
          ${chats
            .map((chat) => {
              const inner = `${avatarHtml(chat.name, chat.uid, 52)}<span class="me-visit-name">${esc(chat.name)}</span>`;
              const href = profileHref(chat.uid);
              return href
                ? `<a class="me-visit" ${externalLinkAttrs(href)} aria-label="打开主页">${inner}</a>`
                : `<button class="me-visit" type="button" data-nav="messages">${inner}</button>`;
            })
            .join('')}
        </div>
      </div>`
    : '';

  const iosHint =
    IS_IOS && !IS_STANDALONE
      ? '<p class="page-note">iPhone 去掉浏览器上下栏：Safari 分享 → 添加到主屏幕。</p>'
      : '';

  return `
    <div class="me-page">
      <section class="me-header">
        ${recent}
        ${identity}
        ${banner}
        ${statsRow}
      </section>
      ${grid}
      ${tasks}
      ${overview}
      ${visits}
      <div class="section-title">切换账号（本地归档对象）</div>
      <div class="me-card me-accounts" id="meAccounts">${state.users.map(acctRow).join('')}</div>
      ${adminLinkHtml('打开后台管理（取数 / 搜索 / 报告）')}
      <p class="page-note">展示页只读取本地归档，不发起取数，也不会改变未读状态。</p>
      ${iosHint}
    </div>`;
}

function buildPlaceholder(icon, title, text) {
  return `<div class="empty">
    <div class="empty-ico">${icon}</div>
    <h2>${esc(title)}</h2>
    <p>${esc(text)}</p>
    ${adminLinkHtml('打开后台管理')}
  </div>`;
}

const SCREENS = {
  messages: buildMessages,
  at: () => buildFeed('at'),
  comments: () => buildFeed('comments'),
  likes: async () => buildLikes(),
  me: async () => buildMe(),
  home: async () => buildPlaceholder(ICON.home, '首页', '展示页目前还原「消息」与「我」，首页信息流不在本地归档范围内。'),
  video: async () => buildPlaceholder(ICON.video, '视频', '视频页不在本地归档范围内。'),
  discover: async () => buildPlaceholder(ICON.discover, '发现', '发现页不在本地归档范围内。'),
};

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

function tip(message) {
  if (!el.tip) return;
  el.tip.textContent = message;
  el.tip.classList.add('show');
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => el.tip.classList.remove('show'), 1600);
}

function updateFullscreenUi() {
  const active = Boolean(document.fullscreenElement);
  document.body.classList.toggle('is-fullscreen', active);
  if (el.fsBtn) {
    el.fsBtn.innerHTML = active ? ICON.compress : ICON.expand;
    el.fsBtn.setAttribute('aria-label', active ? '退出全屏' : '全屏');
  }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      return;
    }
    tip('当前浏览器不支持网页全屏（顶部仿真状态栏已隐藏）');
  } catch {
    tip('当前浏览器不允许进入全屏');
  }
}

function setScreen(markup) {
  el.screen.innerHTML = markup;
  el.screen.scrollTop = 0;
}

const ROUTE_DEPTH = { messages: 0, me: 0, home: 0, video: 0, discover: 0, likes: 1, at: 1, comments: 1 };

function animateScreen(direction) {
  el.screen.classList.remove('anim-forward', 'anim-back');
  void el.screen.offsetWidth;
  el.screen.classList.add(direction === 'forward' ? 'anim-forward' : 'anim-back');
}

function render() {
  const next = currentRoute();
  const previous = state.route;
  const prevDepth = ROUTE_DEPTH[previous] ?? 0;
  const nextDepth = ROUTE_DEPTH[next] ?? 0;
  let direction = '';
  if (next !== previous) {
    direction = nextDepth > prevDepth ? 'forward' : nextDepth < prevDepth ? 'back' : '';
  }
  state.route = next;
  renderNavbar();
  renderTabbar();
  renderOverlay();
  renderScreen(direction);
}

async function renderScreen(direction = '') {
  const seq = ++state.seq;
  el.screen.classList.toggle('screen-me', state.route === 'me');
  if (direction) animateScreen(direction);
  if (!state.uid) {
    setScreen(noUsersHtml());
    return;
  }
  setScreen(skeletonHtml());
  try {
    const markup = await SCREENS[state.route]();
    if (seq !== state.seq) return;
    setScreen(markup);
    renderTabbar();
  } catch (err) {
    if (seq !== state.seq) return;
    setScreen(errorHtml(err));
  }
}

function go(route) {
  state.menu = null;
  const target = `#/${route}`;
  if (location.hash === target) {
    render();
    return;
  }
  location.hash = target;
}

function switchUser(uid) {
  const user = state.users.find((item) => item.uid === uid);
  if (!user) return;
  state.uid = uid;
  state.unread = null;
  try {
    localStorage.setItem(STORAGE_KEY, uid);
  } catch {
    /* 隐私模式下写不了 localStorage：仅影响下次打开的默认账号 */
  }
  render();
  tip(`已切换到 ${user.screenName || uid}`);
}

function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  if (target.closest('[data-demo]')) {
    tip('展示页面：不执行真实微博操作');
    return;
  }
  if (target.closest('[data-close-menu]')) {
    state.menu = null;
    renderNavbar();
    renderOverlay();
    return;
  }
  const menuBtn = target.closest('[data-menu]');
  if (menuBtn) {
    const kind = menuBtn.dataset.menu;
    state.menu = state.menu === kind ? null : kind;
    renderNavbar();
    renderOverlay();
    return;
  }
  const optionBtn = target.closest('[data-opt]');
  if (optionBtn) {
    const [kind, key] = String(optionBtn.dataset.opt || '').split(':');
    if (kind && key) {
      state.option[kind] = key;
      state.menu = null;
      renderNavbar();
      renderOverlay();
      renderScreen();
    }
    return;
  }
  const switchBtn = target.closest('[data-switch]');
  if (switchBtn) {
    switchUser(switchBtn.dataset.switch);
    return;
  }
  const scrollBtn = target.closest('[data-scroll]');
  if (scrollBtn) {
    const node = document.getElementById(scrollBtn.dataset.scroll);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const navBtn = target.closest('[data-nav]');
  if (navBtn) {
    go(navBtn.dataset.nav);
    return;
  }
  if (target.closest('[data-retry]')) render();
  if (target.closest('[data-hard-refresh]')) {
    const url = new URL(window.location.href);
    url.searchParams.set('v', Date.now().toString(36));
    window.location.replace(url.toString());
  }
}

function onImageError(event) {
  const target = event.target;
  if (target && target.tagName === 'IMG') target.classList.add('is-broken');
}

function tickClock() {
  const node = document.getElementById('sbTime');
  const now = new Date();
  if (node) node.textContent = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** iOS 独立窗口切走再回来后视口高度会变化，重新计算并锁定 --app-height。 */
function syncAppHeight() {
  const height = Math.round(
    Math.max(window.innerHeight || 0, window.visualViewport ? window.visualViewport.height : 0)
  );
  if (height > 0) document.documentElement.style.setProperty('--app-height', `${height}px`);
}

const INVITE_KEY = 'weibo-showcase-invite-v1';

function showGate(message = '') {
  if (!el.gate) return;
  el.gate.hidden = false;
  if (el.gateMsg) el.gateMsg.textContent = message;
}

function hideGate() {
  if (el.gate) el.gate.hidden = true;
}

async function verifyInvite(code) {
  try {
    const response = await fetch(`${API_ROOT}api/showcase/invite/verify`, {
      cache: 'no-store',
      headers: { 'X-Invite-Code': code },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && payload.error && payload.error.message ? payload.error.message : '验证服务暂时不可用';
      return { ok: false, reason: message, network: response.status >= 500 };
    }
    if (!payload || payload.ok !== true) return { ok: false, reason: '验证服务返回异常', network: true };
    if (payload.data && payload.data.valid) {
      return {
        ok: true,
        scope: payload.data.scope || 'all',
        accounts: Array.isArray(payload.data.accounts) ? payload.data.accounts.map(String) : [],
      };
    }
    return { ok: false, reason: (payload.data && payload.data.reason) || '邀请码无效' };
  } catch {
    return { ok: false, reason: '验证服务暂时不可用，请稍后再试', network: true };
  }
}

async function requireInvite() {
  let stored = '';
  try {
    stored = localStorage.getItem(INVITE_KEY) || '';
  } catch {
    stored = '';
  }
  let initialMessage = '';
  if (stored) {
    const result = await verifyInvite(stored);
    if (result.ok) {
      hideGate();
      return result;
    }
    initialMessage = result.reason || '';
    if (!result.network) {
      try {
        localStorage.removeItem(INVITE_KEY);
      } catch {
        /* 隐私模式下忽略 */
      }
    }
  }
  if (!el.gate || !el.gateBtn || !el.gateInput) return { ok: true, scope: 'all', accounts: [] };
  showGate(initialMessage);
  return new Promise((resolve) => {
    const submit = async () => {
      const code = el.gateInput.value.trim();
      if (!code) {
        el.gateMsg.textContent = '请输入邀请码';
        return;
      }
      el.gateBtn.disabled = true;
      el.gateMsg.textContent = '验证中…';
      const result = await verifyInvite(code);
      if (result.ok) {
        try {
          localStorage.setItem(INVITE_KEY, code);
        } catch {
          /* 隐私模式下本次仍可访问 */
        }
        hideGate();
        resolve(result);
        return;
      }
      el.gateMsg.textContent = result.reason || '邀请码无效';
      el.gateBtn.disabled = false;
      el.gateInput.focus();
    };
    el.gateBtn.addEventListener('click', submit);
    el.gateInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/** 按邀请码的可见范围过滤账号（仅影响展示页 UI）。 */
function filterUsersByInvite(users) {
  const invite = state.invite;
  if (!invite || invite.scope === 'all') return users;
  const allowed = new Set((invite.accounts || []).map(String));
  return users.filter((user) => allowed.has(String(user.uid)));
}

async function boot() {
  el.navbar = document.getElementById('navbar');
  el.screen = document.getElementById('screen');
  el.tabbar = document.getElementById('tabbar');
  el.overlay = document.getElementById('overlayRoot');
  el.tip = document.getElementById('floatTip');
  el.fsBtn = document.getElementById('fsBtn');
  if (el.fsBtn) {
    el.fsBtn.innerHTML = ICON.expand;
    el.fsBtn.addEventListener('click', () => {
      void toggleFullscreen();
    });
    document.addEventListener('fullscreenchange', updateFullscreenUi);
  }
  el.gate = document.getElementById('gate');
  el.gateInput = document.getElementById('gateInput');
  el.gateBtn = document.getElementById('gateBtn');
  el.gateMsg = document.getElementById('gateMsg');

  tickClock();
  setInterval(tickClock, 30000);
  document.addEventListener('click', onClick);
  document.addEventListener('error', onImageError, true);
  window.addEventListener('hashchange', () => {
    state.menu = null;
    render();
  });

  syncAppHeight();
  window.addEventListener('resize', syncAppHeight);
  window.addEventListener('orientationchange', syncAppHeight);
  window.addEventListener('pageshow', (event) => {
    // 从微博/应用内浏览器返回时 iOS 可能用 bfcache 恢复旧视口，直接重载最稳
    if (event.persisted) {
      window.location.reload();
      return;
    }
    syncAppHeight();
    window.setTimeout(() => {
      window.scrollTo(0, 0);
      void document.documentElement.offsetHeight;
      syncAppHeight();
    }, 300);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      syncAppHeight();
      window.setTimeout(() => {
        void document.documentElement.offsetHeight;
        syncAppHeight();
      }, 300);
    }
  });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', syncAppHeight);

  const invite = await requireInvite();
  if (!invite) return;
  state.invite = invite;

  try {
    const [users, profiles] = await Promise.all([loadUsers(), loadProfiles()]);
    state.users = filterUsersByInvite(users);
    state.profiles = profiles;
  } catch (err) {
    setScreen(errorHtml(err));
    return;
  }

  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  const known = state.users.find((user) => user.uid === saved);
  // 首次打开默认展示最近添加的账号（即最新拉取数据的号），没有则退回第一个
  const newest = state.users
    .slice()
    .sort((a, b) => Number(b.addedAtMs || 0) - Number(a.addedAtMs || 0))[0];
  state.uid = known ? known.uid : newest ? newest.uid : null;
  state.route = currentRoute();
  render();
}

boot();
