/**
 * @file 前端外壳：hash 路由 + 视图注册表 + 顶栏状态（余额/登录/演示横幅）+ 统一错误条。
 *
 * 路由用 hash（`#/users/123`）而非 History API —— 服务端静态托管无需为深链做 rewrites。
 * @module web/js/app
 */

import {
  api,
  clearNode,
  esc,
  errorBar,
  fmtNum,
  fmtTime,
  getStatus,
  html,
  navigate,
  numOrNull,
  onStatus,
  refreshStatus,
  toast,
} from './api.js';
import * as library from './views-library.js';
import * as fetchView from './views-fetch.js';
import * as searchView from './views-search.js';
import * as configView from './views-config.js';

/** 视图注册表：`re` 捕获组会作为 `ctx.params` 传给视图。 */
const ROUTES = [
  { re: /^\/overview$/, nav: 'overview', render: library.renderOverview },
  { re: /^\/users$/, nav: 'users', render: library.renderUsers },
  { re: /^\/users\/(\d{1,20})$/, nav: 'users', render: library.renderUserDetail },
  { re: /^\/posts$/, nav: 'posts', render: library.renderPosts },
  { re: /^\/posts\/(\d{1,20})$/, nav: 'posts', render: library.renderPostDetail },
  { re: /^\/fetch$/, nav: 'fetch', render: fetchView.renderFetch },
  { re: /^\/search$/, nav: 'search', render: searchView.renderSearch },
  { re: /^\/subscriptions$/, nav: 'settings', render: configView.renderSubscriptions },
  { re: /^\/settings$/, nav: 'settings', render: configView.renderSettings },
];

/** 顶栏余额 chip 元素。 */
const els = {};

/** 高亮侧边栏当前项。 */
function setActiveNav(nav) {
  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.nav === nav);
  }
}

/** 渲染顶栏（余额 / 账号 / 演示横幅 / 数据目录）。 */
function renderTopbar(status) {
  const value = els.balanceValue;
  if (!value) return;
  if (!status) {
    value.textContent = '—';
    return;
  }
  const balance = status.balance;
  const balanceValue = balance ? numOrNull(balance.value) : null;
  if (balanceValue !== null) {
    value.textContent = fmtNum(balanceValue);
    els.chip.classList.toggle('is-stale', Boolean(balance.stale));
    els.balanceAt.textContent = balance.atMs
      ? `${balance.stale ? '缓存于' : '更新于'} ${fmtTime(balance.atMs)}`
      : '';
  } else {
    // 余额未知（未登录 / 演示模式 / 接口未取到）一律显示 `—`，
    // 绝不能因为 `Number(null) === 0` 而渲染成「剩余 0 credits」这种假数据。
    value.textContent = '—';
    els.chip.classList.add('is-stale');
    els.balanceAt.textContent = status.demoMode
      ? '演示模式不查余额'
      : status.loggedIn
        ? '点 ⟳ 获取'
        : '未登录';
  }

  els.account.textContent =
    status.loggedIn && status.account
      ? `${status.account.screenName || '已登录'}${status.account.uid ? ` · ${status.account.uid}` : ''}`
      : '未登录';
  els.login.textContent = status.loggedIn ? '切换账号' : '登录微博';
  els.brandVer.textContent = `v1.0 · 未读 ${status.counts ? status.counts.unread : 0}`;
  els.dataDir.textContent = `数据目录：${status.dataDir}`;
  els.dataDir.title = status.dataDir;

  if (status.demoMode) {
    els.banner.innerHTML = `<span class="banner-strong">演示数据</span>
      <span>当前是内置示例数据，不含真实账号；付费取数与订阅巡检均已停用（零 credits 消耗）。</span>
      <div class="banner-actions">
        <button class="btn btn-sm" type="button" data-act="seed">重置演示数据</button>
        ${status.loggedIn ? '' : '<button class="btn btn-sm btn-primary" type="button" data-act="login">登录真实账号</button>'}
      </div>`;
    els.banner.classList.remove('hidden');
  } else {
    els.banner.classList.add('hidden');
    els.banner.innerHTML = '';
  }
}

