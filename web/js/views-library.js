/**
 * @file 视图：总览、用户库 / 用户详情（互动分组 + 时间轴 + gap）、博文库 / 博文详情、报告弹窗。
 * @module web/js/views-library
 */

import {
  api,
  confirmDialog,
  copyText,
  esc,
  fmtDay,
  fmtNum,
  fmtRelative,
  fmtTime,
  html,
  navigate,
  numOrNull,
  refreshStatus,
  setBusy,
  toast,
} from './api.js';

/* ------------------------------------------------------------------ *
 * 通用小组件
 * ------------------------------------------------------------------ */

/**
 * 手动补录博文正文的弹窗。
 *
 * 为什么需要它：取数接口未必返回原微博对象，所以「取数即回填」只是尽力而为、
 * 不能作为承诺。粘贴正文走 `PATCH /api/posts/:id {text}`，是唯一保证可用的路径。
 *
 * @param {{id:string, author?:string, onDone?:Function}} options
 * @returns {Promise<boolean>} 是否保存成功
 */
function pasteTextDialog(options) {
  return new Promise((resolve) => {
    const mask = html(`<div class="modal-mask">
      <div class="modal" style="max-width:620px">
        <h3>粘贴正文</h3>
        <div class="modal-desc">
          博文 ${esc(options.id)}${options.author ? ` · ${esc(options.author)}` : ''} 的正文尚未落库。
          请从原微博页面复制正文粘贴到这里，保存后即计入正文展示。
        </div>
        <textarea class="textarea" rows="8" data-role="text"
          placeholder="在此粘贴微博正文…"></textarea>
        <div class="form-hint" data-role="err" hidden></div>
        <div class="modal-actions">
          <button class="btn" type="button" data-act="cancel">取消</button>
          <button class="btn btn-primary" type="button" data-act="ok">保存正文</button>
        </div>
      </div>
    </div>`);

    const area = mask.querySelector('[data-role="text"]');
    const err = mask.querySelector('[data-role="err"]');
    const okBtn = mask.querySelector('[data-act="ok"]');

    const close = (value) => {
      mask.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
    };

    const submit = async () => {
      const text = String(area.value || '').trim();
      if (!text) {
        err.hidden = false;
        err.textContent = '正文不能为空，请先粘贴内容。';
        area.focus();
        return;
      }
      okBtn.disabled = true;
      okBtn.textContent = '保存中…';
      try {
        await api(`/api/posts/${encodeURIComponent(options.id)}`, { method: 'PATCH', body: { text } });
        toast('正文已保存');
        close(true);
      } catch (e) {
        err.hidden = false;
        err.textContent = e && e.message ? e.message : '保存失败，请重试。';
        okBtn.disabled = false;
        okBtn.textContent = '保存正文';
      }
    };

    mask.addEventListener('click', (event) => {
      const act = event.target.closest('[data-act]');
      if (act) {
        if (act.dataset.act === 'ok') submit();
        else close(false);
        return;
      }
      if (event.target === mask) close(false);
    });
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
    });
    document.addEventListener('keydown', onKey);
    document.getElementById('modalRoot').appendChild(mask);
    area.focus();
  });
}

