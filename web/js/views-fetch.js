/**
 * @file 取数页：7 模式表单联动、credits 预估（复用 X / 新增 Y）、任务面板 1s 轮询、
 *       日志滚动、停止按钮、额度不足拦截。
 * @module web/js/views-fetch
 */

import { api, esc, fmtNum, navigate, numOrNull, refreshStatus, setBusy, toast } from './api.js';

/** 模式元数据（与 server/config.js 的 7 种模式一一对应）。 */
const MODE_META = [
  { key: 'both', label: '发出和收到的评论', ownerKind: 'user' },
  { key: 'sent', label: '发出的评论', ownerKind: 'user' },
  { key: 'received', label: '收到的评论', ownerKind: 'user' },
  { key: 'mentions-comments', label: '被 @ 的评论', ownerKind: 'user' },
  { key: 'mentions-posts', label: '被 @ 的微博', ownerKind: 'user' },
  { key: 'user-posts', label: '用户微博', ownerKind: 'user' },
  { key: 'post-comments', label: '某条微博下的评论', ownerKind: 'post' },
];

/** 模式说明（表单下的提示）。 */
const MODE_HINT = {
  both: '时间线接口，一次拿到「发出 + 收到」的评论；由微博侧决定排序。',
  sent: '我发出的评论（by_me）。适合归档自己的互动痕迹。',
  received: '别人对我微博的评论（to_me）。适合做未读检视。',
  'mentions-comments': '评论里 @ 我的内容。',
  'mentions-posts': '微博正文里 @ 我的内容（会落正文，超长截断到 2000 字）。',
  'user-posts': '该用户自己发的微博。若 user_timeline/biz 不可用会自动回退到 other 接口并在日志中提示。',
  'post-comments': '某条微博下的全部评论（需要博文已在博文库中）。',
};

const state = {
  mode: 'sent',
  ownerType: 'users',
  ownerId: '',
  limit: 500,
  from: '',
  to: '',
  cursor: 'incremental',
  plan: null,
  taskId: null,
  timer: null,
  owners: [],
};

/** 停止轮询。 */
function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** 计算客户端日期错误文案。 */
function dateError() {
  if (state.from && state.to && state.from > state.to) return '起始日期不能晚于结束日期';
  return '';
}

/**
 * 取数页。
 * @param {HTMLElement} root
 * @param {{query:URLSearchParams}} ctx
 */
