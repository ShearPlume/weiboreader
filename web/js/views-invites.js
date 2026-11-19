/**
 * @file 视图：邀请码管理（生成 / 停用 / 删除 / 复制 / 可见范围）。
 *
 * 可见范围：默认仅测试账号（恐龙毛衫）、全部账号、或指定账号（支持全选/反选）。
 * 邀请码存于服务器 data/invites.json；展示页只拿到校验结果与允许的账号列表。
 * @module web/js/views-invites
 */

import { api, copyText, esc, fmtTime, setBusy, toast } from './api.js';

const DEFAULT_TEST_UID = '7984139147';

function statusMeta(invite) {
  if (invite.status === 'active') return { label: '有效', cls: 'badge-ok' };
  if (invite.status === 'expired') return { label: '已过期', cls: 'badge-warn' };
  return { label: '已停用', cls: 'badge-warn' };
}

function scopeLabel(invite) {
  if (invite.scope === 'all') return '全部账号';
  if (invite.scope === 'selected') {
    return `指定 ${Array.isArray(invite.accounts) ? invite.accounts.length : 0} 个`;
  }
  if (invite.scope === 'default') return '仅测试账号';
  return '全部账号';
}

function rowHtml(invite) {
  const meta = statusMeta(invite);
  const expires = invite.expiresAtMs ? `至 ${fmtTime(invite.expiresAtMs)}` : '永久';
  return `<tr>
    <td class="mono">${esc(invite.code)}</td>
    <td>${esc(invite.note || '—')}</td>
    <td>${esc(scopeLabel(invite))}</td>
    <td class="num">${Number(invite.uses) || 0}</td>
    <td><span class="badge ${meta.cls}">${meta.label}</span></td>
    <td class="tiny">${esc(fmtTime(invite.createdAtMs))}<br>${esc(expires)}</td>
    <td style="white-space:nowrap">
      <button class="btn btn-sm" type="button" data-copy="${esc(invite.code)}">复制</button>
      <button class="btn btn-sm" type="button" data-toggle="${esc(invite.code)}" data-enabled="${invite.enabled ? '1' : '0'}">${invite.enabled ? '停用' : '启用'}</button>
      <button class="btn btn-sm" type="button" data-del="${esc(invite.code)}">删除</button>
    </td>
  </tr>`;
}

