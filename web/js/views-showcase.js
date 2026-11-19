/**
 * @file 视图：展示页发布（导出静态快照 → 增量上传 COS）。
 *
 * 只保留两个动作，避免用户理解成本：
 * ① 发布（增量补齐）：补缺失/过期的资料与头像，导出数据，按内容增量上传；
 * ② 全量更新资料与头像：强制重新拉取所有账号/作者的头像与昵称，然后发布。
 *
 * @module web/js/views-showcase
 */

import { api, esc, setBusy, toast } from './api.js';

/** 把发布脚本的输出拼成可读日志。 */
function stepsToText(steps) {
  const lines = [];
  for (const step of steps || []) {
    const title = step.step === 'profiles' ? '资料与头像' : '发布到 COS';
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

  const status = await api('/api/showcase/status');

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 class="page-title">展示页发布</h2>
        <div class="page-desc">
          把服务器上的归档导出成静态快照并上传 COS 广州，展示页从 CDN 直连读取。
        </div>
      </div>
      <div class="page-actions">
        <a class="btn" href="/fakeaccount/" target="_blank" rel="noopener">打开展示页</a>
        <button class="btn" type="button" data-go="#/fetch">去取数</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3 class="card-title">发布</h3>
        <span class="badge ${status.busy ? 'badge-warn' : 'badge-ok'}">${status.busy ? '有任务运行中' : '空闲'}</span>
      </div>

      <p class="page-desc" style="margin-bottom:6px">
        <strong>发布（增量补齐）</strong>：只补缺失或超过 30 天的资料/头像，导出全部账号的数据，
        只上传变化的文件。日常新增互动后点这个。
      </p>
      <p class="page-desc" style="margin-bottom:14px">
        <strong>全量更新资料与头像</strong>：强制重新拉取所有账号与作者的头像/昵称（适合有人换过头像或昵称），
        耗时可能几分钟。
      </p>

      <div class="page-actions" style="margin-left:0;gap:10px">
        <button class="btn btn-primary" type="button" id="pubRun">发布（增量补齐）</button>
        <button class="btn" type="button" id="pubFull">全量更新资料与头像</button>
      </div>

      <div class="form-hint" style="margin-top:12px">
        COS 配置：<code class="mono">${esc(status.cosConf.path)}</code>
        <span style="color:${status.cosConf.exists ? 'var(--ok)' : 'var(--danger)'}">${status.cosConf.exists ? ' ✓ 可用' : ' ✗ 未找到'}</span>
        · Cookie：<code class="mono">${esc(status.cookieFile.path)}</code>
        <span style="color:${status.cookieFile.exists ? 'var(--ok)' : 'var(--warn)'}">${status.cookieFile.exists ? ' ✓ 可用' : ' ✗ 未找到（跳过资料刷新）'}</span>
        <br>
        发布读取服务器上的 <code class="mono">data/</code>；服务器 IP 无法调用微博 CLI，互动数据请在能访问微博的机器取好后同步到服务器。
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
  const fullBtn = root.querySelector('#pubFull');
  const logBox = root.querySelector('#pubLog');
  const resultBox = root.querySelector('#pubResult');

  async function publish(refresh) {
    const full = refresh === 'full';
    if (full && !window.confirm('全量更新会重新拉取所有账号/作者的头像和昵称，可能耗时几分钟，确定继续？')) {
      return;
    }
    runBtn.disabled = true;
    fullBtn.disabled = true;
    setBusy(full ? fullBtn : runBtn, true, full ? '全量更新中…' : '发布中…');
    resultBox.textContent = '';
    logBox.hidden = false;
    logBox.textContent = full
      ? '正在重新拉取所有资料与头像，然后发布，请耐心等待…'
      : '正在补齐缺失资料并发布，请稍候…';
    try {
      const result = await api('/api/showcase/publish', { method: 'POST', body: { refresh } });
      logBox.textContent = stepsToText(result.steps);
      const publishStep = (result.steps || []).find((step) => step.step === 'publish');
      const profileStep = (result.steps || []).find((step) => step.step === 'profiles');
      if (publishStep && publishStep.code === 0) {
        const profileWarn = profileStep && profileStep.code !== 0
          ? '（资料/头像刷新失败，本次仅发布了已有数据）'
          : '';
        resultBox.innerHTML = `<span style="color:var(--ok)">发布完成${profileWarn}。展示页：<a href="/fakeaccount/" target="_blank" rel="noopener">/fakeaccount/</a>（CDN 约 1 分钟内生效）</span>`;
        toast('展示页发布完成', 'ok');
      } else {
        resultBox.innerHTML = '<span class="form-error">发布失败，请查看下方日志。</span>';
      }
    } catch (err) {
      logBox.textContent = err && err.message ? err.message : '发布失败';
      resultBox.innerHTML = `<span class="form-error">${esc(err && err.message ? err.message : '发布失败')}</span>`;
    } finally {
      setBusy(full ? fullBtn : runBtn, false);
      runBtn.disabled = false;
      fullBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', () => {
    void publish('incremental');
  });
  fullBtn.addEventListener('click', () => {
    void publish('full');
  });
}
