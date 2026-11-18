/**
 * @file 视图：订阅页（CRUD / 启停 / 预算 / 日志）+ 设置页（账户与登录 / 数据目录 / 导入导出 /
 *       费用参考 / 演示模式）+ 设备码登录弹窗。
 * @module web/js/views-config
 */

import { api, confirmDialog, copyText, esc, fmtNum, fmtRelative, fmtTime, html, navigate, numOrNull, refreshStatus, setBusy, toast } from './api.js';

const STATUS_MAP = {
  active: ['运行中', 'badge-ok'],
  paused: ['已暂停', 'badge'],
  'budget-exhausted': ['今日额度用尽', 'badge-warn'],
};

const RESULT_MAP = {
  ok: ['成功', 'badge-ok'],
  'no-new': ['无新增', 'badge'],
  budget: ['额度不足', 'badge-warn'],
  error: ['失败', 'badge-danger'],
};

/* ------------------------------------------------------------------ *
 * 设备码登录弹窗
 * ------------------------------------------------------------------ */

/**
 * 打开登录弹窗：展示 user_code 与授权链接，按 interval 轮询直到 ready / expired / error。
 */
export function openLoginModal() {
  let timer = null;
  let authId = '';
  let intervalSec = 5;
  let remainSec = 600;
  let finished = false;

  const mask = html(`<div class="modal-mask">
    <div class="modal">
      <h3>登录微博账号</h3>
      <div class="modal-desc">
        使用设备码授权：复制下方校验码，在浏览器打开的页面里确认即可。token 只保存在本机
        <code class="mono">data/config.json</code>，不会回传前端。
      </div>
      <div id="lmBody"><div class="poll-status"><span class="spinner"></span><span>正在申请设备码…</span></div></div>
      <div class="modal-actions">
        <button class="btn" type="button" data-act="manual">改用手动 token</button>
        <button class="btn" type="button" data-act="cancel">取消</button>
      </div>
    </div>
  </div>`);

  const body = mask.querySelector('#lmBody');
  const cancelBtn = mask.querySelector('[data-act="cancel"]');

  /** 清理定时器并关闭。 */
  const close = (cancelRemote) => {
    finished = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (cancelRemote && authId) {
      void api(`/api/auth/device/${encodeURIComponent(authId)}`, { method: 'DELETE' }).catch(() => {});
    }
    mask.remove();
  };

  cancelBtn.addEventListener('click', () => close(true));
  mask.querySelector('[data-act="manual"]').addEventListener('click', () => {
    close(true);
    navigate('/settings');
    setTimeout(() => {
      const input = document.getElementById('tokenInput');
      if (input) {
        input.focus();
        input.scrollIntoView({ block: 'center' });
      }
    }, 250);
  });
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close(true);
  });

  /** 展示设备码与链接。 */
  const showCode = (info) => {
    authId = info.authId;
    intervalSec = Math.max(3, Number(info.interval) || 5);
    remainSec = Math.max(60, Number(info.expiresIn) || 600);
    const codeText = String(info.userCode || '').toUpperCase();
    body.innerHTML = `
      <div class="code-box">${esc(codeText)}</div>
      <div class="link-box">
        <div class="tiny" style="margin-bottom:4px">授权链接（点击在新标签打开）：</div>
        <a href="${esc(info.verificationUrl)}" target="_blank" rel="noopener noreferrer" class="mono">${esc(
      info.verificationUrl
    )}</a>
      </div>
      <div class="inline-list">
        <button class="btn btn-sm" type="button" data-act="copyCode">复制校验码</button>
        <button class="btn btn-sm" type="button" data-act="openLink">打开授权页面</button>
      </div>
      <div class="poll-status" id="lmStatus">
        <span class="spinner"></span>
        <span id="lmStatusText">等待浏览器中确认授权…（剩余 ${remainSec} 秒，每 ${intervalSec} 秒检查一次）</span>
      </div>
    `;
    body.querySelector('[data-act="copyCode"]').addEventListener('click', () => copyText(codeText, '校验码已复制'));
    body.querySelector('[data-act="openLink"]').addEventListener('click', () => {
      window.open(info.verificationUrl, '_blank', 'noopener');
    });
    schedule();
  };

  /** 设置状态文案。 */
  const setStatus = (text, spinning = true) => {
    const box = body.querySelector('#lmStatus');
    if (!box) return;
    box.innerHTML = `${spinning ? '<span class="spinner"></span>' : ''}<span>${esc(text)}</span>`;
  };

  /** 失败态：给出重试。 */
  const showFailure = (message) => {
    body.innerHTML = `<div class="error-bar" style="margin:0"><span class="err-code">TOKEN_INVALID</span><span>${esc(
      message || '授权失败'
    )}</span></div>
    <div class="inline-list" style="margin-top:12px">
      <button class="btn btn-primary btn-sm" type="button" data-act="retry">重新申请设备码</button>
    </div>`;
    body.querySelector('[data-act="retry"]').addEventListener('click', () => {
      void start();
    });
  };

  /** 单次轮询。 */
  const poll = async () => {
    if (finished) return;
    remainSec = Math.max(0, remainSec - intervalSec);
    if (!authId) return;
    try {
      const result = await api(`/api/auth/device/${encodeURIComponent(authId)}`);
      if (finished) return;
      if (result.status === 'ready') {
        toast(`已登录：${(result.account && result.account.screenName) || ''}`, 'ok');
        close(false);
        await refreshStatus();
        window.dispatchEvent(new Event('hashchange'));
        return;
      }
      if (result.status === 'expired') {
        showFailure('设备码已过期，请重新申请');
        return;
      }
      if (result.status === 'error') {
        showFailure(result.message || '授权失败');
        return;
      }
      if (result.status === 'slow_down') {
        intervalSec = Math.max(intervalSec + 5, Number(result.interval) || intervalSec + 5);
        setStatus(`轮询过快，已自动放慢到每 ${intervalSec} 秒一次…（剩余 ${remainSec} 秒）`);
      } else {
        setStatus(`等待浏览器中确认授权…（剩余 ${remainSec} 秒，每 ${intervalSec} 秒检查一次）`);
      }
      schedule();
    } catch (err) {
      if (finished) return;
      showFailure(err.message || '轮询失败');
    }
  };

  /** 安排下一次轮询。 */
  const schedule = () => {
    if (finished) return;
    timer = setTimeout(() => {
      void poll();
    }, intervalSec * 1000);
  };

  /** 申请设备码。 */
  const start = async () => {
    body.innerHTML = '<div class="poll-status"><span class="spinner"></span><span>正在申请设备码…</span></div>';
    try {
      const info = await api('/api/auth/device', { method: 'POST' });
      if (finished) return;
      showCode(info);
    } catch (err) {
      showFailure(err.message || '设备码申请失败（可能是网络问题）');
    }
  };

  document.getElementById('modalRoot').appendChild(mask);
  void start();
}

