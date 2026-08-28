/* SECTION: app core */
/* 理财管家 - 银行卡理财收益管理（数据保存在浏览器 localStorage） */
(function () {
  'use strict';

  var LS_KEY = 'wealth-manager-data-v3';

  // ---------- 云同步配置（GitHub 私有仓库） ----------
  // 同步密钥不写在代码里（避免泄露），由你在页面第一次使用时粘贴保存到本浏览器
  var SYNC_OWNER = 'lingongzhe';
  var SYNC_REPO = 'wealth-manager-data';
  var SYNC_PATH = 'data.json';
  var SYNC_TOKEN_KEY = 'wealth-manager-sync-token';
  var SYNC_API = 'https://api.github.com/repos/' + SYNC_OWNER + '/' + SYNC_REPO + '/contents/' + SYNC_PATH;
  var syncTimer = null;
  var syncInFlight = false;
  var lastLocalRaw = '';
  function getSyncToken() {
    try { return localStorage.getItem(SYNC_TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function requireSyncToken() {
    var t = getSyncToken();
    if (t) return t;
    var input = prompt('首次使用云同步，请粘贴你的 GitHub 同步密钥（token，就是你创建的那个同步密钥）：');
    if (input && input.trim()) {
      try { localStorage.setItem(SYNC_TOKEN_KEY, input.trim()); } catch (e) {}
      toast('云同步密钥已保存');
      return getSyncToken();
    }
    return '';
  }
  var CARD_PAGE_SIZE = 10;          // 银行卡下拉框每页显示数量
  var cardPage = 0;                 // 下拉框当前页
  var CARD_LAST_KEY = 'wealth-manager-last-card';  // 记住上次选择的银行卡
  var $ = function (id) { return document.getElementById(id); };

  // ---------- 主题（跟随系统 / 浅色 / 深色） ----------
  var THEME_KEY = 'wealth-manager-theme';
  var THEME_MODES = ['auto', 'light', 'dark'];
  var THEME_LABELS = { auto: '跟随系统', light: '浅色', dark: '深色' };

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function getSavedMode() {
    try {
      var m = localStorage.getItem(THEME_KEY);
      return THEME_MODES.indexOf(m) >= 0 ? m : 'auto';
    } catch (e) { return 'auto'; }
  }
  // mode 解析为实际渲染主题
  function resolveTheme(mode) {
    if (mode === 'dark') return 'dark';
    if (mode === 'light') return 'light';
    return systemPrefersDark() ? 'dark' : 'light'; // auto
  }
  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function chartColors() {
    return isDark()
      ? { grid: '#1c2842', zero: '#3a4a6a', label: '#6d7d96' }
      : { grid: '#e8edf4', zero: '#c6cedd', label: '#8fa0b8' };
  }
  function applyMode(mode) {
    var theme = resolveTheme(mode);
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    // 记录当前模式，用于图标与文字显示
    document.documentElement.setAttribute('data-theme-mode', mode);
    var label = $('themeLabel');
    if (label) label.textContent = THEME_LABELS[mode];
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) {}
  }
  function initTheme() {
    applyMode(getSavedMode());

    // 系统主题变化时，若处于跟随系统模式则实时同步
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        if (getSavedMode() === 'auto') { applyMode('auto'); renderChart(); }
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    var btn = $('themeToggle');
    if (btn) btn.addEventListener('click', function () {
      var cur = getSavedMode();
      var next = THEME_MODES[(THEME_MODES.indexOf(cur) + 1) % THEME_MODES.length];
      applyMode(next);
      renderChart(); // 切换主题后重绘图表配色
    });
  }

  // ---------- 工具函数 ----------
  function fmtMoney(v) {
    if (v === null || v === undefined || isNaN(v)) return '--';
    return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtRate(v) {
    if (v === null || v === undefined || isNaN(v)) return '--';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }
  function monthKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function monthLabel(m) { // "2026-08" -> "26年08月"
    var p = m.split('-');
    return p[0].slice(2) + '年' + p[1] + '月';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ---------- 示例数据（已清空） ----------
  function seedData() {
    return { cards: [], records: [] };
  }

  // ---------- 数据存取 ----------
  var state = { cards: [], records: [], scope: 'all', updatedAt: 0 };

  // 内置示例卡片 ID（历史版本曾预置，现需自动清除）
  var SEED_CARD_IDS = ['c_icbc', 'c_cmb', 'c_citic'];

  function loadState() {
    var cleaned = false;
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var obj = JSON.parse(raw);
        if (obj && Array.isArray(obj.cards)) {
          var cards = obj.cards;
          var records = Array.isArray(obj.records) ? obj.records : [];
          // 剔除内置示例卡片及其收益记录
          var hasSeed = cards.some(function (c) { return SEED_CARD_IDS.indexOf(c.id) >= 0; });
          if (hasSeed) {
            cards = cards.filter(function (c) { return SEED_CARD_IDS.indexOf(c.id) < 0; });
            records = records.filter(function (r) { return SEED_CARD_IDS.indexOf(r.cardId) < 0; });
            cleaned = true;
          }
          state.cards = cards;
          state.records = records;
          state.updatedAt = (typeof obj.updatedAt === 'number') ? obj.updatedAt : 0;
          lastLocalRaw = JSON.stringify({ cards: state.cards, records: state.records });
          if (cleaned) saveState();
          return;
        }
      }
    } catch (e) { /* 数据损坏时重置 */ }
    state.cards = [];
    state.records = [];
    state.updatedAt = 0;
    lastLocalRaw = '';
  }
  function saveState() {
    var raw = JSON.stringify({ cards: state.cards, records: state.records });
    if (raw === lastLocalRaw) {
      if (!state.updatedAt) { state.updatedAt = Date.now(); }
      return;
    }
    lastLocalRaw = raw;
    state.updatedAt = Date.now();
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ cards: state.cards, records: state.records, updatedAt: state.updatedAt }));
    } catch (e) {
      toast('保存失败：浏览器本地存储不可用');
    }
    scheduleSync();
  }

  // ---------- 导出 / 导入备份（跨设备迁移数据） ----------
  function doExport() {
    var data = {
      app: 'wealth-manager',
      version: 1,
      exportedAt: new Date().toISOString(),
      cards: state.cards,
      records: state.records
    };
    var text = JSON.stringify(data, null, 2);
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '理财管家备份_' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已导出备份文件');
  }

  function doImport(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var obj = JSON.parse(e.target.result);
        var cards = obj && Array.isArray(obj.cards) ? obj.cards : null;
        var records = Array.isArray(obj.records) ? obj.records : [];
        if (!cards) { toast('备份文件格式不对：未找到卡片数据'); return; }
        if (!confirm('导入将覆盖当前全部数据（共 ' + cards.length + ' 张卡、' + records.length + ' 条记录），确定继续吗？')) return;
        state.cards = cards;
        state.records = records;
        state.scope = 'all';
        saveState(); renderAll();
        toast('导入成功！');
      } catch (err) {
        toast('导入失败：文件格式不正确');
      }
    };
    reader.readAsText(file);
  }

  // ---------- 云同步（GitHub 私有仓库，自动同步电脑/手机数据） ----------
  function setSyncStatus(txt) {
    var el = document.getElementById('syncStatus');
    if (el) el.textContent = txt;
  }
  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 1500);
  }
  function b64Encode(str) {
    try { return btoa(unescape(encodeURIComponent(str))); } catch (e) { return btoa(str); }
  }
  function b64Decode(b64) {
    try { return decodeURIComponent(escape(atob(b64))); } catch (e) { return atob(b64); }
  }
  function syncNow() {
    if (syncInFlight) return;
    var tk = getSyncToken();
    if (!tk) {
      setSyncStatus('☁ 点击配置云同步');
      return;
    }
    syncInFlight = true;
    setSyncStatus('☁ 同步中…');
    fetch(SYNC_API, { headers: { 'Authorization': 'Bearer ' + tk, 'Accept': 'application/vnd.github+json' } })
      .then(function (res) {
        if (res.status === 404) return { notFound: true };
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (remoteFile) {
        var sha = null, remote = null;
        if (remoteFile && !remoteFile.notFound) {
          sha = remoteFile.sha || null;
          try { remote = JSON.parse(b64Decode(remoteFile.content)); } catch (e) { remote = null; }
        }
        var remoteUpdatedAt = (remote && typeof remote.updatedAt === 'number') ? remote.updatedAt : 0;
        var remoteCards = (remote && Array.isArray(remote.cards)) ? remote.cards : [];
        var remoteRecords = (remote && Array.isArray(remote.records)) ? remote.records : [];
        var hasRemote = remote !== null;
        var hasLocal = state.cards.length + state.records.length > 0;
        if (hasRemote && (!hasLocal || remoteUpdatedAt >= state.updatedAt)) {
          state.cards = remoteCards;
          state.records = remoteRecords;
          state.updatedAt = remoteUpdatedAt;
          lastLocalRaw = JSON.stringify({ cards: state.cards, records: state.records });
          try { localStorage.setItem(LS_KEY, JSON.stringify({ cards: state.cards, records: state.records, updatedAt: state.updatedAt })); } catch (e) {}
          renderAll();
          setSyncStatus('☁ 已同步');
          toast('已从云端同步最新数据');
        } else if (hasLocal && (!hasRemote || state.updatedAt > remoteUpdatedAt)) {
          return pushToCloud(sha);
        } else {
          setSyncStatus('☁ 已同步');
        }
      })
      .catch(function () {
        setSyncStatus('⚠ 云同步失败');
      })
      .then(function () { syncInFlight = false; });
  }
  function pushToCloud(existingSha) {
    var tk = getSyncToken();
    if (!tk) { setSyncStatus('☁ 点击配置云同步'); return Promise.resolve(); }
    var payload = { cards: state.cards, records: state.records, updatedAt: state.updatedAt, app: 'wealth-manager' };
    var body = {
      message: 'auto sync ' + new Date().toISOString(),
      content: b64Encode(JSON.stringify(payload))
    };
    if (existingSha) body.sha = existingSha;
    return fetch(SYNC_API, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + tk, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      setSyncStatus('☁ 已同步');
      return true;
    }).catch(function () {
      setSyncStatus('⚠ 云同步失败');
    });
  }

  // ---------- 计算逻辑 ----------
  function cardById(id) {
    for (var i = 0; i < state.cards.length; i++) if (state.cards[i].id === id) return state.cards[i];
    return null;
  }
  // 取某条收益记录对应的本金：优先使用保存时的本金快照，
  // 旧记录（无快照）回退到该卡当前本金，保证向后兼容
  function recordPrincipal(r) {
    if (typeof r.principalSnapshot === 'number' && r.principalSnapshot >= 0) {
      return r.principalSnapshot;
    }
    var c = cardById(r.cardId);
    return c ? c.principal : 0;
  }
  function recordsOf(scope) {
    if (scope === 'all') return state.records.slice();
    return state.records.filter(function (r) { return r.cardId === scope; });
  }
  // 每个自然月的收益率（汇总口径：当月收益合计 ÷ 有记录卡的本金合计）
  function monthlyRates(scope) {
    var recs = recordsOf(scope);
    var byMonth = {};
    recs.forEach(function (r) {
      if (!byMonth[r.month]) byMonth[r.month] = { income: 0, principal: 0, seen: {} };
      byMonth[r.month].income += r.amount;
      if (!byMonth[r.month].seen[r.cardId]) {
        byMonth[r.month].seen[r.cardId] = true;
        byMonth[r.month].principal += recordPrincipal(r);
      }
    });
    var months = Object.keys(byMonth).sort();
    return months.map(function (m) {
      var d = byMonth[m];
      return {
        month: m,
        income: d.income,
        principal: d.principal,
        rate: d.principal > 0 ? d.income / d.principal * 100 : 0
      };
    });
  }
  // 截止当前月年化收益率 = 累计收益 ÷ 本金 ÷ 已记月数 × 12
  function ytdAnnualized(monthsData) {
    if (!monthsData.length) return null;
    var totalIncome = 0;
    monthsData.forEach(function (d) { totalIncome += d.income; });
    var avgPrincipal = monthsData.reduce(function (s, d) { return s + d.principal; }, 0) / monthsData.length;
    if (avgPrincipal <= 0) return null;
    return totalIncome / avgPrincipal / monthsData.length * 12 * 100;
  }
  // 预测全年年化收益率 = 平均月度收益率 × 12（线性外推）
  function forecastAnnualized(monthsData) {
    if (!monthsData.length) return null;
    var avg = monthsData.reduce(function (s, d) { return s + d.rate; }, 0) / monthsData.length;
    return avg * 12;
  }
  // 单卡某月收益率（用于卡片列表展示最近月份）
  function lastRateOfCard(cardId) {
    var recs = state.records.filter(function (r) { return r.cardId === cardId; });
    if (!recs.length) return null;
    recs.sort(function (a, b) { return a.month < b.month ? 1 : -1; });
    var p = recordPrincipal(recs[0]);
    if (p <= 0) return null;
    return recs[0].amount / p * 100;
  }

  // ---------- 渲染：总览 ----------
  function renderStats() {
    var total = state.cards.reduce(function (s, c) { return s + c.principal; }, 0);
    $('statTotal').textContent = '¥' + fmtMoney(total);

    var nowKey = monthKey(new Date());
    var monthRecs = state.records.filter(function (r) { return r.month === nowKey; });
    var monthIncome = monthRecs.reduce(function (s, r) { return s + r.amount; }, 0);
    $('statMonth').textContent = (monthIncome >= 0 ? '+¥' : '-¥') + fmtMoney(Math.abs(monthIncome));
    $('statMonthHint').textContent = nowKey.replace('-', '年') + '月 · 共 ' + monthRecs.length + ' 笔记录';

    var md = monthlyRates('all');
    var ytd = ytdAnnualized(md);
    $('statYtd').textContent = ytd === null ? '--' : fmtRate(ytd);

    var fc = forecastAnnualized(md);
    $('statForecast').textContent = fc === null ? '--' : fmtRate(fc);
  }

  // ---------- 渲染：银行卡列表 ----------
  var AVATAR_COLORS = [
    ['#143a6b', '#1c4a86'], ['#7a5c1e', '#b8862f'], ['#2a5d4f', '#3d7a68'],
    ['#5d3a6b', '#7d5590'], ['#6b3a3a', '#905555'], ['#33526b', '#4a718f']
  ];
  function renderCards() {
    var list = $('cardList');
    list.innerHTML = '';
    if (!state.cards.length) {
      list.innerHTML = '<li class="empty-tip">还没有银行卡。<br>点击右上角「＋ 添加银行卡」开始管理你的理财资产。</li>';
      return;
    }
    state.cards.forEach(function (card) {
      var li = document.createElement('li');
      li.className = 'bank-card';
      var colors = AVATAR_COLORS[card.color % AVATAR_COLORS.length];
      var abbr = (card.bank || card.name).slice(0, 2);
      var rate = lastRateOfCard(card.id);
      var rateHtml = rate === null
        ? '<span class="bank-rate">暂无收益记录</span>'
        : '<span class="bank-rate">最近月收益率 <b class="' + (rate >= 0 ? 'up' : 'down') + '">' + fmtRate(rate) + '</b></span>';
      li.innerHTML =
        '<div class="bank-avatar" style="background:linear-gradient(135deg,' + colors[0] + ',' + colors[1] + ')">' + escapeHtml(abbr) + '</div>' +
        '<div class="bank-info">' +
          '<div class="bank-name">' + escapeHtml(card.name) + '</div>' +
          '<div class="bank-meta"><span>' + escapeHtml(card.bank || '未填银行') + '</span><span>理财金额 <b>¥' + fmtMoney(card.principal) + '</b></span></div>' +
          rateHtml +
        '</div>' +
        '<div class="bank-actions">' +
          '<button class="icon-btn" data-edit="' + card.id + '" title="编辑">✎</button>' +
          '<button class="icon-btn danger" data-del="' + card.id + '" title="删除">✕</button>' +
        '</div>';
      list.appendChild(li);
    });
  }

  // ---------- 渲染：收益明细 ----------
  function renderDetail() {
    var body = $('detailBody');
    var recs = state.records.slice().sort(function (a, b) {
      return a.month === b.month ? 0 : (a.month < b.month ? 1 : -1);
    });
    body.innerHTML = '';
    $('detailEmpty').style.display = recs.length ? 'none' : 'block';
    $('detailCount').textContent = recs.length ? '共 ' + recs.length + ' 条' : '';
    recs.forEach(function (r) {
      var c = cardById(r.cardId);
      var principal = recordPrincipal(r);
      var rate = principal > 0 ? r.amount / principal * 100 : 0;
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + monthLabel(r.month) + '</td>' +
        '<td>' + escapeHtml(c ? c.name : '（已删除卡片）') + '</td>' +
        '<td class="amt">' + (r.amount >= 0 ? '+' : '') + fmtMoney(r.amount) + '</td>' +
        '<td>' + fmtMoney(principal) + '</td>' +
        '<td><span class="rate ' + (rate >= 0 ? 'up' : 'down') + '">' + fmtRate(rate) + '</span></td>' +
        '<td><button class="icon-btn danger" data-delrec="' + r.id + '" title="删除记录">✕</button></td>';
      body.appendChild(tr);
    });
  }

  // ---------- 渲染：范围选择 ----------
  function renderScopeSelect() {
    var sel = $('chartScope');
    var prev = state.scope;
    sel.innerHTML = '<option value="all">全部银行卡（汇总）</option>';
    state.cards.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      sel.appendChild(opt);
    });
    if (prev === 'all' || cardById(prev)) sel.value = prev;
    else { sel.value = 'all'; state.scope = 'all'; }
  }

  // ---------- 渲染：折线图（SVG） ----------
  var chartPoints = [];
  function renderChart() {
    var svg = $('chartSvg');
    var tip = $('chartTip');
    var empty = $('chartEmpty');
    var statsBox = $('chartStats');
    svg.innerHTML = '';
    tip.style.opacity = 0;
    chartPoints = [];

    var md = monthlyRates(state.scope);
    if (!md.length) {
      svg.style.display = 'none';
      empty.style.display = 'block';
      empty.innerHTML = state.cards.length
        ? '当前范围内暂无收益记录。<br>请先在左侧录入收益，图表将自动生成。'
        : '请先添加银行卡并录入收益，<br>这里会展示月度收益率走势。';
      statsBox.innerHTML = '';
      return;
    }
    svg.style.display = 'block';
    empty.style.display = 'none';

    var W, H, mL, mR, mT, mB, fs;
    if (window.innerWidth <= 560) {
      // 手机：收窄坐标系，加大相对字号
      W = 400; H = 300; mL = 46; mR = 12; mT = 16; mB = 36; fs = 13;
    } else {
      W = 800; H = 340; mL = 58; mR = 24; mT = 24; mB = 44; fs = 11;
    }
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var plotW = W - mL - mR, plotH = H - mT - mB;
    var cc = chartColors();

    var rates = md.map(function (d) { return d.rate; });
    var lo = Math.min.apply(null, rates.concat([0]));
    var hi = Math.max.apply(null, rates.concat([0]));
    if (hi === lo) { hi = lo + 1; }
    var pad = (hi - lo) * 0.15;
    lo -= pad; hi += pad;

    function xPos(i) {
      return md.length === 1 ? mL + plotW / 2 : mL + plotW * i / (md.length - 1);
    }
    function yPos(v) { return mT + plotH * (1 - (v - lo) / (hi - lo)); }

    // 网格与 Y 轴刻度
    var gridN = 4;
    for (var g = 0; g <= gridN; g++) {
      var val = lo + (hi - lo) * g / gridN;
      var y = yPos(val);
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', mL); line.setAttribute('x2', W - mR);
      line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.setAttribute('stroke', Math.abs(val) < 0.001 ? cc.zero : cc.grid);
      line.setAttribute('stroke-width', Math.abs(val) < 0.001 ? 1.4 : 1);
      if (Math.abs(val) >= 0.001) line.setAttribute('stroke-dasharray', '4 4');
      svg.appendChild(line);
      var txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', mL - 6); txt.setAttribute('y', y + 4);
      txt.setAttribute('text-anchor', 'end');
      txt.setAttribute('font-size', fs); txt.setAttribute('fill', cc.label);
      txt.textContent = val.toFixed(2) + '%';
      svg.appendChild(txt);
    }
    // X 轴月份标签
    var labelStep = Math.ceil(md.length / (W <= 400 ? 6 : 12));
    md.forEach(function (d, i) {
      if (i % labelStep !== 0 && i !== md.length - 1) return;
      var t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', xPos(i)); t.setAttribute('y', H - mB + 18);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', fs); t.setAttribute('fill', cc.label);
      t.textContent = monthLabel(d.month);
      svg.appendChild(t);
    });

    // 折线路径
    var pts = md.map(function (d, i) { return [xPos(i), yPos(d.rate)]; });
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M' + pts.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' L'));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#d4a94e');
    path.setAttribute('stroke-width', '2.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);

    // 面积渐变（淡金）
    var grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    grad.setAttribute('id', 'areaGrad'); grad.setAttribute('x1', 0); grad.setAttribute('y1', 0);
    grad.setAttribute('x2', 0); grad.setAttribute('y2', 1);
    grad.innerHTML = '<stop offset="0%" stop-color="#d4a94e" stop-opacity="0.18"/><stop offset="100%" stop-color="#d4a94e" stop-opacity="0"/>';
    svg.appendChild(grad);
    if (pts.length > 1) {
      var area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      var zeroY = yPos(Math.max(lo, Math.min(hi, 0)));
      area.setAttribute('d', 'M' + pts[0][0] + ' ' + zeroY +
        ' L' + pts.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' L') +
        ' L' + pts[pts.length - 1][0] + ' ' + zeroY + ' Z');
      area.setAttribute('fill', 'url(#areaGrad)');
      svg.appendChild(area);
    }

    // 数据点与交互
    md.forEach(function (d, i) {
      var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', pts[i][0]); c.setAttribute('cy', pts[i][1]);
      c.setAttribute('r', 4.5);
      c.setAttribute('fill', '#fff');
      c.setAttribute('stroke', '#d4a94e'); c.setAttribute('stroke-width', 2.4);
      svg.appendChild(c);
      chartPoints.push({ x: pts[i][0], y: pts[i][1], data: d });
      var hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      hit.setAttribute('cx', pts[i][0]); hit.setAttribute('cy', pts[i][1]);
      hit.setAttribute('r', 13); hit.setAttribute('fill', 'transparent');
      hit.style.cursor = 'pointer';
      hit.addEventListener('mouseenter', function () { showTip(i); c.setAttribute('r', 6); });
      hit.addEventListener('mouseleave', function () { tip.style.opacity = 0; c.setAttribute('r', 4.5); });
      hit.addEventListener('touchstart', function (e) { e.preventDefault(); showTip(i); }, { passive: false });
      svg.appendChild(hit);
    });

    function showTip(i) {
      var p = chartPoints[i];
      tip.innerHTML = '<b>' + monthLabel(p.data.month) + '</b><br>月收益率：' + fmtRate(p.data.rate) +
        '<br>收益：¥' + fmtMoney(p.data.income) + '<br>本金：¥' + fmtMoney(p.data.principal);
      var wrap = $('chartWrap').getBoundingClientRect();
      var svgRect = svg.getBoundingClientRect();
      var scale = svgRect.width / W;
      var left = p.x * scale + (svgRect.left - wrap.left);
      var top = p.y * scale + (svgRect.top - wrap.top);
      tip.style.left = Math.max(6, Math.min(left - tip.offsetWidth / 2, wrap.width - tip.offsetWidth - 6)) + 'px';
      tip.style.top = Math.max(4, top - tip.offsetHeight - 12) + 'px';
      tip.style.opacity = 1;
    }

    // 图表下方指标条
    var maxM = md[0], minM = md[0];
    md.forEach(function (d) { if (d.rate > maxM.rate) maxM = d; if (d.rate < minM.rate) minM = d; });
    var avg = md.reduce(function (s, d) { return s + d.rate; }, 0) / md.length;
    var fc = forecastAnnualized(md);
    var scopeName = state.scope === 'all' ? '全部卡片汇总' : (cardById(state.scope) || {}).name;
    statsBox.innerHTML =
      '<div class="chip"><div class="k">最高月收益率（' + monthLabel(maxM.month) + '）</div><div class="v">' + fmtRate(maxM.rate) + '</div></div>' +
      '<div class="chip"><div class="k">最低月收益率（' + monthLabel(minM.month) + '）</div><div class="v">' + fmtRate(minM.rate) + '</div></div>' +
      '<div class="chip blue"><div class="k">' + escapeHtml(scopeName || '') + ' · 平均月收益率</div><div class="v">' + fmtRate(avg) + '</div></div>' +
      '<div class="chip blue"><div class="k">预测全年年化</div><div class="v">' + (fc === null ? '--' : fmtRate(fc)) + '</div></div>';
  }

  // ---------- 弹窗与交互 ----------
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  function openCardModal(card) {
    $('cardModalTitle').textContent = card ? '编辑银行卡' : '添加银行卡';
    $('cardId').value = card ? card.id : '';
    $('cardName').value = card ? card.name : '';
    $('cardBank').value = card ? (card.bank || '') : '';
    $('cardPrincipal').value = card ? card.principal : '';
    $('cardModal').classList.add('show');
    setTimeout(function () { $('cardName').focus(); }, 50);
  }
  function closeCardModal() { $('cardModal').classList.remove('show'); }

  function renderCardSelect() {
    var sel = $('inCard');
    sel.innerHTML = '';
    if (!state.cards.length) {
      var opt = document.createElement('option');
      opt.value = ''; opt.textContent = '请先添加银行卡';
      sel.appendChild(opt);
      sel.disabled = true;
      var nav0 = $('cardPageNav');
      if (nav0) nav0.style.display = 'none';
      return;
    }
    sel.disabled = false;
    var total = state.cards.length;
    var pageCount = Math.max(1, Math.ceil(total / CARD_PAGE_SIZE));
    if (cardPage >= pageCount) cardPage = pageCount - 1;
    var start = cardPage * CARD_PAGE_SIZE;
    var pageCards = state.cards.slice(start, start + CARD_PAGE_SIZE);
    pageCards.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id; opt.textContent = c.name + '（¥' + fmtMoney(c.principal) + '）';
      sel.appendChild(opt);
    });
    // 分页导航
    var nav = $('cardPageNav');
    if (nav) {
      if (pageCount > 1) {
        nav.style.display = 'flex';
        $('cardPageInfo').textContent = (cardPage + 1) + ' / ' + pageCount;
        $('cardPagePrev').disabled = cardPage === 0;
        $('cardPageNext').disabled = cardPage >= pageCount - 1;
      } else {
        nav.style.display = 'none';
      }
    }
    // 记住上次选择的银行卡（需求：提交后不要回到第一个）
    var lastId = '';
    try { lastId = localStorage.getItem(CARD_LAST_KEY) || ''; } catch (e) {}
    if (lastId && cardById(lastId)) {
      var idx = state.cards.findIndex(function (c) { return c.id === lastId; });
      if (idx >= 0) {
        var needPage = Math.floor(idx / CARD_PAGE_SIZE);
        if (needPage !== cardPage) {
          cardPage = needPage;
          return renderCardSelect();
        }
      }
      sel.value = lastId;
    }
  }

  function renderAll() {
    renderStats();
    renderCards();
    renderCardSelect();
    renderScopeSelect();
    renderDetail();
    renderChart();
  }

  function bindEvents() {
    $('btnAddCard').addEventListener('click', function () { openCardModal(null); });
    $('cardCancel').addEventListener('click', closeCardModal);
    $('cardModal').addEventListener('click', function (e) { if (e.target === this) closeCardModal(); });

    // 保存银行卡（新增/编辑）
    $('cardForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var id = $('cardId').value;
      var name = $('cardName').value.trim();
      var bank = $('cardBank').value.trim();
      var principal = parseFloat($('cardPrincipal').value);
      if (!name) { toast('请填写卡片名称'); return; }
      if (!(principal > 0)) { toast('理财总金额必须大于 0'); return; }
      var dup = state.cards.some(function (c) { return c.name === name && c.id !== id; });
      if (dup) { toast('已存在同名卡片，请换一个名称'); return; }
      if (id) {
        var card = cardById(id);
        if (card) { card.name = name; card.bank = bank; card.principal = principal; }
        toast('已更新「' + name + '」');
      } else {
        state.cards.push({ id: uid(), name: name, bank: bank, principal: principal, color: state.cards.length });
        toast('已添加「' + name + '」');
      }
      saveState(); closeCardModal(); renderAll();
    });

    // 卡片编辑/删除（事件委托）
    $('cardList').addEventListener('click', function (e) {
      var editBtn = e.target.closest('[data-edit]');
      var delBtn = e.target.closest('[data-del]');
      if (editBtn) openCardModal(cardById(editBtn.getAttribute('data-edit')));
      if (delBtn) {
        var card = cardById(delBtn.getAttribute('data-del'));
        if (!card) return;
        var n = state.records.filter(function (r) { return r.cardId === card.id; }).length;
        var msg = '确定删除「' + card.name + '」吗？';
        if (n) msg += '\n该卡关联的 ' + n + ' 条收益记录将一并删除，此操作不可撤销。';
        if (confirm(msg)) {
          state.cards = state.cards.filter(function (c) { return c.id !== card.id; });
          state.records = state.records.filter(function (r) { return r.cardId !== card.id; });
          saveState(); renderAll();
          toast('已删除「' + card.name + '」');
        }
      }
    });

    // 收益录入
    $('incomeForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var cardId = $('inCard').value;
      var month = $('inMonth').value;
      var amount = parseFloat($('inAmount').value);
      if (!cardId) { toast('请先添加银行卡'); return; }
      if (!month) { toast('请选择收益月份'); return; }
      if (isNaN(amount) || amount === 0) { toast('请填写有效的收益金额（可负数表示亏损）'); return; }
      var existed = state.records.find(function (r) { return r.cardId === cardId && r.month === month; });
      var card = cardById(cardId);
      var snapshot = card ? card.principal : 0;
      if (existed) {
        if (!confirm(monthLabel(month) + ' 已有该卡的收益记录（' + fmtMoney(existed.amount) + ' 元），是否覆盖？')) return;
        existed.amount = amount;
        existed.principalSnapshot = snapshot; // 同步更新本金快照
        toast('已更新 ' + monthLabel(month) + ' 的收益');
      } else {
        state.records.push({ id: uid(), cardId: cardId, month: month, amount: amount, principalSnapshot: snapshot });
        toast('已保存 ' + monthLabel(month) + ' 的收益');
      }
      try { localStorage.setItem(CARD_LAST_KEY, cardId); } catch (e2) {}
      saveState(); $('inAmount').value = ''; renderAll();
    });

    // 删除收益记录（事件委托）
    $('detailBody').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-delrec]');
      if (!btn) return;
      var rid = btn.getAttribute('data-delrec');
      var rec = state.records.find(function (r) { return r.id === rid; });
      if (!rec) return;
      if (confirm('确定删除 ' + monthLabel(rec.month) + ' 的这条收益记录吗？')) {
        state.records = state.records.filter(function (r) { return r.id !== rid; });
        saveState(); renderAll();
        toast('已删除收益记录');
      }
    });

    // 记住手动选择的银行卡
    $('inCard').addEventListener('change', function () {
      try { localStorage.setItem(CARD_LAST_KEY, this.value); } catch (e3) {}
    });
    // 银行卡下拉框分页
    var pv = $('cardPagePrev'), nx = $('cardPageNext');
    if (pv) pv.addEventListener('click', function () {
      if (cardPage > 0) { cardPage--; renderCardSelect(); }
    });
    if (nx) nx.addEventListener('click', function () {
      var pc = Math.max(1, Math.ceil(state.cards.length / CARD_PAGE_SIZE));
      if (cardPage < pc - 1) { cardPage++; renderCardSelect(); }
    });

    // 点击同步状态可配置云同步
    var stEl = $('syncStatus');
    if (stEl) stEl.addEventListener('click', function () {
      if (!getSyncToken()) {
        requireSyncToken();
        scheduleSync();
      }
    });

    // 图表范围切换
    $('chartScope').addEventListener('change', function () {
      state.scope = this.value;
      renderChart();
    });

    // 清空全部数据
    $('resetSeed').addEventListener('click', function () {
      if (confirm('将清空当前全部银行卡和收益记录，确定继续吗？')) {
        state.cards = [];
        state.records = [];
        state.scope = 'all';
        saveState(); renderAll();
        toast('已清空全部数据');
      }
    });

    // 导出 / 导入备份
    $('btnExport').addEventListener('click', doExport);
    $('btnImport').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function () {
      if (this.files && this.files[0]) doImport(this.files[0]);
      this.value = '';
    });  }

  // ---------- 初始化 ----------
  var resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { renderChart(); }, 200);
  }

  function init() {
    var now = new Date();
    $('headDate').textContent = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 · ' +
      ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    $('inMonth').value = monthKey(now);
    initTheme();
    loadState();
    bindEvents();
    scheduleSync();
    renderAll();
    window.addEventListener('resize', onResize);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
