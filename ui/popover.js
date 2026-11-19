import {
  createI18nHelper,
  escapeHtml,
  formatNumber,
  formatTokens,
  formatUsd,
  modelIconPath,
  normalizeDailyTrends,
  normalizeTodayHourlyPoints,
  renderBarChartSvg,
  renderQuotaRowsHtml,
  tierBadgeHtml,
} from './shared.js';

const state = {
  tab: 'usage', // usage | quota | accounts
  period: 'today',
  metric: 'tokens',
  showAllModels: false,
  expandedIds: new Set(),
  activeLocale: 'zh-Hans',
  i18nPacks: {},
  config: {},
  statusPayload: null,
  usageReport: null,
  accountsPayload: null,
};

const t = createI18nHelper(() => state);

function renderTabs() {
  const tabs = document.getElementById('pop-tabs');
  const labels = {
    usage: t('menu_panel.tab.usage', null, '用量'),
    quota: t('menu_panel.tab.quota', null, '配额'),
    accounts: t('menu_panel.tab.accounts', null, '账号'),
  };
  tabs.querySelectorAll('button').forEach(btn => {
    const id = btn.getAttribute('data-tab');
    btn.textContent = labels[id] || id;
    btn.classList.toggle('active', state.tab === id);
  });
  document.getElementById('pop-refresh').textContent = t('common.refresh', null, '刷新');
  document.getElementById('pop-open-ag').textContent = t('sidebar.open_antigravity', null, '打开 Antigravity');
  document.getElementById('pop-open-main').textContent = t('menu_panel.footer.open_main', null, '打开主界面 ↗');
}

function debugBanner() {
  const s = state.statusPayload?.status;
  if (!s || s.mode !== 'debug-port-missing') return '';
  const busy = Boolean(state.relaunchBusy);
  const label = busy
    ? t('assistant.safe_relaunch_busy', null, '正在安全重启 Antigravity…')
    : t('assistant.safe_relaunch_btn', null, '安全重启 Antigravity 以连接');
  return `
    <div class="banner banner-warn" style="padding:9px 11px;margin-bottom:10px;flex-direction:column;align-items:flex-start;gap:6px">
      <div class="banner-title">${escapeHtml(t('status.debug_port_missing', null, '未开启调试端口'))}</div>
      <div class="banner-body">${escapeHtml(t('debug_port_missing.banner_body', null, '检测到 Antigravity 已运行但未开启调试端口。'))}</div>
      <button class="btn btn-primary btn-sm" id="pop-safe-relaunch" ${busy ? 'disabled' : ''}>${escapeHtml(label)}</button>
    </div>
  `;
}