/* ------------------------------------------------------------------ *
 * 订阅页
 * ------------------------------------------------------------------ */

/** 生成对象下拉选项。 */
async function ownerOptions(ownerType) {
  if (ownerType === 'posts') {
    const data = await api('/api/posts');
    return data.items.map((post) => ({
      id: post.id,
      label: `${post.id} · ${(post.text || '（正文缺失）').slice(0, 26)}`,
    }));
  }
  const data = await api('/api/users');
  return data.items.map((user) => ({ id: user.uid, label: `${user.screenName}（UID ${user.uid}）` }));
}

/**
 * 订阅页：列表 + 新建 + 启停 + 预算 + 日志。
 * @param {HTMLElement} root
 * @param {{query:URLSearchParams}} [ctx]
 */
export async function renderSubscriptions(root, ctx) {
  const query = (ctx && ctx.query) || new URLSearchParams();
  const preOwnerType = query.get('ownerType') === 'posts' ? 'posts' : 'users';
  const preOwnerId = query.get('ownerId') || '';

  root.innerHTML = `<div class="card"><div class="skeleton sk-card"></div><div class="skeleton sk-card"></div></div>`;

  const [subs, logs] = await Promise.all([
    api('/api/subscriptions'),
    api('/api/subscriptions/all/logs?limit=60').catch(() => ({ items: [] })),
  ]);

  const formState = { ownerType: preOwnerType, ownerId: preOwnerId, mode: preOwnerType === 'posts' ? 'post-comments' : 'received' };
  let owners = await ownerOptions(formState.ownerType);

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 class="page-title">订阅巡检</h2>
        <div class="page-desc">进程内定时器每 30 秒检查到期订阅；<b>演示模式下不会执行真实取数</b>。每日预算耗尽会自动暂停并在次日恢复。</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-go="#/settings">设置</button>
        <button class="btn" data-go="#/overview">总览</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3 class="card-title">新建订阅</h3></div>
      <div class="form-row">
        <div class="field w-md">
          <label>对象类型</label>
          <div class="radio-group">
            <label><input type="radio" name="subOwnerType" value="users" ${formState.ownerType === 'users' ? 'checked' : ''}><span>用户</span></label>
            <label><input type="radio" name="subOwnerType" value="posts" ${formState.ownerType === 'posts' ? 'checked' : ''}><span>博文</span></label>
          </div>
        </div>
        <div class="field" style="flex:1 1 260px">
          <label for="subOwner">对象</label>
          <select class="select" id="subOwner">
            ${owners.map((o) => `<option value="${esc(o.id)}" ${o.id === formState.ownerId ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field w-md">
          <label for="subMode">内容模式</label>
          <select class="select" id="subMode">
            ${[
              ['received', '收到的评论'],
              ['sent', '发出的评论'],
              ['both', '发出和收到的评论'],
              ['mentions-comments', '被 @ 的评论'],
              ['mentions-posts', '被 @ 的微博'],
              ['user-posts', '用户微博'],
              ['post-comments', '某条微博下的评论'],
            ]
              .map(([key, label]) => `<option value="${esc(key)}" ${formState.mode === key ? 'selected' : ''}>${esc(label)}</option>`)
              .join('')}
          </select>
        </div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field w-sm">
          <label for="subLimit">每轮取数上限</label>
          <input class="input" id="subLimit" type="number" min="1" max="5000" value="100">
        </div>
        <div class="field w-sm">
          <label for="subBudget">每日 credits 预算</label>
          <input class="input" id="subBudget" type="number" min="0.01" step="0.01" value="2">
        </div>
        <div class="field w-md">
          <label>间隔模式</label>
          <div class="radio-group">
            <label><input type="radio" name="subInterval" value="auto" checked><span>自动退避</span></label>
            <label><input type="radio" name="subInterval" value="fixed"><span>固定</span></label>
          </div>
        </div>
        <div class="field w-sm">
          <label for="subFixed">固定间隔（分钟）</label>
          <input class="input" id="subFixed" type="number" min="1" max="1440" value="60">
        </div>
        <div class="field w-md">
          <label>&nbsp;</label>
          <button class="btn btn-primary" id="subCreate" type="button">创建订阅</button>
        </div>
      </div>
      <div class="form-hint">自动退避：有新增立即回到 1 分钟，无新增按 1 → 3 → 5 → 10 → 15 → 30 分钟逐级放慢。</div>
    </div>

    <div class="card">
      <div class="card-head"><h3 class="card-title">订阅列表（${subs.items.length}）</h3></div>
      <div id="subList"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3 class="card-title">订阅日志（最近 ${(logs.items || []).length} 条）</h3>
        <div class="card-actions"><button class="btn btn-sm" id="subReload" type="button">刷新</button></div>
      </div>
      <div class="table-wrap log-table">
        <table class="data">
          <thead><tr><th>时间</th><th>订阅</th><th>模式</th><th>结果</th><th class="num">返回</th><th class="num">新增</th><th class="num">credits</th><th>说明</th></tr></thead>
          <tbody>
            ${
              (logs.items || []).length
                ? logs.items
                    .map((log) => {
                      const [label, cls] = RESULT_MAP[log.result] || [log.result || '—', 'badge'];
                      return `<tr>
                        <td class="nowrap tiny">${esc(fmtTime(log.atMs))}</td>
                        <td class="mono tiny">${esc(log.subId || '')}</td>
                        <td class="tiny">${esc(log.mode || '')}</td>
                        <td><span class="badge ${cls}">${esc(label)}</span></td>
                        <td class="num">${log.returned || 0}</td>
                        <td class="num">${log.added || 0}</td>
                        <td class="num">${fmtNum(log.credits || 0)}</td>
                        <td class="tiny">${esc(log.message || '')}</td>
                      </tr>`;
                    })
                    .join('')
                : '<tr><td colspan="8" class="muted">暂无日志（演示数据自带几条示例日志）</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  for (const button of root.querySelectorAll('[data-go]')) {
    button.addEventListener('click', () => navigate(button.dataset.go));
  }

  const ownerTypeRadios = [...root.querySelectorAll('input[name="subOwnerType"]')];
  const ownerSelect = root.querySelector('#subOwner');
  const modeSelect = root.querySelector('#subMode');
  const limitInput = root.querySelector('#subLimit');
  const budgetInput = root.querySelector('#subBudget');
  const fixedInput = root.querySelector('#subFixed');
  const listRoot = root.querySelector('#subList');

  for (const radio of ownerTypeRadios) {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      formState.ownerType = radio.value;
      formState.mode = radio.value === 'posts' ? 'post-comments' : 'received';
      modeSelect.value = formState.mode;
      owners = await ownerOptions(formState.ownerType);
      ownerSelect.innerHTML = owners.length
        ? owners.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')
        : '<option value="">（该类型下暂无对象）</option>';
    });
  }

  /** 渲染订阅卡片。 */
  function renderSubList(items) {
    if (items.length === 0) {
      listRoot.innerHTML = `<div class="empty-state">
        <div class="empty-title">还没有订阅</div>
        <div class="empty-desc">订阅会在后台按间隔自动拉取新内容并记日志；不登录真实账号时不会产生任何费用。</div>
      </div>`;
      return;
    }
    listRoot.innerHTML = items
      .map((sub) => {
        const [statusLabel, statusCls] = STATUS_MAP[sub.status] || [sub.status, 'badge'];
        return `<div class="sub-item ${sub.enabled ? '' : 'paused'}" data-sub="${esc(sub.id)}">
          <div class="sub-head">
            <span class="badge ${statusCls}">${esc(statusLabel)}</span>
            <b>${esc(sub.ownerLabel || sub.ownerId)}</b>
            <span class="badge badge-primary">${esc(sub.mode)}</span>
            <span class="tiny">${sub.intervalMode === 'fixed' ? `固定 ${sub.fixedMinutes} 分钟` : `自动退避（当前约 ${sub.intervalMinutes} 分钟）`}</span>
            <div class="card-actions">
              <button class="btn btn-sm" data-toggle="${esc(sub.id)}" type="button">${sub.enabled ? '暂停' : '恢复'}</button>
              <button class="btn btn-sm" data-reset="${esc(sub.id)}" type="button">重置额度</button>
              <button class="btn btn-sm btn-danger" data-del="${esc(sub.id)}" type="button">删除</button>
            </div>
          </div>
          <div class="sub-meta">
            <span>下次检查 <b>${esc(fmtRelative(sub.nextRunAtMs))}</b></span>
            <span>上次运行 <b>${sub.lastRunAtMs ? esc(fmtRelative(sub.lastRunAtMs)) : '—'}</b></span>
            <span>今日已花 <b>${fmtNum(sub.spentToday)}</b> / 预算 ${fmtNum(sub.dailyCreditsBudget)} credits</span>
            <span>最近结果 <b>${esc(sub.lastResult || '—')}</b></span>
          </div>
          <div class="sub-body">
            <div class="field w-sm">
              <label>每轮上限</label>
              <input class="input input-sm" type="number" min="1" max="5000" value="${sub.perRoundLimit}" data-field="perRoundLimit" data-id="${esc(sub.id)}">
            </div>
            <div class="field w-sm">
              <label>每日预算</label>
              <input class="input input-sm" type="number" min="0.01" step="0.01" value="${sub.dailyCreditsBudget}" data-field="dailyCreditsBudget" data-id="${esc(sub.id)}">
            </div>
            <div class="field w-sm">
              <label>固定间隔（分钟）</label>
              <input class="input input-sm" type="number" min="1" max="1440" value="${sub.fixedMinutes}" data-field="fixedMinutes" data-id="${esc(sub.id)}">
            </div>
            <button class="btn btn-sm" data-save="${esc(sub.id)}" type="button">保存</button>
          </div>
        </div>`;
      })
      .join('');

    /** 重新拉取列表并重绘。 */
    const reload = async () => {
      const fresh = await api('/api/subscriptions');
      renderSubList(fresh.items);
    };

    for (const button of listRoot.querySelectorAll('[data-toggle]')) {
      button.addEventListener('click', async () => {
        const sub = items.find((s) => s.id === button.dataset.toggle);
        if (!sub) return;
        setBusy(button, true, '…');
        try {
          await api(`/api/subscriptions/${sub.id}`, { method: 'PATCH', body: { enabled: !sub.enabled } });
          toast(sub.enabled ? '已暂停订阅' : '已恢复订阅', 'ok');
          await reload();
        } catch (err) {
          toast(err.message || '操作失败', 'error');
          setBusy(button, false);
        }
      });
    }
    for (const button of listRoot.querySelectorAll('[data-reset]')) {
      button.addEventListener('click', async () => {
        setBusy(button, true, '…');
        try {
          await api(`/api/subscriptions/${button.dataset.reset}/reset-budget`, { method: 'POST' });
          toast('已重置今日额度并恢复订阅', 'ok');
          await reload();
        } catch (err) {
          toast(err.message || '操作失败', 'error');
          setBusy(button, false);
        }
      });
    }
    for (const button of listRoot.querySelectorAll('[data-del]')) {
      button.addEventListener('click', async () => {
        const yes = await confirmDialog({ title: '删除该订阅？', desc: '不会删除已归档的数据。', okText: '删除', danger: true });
        if (!yes) return;
        try {
          await api(`/api/subscriptions/${button.dataset.del}`, { method: 'DELETE' });
          toast('订阅已删除', 'ok');
          await reload();
        } catch (err) {
          toast(err.message || '删除失败', 'error');
        }
      });
    }
    for (const button of listRoot.querySelectorAll('[data-save]')) {
      button.addEventListener('click', async () => {
        const id = button.dataset.save;
        const inputs = [...listRoot.querySelectorAll(`input[data-id="${id}"]`)];
        const body = {};
        for (const input of inputs) body[input.dataset.field] = Number(input.value);
        setBusy(button, true, '…');
        try {
          await api(`/api/subscriptions/${id}`, { method: 'PATCH', body });
          toast('已保存', 'ok');
          await reload();
        } catch (err) {
          toast(err.message || '保存失败', 'error');
          setBusy(button, false);
        }
      });
    }
  }

  root.querySelector('#subReload').addEventListener('click', () => {
    void renderSubscriptions(root, ctx);
  });

  root.querySelector('#subCreate').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const ownerId = ownerSelect.value;
    if (!ownerId) {
      toast('请先选择对象（可到用户库/博文库添加）', 'warn');
      return;
    }
    const intervalMode = root.querySelector('input[name="subInterval"]:checked').value;
    setBusy(button, true, '创建中…');
    try {
      await api('/api/subscriptions', {
        method: 'POST',
        body: {
          ownerType: formState.ownerType,
          ownerId,
          mode: modeSelect.value,
          perRoundLimit: Number(limitInput.value) || 100,
          dailyCreditsBudget: Number(budgetInput.value) || 2,
          intervalMode,
          fixedMinutes: Number(fixedInput.value) || 60,
        },
      });
      toast('订阅已创建', 'ok');
      const fresh = await api('/api/subscriptions');
      renderSubList(fresh.items);
    } catch (err) {
      toast(err.message || '创建失败', 'error');
    } finally {
      setBusy(button, false);
      button.textContent = '创建订阅';
    }
  });

  renderSubList(subs.items);
}

/* ------------------------------------------------------------------ *
 * 设置页
 * ------------------------------------------------------------------ */

/**
 * 设置页。
 * @param {HTMLElement} root
 */
export async function renderSettings(root) {
  root.innerHTML = `<div class="card"><div class="skeleton sk-card"></div><div class="skeleton sk-card"></div></div>`;
  const [settings, pricing, status] = await Promise.all([
    api('/api/settings'),
    api('/api/pricing').catch(() => ({ unitPriceByMode: {}, source: 'builtin', fetchedAtMs: null })),
    api('/api/status'),
  ]);

  const priceRows = Object.entries(pricing.unitPriceByMode || {})
    .map(
      ([mode, price]) => `<tr>
        <td class="mono tiny">${esc(mode)}</td>
        <td>${esc(labelOfMode(mode))}</td>
        <td class="num">${fmtNum(price, 4)}</td>
      </tr>`
    )
    .join('');

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 class="page-title">设置</h2>
        <div class="page-desc">所有数据仅存本机；token 只写入 <code class="mono">data/config.json</code>，任何接口响应只回传尾 4 位。</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-go="#/subscriptions">订阅巡检</button>
        <button class="btn" data-go="#/overview">总览</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3 class="card-title">账户与登录</h3>
        <span class="badge ${status.loggedIn ? 'badge-ok' : 'badge-warn'}">${status.loggedIn ? '已登录' : '未登录'}</span>
        ${status.demoMode ? '<span class="badge badge-warn">演示模式</span>' : ''}
        <div class="card-actions">
          <button class="btn btn-sm btn-primary" id="btnDeviceLogin" type="button">${status.loggedIn ? '重新授权' : '登录微博'}</button>
        </div>
      </div>
      <dl class="kv-list">
        <dt>账户</dt>
        <dd>${status.account ? `${esc(status.account.screenName || '—')} · UID <span class="mono">${esc(status.account.uid || '—')}</span>` : '—'}</dd>
        <dt>token</dt>
        <dd>${status.tokenTail4 ? `<span class="mono">••••${esc(status.tokenTail4)}</span>` : '—'}</dd>
        <dt>剩余 credits</dt>
        <dd>${status.balance && numOrNull(status.balance.value) !== null ? `${fmtNum(status.balance.value)}（${esc(fmtTime(status.balance.atMs))}）` : '未获取'}</dd>
      </dl>
      <div class="hr"></div>
      <div class="form-row">
        <div class="field" style="flex:2 1 320px">
          <label for="tokenInput">手动 access token（兜底）</label>
          <input class="input" id="tokenInput" type="password" placeholder="粘贴 access token，保存前会先调用 userinfo 校验">
        </div>
        <button class="btn" id="btnTokenSave" type="button">保存并校验</button>
        <button class="btn btn-danger" id="btnLogout" type="button">退出登录</button>
      </div>
      <div class="form-hint" id="tokenHint">校验失败不会覆盖已有 token；退出登录不会删除本地归档数据。</div>
    </div>

    <div class="card">
      <div class="card-head"><h3 class="card-title">数据目录</h3></div>
      <div class="form-row">
        <div class="field" style="flex:2 1 320px">
          <label for="dataDirInput">归档目录（JSON / JSONL / 报告）</label>
          <input class="input" id="dataDirInput" value="${esc(settings.dataDir)}">
        </div>
        <button class="btn" id="btnDataDir" type="button">切换目录</button>
        <button class="btn" id="btnDataDirReset" type="button">恢复默认</button>
      </div>
      <div class="form-hint">目录必须可写；切换后会立即重新加载列表。有取数任务运行中时不允许切换。</div>
      <div class="tiny" style="margin-top:6px">当前生效：<span class="mono" id="dataDirNow">${esc(settings.dataDir)}</span></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3 class="card-title">导出数据包</h3></div>
        <div class="form-hint" style="margin-bottom:10px">导出内容数据用于合并迁移，<b>不含</b>登录态、订阅、备注与已读状态。</div>
        <div class="inline-list">
          <a class="btn btn-primary" href="/api/exchange/export" download>导出 JSON 数据包</a>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3 class="card-title">导入数据包</h3></div>
        <div class="form-hint" style="margin-bottom:10px">按「记录唯一键」去重合并，导入完成后会重建统计。</div>
        <div class="inline-list">
          <input type="file" id="importFile" accept="application/json,.json" class="input" style="height:auto;padding:6px">
          <button class="btn" id="btnImport" type="button">导入</button>
        </div>
        <div class="form-hint" id="importHint"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3 class="card-title">费用参考</h3>
        <span class="badge">${pricing.source === 'api' ? '接口实时价' : '内置估算价'}</span>
        <span class="badge">${pricing.fetchedAtMs ? `更新于 ${esc(fmtTime(pricing.fetchedAtMs))}` : '尚未查询'}</span>
        <div class="card-actions"><button class="btn btn-sm" id="btnPricing" type="button">查询最新单价</button></div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>模式</th><th>说明</th><th class="num">credits / 条</th></tr></thead>
          <tbody>${priceRows || '<tr><td colspan="3" class="muted">暂无价目数据</td></tr>'}</tbody>
        </table>
      </div>
      <div class="form-hint" style="margin-top:8px">
        本地查看、搜索、生成报告、导出数据包均为 <b>0 credits</b>；只有真实调用微博取数接口才会计费，且按接口实际返回条数计费。
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3 class="card-title">演示模式</h3>
        <span class="badge ${status.demoMode ? 'badge-warn' : 'badge-ok'}">${status.demoMode ? '当前为演示数据' : '当前为真实数据'}</span>
        <div class="card-actions">
          <button class="btn btn-sm" id="btnDemoSeed" type="button">载入 / 重置演示数据</button>
          ${status.demoMode ? '<button class="btn btn-sm btn-primary" id="btnDemoOff" type="button">切回真实数据</button>' : ''}
        </div>
      </div>
      <div class="form-hint">
        演示数据写在 <span class="mono">data/demo/</span>，与真实数据物理隔离；演示模式下不会发起任何付费请求。
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3 class="card-title">关于</h3></div>
      <dl class="kv-list">
        <dt>版本</dt><dd>v1.0.0（零第三方依赖 / 零构建）</dd>
        <dt>监听地址</dt><dd class="mono">http://127.0.0.1:7788（仅回环，不监听 0.0.0.0）</dd>
        <dt>数据目录</dt><dd class="mono">${esc(status.dataDir)}</dd>
        <dt>归档规模</dt><dd>用户 ${status.counts.users} · 博文 ${status.counts.posts} · 未读 ${status.counts.unread}</dd>
        <dt>今日消耗</dt><dd>${fmtNum(status.todayCredits)} credits</dd>
      </dl>
    </div>
  `;

  for (const button of root.querySelectorAll('[data-go]')) {
    button.addEventListener('click', () => navigate(button.dataset.go));
  }

  root.querySelector('#btnDeviceLogin').addEventListener('click', openLoginModal);

  root.querySelector('#btnTokenSave').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const input = root.querySelector('#tokenInput');
    const hint = root.querySelector('#tokenHint');
    const token = input.value.trim();
    if (!token) {
      hint.textContent = '请先粘贴 access token';
      return;
    }
    setBusy(button, true, '校验中…');
    try {
      const result = await api('/api/auth/token', { method: 'POST', body: { token } });
      hint.textContent = `校验通过：${(result.account && result.account.screenName) || ''}`;
      toast('token 已保存', 'ok');
      input.value = '';
      await refreshStatus();
      await renderSettings(root);
    } catch (err) {
      hint.textContent = err.message || 'token 校验失败（未覆盖旧 token）';
      toast(err.message || 'token 校验失败', 'error');
    } finally {
      setBusy(button, false);
      button.textContent = '保存并校验';
    }
  });

  root.querySelector('#btnLogout').addEventListener('click', async () => {
    const yes = await confirmDialog({
      title: '退出登录？',
      desc: '将清除 token 并切回演示模式；本地已归档数据完整保留。',
      okText: '退出登录',
      danger: true,
    });
    if (!yes) return;
    try {
      await api('/api/auth/logout', { method: 'POST' });
      toast('已退出登录，数据保留', 'ok');
      await refreshStatus();
      await renderSettings(root);
    } catch (err) {
      toast(err.message || '退出失败', 'error');
    }
  });

  root.querySelector('#btnDataDir').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const input = root.querySelector('#dataDirInput');
    setBusy(button, true, '切换中…');
    try {
      const result = await api('/api/settings', { method: 'PATCH', body: { dataDir: input.value.trim() } });
      root.querySelector('#dataDirNow').textContent = result.dataDir;
      toast('数据目录已切换', 'ok');
      await refreshStatus();
      await renderSettings(root);
    } catch (err) {
      toast(err.message || '切换失败（目录不可写？）', 'error');
    } finally {
      setBusy(button, false);
      button.textContent = '切换目录';
    }
  });

  root.querySelector('#btnDataDirReset').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, '恢复中…');
    try {
      // 空 dataDir 表示回到默认目录
      await api('/api/settings', { method: 'PATCH', body: { dataDir: defaultDataDirGuess(settings.dataDir) } });
      toast('已恢复到默认数据目录', 'ok');
      await refreshSettingsAndRender(root);
    } catch (err) {
      toast(err.message || '恢复失败', 'error');
    } finally {
      setBusy(button, false);
      button.textContent = '恢复默认';
    }
  });

  root.querySelector('#btnImport').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const fileInput = root.querySelector('#importFile');
    const hint = root.querySelector('#importHint');
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      hint.textContent = '请先选择 JSON 数据包文件';
      return;
    }
    setBusy(button, true, '导入中…');
    hint.textContent = '';
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const result = await api('/api/exchange/import', { method: 'POST', body: { payload } });
      hint.textContent = `导入完成：新增 ${result.added} 条，跳过 ${result.skipped} 条；用户 +${result.usersAdded}，博文 +${result.postsAdded}`;
      toast(`导入完成：新增 ${result.added} 条`, 'ok');
      await refreshStatus();
    } catch (err) {
      hint.textContent = err.message || '导入失败（请确认是本工具导出的 JSON）';
      toast(err.message || '导入失败', 'error');
    } finally {
      setBusy(button, false);
      button.textContent = '导入';
    }
  });

  root.querySelector('#btnPricing').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, '查询中…');
    try {
      const result = await api('/api/pricing?refresh=1');
      toast(result.source === 'api' ? '已更新为接口实时单价' : '未取到实时单价，沿用内置估算价', result.source === 'api' ? 'ok' : 'warn');
      await renderSettings(root);
    } catch (err) {
      toast(err.message || '查询失败', 'error');
    } finally {
      setBusy(button, false);
      button.textContent = '查询最新单价';
    }
  });

  root.querySelector('#btnDemoSeed').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const yes = await confirmDialog({
      title: '载入 / 重置演示数据？',
      desc: '会切换到演示模式并清空 data/demo 下的旧演示数据；真实数据目录不受影响。',
      okText: '继续',
    });
    if (!yes) return;
    setBusy(button, true, '处理中…');
    try {
      const result = await api('/api/demo/seed', { method: 'POST', body: { reset: true } });
      toast(`演示数据已重置：${result.counts.users} 用户 / ${result.counts.posts} 博文`, 'ok');
      await refreshStatus();
      await renderSettings(root);
    } catch (err) {
      toast(err.message || '重置失败', 'error');
    } finally {
      setBusy(button, false);
      button.textContent = '载入 / 重置演示数据';
    }
  });

  const demoOff = root.querySelector('#btnDemoOff');
  if (demoOff) {
    demoOff.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      setBusy(button, true, '切换中…');
      try {
        await api('/api/settings', { method: 'PATCH', body: { demoMode: false } });
        toast('已切回真实数据目录', 'ok');
        await refreshStatus();
        await renderSettings(root);
      } catch (err) {
        toast(err.message || '切换失败', 'error');
      } finally {
        setBusy(button, false);
        button.textContent = '切回真实数据';
      }
    });
  }
}

/** 重新拉设置并整页重绘。 */
async function refreshSettingsAndRender(root) {
  await refreshStatus();
  await renderSettings(root);
}

/** 由当前目录反推默认目录（去掉末尾 /demo）。 */
function defaultDataDirGuess(current) {
  const value = String(current || '');
  if (!value) return '';
  return value.replace(/[\\/]demo$/, '');
}

/** 模式 key → 中文标签。 */
function labelOfMode(mode) {
  const map = {
    both: '发出和收到的评论',
    sent: '发出的评论',
    received: '收到的评论',
    'mentions-comments': '被 @ 的评论',
    'mentions-posts': '被 @ 的微博',
    'user-posts': '用户微博',
    'post-comments': '某条微博下的评论',
  };
  return map[mode] || mode;
}