/** 头像（缺失时用首字占位）。 */
function avatarMarkup(user, large = false) {
  const size = large ? 'avatar avatar-lg' : 'avatar';
  if (user && user.avatarUrl) {
    return `<img class="${size}" src="${esc(user.avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  }
  const name = String((user && (user.screenName || user.label)) || '?').trim();
  const initial = name ? name.slice(0, 1) : '?';
  return `<span class="avatar-fallback">${esc(initial)}</span>`;
}

/** 统计卡。 */
function statCard(label, value, hint = '') {
  return `<div class="stat-card">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${esc(value)}</div>
    ${hint ? `<div class="stat-hint">${esc(hint)}</div>` : ''}
  </div>`;
}

/** 骨架屏 HTML。 */
function skeletonMarkup(rows = 3) {
  let out = '<div class="card">';
  for (let i = 0; i < rows; i += 1) out += '<div class="skeleton sk-card"></div>';
  return `${out}</div>`;
}

/** 空态。 */
function emptyStateMarkup(title, desc, actions = '') {
  return `<div class="empty-state">
    <div class="empty-title">${esc(title)}</div>
    <div class="empty-desc">${esc(desc)}</div>
    ${actions ? `<div class="empty-actions">${actions}</div>` : ''}
  </div>`;
}

/** `limit` 条数上限可选值。 */
const STATUS_LABEL = {
  success: ['成功', 'badge-ok'],
  stopped: ['已停止', 'badge-warn'],
  failed: ['失败', 'badge-danger'],
  interrupted: ['已中断', 'badge-warn'],
  running: ['运行中', 'badge-primary'],
};

/* ------------------------------------------------------------------ *
 * 总览
 * ------------------------------------------------------------------ */

/**
 * 总览：余额、今日消耗、未读总数、最近任务、快捷入口。
 * @param {HTMLElement} root
 */
export async function renderOverview(root) {
  root.innerHTML = skeletonMarkup(4);
  const [status, users, posts, tasks, logs] = await Promise.all([
    api('/api/status'),
    api('/api/users'),
    api('/api/posts'),
    api('/api/fetch/tasks?limit=6').catch(() => ({ items: [] })),
    api('/api/subscriptions/all/logs?limit=6').catch(() => ({ items: [] })),
  ]);

  const balanceText =
    status.balance && numOrNull(status.balance.value) !== null ? fmtNum(status.balance.value) : '—';
  const balanceHint =
    status.balance && status.balance.atMs
      ? `${status.balance.stale ? '缓存于' : '更新于'} ${fmtTime(status.balance.atMs)}`
      : status.demoMode
        ? '演示模式不查真实余额'
        : '未获取，点顶栏 ⟳';

  const userUnread = users.items.reduce((sum, u) => sum + (u.stats ? u.stats.unreadCount : 0), 0);
  const postUnread = posts.items.reduce((sum, p) => sum + (p.stats ? p.stats.unreadCount : 0), 0);

  const taskRows = (tasks.items || []).length
    ? tasks.items
        .map((task) => {
          const [label, cls] = STATUS_LABEL[task.status] || [task.status || '—', 'badge'];
          return `<tr>
            <td class="nowrap">${esc(fmtTime(task.finishedAtMs || task.startedAtMs))}</td>
            <td>${esc(task.mode || '')}</td>
            <td>${esc(task.ownerType === 'posts' ? '博文' : '用户')} ${esc(task.ownerId || '')}</td>
            <td><span class="badge ${cls}">${esc(label)}</span></td>
            <td class="num">${esc(String(task.returned || 0))}</td>
            <td class="num">${esc(String(task.added || 0))}</td>
            <td class="num">${esc(fmtNum(task.creditsSpent || 0))}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="7" class="muted">暂无取数任务记录</td></tr>';

  const logRows = (logs.items || []).length
    ? logs.items
        .map((log) => {
          const map = {
            ok: ['成功', 'badge-ok'],
            'no-new': ['无新增', 'badge'],
            budget: ['额度不足', 'badge-warn'],
            error: ['失败', 'badge-danger'],
          };
          const [label, cls] = map[log.result] || [log.result || '—', 'badge'];
          return `<tr>
            <td class="nowrap">${esc(fmtTime(log.atMs))}</td>
            <td>${esc(log.mode || '')}</td>
            <td><span class="badge ${cls}">${esc(label)}</span></td>
            <td class="num">${esc(String(log.added || 0))}</td>
            <td class="num">${esc(fmtNum(log.credits || 0))}</td>
            <td class="text-2">${esc(log.message || '')}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="muted">暂无订阅日志</td></tr>';

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 class="page-title">总览</h2>
        <div class="page-desc">付费取数一次，之后搜索、阅读、出报告全部免费且离线可用。</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" data-go="#/fetch">去取数</button>
        <button class="btn" data-go="#/search">本地搜索</button>
        <button class="btn" data-go="#/subscriptions">订阅巡检</button>
      </div>
    </div>

    ${
      status.demoMode
        ? '<div class="notice">当前是演示数据（结构、交互与真实模式一致，只是数据来自内置示例）。可到「设置」登录真实账号以取数。</div>'
        : ''
    }

    <div class="grid-4">
      ${statCard('剩余 credits', balanceText, balanceHint)}
      ${statCard('今日消耗', fmtNum(status.todayCredits || 0), '含手动取数（订阅单独记账）')}
      ${statCard('未读总数', String(status.counts.unread || 0), `用户 ${userUnread} · 博文 ${postUnread}`)}
      ${statCard('归档对象', `${status.counts.users} / ${status.counts.posts}`, '用户数 / 博文数')}
    </div>

    <div class="card">
      <div class="card-head">
        <h3 class="card-title">最近取数任务</h3>
        <div class="card-actions">
          <button class="btn btn-sm" data-go="#/fetch">新建取数</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>结束时间</th><th>模式</th><th>对象</th><th>状态</th><th class="num">返回</th><th class="num">新增</th><th class="num">credits</th></tr></thead>
          <tbody>${taskRows}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3 class="card-title">最近订阅日志</h3>
        <div class="card-actions"><button class="btn btn-sm" data-go="#/subscriptions">管理订阅</button></div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>时间</th><th>模式</th><th>结果</th><th class="num">新增</th><th class="num">credits</th><th>说明</th></tr></thead>
          <tbody>${logRows}</tbody>
        </table>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3 class="card-title">用户库</h3><div class="card-actions"><button class="btn btn-sm" data-go="#/users">打开</button></div></div>
        ${users.items.length ? users.items.slice(0, 5).map((u) => `
          <div class="inline-list" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)">
            <span class="inline-list">
              ${avatarMarkup(u)}
              <span>
                <span style="font-weight:600">${esc(u.screenName)}</span>
                ${u.starred ? '<span class="badge badge-warn">特别关注</span>' : ''}
                <span class="tiny">UID ${esc(u.uid)}</span>
              </span>
            </span>
            <span class="tiny">${u.stats.recordCount} 条 · 未读 ${u.stats.unreadCount}</span>
          </div>`).join('') : '<div class="muted">尚无用户，去用户库添加或载入演示数据。</div>'}
      </div>
      <div class="card">
        <div class="card-head"><h3 class="card-title">博文库</h3><div class="card-actions"><button class="btn btn-sm" data-go="#/posts">打开</button></div></div>
        ${posts.items.length ? posts.items.slice(0, 5).map((p) => `
          <div style="padding:7px 0;border-bottom:1px solid var(--border)">
            <div style="font-weight:600">${esc(p.author || '未知作者')} <span class="tiny">ID ${esc(p.id)}</span></div>
            <div class="tiny">${p.stats.recordCount > 0 ? `${p.stats.recordCount} 条评论 · 未读 ${p.stats.unreadCount}` : '尚未获取评论'}</div>
          </div>`).join('') : '<div class="muted">尚无博文，去博文库添加或载入演示数据。</div>'}
      </div>
    </div>
  `;

  for (const button of root.querySelectorAll('[data-go]')) {
    button.addEventListener('click', () => navigate(button.dataset.go));
  }
}

/* ------------------------------------------------------------------ *
 * 用户库
 * ------------------------------------------------------------------ */

/** @param {HTMLElement} root */
export async function renderUsers(root) {
  root.innerHTML = skeletonMarkup(3);
  const data = await api('/api/users');
  const all = data.items || [];
  let filter = '';
  let starredOnly = false;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 class="page-title">用户库</h2>
        <div class="page-desc">支持 <code class="mono">weibo.com/u/123</code>、<code class="mono">weibo.com/昵称</code>、纯 UID 三种输入；添加对象本身不消耗 credits。</div>
      </div>
      <div class="page-actions">
        <input class="input" id="uFilter" placeholder="按昵称或 UID 过滤（0 credits）" style="width:240px">
        <button class="btn" id="uStarOnly" type="button">只看特别关注</button>
      </div>
    </div>

    <div class="card">
      <div class="form-row">
        <div class="field" style="flex:1 1 360px">
          <label for="uInput">添加用户</label>
          <input class="input" id="uInput" placeholder="粘贴主页链接或 UID，例如 https://weibo.com/u/1234567890">
        </div>
        <button class="btn btn-primary" id="uAdd" type="button">添加</button>
      </div>
      <div class="form-hint" id="uHint">
        支持 <code class="mono">weibo.com/u/1234567890</code>、纯 UID，或昵称链接
        <code class="mono">weibo.com/昵称</code>。昵称解析只能命中<b>本地库里已存在的昵称</b>（不联网、0 credits），
        未收录的昵称请改用 <code class="mono">weibo.com/u/&lt;UID&gt;</code>。添加后昵称/头像会在首次取数时补全。
      </div>
    </div>

    <div id="uList"></div>
  `;

  const listRoot = root.querySelector('#uList');
  const filterInput = root.querySelector('#uFilter');
  const starBtn = root.querySelector('#uStarOnly');

  /** 渲染列表（纯前端过滤，即时响应）。 */
  function renderList() {
    const keyword = filter.trim().toLowerCase();
    const items = all.filter((user) => {
      if (starredOnly && !user.starred) return false;
      if (!keyword) return true;
      return (
        String(user.screenName || '').toLowerCase().includes(keyword) ||
        String(user.uid).includes(keyword) ||
        String(user.remark || '').toLowerCase().includes(keyword)
      );
    });

    if (all.length === 0) {
      listRoot.innerHTML = emptyStateMarkup(
        '还没有归档任何用户',
        '① 粘贴微博主页链接添加；② 或先载入演示数据看看完整流程。',
        '<button class="btn btn-primary" id="uDemo">载入演示数据</button>'
      );
      const demoBtn = listRoot.querySelector('#uDemo');
      if (demoBtn) {
        demoBtn.addEventListener('click', async () => {
          setBusy(demoBtn, true, '载入中…');
          try {
            await api('/api/demo/seed', { method: 'POST', body: { reset: true } });
            toast('演示数据已载入', 'ok');
            await refreshStatus();
            await renderUsers(root);
          } catch (err) {
            toast(err.message || '载入失败', 'error');
            setBusy(demoBtn, false);
          }
        });
      }
      return;
    }

    if (items.length === 0) {
      listRoot.innerHTML = emptyStateMarkup('没有匹配的用户', '试试清空过滤条件。');
      return;
    }

    listRoot.innerHTML = `<div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th style="width:34px"></th><th>用户</th><th>UID</th><th class="num">已存条数</th><th class="num">未读</th><th>最近取数</th><th style="width:170px">操作</th>
        </tr></thead>
        <tbody>
          ${items
            .map(
              (user) => `<tr data-uid="${esc(user.uid)}">
              <td><button class="star-btn ${user.starred ? 'on' : ''}" data-star="${esc(user.uid)}" title="特别关注">${user.starred ? '★' : '☆'}</button></td>
              <td>
                <div class="inline-list">
                  ${avatarMarkup(user)}
                  <div>
                    <div style="font-weight:600">${esc(user.screenName)}</div>
                    ${user.remark ? `<div class="tiny">${esc(user.remark)}</div>` : ''}
                  </div>
                </div>
              </td>
              <td class="mono tiny">${esc(user.uid)}</td>
              <td class="num">${user.stats.recordCount}</td>
              <td class="num">${user.stats.unreadCount > 0 ? `<span class="unread-dot"></span>${user.stats.unreadCount}` : '0'}</td>
              <td class="tiny nowrap">${user.lastFetchedAtMs ? esc(fmtRelative(user.lastFetchedAtMs)) : '尚未取数'}</td>
              <td>
                <div class="inline-list">
                  <button class="btn btn-sm" data-detail="${esc(user.uid)}">详情</button>
                  <button class="btn btn-sm" data-fetch="${esc(user.uid)}">取数</button>
                  <button class="btn btn-sm btn-danger" data-del="${esc(user.uid)}">删除</button>
                </div>
              </td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;

    for (const btn of listRoot.querySelectorAll('[data-detail]')) {
      btn.addEventListener('click', () => navigate(`/users/${btn.dataset.detail}`));
    }
    for (const btn of listRoot.querySelectorAll('[data-fetch]')) {
      const user = all.find((u) => u.uid === btn.dataset.fetch);
      btn.addEventListener('click', () =>
        navigate(`/fetch?mode=sent&ownerType=users&ownerId=${encodeURIComponent(btn.dataset.fetch)}&label=${encodeURIComponent(user ? user.screenName : '')}`)
      );
    }
    for (const btn of listRoot.querySelectorAll('[data-star]')) {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.star;
        const user = all.find((u) => u.uid === uid);
        if (!user) return;
        try {
          const updated = await api(`/api/users/${uid}`, { method: 'PATCH', body: { starred: !user.starred } });
          user.starred = updated.starred;
          renderList();
        } catch (err) {
          toast(err.message || '操作失败', 'error');
        }
      });
    }
    for (const btn of listRoot.querySelectorAll('[data-del]')) {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.del;
        const user = all.find((u) => u.uid === uid);
        const yes = await confirmDialog({
          title: `删除用户「${user ? user.screenName : uid}」？`,
          desc: '将同时删除其本地归档记录，此操作不可恢复。',
          okText: '删除',
          danger: true,
        });
        if (!yes) return;
        try {
          const result = await api(`/api/users/${uid}?purge=1`, { method: 'DELETE' });
          toast(`已删除，清理 ${result.recordsRemoved} 条记录`, 'ok');
          const index = all.findIndex((u) => u.uid === uid);
          if (index >= 0) all.splice(index, 1);
          await refreshStatus();
          renderList();
        } catch (err) {
          toast(err.message || '删除失败', 'error');
        }
      });
    }
  }

  filterInput.addEventListener('input', () => {
    filter = filterInput.value;
    renderList();
  });
  starBtn.addEventListener('click', () => {
    starredOnly = !starredOnly;
    starBtn.classList.toggle('btn-primary', starredOnly);
    renderList();
  });

  const input = root.querySelector('#uInput');
  const addBtn = root.querySelector('#uAdd');
  const hint = root.querySelector('#uHint');
  const submit = async () => {
    const value = input.value.trim();
    if (!value) {
      hint.textContent = '请输入主页链接、昵称或 UID';
      return;
    }
    setBusy(addBtn, true, '添加中…');
    hint.textContent = '';
    try {
      const result = await api('/api/users', { method: 'POST', body: { input: value } });
      if (result.created) {
        all.push(result.user);
        toast(`已添加 ${result.user.screenName}`, 'ok');
      } else {
        toast('该用户已在库中（未产生重复记录）', 'warn');
      }
      input.value = '';
      await refreshStatus();
      renderList();
    } catch (err) {
      hint.textContent = err.message || '添加失败';
    } finally {
      setBusy(addBtn, false);
      addBtn.textContent = '添加';
    }
  };
  addBtn.addEventListener('click', () => {
    void submit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });

  renderList();
}

/* ------------------------------------------------------------------ *
 * 用户详情
 * ------------------------------------------------------------------ */

/** 用户详情页可切换的内容模式。 */
const USER_TABS = [
  { key: 'sent', label: '发出的评论' },
  { key: 'received', label: '收到的评论' },
  { key: 'mentions-comments', label: '被 @ 的评论' },
  { key: 'user-posts', label: '用户微博' },
  { key: 'mentions-posts', label: '被 @ 的微博' },
  { key: '', label: '全部' },
];

/**
 * 用户详情：互动分组 + 时间轴（gap）+ 报告 + 订阅入口。
 * @param {HTMLElement} root
 * @param {{params:string[]}} ctx
 */
export async function renderUserDetail(root, ctx) {
  const uid = ctx.params[0];
  const user = await api(`/api/users/${uid}`);
  const state = { mode: 'sent', page: 1, pageSize: 20, q: '' };

  const render = () => {
    root.innerHTML = `
      <div class="page-head">
        <div class="inline-list">
          ${avatarMarkup(user, true)}
          <div>
            <h2 class="page-title">${esc(user.screenName)}</h2>
            <div class="page-desc">
              UID <span class="mono">${esc(user.uid)}</span>
              ${user.starred ? '<span class="badge badge-warn">特别关注</span>' : ''}
              ${user.lastFetchedAtMs ? `· 最近取数 ${esc(fmtTime(user.lastFetchedAtMs))}` : '· 尚未取数'}
            </div>
          </div>
        </div>
        <div class="page-actions">
          <button class="btn" data-act="back">返回用户库</button>
          <button class="btn" data-act="star">${user.starred ? '取消特别关注' : '设为特别关注'}</button>
          <button class="btn" data-act="sub">创建订阅</button>
          <button class="btn btn-primary" data-act="report">生成报告</button>
        </div>
      </div>

      <div class="grid-4">
        ${statCard('本地记录', String(user.stats.recordCount), '含评论与微博')}
        ${statCard('未读', String(user.stats.unreadCount), '报告生成并确认后自动已读')}
        ${statCard('评论类', String((user.stats.byMode.sent || 0) + (user.stats.byMode.received || 0) + (user.stats.byMode['mentions-comments'] || 0)), `发出 ${user.stats.byMode.sent || 0} / 收到 ${user.stats.byMode.received || 0} / @ ${user.stats.byMode['mentions-comments'] || 0}`)}
        ${statCard('微博类', String((user.stats.byMode['user-posts'] || 0) + (user.stats.byMode['mentions-posts'] || 0)), '用户微博 + 被 @ 的微博')}
      </div>

      <div class="card">
        <div class="card-head">
          <div class="tabs" id="uTabs" style="margin:0">
            ${USER_TABS.map((tab) => `<button class="tab ${state.mode === tab.key ? 'active' : ''}" data-tab="${esc(tab.key)}" type="button">${esc(tab.label)}</button>`).join('')}
          </div>
          <div class="card-actions">
            <input class="input" id="uRecFilter" placeholder="按对方昵称 / UID 过滤"
                   style="width:200px" value="${esc(state.q)}">
            <button class="btn btn-sm" data-act="read-mode">把本组标记已读</button>
            <button class="btn btn-sm" data-act="fetch">取数</button>
          </div>
        </div>
        <div id="uBody"><div class="skeleton sk-card"></div></div>
      </div>
    `;

    root.querySelector('[data-act="back"]').addEventListener('click', () => navigate('/users'));
    root.querySelector('[data-act="fetch"]').addEventListener('click', () =>
      navigate(`/fetch?mode=${encodeURIComponent(state.mode || 'sent')}&ownerType=users&ownerId=${encodeURIComponent(uid)}&label=${encodeURIComponent(user.screenName)}`)
    );
    root.querySelector('[data-act="report"]').addEventListener('click', () => {
      reportDialog({ ownerType: 'users', ownerId: uid, label: user.screenName, onDone: reload });
    });
    root.querySelector('[data-act="sub"]').addEventListener('click', () => {
      navigate(`/subscriptions?ownerType=users&ownerId=${encodeURIComponent(uid)}`);
    });
    root.querySelector('[data-act="star"]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      try {
        const updated = await api(`/api/users/${uid}`, { method: 'PATCH', body: { starred: !user.starred } });
        user.starred = updated.starred;
        toast(updated.starred ? '已设为特别关注' : '已取消特别关注', 'ok');
        render();
      } catch (err) {
        toast(err.message || '操作失败', 'error');
        button.disabled = false;
      }
    });
    root.querySelector('[data-act="read-mode"]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      setBusy(button, true, '标记中…');
      try {
        const result = await api(`/api/owners/users/${uid}/read`, {
          method: 'POST',
          body: state.mode ? { mode: state.mode, all: true } : { all: true },
        });
        toast(`已标记 ${result.marked} 条为已读，剩余未读 ${result.unreadTotal} 条`, 'ok');
        await refreshStatus();
        await reload();
      } catch (err) {
        toast(err.message || '标记失败', 'error');
      } finally {
        setBusy(button, false);
        button.textContent = '把本组标记已读';
      }
    });

    for (const tab of root.querySelectorAll('[data-tab]')) {
      tab.addEventListener('click', () => {
        state.mode = tab.dataset.tab;
        state.page = 1;
        render();
      });
    }

    const filterEl = root.querySelector('#uRecFilter');
    if (filterEl) {
      let timer = null;
      filterEl.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.q = filterEl.value.trim();
          state.page = 1;
          void loadBody();
        }, 250);
      });
    }

    void loadBody();
  };

  /** 只刷新记录区（切换 tab / 分页 / 标记已读都走这里）。 */
  async function loadBody() {
    const bodyRoot = root.querySelector('#uBody');
    if (!bodyRoot) return;
    bodyRoot.innerHTML = '<div class="skeleton sk-card"></div>';
    const qs = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize) });
    if (state.mode) qs.set('mode', state.mode);
    if (state.q) qs.set('q', state.q);
    const data = await api(`/api/owners/users/${uid}/records?${qs.toString()}`);
    bodyRoot.innerHTML = renderBody(data);
    wireBody(data);
  }

  /** 记录区 HTML（时间轴 + gap + 记录卡 + 分页）。 */
  function renderBody(data) {
    const hasAny = data.total > 0 || (data.gaps || []).length > 0;
    if (!hasAny) {
      return emptyStateMarkup(
        '该分组还没有本地记录',
        '取数一次后即可离线检索与生成报告；也可以直接点右上角「取数」按 gap 区间补取。',
        `<button class="btn btn-primary" data-act="fetch-empty">去取数</button>`
      );
    }

    const timelineHtml = renderTimeline(data.timeline || [], data.gaps || []);
    const gapHtml = (data.gaps || []).length
      ? `<div class="gap-list">${data.gaps
          .slice(0, 12)
          .map(
            (gap) =>
              `<button class="gap-chip" type="button" data-gap-from="${esc(fmtDay(gap.startMs))}" data-gap-to="${esc(fmtDay(gap.endMs))}" data-gap-limit="${gap.limit}">待补 ${esc(gap.startDay)} ~ ${esc(gap.endDay)}（${gap.days} 天）</button>`
          )
          .join('')}</div>`
      : '<div class="tiny">当前区间没有空白日段。</div>';

    const recordsHtml = (data.items || []).length
      ? `<div class="rec-list">${data.items.map((record) => recordCard(record)).join('')}</div>`
      : emptyStateMarkup('该分组当前筛选下没有记录', '可切换分组或调整日期区间。');

    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

    return `
      <div class="card" style="box-shadow:none;border:none;padding:0;margin:0">
        <div class="card-sub" style="margin-bottom:6px">时间轴（蓝色为已存记录日，黄色斜纹为待补区间，点击可预填取数表单）</div>
        ${timelineHtml}
        ${gapHtml}
      </div>
      <div class="hr"></div>
      <div class="card-sub" style="margin-bottom:8px">共 ${data.total} 条 · 第 ${data.page} / ${totalPages} 页</div>
      ${recordsHtml}
      ${
        totalPages > 1
          ? `<div class="pager">
              <button class="btn btn-sm" data-page="prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
              <span>${data.page} / ${totalPages}</span>
              <button class="btn btn-sm" data-page="next" ${data.page >= totalPages ? 'disabled' : ''}>下一页</button>
            </div>`
          : ''
      }
    `;
  }

  /** 绑定记录区事件。 */
  function wireBody(data) {
    const bodyRoot = root.querySelector('#uBody');
    if (!bodyRoot) return;
    const fetchEmpty = bodyRoot.querySelector('[data-act="fetch-empty"]');
    if (fetchEmpty) {
      fetchEmpty.addEventListener('click', () =>
        navigate(`/fetch?mode=${encodeURIComponent(state.mode || 'sent')}&ownerType=users&ownerId=${encodeURIComponent(uid)}`)
      );
    }
    for (const chip of bodyRoot.querySelectorAll('[data-gap-from]')) {
      chip.addEventListener('click', () => {
        const qs = new URLSearchParams({
          mode: state.mode || 'sent',
          ownerType: 'users',
          ownerId: uid,
          from: chip.dataset.gapFrom,
          to: chip.dataset.gapTo,
          limit: chip.dataset.gapLimit,
        });
        navigate(`/fetch?${qs.toString()}`);
      });
    }
    for (const button of bodyRoot.querySelectorAll('[data-page]')) {
      button.addEventListener('click', () => {
        state.page += button.dataset.page === 'next' ? 1 : -1;
        void loadBody();
      });
    }
    for (const button of bodyRoot.querySelectorAll('[data-read-id]')) {
      button.addEventListener('click', async () => {
        const id = button.dataset.readId;
        setBusy(button, true, '…');
        try {
          const result = await api(`/api/owners/users/${uid}/read`, { method: 'POST', body: { ids: [id] } });
          toast(`已标记已读，剩余未读 ${result.unreadTotal} 条`, 'ok');
          await refreshStatus();
          await loadBody();
        } catch (err) {
          toast(err.message || '标记失败', 'error');
          setBusy(button, false);
        }
      });
    }
    const totalPages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 20)));
    if (state.page > totalPages) state.page = totalPages;
  }

  /** 重新拉取用户信息并整体渲染。 */
  async function reload() {
    const fresh = await api(`/api/users/${uid}`);
    Object.assign(user, fresh);
    render();
  }

  render();
}

/* ------------------------------------------------------------------ *
 * 博文库 / 博文详情
 * ------------------------------------------------------------------ */

/** @param {HTMLElement} root */
export async function renderPosts(root) {
  root.innerHTML = skeletonMarkup(3);
  const data = await api('/api/posts');
  let all = data.items || [];
  let filter = '';
  let favoriteOnly = false;
  let missingOnly = false;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 class="page-title">博文库</h2>
        <div class="page-desc">添加博文只创建记录，<b>不会自动取评论</b>（避免意外扣费）；评论需到取数页手动发起。</div>
      </div>
      <div class="page-actions">
        <input class="input" id="pFilter" placeholder="按正文 / 作者 / ID 过滤" style="width:220px">
        <button class="btn" id="pFav" type="button">只看收藏</button>
        <button class="btn" id="pMissing" type="button">正文缺失清单</button>
      </div>
    </div>

    <div class="card">
      <div class="form-row">
        <div class="field" style="flex:1 1 380px">
          <label for="pInput">添加博文</label>
          <input class="input" id="pInput" placeholder="粘贴详情页链接（支持 mblogid 短链）或微博 ID">
        </div>
        <button class="btn btn-primary" id="pAdd" type="button">添加</button>
      </div>
      <div class="form-hint" id="pHint"></div>
    </div>

    <div id="pMissingBox"></div>
    <div id="pList"></div>
  `;

  const listRoot = root.querySelector('#pList');
  const filterInput = root.querySelector('#pFilter');
  const favBtn = root.querySelector('#pFav');
  const missingBtn = root.querySelector('#pMissing');
  const missingBox = root.querySelector('#pMissingBox');

  /** 重新拉取博文列表并重绘（粘贴正文后需要刷新"缺失正文"清单与列表徽标）。 */
  async function reloadPosts() {
    try {
      const fresh = await api('/api/posts');
      all = fresh.items || [];
      renderList();
    } catch (e) {
      toast(e && e.message ? e.message : '刷新失败', 'warn');
    }
  }

  /** 正文缺失清单区块（P0-15：已知 ID 但正文缺失的记录单独列出，可单独补取）。 */
  function renderMissingBox() {
    const missing = all.filter((post) => !String(post.text || '').trim());
    if (missing.length === 0) {
      missingBox.innerHTML = '';
      return;
    }
    missingBox.innerHTML = `<div class="card">
      <div class="card-head">
        <h3 class="card-title">缺失正文（${missing.length}）</h3>
        <span class="badge badge-warn">不计入互动统计</span>
        <div class="card-sub" style="width:100%">
          以下博文仅知微博 ID、正文为空。<b>推荐直接「粘贴正文」</b>（从原微博页面复制，立即生效）。
          「补取评论」会预填「某条微博下的评论」模式——若接口响应里带回原微博对象，正文会自动回填；
          但接口未必返回该对象，此时仍需粘贴。
        </div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>微博 ID</th><th>作者</th><th class="num">已存评论</th><th style="width:200px">操作</th></tr></thead>
          <tbody>
            ${missing
              .map(
                (post) => `<tr>
                <td class="mono tiny">${esc(post.id)}</td>
                <td>${post.author ? esc(post.author) : '<span class="muted">未知</span>'}</td>
                <td class="num">${post.stats.recordCount > 0 ? post.stats.recordCount : '<span class="badge badge-warn">尚未获取评论</span>'}</td>
                <td><div class="inline-list">
                  <button class="btn btn-sm btn-primary" data-missing-paste="${esc(post.id)}">粘贴正文</button>
                  <button class="btn btn-sm" data-missing-fetch="${esc(post.id)}">补取评论</button>
                  <button class="btn btn-sm" data-detail="${esc(post.id)}">详情</button>
                </div></td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>`;
    for (const button of missingBox.querySelectorAll('[data-missing-paste]')) {
      button.addEventListener('click', async () => {
        const id = button.dataset.missingPaste;
        const post = all.find((item) => item.id === id);
        const saved = await pasteTextDialog({ id, author: post ? post.author : '' });
        if (saved) await reloadPosts();
      });
    }
    for (const button of missingBox.querySelectorAll('[data-missing-fetch]')) {
      button.addEventListener('click', () => {
        // 博文维度的取数只支持「某条微博下的评论」（comments/show/all）。
        // 该接口的响应可能带原微博对象，取评论时可顺带回填缺失正文；但不保证，
        // 因此这只是「顺手尝试」，正文为空时仍应引导用户粘贴。
        const id = button.dataset.missingFetch;
        const qs = new URLSearchParams({ mode: 'post-comments', ownerType: 'posts', ownerId: id });
        navigate(`/fetch?${qs.toString()}`);
      });
    }
    for (const button of missingBox.querySelectorAll('[data-detail]')) {
      button.addEventListener('click', () => navigate(`/posts/${button.dataset.detail}`));
    }
  }

  function renderList() {
    renderMissingBox();
    const keyword = filter.trim().toLowerCase();
    const items = all.filter((post) => {
      if (favoriteOnly && !post.favorite) return false;
      if (missingOnly && String(post.text || '').trim()) return false;
      if (!keyword) return true;
      return (
        String(post.text || '').toLowerCase().includes(keyword) ||
        String(post.author || '').toLowerCase().includes(keyword) ||
        String(post.id).includes(keyword)
      );
    });

    if (all.length === 0) {
      listRoot.innerHTML = emptyStateMarkup(
        '还没有归档任何博文',
        '① 粘贴博文详情页链接添加；② 添加后到取数页选择「某条微博下的评论」再取评论。',
        '<button class="btn btn-primary" id="pDemo">载入演示数据</button>'
      );
      const demoBtn = listRoot.querySelector('#pDemo');
      if (demoBtn) {
        demoBtn.addEventListener('click', async () => {
          setBusy(demoBtn, true, '载入中…');
          try {
            await api('/api/demo/seed', { method: 'POST', body: { reset: true } });
            toast('演示数据已载入', 'ok');
            await refreshStatus();
            await renderPosts(root);
          } catch (err) {
            toast(err.message || '载入失败', 'error');
            setBusy(demoBtn, false);
          }
        });
      }
      return;
    }
    if (items.length === 0) {
      listRoot.innerHTML = emptyStateMarkup(
        missingOnly ? '没有正文缺失的博文' : '没有匹配的博文',
        missingOnly ? '所有博文的正文都已补齐。' : '试试清空过滤条件。'
      );
      return;
    }

    listRoot.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th style="width:34px"></th><th>作者</th><th>正文摘要</th><th>发布时间</th><th class="num">已存评论</th><th class="num">未读</th><th style="width:170px">操作</th></tr></thead>
      <tbody>
        ${items
          .map(
            (post) => `<tr data-id="${esc(post.id)}">
            <td><button class="star-btn ${post.favorite ? 'on' : ''}" data-fav="${esc(post.id)}" title="收藏">${post.favorite ? '★' : '☆'}</button></td>
            <td class="nowrap">${esc(post.author || '未知')}<div class="tiny mono">${esc(post.id)}</div></td>
            <td>${post.text ? esc(post.text.slice(0, 90)) : '<span class="muted">（正文缺失，仅知 ID）</span>'}${
              String(post.text || '').trim() ? '' : '<div><span class="badge badge-danger">正文缺失</span></div>'
            }</td>            <td class="tiny nowrap">${post.createdAtMs ? esc(fmtTime(post.createdAtMs)) : '—'}</td>
            <td class="num">${post.stats.recordCount > 0 ? post.stats.recordCount : '<span class="badge badge-warn">尚未获取评论</span>'}</td>
            <td class="num">${post.stats.unreadCount > 0 ? `<span class="unread-dot"></span>${post.stats.unreadCount}` : '0'}</td>
            <td><div class="inline-list">
              <button class="btn btn-sm" data-detail="${esc(post.id)}">详情</button>
              <button class="btn btn-sm" data-fetch="${esc(post.id)}">取评论</button>
              <button class="btn btn-sm btn-danger" data-del="${esc(post.id)}">删除</button>
            </div></td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table></div>`;

    for (const btn of listRoot.querySelectorAll('[data-detail]')) {
      btn.addEventListener('click', () => navigate(`/posts/${btn.dataset.detail}`));
    }
    for (const btn of listRoot.querySelectorAll('[data-fetch]')) {
      btn.addEventListener('click', () =>
        navigate(`/fetch?mode=post-comments&ownerType=posts&ownerId=${encodeURIComponent(btn.dataset.fetch)}`)
      );
    }
    for (const btn of listRoot.querySelectorAll('[data-fav]')) {
      btn.addEventListener('click', async () => {
        const post = all.find((p) => p.id === btn.dataset.fav);
        if (!post) return;
        try {
          const updated = await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { favorite: !post.favorite } });
          post.favorite = updated.favorite;
          renderList();
        } catch (err) {
          toast(err.message || '操作失败', 'error');
        }
      });
    }
    for (const btn of listRoot.querySelectorAll('[data-del]')) {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.del;
        const yes = await confirmDialog({
          title: `删除博文 ${id}？`,
          desc: '将同时删除其本地归档的评论记录，此操作不可恢复。',
          okText: '删除',
          danger: true,
        });
        if (!yes) return;
        try {
          const result = await api(`/api/posts/${id}?purge=1`, { method: 'DELETE' });
          toast(`已删除，清理 ${result.recordsRemoved} 条评论`, 'ok');
          const index = all.findIndex((p) => p.id === id);
          if (index >= 0) all.splice(index, 1);
          await refreshStatus();
          renderList();
        } catch (err) {
          toast(err.message || '删除失败', 'error');
        }
      });
    }
  }

  filterInput.addEventListener('input', () => {
    filter = filterInput.value;
    renderList();
  });
  favBtn.addEventListener('click', () => {
    favoriteOnly = !favoriteOnly;
    favBtn.classList.toggle('btn-primary', favoriteOnly);
    renderList();
  });
  missingBtn.addEventListener('click', () => {
    missingOnly = !missingOnly;
    missingBtn.classList.toggle('btn-primary', missingOnly);
    renderList();
    if (missingOnly) missingBox.scrollIntoView({ block: 'nearest' });
  });

  const input = root.querySelector('#pInput');
  const addBtn = root.querySelector('#pAdd');
  const hint = root.querySelector('#pHint');
  const submit = async () => {
    const value = input.value.trim();
    if (!value) {
      hint.textContent = '请输入详情页链接或微博 ID';
      return;
    }
    setBusy(addBtn, true, '添加中…');
    hint.textContent = '';
    try {
      const result = await api('/api/posts', { method: 'POST', body: { input: value } });
      if (result.created) {
        all.unshift(result.post);
        toast('已添加博文（未自动取评论）', 'ok');
      } else {
        toast('该博文已在库中', 'warn');
      }
      input.value = '';
      await refreshStatus();
      renderList();
    } catch (err) {
      hint.textContent = err.message || '添加失败';
    } finally {
      setBusy(addBtn, false);
      addBtn.textContent = '添加';
    }
  };
  addBtn.addEventListener('click', () => {
    void submit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });

  renderList();
}

/**
 * 博文详情：评论列表 + 报告 + 缺失正文提示。
 * @param {HTMLElement} root
 * @param {{params:string[]}} ctx
 */
export async function renderPostDetail(root, ctx) {
  const id = ctx.params[0];
  const payload = await api(`/api/posts/${id}`);
  const post = payload.post;
  const state = { page: 1, pageSize: 20 };

  const render = () => {
    root.innerHTML = `
      <div class="page-head">
        <div>
          <h2 class="page-title">博文 ${esc(post.id)}</h2>
          <div class="page-desc">
            ${post.author ? `作者 ${esc(post.author)}` : '作者未知'} ·
            ${post.createdAtMs ? esc(fmtTime(post.createdAtMs)) : '发布时间未知'}
            ${post.favorite ? '<span class="badge badge-warn">已收藏</span>' : ''}
            ${payload.missingText ? '<span class="badge badge-danger">正文缺失</span>' : ''}
          </div>
        </div>
        <div class="page-actions">
          <button class="btn" data-act="back">返回博文库</button>
          <button class="btn" data-act="fav">${post.favorite ? '取消收藏' : '收藏'}</button>
          <button class="btn" data-act="sub">创建订阅</button>
          <button class="btn btn-primary" data-act="report">生成报告</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3 class="card-title">原博文</h3>
          <div class="card-actions">
            ${post.sourceUrl ? `<a class="btn btn-sm" href="${esc(post.sourceUrl)}" target="_blank" rel="noopener noreferrer">打开原链接</a>` : ''}
          </div>
        </div>
        ${
          payload.missingText
            ? `<div class="notice">正文缺失：仅知微博 ID，正文尚未落库。<b>补取前该条不计入互动统计。</b>
                <div class="inline-list" style="margin-top:8px">
                  <button class="btn btn-sm btn-primary" type="button" data-act="paste-text">粘贴正文</button>
                  <button class="btn btn-sm" type="button" data-act="fetch-text">去取评论（可能回填）</button>
                </div>
                <div class="form-hint">
                  推荐用「粘贴正文」：从原微博页面复制内容，保存后立即生效。
                  「去取评论」会预填「某条微博下的评论」模式，若接口响应带回原微博对象可自动回填，但不保证。
                </div>
              </div>`
            : `<div class="rec-body">${esc(post.text)}</div>${
                post.textTruncated ? '<div class="form-hint">正文超长，已截断到 2000 字符；完整内容请打开原链接。</div>' : ''
              }`
        }
      </div>

      <div class="grid-4">
        ${statCard('已存评论', String(post.stats.recordCount), post.stats.recordCount === 0 ? '尚未获取评论' : '博文评论模式')}
        ${statCard('未读', String(post.stats.unreadCount), '生成报告后可自动已读')}
        ${statCard('最近取数', post.lastFetchedAtMs ? fmtRelative(post.lastFetchedAtMs) : '尚未取数', '')}
        ${statCard('添加时间', fmtTime(post.addedAtMs), '')}
      </div>

      <div class="card">
        <div class="card-head">
          <h3 class="card-title">评论记录</h3>
          <div class="card-actions">
            <button class="btn btn-sm" data-act="read-all">全部标记已读</button>
            <button class="btn btn-sm" data-act="fetch">去取评论</button>
          </div>
        </div>
        <div id="pBody"><div class="skeleton sk-card"></div></div>
      </div>
    `;

    root.querySelector('[data-act="back"]').addEventListener('click', () => navigate('/posts'));
    const pasteBtn = root.querySelector('[data-act="paste-text"]');
    if (pasteBtn) {
      pasteBtn.addEventListener('click', async () => {
        const saved = await pasteTextDialog({ id, author: post.author });
        // 保存成功后整页重渲染：徽标消失、正文正常显示
        if (saved) await renderPostDetail(root, { params: [id] });
      });
    }
    const fetchTextBtn = root.querySelector('[data-act="fetch-text"]');
    if (fetchTextBtn) {
      fetchTextBtn.addEventListener('click', () => {
        // 博文维度只有「某条微博下的评论」这一种取数模式；响应内可能带原微博对象，
        // 取评论时或可顺带回填正文，但不保证——所以这只是尽力而为的辅助路径。
        const qs = new URLSearchParams({ mode: 'post-comments', ownerType: 'posts', ownerId: id });
        navigate(`/fetch?${qs.toString()}`);
      });
    }
    root.querySelector('[data-act="fetch"]').addEventListener('click', () =>
      navigate(`/fetch?mode=post-comments&ownerType=posts&ownerId=${encodeURIComponent(id)}`)
    );
    root.querySelector('[data-act="report"]').addEventListener('click', () =>
      reportDialog({ ownerType: 'posts', ownerId: id, label: `博文 ${id}`, onDone: loadBody })
    );
    root.querySelector('[data-act="sub"]').addEventListener('click', () =>
      navigate(`/subscriptions?ownerType=posts&ownerId=${encodeURIComponent(id)}`)
    );
    root.querySelector('[data-act="fav"]').addEventListener('click', async () => {
      try {
        const updated = await api(`/api/posts/${id}`, { method: 'PATCH', body: { favorite: !post.favorite } });
        post.favorite = updated.favorite;
        toast(updated.favorite ? '已收藏' : '已取消收藏', 'ok');
        render();
      } catch (err) {
        toast(err.message || '操作失败', 'error');
      }
    });
    root.querySelector('[data-act="read-all"]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      setBusy(button, true, '标记中…');
      try {
        const result = await api(`/api/owners/posts/${id}/read`, { method: 'POST', body: { all: true } });
        toast(`已标记 ${result.marked} 条，剩余未读 ${result.unreadTotal} 条`, 'ok');
        await refreshStatus();
        await loadBody();
      } catch (err) {
        toast(err.message || '标记失败', 'error');
      } finally {
        setBusy(button, false);
        button.textContent = '全部标记已读';
      }
    });

    void loadBody();
  };

  async function loadBody() {
    const bodyRoot = root.querySelector('#pBody');
    if (!bodyRoot) return;
    bodyRoot.innerHTML = '<div class="skeleton sk-card"></div>';
    const qs = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize), mode: 'post-comments' });
    const data = await api(`/api/owners/posts/${id}/records?${qs.toString()}`);
    if (!data.items.length) {
      bodyRoot.innerHTML = emptyStateMarkup(
        '尚未获取评论',
        '添加博文不会自动取评论。点「去取评论」选择条数与日期范围后开始取数。',
        `<button class="btn btn-primary" data-act="fetch-empty">去取评论</button>`
      );
      const btn = bodyRoot.querySelector('[data-act="fetch-empty"]');
      if (btn) {
        btn.addEventListener('click', () =>
          navigate(`/fetch?mode=post-comments&ownerType=posts&ownerId=${encodeURIComponent(id)}`)
        );
      }
      return;
    }
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    bodyRoot.innerHTML = `
      <div class="card-sub" style="margin-bottom:8px">共 ${data.total} 条 · 第 ${data.page} / ${totalPages} 页</div>
      <div class="rec-list">${data.items.map((record) => recordCard(record)).join('')}</div>
      ${
        totalPages > 1
          ? `<div class="pager">
              <button class="btn btn-sm" data-page="prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
              <span>${data.page} / ${totalPages}</span>
              <button class="btn btn-sm" data-page="next" ${data.page >= totalPages ? 'disabled' : ''}>下一页</button>
            </div>`
          : ''
      }
    `;
    for (const button of bodyRoot.querySelectorAll('[data-page]')) {
      button.addEventListener('click', () => {
        state.page += button.dataset.page === 'next' ? 1 : -1;
        void loadBody();
      });
    }
    for (const button of bodyRoot.querySelectorAll('[data-read-id]')) {
      button.addEventListener('click', async () => {
        setBusy(button, true, '…');
        try {
          const result = await api(`/api/owners/posts/${id}/read`, {
            method: 'POST',
            body: { ids: [button.dataset.readId] },
          });
          toast(`已标记已读，剩余未读 ${result.unreadTotal} 条`, 'ok');
          await refreshStatus();
          await loadBody();
        } catch (err) {
          toast(err.message || '标记失败', 'error');
          setBusy(button, false);
        }
      });
    }
  }

  render();
}

/* ------------------------------------------------------------------ *
 * 记录卡 / 时间轴
 * ------------------------------------------------------------------ */

/** 展示「对方」：优先显示昵称 + UID，可点击进主页。 */
function uidLink(uid, name) {
  const u = String(uid || '');
  if (!u) return esc(name || '未知');
  const label = name ? `@${esc(name)}` : `UID ${esc(u)}`;
  return `<a href="https://weibo.com/u/${encodeURIComponent(u)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    + ` <span class="mono">UID ${esc(u)}</span>`;
}

/** 记录上下文：发给谁 / 来自谁 / 谁 @ 的。 */
function recordContext(record) {
  const dir = record.direction || '';
  if (dir === 'sent') {
    return record.postAuthorUid
      ? `→ 发给 ${uidLink(record.postAuthorUid, record.postAuthor)}`
      : '→ 发出的评论';
  }
  if (dir === 'received') return `← 收到 ${uidLink(record.authorUid, record.author)}`;
  if (dir === 'mention') return `@ 来自 ${uidLink(record.authorUid, record.author)} 的提及`;
  if (dir === 'commenter') return `← 来自 ${uidLink(record.authorUid, record.author)}`;
  if (dir === 'self') return '';

  // 兼容旧记录（没有 direction 字段）
  const mode = record.mode || record.group;
  if (mode === 'sent') return '→ 发出的评论';
  if (mode === 'received') return `← 收到 ${uidLink(record.authorUid, record.author)}`;
  if (mode === 'mentions-comments' || mode === 'mentions-posts') {
    return `@ 来自 ${uidLink(record.authorUid, record.author)} 的提及`;
  }
  if (mode === 'post-comments') return `← 来自 ${uidLink(record.authorUid, record.author)}`;
  return '';
}

/** 单条记录卡。 */
function recordCard(record) {
  const pics = record.pictures && Array.isArray(record.pictures.items) ? record.pictures.items.length : 0;
  const postUrl = record.postUrl && /^https?:\/\//i.test(record.postUrl) ? record.postUrl : '';
  const ctx = recordContext(record);
  return `<article class="rec ${record.isUnread ? 'unread' : ''}">
    <div class="rec-head">
      ${record.isUnread ? '<span class="unread-dot"></span>' : ''}
      <span class="rec-author">${esc(record.author || '未知作者')}</span>
      ${record.authorUid ? `<span class="badge">UID ${esc(record.authorUid)}</span>` : ''}
      <span class="rec-time">${esc(record.time || fmtTime(record.ms))}</span>
      <span class="badge badge-primary">${esc(record.type || record.mode || '')}</span>
      ${record.textTruncated ? '<span class="badge">已截断</span>' : ''}
      ${
        record.isUnread
          ? `<span class="rec-actions"><button class="btn btn-sm" type="button" data-read-id="${esc(record.recordId)}">标记已读</button></span>`
          : ''
      }
    </div>
    ${ctx ? `<div class="rec-context">${ctx}</div>` : ''}
    <div class="rec-body">${esc(record.text || '（无正文）')}</div>
    <div class="rec-foot">
      ${pics ? `<span>配图 ${pics} 张</span>` : ''}
      ${record.likes !== undefined ? `<span>赞 ${record.likes}</span>` : ''}
      ${postUrl ? `<a href="${esc(postUrl)}" target="_blank" rel="noopener noreferrer">查看原微博</a>` : record.postId ? `<span>原微博 ${esc(record.postId)}</span>` : ''}
    </div>
  </article>`;
}

/**
 * 时间轴条：蓝条=有记录的日子，黄色斜纹=待补日子。
 * @param {Array<{day:string,count:number,unread:number,ms:number}>} timeline
 * @param {Array<{startMs:number,endMs:number,startDay:string,endDay:string}>} gaps
 */
function renderTimeline(timeline, gaps) {
  /** @type {Map<string,{day:string,count:number,unread:number,ms:number,gap:boolean}>} */
  const map = new Map();
  for (const point of timeline) {
    map.set(point.day, { ...point, gap: false });
  }
  for (const gap of gaps) {
    let cursor = gap.startMs;
    let guard = 0;
    while (cursor <= gap.endMs && guard < 400) {
      guard += 1;
      const day = fmtDay(cursor);
      if (!map.has(day)) map.set(day, { day, count: 0, unread: 0, ms: cursor, gap: true });
      const next = new Date(cursor);
      next.setDate(next.getDate() + 1);
      cursor = next.getTime();
    }
  }
  const days = [...map.values()].sort((a, b) => a.ms - b.ms);
  if (days.length === 0) return '<div class="tiny">暂无时间轴数据。</div>';

  const visible = days.slice(-120);
  const max = visible.reduce((acc, day) => Math.max(acc, day.count), 1);
  const bars = visible
    .map((day) => {
      const height = day.gap ? 10 : Math.max(3, Math.round((day.count / max) * 52));
      const title = day.gap ? `${day.day} · 待补` : `${day.day} · ${day.count} 条${day.unread ? `（未读 ${day.unread}）` : ''}`;
      return `<div class="tl-day ${day.gap ? 'is-gap' : ''}" title="${esc(title)}">
        <div class="tl-bar" style="height:${height}px"></div>
        <div class="tl-label">${esc(day.day.slice(5))}</div>
      </div>`;
    })
    .join('');

  return `<div class="timeline">${bars}</div>${
    days.length > visible.length ? `<div class="tiny">仅显示最近 ${visible.length} 天（共 ${days.length} 天）</div>` : ''
  }`;
}

/* ------------------------------------------------------------------ *
 * 报告弹窗（两段式已读）
 * ------------------------------------------------------------------ */

/**
 * 生成报告弹窗：生成 → 前端确认能取到 200 → 才提交已读（P0-25）。
 * @param {{ownerType:string,ownerId:string,label:string,onDone?:()=>void}} options
 */
export function reportDialog(options) {
  const mask = html(`<div class="modal-mask">
    <div class="modal" style="max-width:520px">
      <h3>生成离线 HTML 报告</h3>
      <div class="modal-desc">${esc(options.label)} · 报告写入本地 <code class="mono">data/reports/</code>，可离线打开或邮件转发；每位对象只保留最新 1 份。</div>
      <div class="form-row">
        <div class="field w-md">
          <label for="rpLimit">条数上限</label>
          <input class="input" id="rpLimit" type="number" min="1" max="5000" value="500">
        </div>
        <div class="field">
          <label for="rpFrom">起始日期（可选）</label>
          <input class="input" id="rpFrom" type="date">
        </div>
        <div class="field">
          <label for="rpTo">结束日期（可选，含当天）</label>
          <input class="input" id="rpTo" type="date">
        </div>
      </div>
      <div id="rpResult" class="form-hint"></div>
      <div class="modal-actions">
        <button class="btn" type="button" data-act="close">关闭</button>
        <button class="btn btn-primary" type="button" data-act="gen">生成报告</button>
      </div>
    </div>
  </div>`);

  const resultBox = mask.querySelector('#rpResult');
  const genBtn = mask.querySelector('[data-act="gen"]');
  const close = () => mask.remove();

  mask.addEventListener('click', (event) => {
    const act = event.target.closest('[data-act]');
    if (act && act.dataset.act === 'close') close();
    if (event.target === mask) close();
  });

  genBtn.addEventListener('click', async () => {
    const limit = Number(mask.querySelector('#rpLimit').value) || 500;
    const from = mask.querySelector('#rpFrom').value;
    const to = mask.querySelector('#rpTo').value;
    if (from && to && from > to) {
      resultBox.innerHTML = '<span class="form-error">起始日期不能晚于结束日期</span>';
      return;
    }
    setBusy(genBtn, true, '生成中…');
    resultBox.textContent = '';
    try {
      const report = await api('/api/reports', {
        method: 'POST',
        body: {
          ownerType: options.ownerType,
          ownerId: options.ownerId,
          limit,
          fromMs: from || undefined,
          toMs: to || undefined,
        },
      });

      // 两段式：先确认浏览器能取到报告（200），再提交已读
      let fetchedOk = false;
      try {
        const check = await fetch(report.url, { cache: 'no-store' });
        fetchedOk = check.ok;
      } catch {
        fetchedOk = false;
      }

      if (fetchedOk) {
        window.open(report.url, '_blank', 'noopener');
        try {
          const marked = await api(`/api/reports/${report.reportKey}/read`, {
            method: 'POST',
            body: { ids: report.pendingReadIds },
          });
          resultBox.innerHTML = `<span style="color:var(--ok)">报告已生成并打开：${report.recordCount} 条记录，${marked.marked} 条未读已标记为已读。</span>`;
        } catch (err) {
          resultBox.innerHTML = `<span class="form-error">报告已生成，但已读状态未更新（${esc(
            err.message || '回调失败'
          )}），记录保持未读，可稍后重试。</span>`;
        }
      } else {
        resultBox.innerHTML = `<span class="form-error">报告已生成，但无法从本地服务取回（已读状态保持未读）。</span>`;
      }

      resultBox.innerHTML += `<div style="margin-top:10px">
        <div class="tiny">文件路径：<span class="mono">${esc(report.path)}</span></div>
        <div class="inline-list" style="margin-top:8px">
          <a class="btn btn-sm" href="${esc(report.url)}" target="_blank" rel="noopener noreferrer">再次打开报告</a>
          <button class="btn btn-sm" type="button" data-act="copy">复制路径</button>
          <button class="btn btn-sm" type="button" data-act="open">用系统浏览器打开</button>
        </div>
      </div>`;

      resultBox.querySelector('[data-act="copy"]').addEventListener('click', () => copyText(report.path, '路径已复制'));
      resultBox.querySelector('[data-act="open"]').addEventListener('click', async () => {
        try {
          await api(`/api/reports/${report.reportKey}/open`, { method: 'POST' });
          toast('已请求系统浏览器打开', 'ok');
        } catch (err) {
          toast(err.message || '打开失败', 'error');
        }
      });

      await refreshStatus();
      if (typeof options.onDone === 'function') options.onDone();
    } catch (err) {
      resultBox.innerHTML = `<span class="form-error">${esc(err.message || '生成失败')}</span>`;
    } finally {
      setBusy(genBtn, false);
      genBtn.textContent = '生成报告';
    }
  });

  document.getElementById('modalRoot').appendChild(mask);
}

/** 供其他视图复用（博文详情里误写的字段兜底）。 */
export function noop() {}
