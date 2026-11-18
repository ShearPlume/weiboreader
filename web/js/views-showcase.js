/**
 * @file 视图：展示页发布（把归档导出为静态快照并上传 COS）。
 *
 * 互动数据本身仍在「取数」页通过微博 CLI 同步；本页负责：
 * ① 可选刷新用户资料与头像（新账号/新作者需要）
 * ② 重新导出 users/profiles/records 静态快照
 * ③ 按内容 MD5 增量上传到 COS 广州（缓存直连）
 *
 * @module web/js/views-showcase
 */

import { api, esc, setBusy, toast } from './api.js';

/** 把发布脚本的输出拼成可读日志。 */
function stepsToText(steps) {
  const lines = [];
  for (const step of steps || []) {
    const title = step.step === 'profiles' ? '刷新资料与头像' : '发布到 COS';
    lines.push(`===== ${title}（exit ${step.code}）=====`);
    if (step.stdout) lines.push(step.stdout.trimEnd());
    if (step.stderr) lines.push(step.stderr.trimEnd());
    if (step.error) lines.push(`错误：${step.error}`);
    lines.push('');
  }
  return lines.join('\n').trim() || '（无输出）';
}

export async function renderShowcase(root) {
  root.innerHTML = '<div class="card"><div class="skeleton sk-card"></div></div>';

  const [status, users] = await Promise.all([api('/api/showcase/status'), api('/api/users')]);
  const userOptions = (users.items || [])
    .map((user) => `<option value="${esc(user.uid)}">${esc(user.screenName || user.uid)} · ${esc(user.uid)}</option>`)
    .join('');

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 class="page-title">展示页发布</h2>
        <div class="page-desc">
          把本地归档导出成静态快照并上传 COS 广州；展示页从 CDN 直连读取，只有很小的 HTML/API 走服务器。
          互动数据请先在「取数」页同步。
        </div>
      </div>
      <div class="page-actions">
        <a class="btn" href="/fakeaccount/" target="_blank" rel="noopener">打开展示页</a>
        <button class="btn" type="button" data-go="#/fetch">去取数</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3 class="card-title">发布配置</h3>
        <span class="badge ${status.busy ? 'badge-warn' : 'badge-ok'}">${status.busy ? '有任务运行中' : '空闲'}</span>
      </div>

      <div class="form-row">
        <div class="field w-md">
          <label for="pubUid">账号范围</label>
          <select class="select" id="pubUid">
            <option value="">全部账号（users / profiles 始终全量）</option>
            ${userOptions}
          </select>
        </div>
        <div class="field" style="flex:1 1 320px">
          <label>选项</label>
          <div style="display:flex;flex-wrap:wrap;gap:14px">
            <label class="checkbox"><input type="checkbox" id="pubProfiles" checked> 先刷新资料与头像</label>
            <label class="checkbox"><input type="checkbox" id="pubDataOnly"> 只发布数据</label>
            <label class="checkbox"><input type="checkbox" id="pubDryRun"> 预演（不上传）</label>
          </div>
        </div>
      </div>

      <div class="form-hint">
        COS 配置：<code class="mono">${esc(status.cosConf.path)}</code>
        <span style="color:${status.cosConf.exists ? 'var(--ok)' : 'var(--danger)'}">${status.cosConf.exists ? ' ✓ 可用' : ' ✗ 未找到'}</span>
        <br>
        Cookie（头像/资料）：<code class="mono">${esc(status.cookieFile.path)}</code>
        <span style="color:${status.cookieFile.exists ? 'var(--ok)' : 'var(--warn)'}">${status.cookieFile.exists ? ' ✓ 可用' : ' ✗ 未找到（跳过资料刷新）'}</span>
      </div>

      <div class="page-actions" style="margin-top:12px">
        <button class="btn btn-primary" type="button" id="pubRun">发布到 COS</button>
      </div>

      <div id="pubResult" class="form-hint" style="margin-top:10px"></div>
      <div class="log-box" id="pubLog" hidden></div>
    </div>
  `;

  for (const button of root.querySelectorAll('[data-go]')) {
    button.addEventListener('click', () => {
      location.hash = button.dataset.go;
    });
  }

  const runBtn = root.querySelector('#pubRun');
  const logBox = root.querySelector('#pubLog');
  const resultBox = root.querySelector('#pubResult');
  const uidSelect = root.querySelector('#pubUid');
  const profilesBox = root.querySelector('#pubProfiles');
  const dataOnlyBox = root.querySelector('#pubDataOnly');
  const dryRunBox = root.querySelector('#pubDryRun');

  // 预演时不必真的去抓资料/头像
  dryRunBox.addEventListener('change', () => {
    if (dryRunBox.checked) profilesBox.checked = false;
    profilesBox.disabled = dryRunBox.checked;
  });

  runBtn.addEventListener('click', async () => {
    const body = {
      uid: uidSelect.value || undefined,
      withProfiles: profilesBox.checked,
      mode: dataOnlyBox.checked ? 'data' : 'all',
      dryRun: dryRunBox.checked,
    };
    if (body.withProfiles && !status.cookieFile.exists) {
      toast('Cookie 文件不存在，将跳过资料/头像刷新', 'warn');
    }
    setBusy(runBtn, true, body.dryRun ? '预演中…' : '发布中…');
    resultBox.textContent = '';
    logBox.hidden = false;
    logBox.textContent = '正在执行，请稍候（增量上传通常几秒）…';
    try {
      const result = await api('/api/showcase/publish', { method: 'POST', body });
      logBox.textContent = stepsToText(result.steps);
      const publishStep = (result.steps || []).find((step) => step.step === 'publish');
      if (publishStep && publishStep.code === 0) {
        resultBox.innerHTML = `<span style="color:var(--ok)">发布完成。展示页：<a href="/fakeaccount/" target="_blank" rel="noopener">/fakeaccount/</a>（CDN 缓存约 1 分钟内生效）</span>`;
        toast('展示页发布完成', 'ok');
      } else {
        resultBox.innerHTML = '<span class="form-error">发布失败，请查看下方日志。</span>';
      }
    } catch (err) {
      logBox.textContent = err && err.message ? err.message : '发布失败';
      resultBox.innerHTML = `<span class="form-error">${esc(err && err.message ? err.message : '发布失败')}</span>`;
    } finally {
      setBusy(runBtn, false);
    }
  });
}