export async function renderFetch(root, ctx) {
  stopPolling();

  // 1) 从 query 预填（gap 区块、列表页「取数」按钮会带参数）
  const query = (ctx && ctx.query) || new URLSearchParams();
  const qMode = query.get('mode');
  if (qMode && MODE_META.some((m) => m.key === qMode)) state.mode = qMode;
  const qOwnerType = query.get('ownerType');
  if (qOwnerType === 'posts' || qOwnerType === 'users') state.ownerType = qOwnerType;
  state.ownerType = MODE_META.find((m) => m.key === state.mode).ownerKind === 'post' ? 'posts' : 'users';
  state.ownerId = query.get('ownerId') || '';
  state.from = query.get('from') || '';
  state.to = query.get('to') || '';
  const qLimit = Number(query.get('limit'));
  if (Number.isFinite(qLimit) && qLimit > 0) state.limit = Math.min(5000, Math.round(qLimit));
  state.plan = null;
  state.taskId = null;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 class="page-title">获取数据</h2>
        <div class="page-desc">开始前会先预检接口参数并给出 credits 预估；本地已存的记录复用时 <b>不计费</b>。</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-go="#/users">用户库</button>
        <button class="btn" data-go="#/posts">博文库</button>
        <button class="btn" data-go="#/search">去搜索</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3 class="card-title">1 · 选择内容与对象</h3></div>
      <div class="form-row">
        <div class="field w-md">
          <label for="fMode">内容模式</label>
          <select class="select" id="fMode">
            ${MODE_META.map((m) => `<option value="${esc(m.key)}" ${state.mode === m.key ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="flex:1 1 280px">
          <label for="fOwner" id="fOwnerLabel">对象</label>
          <select class="select" id="fOwner"></select>
        </div>
        <div class="field w-sm">
          <label for="fLimit">条数上限</label>
          <input class="input" id="fLimit" type="number" min="1" max="5000" step="1" value="${state.limit}">
        </div>
      </div>
      <div class="form-hint" id="fModeHint">${esc(MODE_HINT[state.mode] || '')}</div>
    </div>

    <div class="card">
      <div class="card-head"><h3 class="card-title">2 · 范围与方式</h3></div>
      <div class="form-row">
        <div class="field w-md">
          <label for="fFrom">起始日期（可选）</label>
          <input class="input" id="fFrom" type="date" value="${esc(state.from)}">
        </div>
        <div class="field w-md">
          <label for="fTo">结束日期（可选，含当天）</label>
          <input class="input" id="fTo" type="date" value="${esc(state.to)}">
        </div>
        <div class="field w-md">
          <label>取数方式</label>
          <div class="radio-group">
            <label><input type="radio" name="fCursor" value="incremental" ${state.cursor === 'incremental' ? 'checked' : ''}><span>增量更新</span></label>
            <label><input type="radio" name="fCursor" value="history" ${state.cursor === 'history' ? 'checked' : ''}><span>历史分页</span></label>
          </div>
        </div>
        <div class="field w-md">
          <label>&nbsp;</label>
          <div class="inline-list">
            <button class="btn" id="fPlan" type="button">预估</button>
            <button class="btn btn-primary" id="fStart" type="button" disabled>开始读取</button>
          </div>
        </div>
      </div>
      <div class="form-hint" id="fRangeHint">增量：从本地已有最新一条往后拉；历史：向更早翻页（max_id 递减）。</div>
      <div id="fDateError"></div>
      <div id="fPlanBox"></div>
    </div>

    <div id="fTaskBox"></div>
  `;

  for (const button of root.querySelectorAll('[data-go]')) {
    button.addEventListener('click', () => navigate(button.dataset.go));
  }

  const modeSelect = root.querySelector('#fMode');
  const ownerSelect = root.querySelector('#fOwner');
  const ownerLabel = root.querySelector('#fOwnerLabel');
  const limitInput = root.querySelector('#fLimit');
  const fromInput = root.querySelector('#fFrom');
  const toInput = root.querySelector('#fTo');
  const planBtn = root.querySelector('#fPlan');
  const startBtn = root.querySelector('#fStart');
  const planBox = root.querySelector('#fPlanBox');
  const dateErrorBox = root.querySelector('#fDateError');
  const modeHint = root.querySelector('#fModeHint');
  const taskBox = root.querySelector('#fTaskBox');

  /** 按当前模式加载对象下拉。 */
  async function loadOwners() {
    const meta = MODE_META.find((m) => m.key === state.mode);
    state.ownerType = meta.ownerKind === 'post' ? 'posts' : 'users';
    ownerLabel.textContent = state.ownerType === 'users' ? '用户' : '博文';
    modeHint.textContent = MODE_HINT[state.mode] || '';
    ownerSelect.innerHTML = '<option value="">加载中…</option>';
    try {
      if (state.ownerType === 'users') {
        const data = await api('/api/users');
        state.owners = data.items.map((user) => ({
          id: user.uid,
          label: `${user.screenName}（UID ${user.uid}）· ${user.stats.recordCount} 条`,
        }));
      } else {
        const data = await api('/api/posts');
        state.owners = data.items.map((post) => ({
          id: post.id,
          label: `${post.id} · ${(post.text || '（正文缺失）').slice(0, 30)} · ${post.stats.recordCount} 条评论`,
        }));
      }
    } catch (err) {
      state.owners = [];
      ownerSelect.innerHTML = '<option value="">加载失败</option>';
      toast(err.message || '对象列表加载失败', 'error');
      return;
    }
    if (state.owners.length === 0) {
      ownerSelect.innerHTML = `<option value="">${
        state.ownerType === 'users' ? '用户库为空，请先去用户库添加' : '博文库为空，请先去博文库添加'
      }</option>`;
      state.ownerId = '';
      updateStartState();
      return;
    }
    if (!state.ownerId || !state.owners.some((o) => o.id === state.ownerId)) {
      state.ownerId = state.owners[0].id;
    }
    ownerSelect.innerHTML = state.owners
      .map((owner) => `<option value="${esc(owner.id)}" ${owner.id === state.ownerId ? 'selected' : ''}>${esc(owner.label)}</option>`)
      .join('');
    void autoPlan();
  }

  /** 读取当前表单值到 state。 */
  function readForm() {
    state.limit = Math.max(1, Math.min(5000, Number(limitInput.value) || 500));
    state.from = fromInput.value;
    state.to = toInput.value;
    const checked = root.querySelector('input[name="fCursor"]:checked');
    state.cursor = checked ? checked.value : 'incremental';
  }

  /** 更新开始按钮可用性。 */
  function updateStartState() {
    const blocked = state.plan && state.plan.blocked;
    const hasOwner = Boolean(state.ownerId);
    const invalidDate = Boolean(dateError());
    startBtn.disabled = !hasOwner || invalidDate || Boolean(blocked) || Boolean(state.timer);
  }

  /** 渲染预估结果。 */
  function renderPlan() {
    const plan = state.plan;
    if (!plan) {
      planBox.innerHTML = '<div class="form-hint">点「预估」查看单价、预计条数与 credits 消耗。</div>';
      updateStartState();
      return;
    }
    const priceSourceText = plan.priceSource === 'api' ? '接口实时价' : '内置估算价';
    // 不伪造「新增」精度：后端给两个明确口径 ——
    // reusedLocal（区间内本地已有条数，可能被复用不复计费）与
    // newEstimateUpperBound（本轮最多新拉取条数，是上限而非精确值）。
    const reuseCount = Number(plan.reusedLocal) || 0;
    const upperBound = numOrNull(plan.newEstimateUpperBound);
    const blocked = plan.blocked;
    const balance = numOrNull(plan.balance);
    const diff = balance !== null ? Math.max(0, plan.estimateCredits - balance) : 0;

    planBox.innerHTML = `
      <div class="hr"></div>
      <div class="grid-4" style="margin-bottom:10px">
        <div class="stat-card">
          <div class="stat-label">单价</div>
          <div class="stat-value">${fmtNum(plan.unitPrice)}</div>
          <div class="stat-hint">credits / 条 · ${esc(priceSourceText)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">预估消耗</div>
          <div class="stat-value">${fmtNum(plan.estimateCredits)}</div>
          <div class="stat-hint">按最多 ${plan.willFetch} 条保守估算</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">本地已有 / 本轮最多新增</div>
          <div class="stat-value">${reuseCount} / ${upperBound === null ? '—' : fmtNum(upperBound, 0)}</div>
          <div class="stat-hint">区间内已有 ${reuseCount} 条可能复用 · 最多新增 ${upperBound === null ? '—' : fmtNum(upperBound, 0)} 条（上限）</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">当前余额</div>
          <div class="stat-value">${balance === null ? '—' : fmtNum(balance)}</div>
          <div class="stat-hint">${diff > 0 ? `还差 ${fmtNum(diff)} credits` : '余额充足'}</div>
        </div>
      </div>
      ${
        plan.sinceCursor
          ? `<div class="form-hint">增量起点 since_id = <span class="mono">${esc(plan.sinceCursor)}</span></div>`
          : ''
      }
      ${
        blocked
          ? `<div class="error-bar" style="margin-top:10px"><span class="err-code">${esc(blocked.code)}</span><span>${esc(
              blocked.message
            )}</span>${
              blocked.code === 'UNAUTHORIZED' || blocked.code === 'DEMO_MODE'
                ? '<button class="btn btn-sm" type="button" data-act="toSettings">去登录</button>'
                : ''
            }</div>`
          : '<div class="notice notice-ok" style="margin-top:10px">预检通过，可以开始读取。运行中会实时显示进度、接口返回条数与消耗。</div>'
      }
    `;
    const toSettings = planBox.querySelector('[data-act="toSettings"]');
    if (toSettings) toSettings.addEventListener('click', () => navigate('/settings'));
    updateStartState();
  }

  /** 调用 /api/fetch/plan。 */
  async function runPlan(silent = false) {
    readForm();
    const err = dateError();
    if (err) {
      dateErrorBox.innerHTML = `<div class="form-error">${esc(err)}</div>`;
      state.plan = null;
      renderPlan();
      return null;
    }
    dateErrorBox.innerHTML = '';
    if (!state.ownerId) {
      state.plan = null;
      renderPlan();
      return null;
    }
    if (!silent) setBusy(planBtn, true, '预估中…');
    try {
      state.plan = await api('/api/fetch/plan', {
        method: 'POST',
        body: {
          mode: state.mode,
          ownerType: state.ownerType,
          ownerId: state.ownerId,
          limit: state.limit,
          fromMs: state.from || undefined,
          toMs: state.to || undefined,
          cursor: state.cursor,
        },
      });
      renderPlan();
      return state.plan;
    } catch (err2) {
      state.plan = null;
      planBox.innerHTML = `<div class="error-bar" style="margin-top:10px"><span class="err-code">${esc(
        err2.code || 'ERROR'
      )}</span><span>${esc(err2.message || '预估失败')}</span></div>`;
      updateStartState();
      return null;
    } finally {
      if (!silent) {
        setBusy(planBtn, false);
        planBtn.textContent = '预估';
      }
    }
  }

  /** 静默自动预估（600ms 防抖，避免频繁改表单时刷屏）。 */
  let autoTimer = null;
  function autoPlan() {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      void runPlan(true);
    }, 600);
  }

  /* ----------------------------- 任务面板 ----------------------------- */

  /** 渲染任务面板。 */
  function renderTask(task) {
    const progress = task.progress || {};
    const limit = state.limit || 500;
    const pct =
      task.status === 'running'
        ? Math.min(99, Math.max(2, Math.round(((progress.returned || 0) / limit) * 100)))
        : 100;
    const statusMap = {
      running: ['运行中', 'badge-primary'],
      success: ['完成', 'badge-ok'],
      stopped: ['已停止', 'badge-warn'],
      failed: ['失败', 'badge-danger'],
    };
    const [statusText, statusCls] = statusMap[task.status] || [task.status, 'badge'];
    const logs = (task.logs || []).slice(-200);
    const logHtml = logs
      .map((line) => {
        const cls = /失败|错误|停止|不足/.test(line) ? 'error' : /提示|回退|忽略|重试/.test(line) ? 'warn' : '';
        return `<div class="log-line ${cls}">${esc(line)}</div>`;
      })
      .join('');

    taskBox.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3 class="card-title">取数任务</h3>
          <span class="badge ${statusCls}" id="fTaskStatus">${esc(statusText)}</span>
          <div class="card-actions">
            <button class="btn btn-sm btn-danger" id="fStop" type="button" ${task.canStop ? '' : 'disabled'}>停止读取</button>
          </div>
        </div>
        <div class="progress"><div class="progress-bar ${task.status === 'running' ? 'running' : ''}" style="width:${pct}%"></div></div>
        <div class="progress-meta">
          <span>第 <b>${progress.page || 0}</b> 页</span>
          <span>接口返回 <b>${progress.returned || 0}</b> 条</span>
          <span>新增 <b>${progress.added || 0}</b> 条</span>
          <span>复用 <b>${progress.reused || 0}</b> 条</span>
          <span>消耗 <b>${fmtNum(progress.credits || 0)}</b> credits</span>
          <span>剩余 <b>${progress.balance === null || progress.balance === undefined ? '—' : fmtNum(progress.balance)}</b></span>
        </div>
        ${task.reason ? `<div class="form-hint" style="margin-top:8px">结束原因：${esc(task.reason)}</div>` : ''}
        <div class="log-box" id="fLogBox">${logHtml || '<div class="log-line">等待第一页返回…</div>'}</div>
      </div>
    `;

    const logBox = taskBox.querySelector('#fLogBox');
    if (logBox) {
      const nearBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 60;
      if (nearBottom) logBox.scrollTop = logBox.scrollHeight;
    }

    const stopBtn = taskBox.querySelector('#fStop');
    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        setBusy(stopBtn, true, '停止中…');
        try {
          await api(`/api/fetch/tasks/${task.taskId}/stop`, { method: 'POST' });
          toast('已请求停止，当前页结束后会停下（已落盘数据保留）', 'warn');
        } catch (err) {
          toast(err.message || '停止失败', 'error');
          setBusy(stopBtn, false);
          stopBtn.textContent = '停止读取';
        }
      });
    }
  }

  /** 单次轮询。 */
  async function poll() {
    if (!state.taskId) return;
    try {
      const task = await api(`/api/fetch/tasks/${state.taskId}`);
      renderTask(task);
      if (task.status !== 'running') {
        stopPolling();
        state.taskId = null;
        updateStartState();
        await refreshStatus();
        const map = { success: 'ok', stopped: 'warn', failed: 'error' };
        toast(`任务${task.status === 'success' ? '完成' : task.status === 'stopped' ? '已停止' : '失败'}：${task.reason || ''}`, map[task.status] || 'info', 5000);
        await runPlan(true);
      }
    } catch (err) {
      stopPolling();
      state.taskId = null;
      updateStartState();
      toast(err.message || '任务状态获取失败', 'error');
    }
  }

  /* ----------------------------- 事件绑定 ----------------------------- */

  modeSelect.addEventListener('change', () => {
    state.mode = modeSelect.value;
    state.plan = null;
    planBox.innerHTML = '';
    void loadOwners();
  });
  ownerSelect.addEventListener('change', () => {
    state.ownerId = ownerSelect.value;
    void runPlan(true);
  });
  limitInput.addEventListener('change', () => autoPlan());
  fromInput.addEventListener('change', () => autoPlan());
  toInput.addEventListener('change', () => autoPlan());
  for (const radio of root.querySelectorAll('input[name="fCursor"]')) {
    radio.addEventListener('change', () => autoPlan());
  }
  planBtn.addEventListener('click', () => {
    void runPlan(false);
  });

  startBtn.addEventListener('click', async () => {
    readForm();
    if (dateError()) {
      dateErrorBox.innerHTML = `<div class="form-error">${esc(dateError())}</div>`;
      return;
    }
    setBusy(startBtn, true, '启动中…');
    try {
      const result = await api('/api/fetch/tasks', {
        method: 'POST',
        body: {
          mode: state.mode,
          ownerType: state.ownerType,
          ownerId: state.ownerId,
          limit: state.limit,
          fromMs: state.from || undefined,
          toMs: state.to || undefined,
          cursor: state.cursor,
        },
      });
      state.taskId = result.taskId;
      toast('任务已启动，正在取数…', 'ok');
      taskBox.innerHTML = '<div class="card"><div class="skeleton sk-card"></div></div>';
      stopPolling();
      state.timer = setInterval(() => {
        void poll();
      }, 1000);
      void poll();
      startBtn.disabled = true;
    } catch (err) {
      const message = err.message || '启动失败';
      toast(message, 'error');
      planBox.innerHTML = `<div class="error-bar" style="margin-top:10px"><span class="err-code">${esc(
        err.code || 'ERROR'
      )}</span><span>${esc(message)}</span></div>`;
      startBtn.disabled = false;
    } finally {
      setBusy(startBtn, false);
      startBtn.textContent = '开始读取';
      updateStartState();
    }
  });

  // 首次加载：填对象下拉 + 自动预估
  await loadOwners();
  renderPlan();
}
