export function createI18nHelper(getState) {
  return function t(key, params, fallback) {
    const state = getState();
    const locale = state.activeLocale === 'en' ? 'en' : 'zh-Hans';
    const packs = state.i18nPacks || {};
    let tpl = packs[locale]?.app?.[key] ?? packs.en?.app?.[key] ?? fallback ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        tpl = tpl.replaceAll(`{${k}}`, String(v ?? ''));
      }
    }
    return tpl;
  };
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1e9) return `${(num / 1e9).toFixed(num >= 1e10 ? 0 : 1)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return String(Math.round(num));
}

export function formatNumber(n) {
  return (Number(n) || 0).toLocaleString();
}

export function formatUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '$0.00';
  return `$${num.toFixed(2)}`;
}

export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

export function formatTimestampShort(epochSec) {
  if (!epochSec) return '';
  const ms = epochSec < 1e11 ? epochSec * 1000 : epochSec;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${h}:${min}`;
}

export function modelIconPath(modelOrGroup) {
  const lower = String(modelOrGroup || '').toLowerCase();
  if (lower.includes('claude')) return '../assets/model-icons/claude.png';
  if (lower.includes('gpt') || lower.includes('openai')) return '../assets/model-icons/openai.png';
  return '../assets/model-icons/gemini.png';
}

export function tierBadgeHtml(tier) {
  const clean = String(tier || 'FREE');
  const cls = /ULTRA|ENTERPRISE/i.test(clean)
    ? 'pill-blue'
    : /PRO|PLUS|TEAM/i.test(clean)
    ? 'pill-blue'
    : '';
  return `<span class="pill ${cls}">${escapeHtml(clean)}</span>`;
}

