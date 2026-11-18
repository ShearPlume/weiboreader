/**
 * @file 搜索页：关键词 + 作者 + 对象 + 日期四条件取交集、分页（每页 20）、
 *       显示命中总数与耗时、空结果显示当前生效条件。
 * @module web/js/views-search
 */

import { api, esc, fmtNum, fmtTime, highlight, rangeText, setBusy, toast } from './api.js';

const state = {
  q: '',
  author: '',
  ownerType: '',
  ownerId: '',
  from: '',
  to: '',
  page: 1,
  pageSize: 20,
  terms: [],
  result: null,
};

/** 条件摘要文案。 */
function conditionSummary(conditions) {
  const parts = [];
  if (conditions.q) parts.push(`关键词「${conditions.q}」`);
  if (conditions.author) parts.push(`作者含「${conditions.author}」`);
  if (conditions.ownerType === 'users') parts.push(`对象=用户 ${conditions.ownerId}`);
  if (conditions.ownerType === 'posts') parts.push(`对象=博文 ${conditions.ownerId}`);
  if (!conditions.ownerType) parts.push('对象=全部');
  if (conditions.fromMs || conditions.toMs) parts.push(rangeText(conditions.fromMs, conditions.toMs));
  return parts.length ? parts.join(' · ') : '（无条件，展示全部本地记录）';
}

/**
 * 搜索页。
 * @param {HTMLElement} root
 */