function renderUsageTab(root) {
  const rep = state.usageReport || {};
  const s = rep.summary || rep;
  const models = Array.isArray(rep.byModel) ? rep.byModel : [];
  const visibleModels = state.showAllModels ? models : models.slice(0, 3);
  const maxTokens = Math.max(1, ...models.map(m => m.totalTokens || 0));
  const totalTokens = Number(s.totalTokens ?? s.total_tokens ?? 0);
  const requestCount = Number(s.requestCount ?? s.request_count ?? 0);
  const estimatedUsd = Number(s.estimatedUsd ?? s.estimated_usd ?? rep.totalEstimatedUsd ?? 0);
  const cacheHitRate = Number(s.cacheHitRate ?? 0);
  const periods = [
    { id: 'today', label: t('menu_panel.period.today', null, '今日') },
    { id: '7d', label: t('menu_panel.period.7d', null, '近 7 天') },
    { id: '30d', label: t('menu_panel.period.30d', null, '近 30 天') },
    { id: 'all', label: t('menu_panel.period.all', null, '全部') },
  ];

  const trendSrc = state.period === 'today'
    ? normalizeTodayHourlyPoints(rep.todayHourly, 6)
    : normalizeDailyTrends(rep);

  root.innerHTML = `
    ${debugBanner()}
    <div class="segmented" id="pop-periods" style="width:100%;display:grid;grid-template-columns:repeat(4,1fr);margin-bottom:9px">
      ${periods.map(p => `<button data-p="${p.id}" class="${state.period === p.id ? 'active' : ''}">${escapeHtml(p.label)}</button>`).join('')}
    </div>
    <div class="tile-grid-2">
      <div class="mini-tile">
        <div class="mini-tile-label">${escapeHtml(t('menu_panel.tile.tokens', null, 'Token 用量'))}</div>
        <div class="mini-tile-val tabular">${escapeHtml(formatTokens(totalTokens))}</div>
      </div>
      <div class="mini-tile">
        <div class="mini-tile-label">${escapeHtml(t('menu_panel.tile.requests', null, '请求数'))}</div>
        <div class="mini-tile-val tabular">${escapeHtml(formatNumber(requestCount))}</div>
      </div>
      <div class="mini-tile">
        <div class="mini-tile-label">${escapeHtml(t('menu_panel.tile.cost', null, 'API 费用估算'))}</div>
        <div class="mini-tile-val tabular">${escapeHtml(formatUsd(estimatedUsd))}</div>
      </div>
      <div class="mini-tile">
        <div class="mini-tile-label">${escapeHtml(t('menu_panel.tile.cache', null, '缓存命中率'))}</div>
        <div class="mini-tile-val tabular">${cacheHitRate.toFixed(1)}%</div>
      </div>
    </div>

    <div class="card" style="margin-top:9px;padding:11px 12px">
      <div class="account-head">
        <strong style="font-size:12.5px">${escapeHtml(t('menu_panel.trend.today', null, '趋势'))}</strong>
        <div class="segmented" id="pop-metric">
          <button data-m="tokens" class="${state.metric === 'tokens' ? 'active' : ''}">Token</button>
          <button data-m="requests" class="${state.metric === 'requests' ? 'active' : ''}">${escapeHtml(t('menu_panel.dim.requests', null, '请求'))}</button>
        </div>
      </div>
      <div id="pop-trend-chart" style="margin-top:6px"></div>
    </div>

    <div class="card" style="margin-top:9px;padding:11px 12px">
      <div class="account-head" style="margin-bottom:6px">
        <strong style="font-size:12.5px">${escapeHtml(t('menu_panel.models_header', null, '模型用量'))}</strong>
        <span class="muted xs">${models.length} 个模型</span>
      </div>
      ${visibleModels.length === 0
        ? `<div class="muted xs" style="padding:10px 0">${escapeHtml(t('menu_panel.models_empty', null, '暂无记录'))}</div>`
        : visibleModels.map(m => {
            const w = Math.max(3, Math.round(((m.totalTokens || 0) / maxTokens) * 100));
            return `
              <div style="padding:5px 0">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px">
                  <span style="display:flex;align-items:center;gap:6px;min-width:0">
                    <img src="${modelIconPath(m.model)}" style="width:14px;height:14px" alt="" />
                    <span class="truncate small" style="font-weight:600">${escapeHtml(m.model)}</span>
                  </span>
                  <span class="tabular small" style="font-weight:600">${escapeHtml(formatTokens(m.totalTokens))}</span>
                </div>
                <div class="progress-track" style="height:4px"><div class="progress-fill" style="width:${w}%"></div></div>
              </div>
            `;
          }).join('')}
      ${models.length > 3 ? `<button class="btn btn-sm" id="pop-toggle-models" style="margin-top:6px;width:100%">${state.showAllModels ? t('menu_panel.collapse_other_models', null, '收起其余模型') : t('menu_panel.expand_n_models', { count: models.length - 3 }, `展开其余 ${models.length - 3} 个模型`)}</button>` : ''}
    </div>
  `;

  renderBarChartSvg(document.getElementById('pop-trend-chart'), trendSrc, { metric: state.metric, height: 112 });
  root.querySelectorAll('#pop-periods button').forEach(b => b.addEventListener('click', () => {
    state.period = b.getAttribute('data-p');
    void loadUsage();
  }));
  root.querySelectorAll('#pop-metric button').forEach(b => b.addEventListener('click', () => {
    state.metric = b.getAttribute('data-m');
    renderUsageTab(root);
  }));
  document.getElementById('pop-toggle-models')?.addEventListener('click', () => {
    state.showAllModels = !state.showAllModels;
    renderUsageTab(root);
  });
}

function renderQuotaTab(root) {
  const payload = state.accountsPayload || {};
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const activeId = payload.activeId || payload.currentAccountId || '';
  const active = accounts.find(a => a.id === activeId) || accounts[0];
  if (!active) {
    root.innerHTML = `
      ${debugBanner()}
      <div class="card" style="text-align:center;padding:24px 14px">
        <div style="font-weight:600;margin-bottom:6px">${escapeHtml(t('menu_panel.quota.no_saved', null, '尚未保存账号'))}</div>
        <div class="muted small" style="margin-bottom:12px">${escapeHtml(t('menu_panel.quota.empty_hint', null, '前往账号页保存当前账号或添加备用账号'))}</div>
        <button class="btn btn-primary btn-sm" id="pop-go-accounts">${escapeHtml(t('menu_panel.quota.go_add_account', null, '前往账号页添加…'))}</button>
      </div>
    `;
    document.getElementById('pop-go-accounts')?.addEventListener('click', () => {
      void window.gravitybox.openMainWindow('accounts');
    });
    return;
  }

  root.innerHTML = `
    ${debugBanner()}
    <div class="card" style="padding:12px">
      <div style="display:flex;align-items:center;gap:7px">
        <strong style="font-size:15px">${escapeHtml(active.name || active.email)}</strong>
        ${tierBadgeHtml(active.subscription_tier)}
      </div>
      <div class="muted xs truncate" style="margin-top:2px">${escapeHtml(active.email)}</div>
      ${renderQuotaRowsHtml(active, t)}
    </div>
  `;
}