/** 手动刷新余额。 */
async function refreshBalance() {
  const button = els.refresh;
  if (button) button.textContent = '…';
  try {
    const data = await api('/api/account/balance?refresh=1');
    const fetched = data ? numOrNull(data.value) : null;
    if (fetched !== null) {
      toast(data.stale ? `接口异常，显示缓存值 ${fmtNum(fetched)}（${fmtTime(data.atMs)}）` : `剩余 ${fmtNum(fetched)} credits`, data.stale ? 'warn' : 'ok');
    } else {
      toast('未获取到余额（未登录或演示模式）', 'warn');
    }
  } catch (err) {
    toast(err && err.message ? err.message : '余额刷新失败', 'error');
  } finally {
    if (button) button.textContent = '⟳';
    await refreshStatus();
  }
}

/** 演示横幅上的按钮（事件委托）。 */
function bindBanner() {
  els.banner.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-act]');
    if (!target) return;
    const act = target.dataset.act;
    if (act === 'login') {
      configView.openLoginModal();
      return;
    }
    if (act === 'seed') {
      target.disabled = true;
      try {
        const result = await api('/api/demo/seed', { method: 'POST', body: { reset: true } });
        toast(`演示数据已重置：${result.counts.users} 位用户 / ${result.counts.posts} 条博文`, 'ok');
        await refreshStatus();
        renderRoute();
      } catch (err) {
        toast(err && err.message ? err.message : '重置失败', 'error');
      } finally {
        target.disabled = false;
      }
    }
  });
}

/** 404 视图。 */
function renderNotFound(root, pathname) {
  clearNode(root);
  root.appendChild(
    html(`<div class="empty-state">
      <div class="empty-title">页面不存在</div>
      <div class="empty-desc">路径 <code class="mono">${esc(pathname)}</code> 没有对应的视图。</div>
      <div class="empty-actions"><a class="btn btn-primary" href="#/overview">回到总览</a></div>
    </div>`)
  );
}

let renderToken = 0;

/** 解析并渲染当前 hash 路由。 */
async function renderRoute() {
  const raw = location.hash.replace(/^#/, '') || '/overview';
  const [pathPart, queryPart] = raw.split('?');
  const pathname = pathPart || '/overview';
  const query = new URLSearchParams(queryPart || '');
  const root = document.getElementById('view');
  if (!root) return;

  let matched = null;
  let params = [];
  for (const route of ROUTES) {
    const m = route.re.exec(pathname);
    if (m) {
      matched = route;
      params = m.slice(1);
      break;
    }
  }
  if (!matched) {
    renderNotFound(root, pathname);
    return;
  }

  setActiveNav(matched.nav);
  renderToken += 1;
  const token = renderToken;
  clearNode(root);
  try {
    await matched.render(root, { params, query, pathname });
  } catch (err) {
    if (token !== renderToken) return;
    clearNode(root);
    root.appendChild(
      errorBar(err, () => {
        renderRoute();
      })
    );
  }
  if (token === renderToken) window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/** 初始化。 */
function init() {
  els.balanceValue = document.getElementById('balanceValue');
  els.balanceAt = document.getElementById('balanceAt');
  els.chip = document.getElementById('balanceChip');
  els.account = document.getElementById('accountChip');
  els.login = document.getElementById('btnLogin');
  els.banner = document.getElementById('banner');
  els.refresh = document.getElementById('btnRefreshBalance');
  els.brandVer = document.getElementById('brandVer');
  els.dataDir = document.getElementById('dataDirHint');

  els.login.addEventListener('click', () => configView.openLoginModal());
  els.refresh.addEventListener('click', () => {
    void refreshBalance();
  });
  bindBanner();
  onStatus(renderTopbar);

  window.addEventListener('hashchange', () => {
    void renderRoute();
  });

  if (!location.hash) location.hash = '#/overview';
  void refreshStatus();
  void renderRoute();

  // 顶栏余额每 3 分钟自动刷新一次（失败保留缓存值）
  setInterval(() => {
    const status = getStatus();
    if (status && status.loggedIn && !status.demoMode) void refreshStatus();
  }, 180000);
}

init();

/** 供视图调用的轻量再渲染（不改变路由）。 */
export function rerender() {
  void renderRoute();
}

/** 供视图调用：跳转到取数页（预填参数）。 */
export function gotoFetch(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  navigate(`/fetch${qs ? `?${qs}` : ''}`);
}