export async function renderSearch(root) {
  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 class="page-title">本地搜索</h2>
        <div class="page-desc">关键词按空格分词后全部命中；可与作者、对象、日期叠加取交集。<b>0 credits</b>，完全离线。</div>
      </div>
    </div>

    <div class="card">
      <div class="form-row">
        <div class="field" style="flex:2 1 280px">
          <label for="sQ">关键词</label>
          <input class="input" id="sQ" placeholder="多个关键词用空格分隔，例如：路灯 井盖" value="${esc(state.q)}">
        </div>
        <div class="field w-md">
          <label for="sAuthor">作者（昵称 / UID）</label>
          <input class="input" id="sAuthor" placeholder="可选" value="${esc(state.author)}">
        </div>
        <div class="field w-sm">
          <label for="sOwnerType">对象范围</label>
          <select class="select" id="sOwnerType">
            <option value="">全部</option>
            <option value="users">用户</option>
            <option value="posts">博文</option>
          </select>
        </div>
        <div class="field w-md" id="sOwnerWrap" style="display:none">
          <label for="sOwner">具体对象</label>
          <select class="select" id="sOwner"></select>
        </div>
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field w-md">
          <label for="sFrom">起始日期（可选）</label>
          <input class="input" id="sFrom" type="date" value="${esc(state.from)}">
        </div>
        <div class="field w-md">
          <label for="sTo">结束日期（可选，含当天）</label>
          <input class="input" id="sTo" type="date" value="${esc(state.to)}">
        </div>
        <div class="field w-md">
          <label>&nbsp;</label>
          <div class="inline-list">
            <button class="btn btn-primary" id="sGo" type="button">搜索</button>
            <button class="btn" id="sClear" type="button">清空筛选</button>
          </div>
        </div>
      </div>
      <div id="sError"></div>
    </div>

    <div id="sResult"></div>
  `;

  const qInput = root.querySelector('#sQ');
  const authorInput = root.querySelector('#sAuthor');
  const ownerTypeSelect = root.querySelector('#sOwnerType');
  const ownerWrap = root.querySelector('#sOwnerWrap');
  const ownerSelect = root.querySelector('#sOwner');
  const fromInput = root.querySelector('#sFrom');
  const toInput = root.querySelector('#sTo');
  const resultBox = root.querySelector('#sResult');
  const errorBox = root.querySelector('#sError');
  const goBtn = root.querySelector('#sGo');

  ownerTypeSelect.value = state.ownerType;

  /** 对象下拉（按类型切换）。 */
  async function loadOwners() {
    const type = ownerTypeSelect.value;
    if (!type) {
      ownerWrap.style.display = 'none';
      ownerSelect.innerHTML = '';
      return;
    }
    ownerWrap.style.display = '';
    ownerSelect.innerHTML = '<option value="">全部</option>';
    try {
      const data = type === 'users' ? await api('/api/users') : await api('/api/posts');
      const items = type === 'users' ? data.items : data.items;
      ownerSelect.innerHTML =
        '<option value="">全部</option>' +
        items
          .map((item) =>
            type === 'users'
              ? `<option value="${esc(item.uid)}">${esc(item.screenName)}（UID ${esc(item.uid)}）</option>`
              : `<option value="${esc(item.id)}">${esc(item.id)} · ${esc((item.text || '（正文缺失）').slice(0, 26))}</option>`
          )
          .join('');
      if (state.ownerId) ownerSelect.value = state.ownerId;
    } catch (err) {
      toast(err.message || '对象列表加载失败', 'error');
    }
  }

  ownerTypeSelect.addEventListener('change', () => {
    state.ownerType = ownerTypeSelect.value;
    state.ownerId = '';
    void loadOwners();
  });

  /** 执行搜索。 */
  async function doSearch() {
    state.q = qInput.value.trim();
    state.author = authorInput.value.trim();
    state.ownerType = ownerTypeSelect.value;
    state.ownerId = state.ownerType ? ownerSelect.value : '';
    state.from = fromInput.value;
    state.to = toInput.value;
    if (state.from && state.to && state.from > state.to) {
      errorBox.innerHTML = '<div class="form-error">起始日期不能晚于结束日期</div>';
      return;
    }
    errorBox.innerHTML = '';
    state.terms = state.q ? state.q.split(/\s+/).filter(Boolean) : [];
    setBusy(goBtn, true, '搜索中…');
    resultBox.innerHTML = '<div class="card"><div class="skeleton sk-card"></div></div>';
    try {
      state.result = await api('/api/search', {
        method: 'POST',
        body: {
          q: state.q,
          author: state.author || undefined,
          ownerType: state.ownerType || undefined,
          ownerId: state.ownerId || undefined,
          fromMs: state.from || undefined,
          toMs: state.to || undefined,
          page: state.page,
          pageSize: state.pageSize,
        },
      });
      renderResult();
    } catch (err) {
      errorBox.innerHTML = `<div class="form-error">${esc(err.message || '搜索失败')}</div>`;
      resultBox.innerHTML = '';
    } finally {
      setBusy(goBtn, false);
      goBtn.textContent = '搜索';
    }
  }

  /** 渲染结果。 */
  function renderResult() {
    const result = state.result;
    if (!result) {
      resultBox.innerHTML = '';
      return;
    }
    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    const summary = conditionSummary(result.conditions || {});

    if (result.total === 0) {
      resultBox.innerHTML = `<div class="card">
        <div class="empty-state">
          <div class="empty-title">无结果</div>
          <div class="empty-desc">当前生效条件：<br>${esc(summary)}<br>共扫描 0 条匹配记录（耗时 ${fmtNum(
            result.tookMs
          )} ms）。可减少关键词或放宽日期区间。</div>
          <div class="empty-actions"><button class="btn btn-primary" id="sClearEmpty" type="button">一键清空筛选</button></div>
        </div>
      </div>`;
      const clearBtn = resultBox.querySelector('#sClearEmpty');
      if (clearBtn) clearBtn.addEventListener('click', clearAll);
      return;
    }

    const items = result.items
      .map((item) => {
        const target =
          item.ownerType === 'users' ? `/users/${item.ownerId}` : `/posts/${item.ownerId}`;
        return `<article class="rec ${item.isUnread ? 'unread' : ''}">
          <div class="rec-head">
            ${item.isUnread ? '<span class="unread-dot"></span>' : ''}
            <span class="rec-author">${esc(item.author || '未知作者')}</span>
            <span class="rec-time">${esc(item.time || fmtTime(item.ms))}</span>
            <span class="badge badge-primary">${esc(item.type || item.mode || '')}</span>
            <span class="badge">
              ${item.ownerType === 'users' ? '用户' : '博文'}：
              <a href="#${esc(target)}">${esc(item.ownerLabel)}</a>
            </span>
          </div>
          <div class="rec-body">${highlight(item.text || '（无正文）', state.terms)}</div>
          <div class="rec-foot">
            ${item.textTruncated ? '<span>已截断</span>' : ''}
            ${
              item.postUrl && /^https?:\/\//i.test(item.postUrl)
                ? `<a href="${esc(item.postUrl)}" target="_blank" rel="noopener noreferrer">查看原微博</a>`
                : item.postId
                  ? `<span>原微博 ${esc(item.postId)}</span>`
                  : ''
            }
            <button class="btn btn-sm" type="button" data-read="${esc(item.ownerType)}|${esc(item.ownerId)}|${esc(
              item.recordId
            )}" ${item.isUnread ? '' : 'disabled'}>${item.isUnread ? '标记已读' : '已读'}</button>
          </div>
        </article>`;
      })
      .join('');

    resultBox.innerHTML = `<div class="card">
      <div class="card-head">
        <h3 class="card-title">命中 ${result.total} 条</h3>
        <span class="badge">耗时 ${fmtNum(result.tookMs)} ms</span>
        <span class="badge">0 credits</span>
        <div class="card-sub" style="width:100%">条件：${esc(summary)}</div>
      </div>
      <div class="rec-list">${items}</div>
      ${
        totalPages > 1
          ? `<div class="pager">
              <button class="btn btn-sm" data-page="prev" ${result.page <= 1 ? 'disabled' : ''}>上一页</button>
              <span>第 ${result.page} / ${totalPages} 页</span>
              <button class="btn btn-sm" data-page="next" ${result.page >= totalPages ? 'disabled' : ''}>下一页</button>
            </div>`
          : ''
      }
    </div>`;

    for (const button of resultBox.querySelectorAll('[data-page]')) {
      button.addEventListener('click', () => {
        state.page = button.dataset.page === 'next' ? state.page + 1 : state.page - 1;
        void doSearch();
      });
    }
    for (const button of resultBox.querySelectorAll('[data-read]')) {
      button.addEventListener('click', async () => {
        const [ownerType, ownerId, recordId] = button.dataset.read.split('|');
        setBusy(button, true, '…');
        try {
          const res = await api(`/api/owners/${ownerType}/${ownerId}/read`, {
            method: 'POST',
            body: { ids: [recordId] },
          });
          toast(`已标记已读，剩余未读 ${res.unreadTotal} 条`, 'ok');
          await doSearch();
        } catch (err) {
          toast(err.message || '标记失败', 'error');
          setBusy(button, false);
        }
      });
    }
  }

  /** 清空全部筛选并重查。 */
  function clearAll() {
    qInput.value = '';
    authorInput.value = '';
    ownerTypeSelect.value = '';
    fromInput.value = '';
    toInput.value = '';
    state.ownerType = '';
    state.ownerId = '';
    ownerWrap.style.display = 'none';
    state.page = 1;
    void doSearch();
  }

  goBtn.addEventListener('click', () => {
    state.page = 1;
    void doSearch();
  });
  root.querySelector('#sClear').addEventListener('click', clearAll);
  for (const input of [qInput, authorInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        state.page = 1;
        void doSearch();
      }
    });
  }

  await loadOwners();
  void doSearch();
}