function renderAccountsTab(root) {
  const payload = state.accountsPayload || {};
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const activeId = payload.activeId || payload.currentAccountId || '';
  root.innerHTML = `
    ${debugBanner()}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span class="small" style="font-weight:600">${escapeHtml(t('menu_panel.tab.accounts', null, '已保存账号'))}</span>
      <span class="muted xs">${accounts.length} 个账号</span>
    </div>
    ${accounts.length === 0
      ? `<div class="card" style="text-align:center;padding:22px"><div class="muted small">${escapeHtml(t('menu_panel.quota.no_saved', null, '尚未保存账号'))}</div></div>`
      : accounts.map(acc => {
          const isActive = acc.id === activeId;
          const expanded = state.expandedIds.has(acc.id) || isActive;
          return `
            <div class="card account-card ${isActive ? 'active' : ''}" style="padding:11px 12px;margin-top:8px">
              <div class="account-head">
                <div style="min-width:0">
                  <div style="display:flex;align-items:center;gap:6px">
                    <strong class="truncate">${escapeHtml(acc.name || acc.email)}</strong>
                    ${tierBadgeHtml(acc.subscription_tier)}
                  </div>
                  <div class="muted xs truncate">${escapeHtml(acc.email)}</div>
                </div>
                <button class="btn btn-sm pop-expand-acc" data-id="${escapeHtml(acc.id)}">${expanded ? '▴' : '▾'}</button>
              </div>
              ${expanded ? renderQuotaRowsHtml(acc, t) : ''}
              ${expanded ? `<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px">
                <button class="btn btn-sm pop-refresh-one" data-id="${escapeHtml(acc.id)}">${escapeHtml(t('common.refresh_quota', null, '刷新配额'))}</button>
                ${!isActive ? `<button class="btn btn-primary btn-sm pop-open-switch">${escapeHtml(t('accounts.switch_btn', null, '切换'))}</button>` : ''}
              </div>` : ''}
            </div>
          `;
        }).join('')}
  `;

  root.querySelectorAll('.pop-expand-acc').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    if (state.expandedIds.has(id)) state.expandedIds.delete(id);
    else state.expandedIds.add(id);
    renderAccountsTab(root);
  }));
  root.querySelectorAll('.pop-refresh-one').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    await window.gravitybox.rpc('quota_refresh', { id: b.getAttribute('data-id') });
    await loadAccounts();
  }));
  root.querySelectorAll('.pop-open-switch').forEach(b => b.addEventListener('click', () => {
    void window.gravitybox.openMainWindow('accounts');
  }));
}

function renderBody() {
  const root = document.getElementById('pop-body');
  if (state.tab === 'usage') renderUsageTab(root);
  else if (state.tab === 'quota') renderQuotaTab(root);
  else renderAccountsTab(root);

  document.getElementById('pop-safe-relaunch')?.addEventListener('click', async () => {
    if (state.relaunchBusy) return;
    state.relaunchBusy = true;
    const btn = document.getElementById('pop-safe-relaunch');
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('assistant.safe_relaunch_busy', null, '正在安全重启 Antigravity…');
    }
    try {
      await window.gravitybox.safeRelaunchAntigravity();
    } finally {
      state.relaunchBusy = false;
      renderBody();
    }
  });
}

async function loadUsage() {
  const res = await window.gravitybox.rpc('usage_summary', { period: state.period });
  if (res?.ok) {
    state.usageReport = res;
    if (state.tab === 'usage') renderBody();
  }
}

async function loadAccounts() {
  const res = await window.gravitybox.rpc('account_list');
  if (res?.ok) {
    state.accountsPayload = res;
    if (state.tab !== 'usage') renderBody();
  }
}

async function bootstrap() {
  const initial = await window.gravitybox.getState();
  state.i18nPacks = initial.i18nPacks || {};
  state.config = initial.config || {};
  state.activeLocale = initial.activeLocale || 'zh-Hans';
  state.statusPayload = initial.status || null;

  renderTabs();
  renderBody();

  document.getElementById('pop-tabs').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tab = btn.getAttribute('data-tab');
      renderTabs();
      renderBody();
      if (state.tab === 'usage') void loadUsage();
      else void loadAccounts();
    });
  });

  document.getElementById('pop-refresh').addEventListener('click', () => {
    if (state.tab === 'usage') void loadUsage();
    else void loadAccounts();
  });
  document.getElementById('pop-settings').addEventListener('click', () => void window.gravitybox.openMainWindow('settings'));
  document.getElementById('pop-open-ag').addEventListener('click', () => void window.gravitybox.openAntigravity());
  document.getElementById('pop-open-main').addEventListener('click', () => {
    const map = { usage: 'usage', quota: 'overview', accounts: 'accounts' };
    void window.gravitybox.openMainWindow(map[state.tab] || 'overview');
  });

  window.gravitybox.onStatus(p => {
    state.statusPayload = p;
  });
  window.gravitybox.onConfig(cfg => {
    state.config = cfg;
    void window.gravitybox.getState().then(s => {
      state.activeLocale = s.activeLocale;
      renderTabs();
      renderBody();
    });
  });

  await Promise.all([loadUsage(), loadAccounts()]);
}

void bootstrap();