export function renderQuotaRowsHtml(account, t) {
  if (!account) return '';
  const fw = account.familyWindows || {};
  const argon = account.argonStatus || {};
  const carbon = account.carbonStatus || {};
  const standalone = Array.isArray(account.standaloneModels) ? account.standaloneModels : [];

  const rows = [];
  const pushWindow = (label, icon, win) => {
    if (!win) return;
    const pct = typeof win.remaining === 'number'
      ? Math.round((win.remaining <= 1 ? win.remaining * 100 : win.remaining))
      : null;
    const reset = win.resetCountdown || '';
    rows.push({ label, icon, pct, reset });
  };

  if (fw.gemini) {
    pushWindow(`Gemini · ${t('common.period.5h', null, '5 小时')}`, 'gemini', fw.gemini.fiveHour);
    pushWindow(`Gemini · ${t('common.period.weekly', null, '每周')}`, 'gemini', fw.gemini.weekly);
  }
  if (fw.claude) {
    pushWindow(`Claude/GPT · ${t('common.period.5h', null, '5 小时')}`, 'claude', fw.claude.fiveHour);
    pushWindow(`Claude/GPT · ${t('common.period.weekly', null, '每周')}`, 'claude', fw.claude.weekly);
  }

  // Fallback to legacy top-level fields if familyWindows wasn't populated
  if (rows.length === 0) {
    if (account.geminiFiveHourRemaining != null) {
      rows.push({ label: `Gemini · ${t('common.period.5h', null, '5 小时')}`, icon: 'gemini', pct: Math.round(account.geminiFiveHourRemaining), reset: account.geminiFiveHourResetCountdown || '' });
    }
    if (account.geminiWeeklyRemaining != null) {
      rows.push({ label: `Gemini · ${t('common.period.weekly', null, '每周')}`, icon: 'gemini', pct: Math.round(account.geminiWeeklyRemaining), reset: account.geminiWeeklyResetCountdown || '' });
    }
    if (account.claudeFiveHourRemaining != null) {
      rows.push({ label: `Claude/GPT · ${t('common.period.5h', null, '5 小时')}`, icon: 'claude', pct: Math.round(account.claudeFiveHourRemaining), reset: account.claudeFiveHourResetCountdown || '' });
    }
    if (account.claudeWeeklyRemaining != null) {
      rows.push({ label: `Claude/GPT · ${t('common.period.weekly', null, '每周')}`, icon: 'claude', pct: Math.round(account.claudeWeeklyRemaining), reset: account.claudeWeeklyResetCountdown || '' });
    }
  }

  const standaloneRows = [];
  if (argon?.availability === 'available' && typeof argon.remaining === 'number') {
    const periodLabel = argon.period === '5h'
      ? t('common.period.5h', null, '5 小时')
      : argon.period === 'weekly'
      ? t('common.period.weekly', null, '每周')
      : '';
    standaloneRows.push({
      label: `Gemini 4 Argon${periodLabel ? ` · ${periodLabel}` : ''}`,
      icon: 'gemini',
      pct: Math.round(argon.remaining <= 1 ? argon.remaining * 100 : argon.remaining),
      reset: argon.resetCountdown || '',
    });
  }
  if (carbon?.availability === 'available' && typeof carbon.remaining === 'number') {
    const periodLabel = carbon.period === '5h'
      ? t('common.period.5h', null, '5 小时')
      : carbon.period === 'weekly'
      ? t('common.period.weekly', null, '每周')
      : '';
    standaloneRows.push({
      label: `Gemini 4 Carbon${periodLabel ? ` · ${periodLabel}` : ''}`,
      icon: 'gemini',
      pct: Math.round(carbon.remaining <= 1 ? carbon.remaining * 100 : carbon.remaining),
      reset: carbon.resetCountdown || '',
    });
  }
  for (const m of standalone) {
    if (!m || typeof m.remaining !== 'number') continue;
    const label = m.displayName || m.name || m.id || 'Model';
    if (standaloneRows.some(r => r.label.startsWith(label))) continue;
    standaloneRows.push({
      label,
      icon: label.toLowerCase().includes('claude') ? 'claude' : 'gemini',
      pct: Math.round(m.remaining <= 1 ? m.remaining * 100 : m.remaining),
      reset: m.resetCountdown || '',
    });
  }

  const renderRow = (r) => {
    const pct = r.pct;
    const known = typeof pct === 'number' && Number.isFinite(pct);
    const clamped = known ? Math.max(0, Math.min(100, pct)) : 0;
    const stateCls = !known ? '' : clamped <= 10 ? 'low' : clamped <= 25 ? 'mid' : '';
    const iconSrc = r.icon === 'claude' ? '../assets/model-icons/claude.png' : '../assets/model-icons/gemini.png';
    return `
      <div class="quota-item">
        <div class="quota-item-head">
          <span class="quota-item-label">
            <img src="${iconSrc}" alt="" />
            <span class="truncate">${escapeHtml(r.label)}</span>
          </span>
          <span class="quota-item-meta">
            ${r.reset ? `<span class="quota-reset">${escapeHtml(r.reset)}</span>` : ''}
            <span class="quota-pct tabular ${stateCls}">${known ? `${clamped}%` : '--'}</span>
          </span>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${stateCls}" style="width: ${known ? Math.max(clamped, clamped > 0 ? 2 : 0) : 0}%"></div>
        </div>
      </div>
    `;
  };

  if (rows.length === 0 && standaloneRows.length === 0) {
    return `<div class="muted small" style="margin-top:10px">${escapeHtml(t('menu_panel.quota.no_record', null, '尚未取得配额记录'))}</div>`;
  }
  return `
    <div class="quota-grid">${rows.map(renderRow).join('')}</div>
    ${standaloneRows.length ? `<div class="quota-grid" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-subtle)">${standaloneRows.map(renderRow).join('')}</div>` : ''}
  `;
}

export function parseHourlyBucketIndex(rawHour) {
  if (typeof rawHour === 'number' && Number.isFinite(rawHour)) {
    const h = Math.floor(rawHour);
    return h >= 0 && h <= 23 ? h : null;
  }
  const str = String(rawHour ?? '').trim();
  const match = str.match(/(?:^|\s)(\d{1,2})(?::\d{2})?$/);
  if (!match) return null;
  const h = Number(match[1]);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

export function normalizeTodayHourlyPoints(rawHourly, tickEvery = 4) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    hourNum: hour,
    label: `${String(hour).padStart(2, '0')}时`,
    shortLabel: hour % tickEvery === 0 || hour === 23 ? `${String(hour).padStart(2, '0')}时` : '',
    tooltipLabel: `${String(hour).padStart(2, '0')}:00`,
    tokens: 0,
    requests: 0,
  }));
  if (Array.isArray(rawHourly)) {
    for (const item of rawHourly) {
      if (!item || typeof item !== 'object') continue;
      const idx = parseHourlyBucketIndex(item.hour);
      if (idx === null) continue;
      buckets[idx].tokens += Number(item.total_tokens ?? item.totalTokens ?? item.tokens ?? 0) || 0;
      buckets[idx].requests += Number(item.request_count ?? item.requestCount ?? item.requests ?? 0) || 0;
    }
  }
  return buckets;
}

export function normalizeDailyTrends(rep) {
  const raw = Array.isArray(rep?.dailyTrends)
    ? rep.dailyTrends
    : (Array.isArray(rep?.dailyBreakdown) ? rep.dailyBreakdown : []);
  return raw.map(d => ({
    label: String(d?.date ?? ''),
    shortLabel: typeof d?.date === 'string' && d.date.length >= 10 ? d.date.slice(5) : String(d?.date ?? ''),
    tooltipLabel: String(d?.date ?? ''),
    tokens: Number(d?.total_tokens ?? d?.totalTokens ?? d?.tokens ?? 0) || 0,
    requests: Number(d?.request_count ?? d?.requestCount ?? d?.requests ?? 0) || 0,
  }));
}

export function renderBarChartSvg(container, points, { metric = 'tokens', height = 132 } = {}) {
  if (!container) return;
  if (!Array.isArray(points) || points.length === 0) {
    container.innerHTML = `<div class="muted small" style="padding:28px 0;text-align:center">—</div>`;
    return;
  }
  const values = points.map(p => Number(metric === 'requests' ? (p.requests ?? p.requestCount ?? 0) : (p.tokens ?? p.totalTokens ?? 0)) || 0);
  const actualMax = Math.max(0, ...values);
  const maxVal = Math.max(1, actualMax);
  const w = Math.max(320, container.clientWidth || 380);
  const padL = 40;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = height - padT - padB;
  const step = plotW / points.length;
  const barW = Math.max(4, Math.min(20, step * 0.62));

  const formatY = v => (metric === 'requests' ? String(Math.round(v)) : formatTokens(v));
  const midLabel = actualMax > 1 ? formatY(maxVal / 2) : '';
  const bars = points.map((p, i) => {
    const val = values[i];
    const barH = val > 0 ? Math.max(4, (val / maxVal) * plotH) : 3;
    const x = padL + i * step + (step - barW) / 2;
    const y = padT + plotH - barH;
    const opacity = val > 0 ? 1 : 0.14;
    const fill = val > 0 ? 'url(#gbBarGrad)' : 'currentColor';
    return `<rect class="gb-bar" data-idx="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="${Math.min(3.5, barW / 2).toFixed(1)}" fill="${fill}" opacity="${opacity}" style="cursor:pointer"></rect>`;
  }).join('');

  const labelStep = points.length > 16 ? 4 : points.length > 10 ? 2 : 1;
  const xLabels = points.map((p, i) => {
    if (i !== 0 && i !== points.length - 1 && i % labelStep !== 0) return '';
    const text = p.shortLabel ?? p.label ?? '';
    if (!text) return '';
    const x = padL + i * step + step / 2;
    return `<text x="${x.toFixed(1)}" y="${height - 5}" text-anchor="middle" font-size="10" fill="var(--text-secondary)">${escapeHtml(text)}</text>`;
  }).join('');

  container.innerHTML = `
    <div style="position:relative">
      <svg width="100%" height="${height}" viewBox="0 0 ${w} ${height}" style="display:block;overflow:visible">
        <defs>
          <linearGradient id="gbBarGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#3b82f6"/>
            <stop offset="100%" stop-color="#2563eb"/>
          </linearGradient>
        </defs>
        <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="var(--border-subtle)" stroke-dasharray="3 3"/>
        <line x1="${padL}" y1="${padT + plotH / 2}" x2="${w - padR}" y2="${padT + plotH / 2}" stroke="var(--border-subtle)" stroke-dasharray="3 3"/>
        <line x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" stroke="var(--border-subtle)"/>
        <text x="${padL - 5}" y="${padT + 4}" text-anchor="end" font-size="10" fill="var(--text-secondary)">${escapeHtml(actualMax > 0 ? formatY(maxVal) : '0')}</text>
        ${midLabel ? `<text x="${padL - 5}" y="${padT + plotH / 2 + 3}" text-anchor="end" font-size="10" fill="var(--text-secondary)">${escapeHtml(midLabel)}</text>` : ''}
        <text x="${padL - 5}" y="${padT + plotH + 3}" text-anchor="end" font-size="10" fill="var(--text-secondary)">0</text>
        ${bars}
        ${xLabels}
      </svg>
      <div class="chart-tooltip"></div>
    </div>
  `;

  const tip = container.querySelector('.chart-tooltip');
  container.querySelectorAll('.gb-bar').forEach(bar => {
    bar.addEventListener('mouseenter', e => {
      const idx = Number(bar.getAttribute('data-idx'));
      const p = points[idx];
      if (!p || !tip) return;
      const val = values[idx];
      tip.textContent = `${p.tooltipLabel || p.label || ''} · ${metric === 'requests' ? `${val} req` : `${formatTokens(val)} Token`}`;
      tip.style.display = 'block';
      const rect = container.getBoundingClientRect();
      const bRect = bar.getBoundingClientRect();
      tip.style.left = `${Math.max(4, Math.min(rect.width - 140, bRect.left - rect.left - 20))}px`;
      tip.style.top = `${Math.max(0, bRect.top - rect.top - 26)}px`;
    });
    bar.addEventListener('mouseleave', () => {
      if (tip) tip.style.display = 'none';
    });
  });
}

