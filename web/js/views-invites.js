/**
 * @file 视图：邀请码管理（生成 / 停用 / 删除 / 复制）。
 *
 * 邀请码只用于展示页的访问校验，存于服务器 data/invites.json；后台列表只在这里可见。
 * @module web/js/views-invites
 */

import { api, copyText, esc, fmtTime, setBusy, toast } from './api.js';

function statusMeta(invite) {
  if (invite.status === 'active') return { label: '有效', cls: 'badge-ok' };
  if (invite.status === 'expired') return { label: '已过期', cls: 'badge-warn' };
  return { label: '已停用', cls: 'badge-warn' };
}

function rowHtml(invite) {
  const meta = statusMeta(invite);
  const expires = invite.expiresAtMs ? `至 ${fmtTime(invite.expiresAtMs)}` : '永久';
  return `<tr>
    <td class="mono">${esc(invite.code)}</td>
    <td>${esc(invite.note || '—')}</td>
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
  const data = await api('/api/invites');
  const items = Array.isArray(data.items) ? data.items : [];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 class="page-title">邀请码</h2>
        <div class="page-desc">展示页需要输入邀请码才能进入；在这里生成、停用或删除。</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="/fakeaccount/" target="_blank" rel="noopener">打开展示页</a>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3 class="card-title">生成邀请码</h3></div>
      <div class="form-row">
        <div class="field" style="flex:1 1 260px">
          <label for="invNote">备注（给谁、用途）</label>
          <input class="input" id="invNote" maxlength="80" placeholder="例如：给同事的预览码">
        </div>
        <div class="field w-sm">
          <label for="invDays">有效期（天）</label>
          <input class="input" id="invDays" type="number" min="0" max="3650" value="30">
        </div>
        <button class="btn btn-primary" type="button" id="invCreate">生成</button>
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
              <thead><tr><th>邀请码</th><th>备注</th><th>使用</th><th>状态</th><th>创建 / 到期</th><th>操作</th></tr></thead>
              <tbody>${items.map(rowHtml).join('')}</tbody>
            </table></div>`
          : '<div class="form-hint">还没有邀请码；填一个备注后点「生成」。</div>'
      }
    </div>
  `;

  const noteInput = root.querySelector('#invNote');
  const daysInput = root.querySelector('#invDays');
  const createBtn = root.querySelector('#invCreate');
  const createdBox = root.querySelector('#invCreated');

  createBtn.addEventListener('click', async () => {
    setBusy(createBtn, true, '生成中…');
    createdBox.textContent = '';
    try {
      const result = await api('/api/invites', {
        method: 'POST',
        body: { note: noteInput.value.trim(), expiresInDays: Number(daysInput.value) || 0 },
      });
      const invite = result.invite;
      createdBox.innerHTML = `<span style="color:var(--ok)">已生成：</span><code class="mono">${esc(invite.code)}</code>
        <button class="btn btn-sm" type="button" data-copy="${esc(invite.code)}">复制</button>`;
      toast(`邀请码 ${invite.code} 已生成`, 'ok');
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