export async function renderInvites(root) {
  root.innerHTML = '<div class="card"><div class="skeleton sk-card"></div></div>';
  const [data, usersData] = await Promise.all([api('/api/invites'), api('/api/users')]);
  const items = Array.isArray(data.items) ? data.items : [];
  const users = Array.isArray(usersData.items) ? usersData.items : [];
  const testUser = users.find((user) => String(user.uid) === DEFAULT_TEST_UID);
  const testLabel = testUser
    ? `${testUser.screenName || testUser.uid}（${DEFAULT_TEST_UID}）`
    : `恐龙毛衫（${DEFAULT_TEST_UID}）`;
  const accountRows = users
    .map(
      (user) =>
        `<label class="checkbox" style="height:auto"><input type="checkbox" class="inv-account" value="${esc(
          user.uid
        )}"> ${esc(user.screenName || user.uid)} <span class="tiny mono">${esc(user.uid)}</span></label>`
    )
    .join('');

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 class="page-title">邀请码</h2>
        <div class="page-desc">展示页需要输入邀请码才能进入；可限制只能看测试账号、全部账号或指定账号。</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="/fakeaccount/" target="_blank" rel="noopener">打开展示页</a>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3 class="card-title">生成邀请码</h3></div>
      <div class="form-row">
        <div class="field" style="flex:1 1 240px">
          <label for="invNote">备注（给谁、用途）</label>
          <input class="input" id="invNote" maxlength="80" placeholder="例如：给同事的预览码">
        </div>
        <div class="field w-md">
          <label for="invScope">可见范围</label>
          <select class="select" id="invScope">
            <option value="default">仅测试账号（${esc(testLabel)}）</option>
            <option value="all">全部账号</option>
            <option value="selected">指定账号…</option>
          </select>
        </div>
        <div class="field w-sm">
          <label for="invDays">有效期（天）</label>
          <input class="input" id="invDays" type="number" min="0" max="3650" value="30">
        </div>
        <button class="btn btn-primary" type="button" id="invCreate">生成</button>
      </div>

      <div class="field" id="invAccountsWrap" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <label>选择可见账号</label>
          <span style="display:flex;gap:6px">
            <button class="btn btn-sm" type="button" id="invAll">全选</button>
            <button class="btn btn-sm" type="button" id="invInvert">反选</button>
          </span>
        </div>
        <div class="tiny" style="color:var(--muted);margin-top:2px">勾选后，该邀请码只能切换查看这些账号。</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:8px">${accountRows}</div>
      </div>

      <div class="form-hint" id="invCreated"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3 class="card-title">已生成</h3>
        <span class="badge">${items.length}</span>
      </div>
      ${
        items.length
          ? `<div class="table-wrap"><table class="data">
              <thead><tr><th>邀请码</th><th>备注</th><th>可见范围</th><th>使用</th><th>状态</th><th>创建 / 到期</th><th>操作</th></tr></thead>
              <tbody>${items.map(rowHtml).join('')}</tbody>
            </table></div>`
          : '<div class="form-hint">还没有邀请码；选好范围后点「生成」。</div>'
      }
    </div>
  `;

  const noteInput = root.querySelector('#invNote');
  const daysInput = root.querySelector('#invDays');
  const scopeSelect = root.querySelector('#invScope');
  const accountsWrap = root.querySelector('#invAccountsWrap');
  const createBtn = root.querySelector('#invCreate');
  const createdBox = root.querySelector('#invCreated');

  scopeSelect.addEventListener('change', () => {
    accountsWrap.style.display = scopeSelect.value === 'selected' ? '' : 'none';
  });

  createBtn.addEventListener('click', async () => {
    const scope = scopeSelect.value;
    const accounts = [...root.querySelectorAll('.inv-account:checked')].map((input) => input.value);
    if (scope === 'selected' && accounts.length === 0) {
      createdBox.innerHTML = '<span class="form-error">指定账号范围时请至少勾选一个账号</span>';
      return;
    }
    setBusy(createBtn, true, '生成中…');
    createdBox.textContent = '';
    try {
      const result = await api('/api/invites', {
        method: 'POST',
        body: {
          note: noteInput.value.trim(),
          expiresInDays: Number(daysInput.value) || 0,
          scope,
          accounts,
        },
      });
      createdBox.innerHTML = `<span style="color:var(--ok)">已生成：</span><code class="mono">${esc(result.invite.code)}</code>
        <button class="btn btn-sm" type="button" data-copy="${esc(result.invite.code)}">复制</button>`;
      toast(`邀请码 ${result.invite.code} 已生成`, 'ok');
      await renderInvites(root);
    } catch (err) {
      createdBox.innerHTML = `<span class="form-error">${esc(err && err.message ? err.message : '生成失败')}</span>`;
    } finally {
      setBusy(createBtn, false);
    }
  });

  root.onclick = async (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.id === 'invAll') {
      for (const input of root.querySelectorAll('.inv-account')) input.checked = true;
      return;
    }
    if (target.id === 'invInvert') {
      for (const input of root.querySelectorAll('.inv-account')) input.checked = !input.checked;
      return;
    }
    const copy = target.dataset.copy;
    if (copy) {
      await copyText(copy, '已复制邀请码');
      return;
    }
    const toggle = target.dataset.toggle;
    if (toggle) {
      target.disabled = true;
      try {
        await api(`/api/invites/${encodeURIComponent(toggle)}`, {
          method: 'PATCH',
          body: { enabled: target.dataset.enabled !== '1' },
        });
        await renderInvites(root);
      } catch (err) {
        toast(err && err.message ? err.message : '操作失败', 'error');
        target.disabled = false;
      }
      return;
    }
    const del = target.dataset.del;
    if (del) {
      if (!window.confirm(`确定删除邀请码 ${del}？已通过校验的设备不会被强制退出。`)) return;
      target.disabled = true;
      try {
        await api(`/api/invites/${encodeURIComponent(del)}`, { method: 'DELETE' });
        await renderInvites(root);
      } catch (err) {
        toast(err && err.message ? err.message : '删除失败', 'error');
        target.disabled = false;
      }
    }
  };
}