export const DONUT_PALETTE = ['#2563eb', '#0d9488', '#7c3aed', '#d97706', '#4f46e5', '#db2777'];

export function renderDonutSvg(container, slices, totalLabel, subLabel) {
  if (!container) return;
  const size = 104;
  const r = 39;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const total = slices.reduce((s, x) => s + (Number(x.value) || 0), 0);
  if (total <= 0) {
    container.innerHTML = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg-track)" stroke-width="11"/>
        <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--text-secondary)">$0.00</text>
      </svg>
    `;
    return;
  }
  let offset = 0;
  const arcs = slices.map((s, idx) => {
    const frac = (Number(s.value) || 0) / total;
    const len = Math.max(0, frac * circ - 2);
    const dash = `${len.toFixed(2)} ${(circ - len).toFixed(2)}`;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${DONUT_PALETTE[idx % DONUT_PALETTE.length]}" stroke-width="11" stroke-dasharray="${dash}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += frac * circ;
    return seg;
  }).join('');
  container.innerHTML = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">
      ${arcs}
      <text x="${cx}" y="${cy - 1}" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--text-primary)">${escapeHtml(totalLabel)}</text>
      <text x="${cx}" y="${cy + 13}" text-anchor="middle" font-size="9.5" fill="var(--text-secondary)">${escapeHtml(subLabel)}</text>
    </svg>
  `;
}
