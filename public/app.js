'use strict';

// ── Socket.io ─────────────────────────────────────────────────────────────────
const socket = io();

// ── Estado da UI ──────────────────────────────────────────────────────────────
const state = {
  connected: false,
  wins: 0,
  losses: 0,
  totalProfit: 0,
  contractProfit: 0,
  totalScheduled: 0,
  balance: null,
  balanceCurrency: 'USD',
  initialBalance: null,
};

// ── Elementos ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

/** Retorna a data local do navegador no formato YYYY-MM-DD (sem depender de UTC). */
function _todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const elStatusBadge      = $('status-badge');
const elApiHealthBadge   = $('api-health-badge');
const elBtnConnect       = $('btn-connect');
const elBtnDisconnect    = $('btn-disconnect');
const elBtnSchedule      = $('btn-schedule');
const elBtnCancelAll     = $('btn-cancel-all');
const elBtnClearLog      = $('btn-clear-log');
const elBtnClearSignals  = $('btn-clear-signals');
const elBtnSwitch        = $('btn-switch');
const elFormConfig       = $('form-config');
const elFormSignals      = $('form-signals');
const elSectionAccount   = $('section-account');
const elLog              = $('log');
const elResultsBody      = $('results-body');
const elScheduleBody     = $('schedule-body');
const elSelectAccount    = $('select-account');
const elStatBalance      = $('stat-balance');
const elStatContractProfit = $('stat-contract-profit');

// Rastreia elementos de linha da tabela de agendamentos por signalId
const scheduleRows = new Map();

// Dados para persistência
const _resultRows    = [];
const _scheduleData  = [];
const _logEntries    = [];
const _blockedRows   = [];
// Acumula lucro/prejuízo de rounds intermediários de Gale por signalId
const _galeProfitMap = {};

// Identificador de sessão — sobrevive recargas, mantém conexão Deriv viva no servidor
const _sessionId = (() => {
  const KEY = 'eltoro_session_id';
  let id = localStorage.getItem(KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
  return id;
})();

// Paginação – agendamentos
const schedPagination   = { page: 0, perPage: 30 };
const resultsPagination = { page: 0, perPage: 30 };
const blockedPagination = { page: 0, perPage: 30 };

// Ordenação
const schedSort   = { dir: null }; // null | 'asc' | 'desc'
const resultsSort = { dir: null };

// Filtros
const schedFilters   = new Map(); // col → Set de valores incluídos (vazio = todos)
const resultsFilters = new Map();

// Filtro de data (timestamps em ms — null = sem limite)
let _filterFrom = null;
let _filterTo   = null;

/** Retorna os resultados filtrados pelo intervalo de datas selecionado. */
function _getDateFilteredResults() {
  if (_filterFrom === null && _filterTo === null) return _resultRows;
  return _resultRows.filter(r => {
    const ms = r.scheduledAtMs || (r.scheduledAt ? new Date(r.scheduledAt).getTime() : 0);
    if (_filterFrom !== null && ms < _filterFrom) return false;
    if (_filterTo   !== null && ms > _filterTo)   return false;
    return true;
  });
}

/** Atualiza _filterFrom/_filterTo a partir dos inputs De/Até e re-renderiza tudo. */
function _applyDateFilter() {
  const fromVal = $('filter-from').value;
  const toVal   = $('filter-to').value;

  if (fromVal) {
    const d = new Date(fromVal);
    d.setHours(0, 0, 0, 0);
    _filterFrom = d.getTime();
  } else {
    _filterFrom = null;
  }

  if (toVal) {
    const d = new Date(toVal);
    d.setHours(23, 59, 59, 999);
    _filterTo = d.getTime();
  } else {
    _filterTo = null;
  }

  updateStats();
  renderReportSummary();
  renderResultsTable();
}

// Inicializa campo de data com hoje (data local do navegador)
$('input-date').value = _todayLocal();

// ── AudioContext para sons ─────────────────────────────────────────────────────
let _audioCtx = null;

function _getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function playSound(type) {
  try {
    const ctx = _getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;

    if (type === 'win') {
      [[660, 0, 0.15], [880, 0.18, 0.15], [1046, 0.36, 0.2]].forEach(([freq, offset, dur]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + offset);
        gain.gain.setValueAtTime(0.35, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + dur);
        osc.start(now + offset);
        osc.stop(now + offset + dur + 0.05);
      });
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.linearRampToValueAtTime(180, now + 0.5);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.55);
    }
  } catch (_) {}
}

// Inicializa AudioContext na primeira interação do usuário
document.addEventListener('click', () => { try { _getAudioCtx(); } catch (_) {} }, { once: true });

// ── Funções de Log ─────────────────────────────────────────────────────────────
function addLog(message, type = 'info') {
  const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="log-time">${now}</span>${escapeHtml(message)}`;
  elLog.appendChild(entry);
  elLog.scrollTop = elLog.scrollHeight;
  _logEntries.push({ time: now, message, type });
  if (_logEntries.length > 200) _logEntries.shift();
  saveLog();
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

elBtnClearLog.addEventListener('click', () => {
  elLog.innerHTML = '';
  _logEntries.length = 0;
  saveLog();
});

elBtnClearSignals.addEventListener('click', () => {
  $('input-signals').value = '';
  saveForm();
});

// ── Saldo ─────────────────────────────────────────────────────────────────────
function updateBalance(amount, currency) {
  state.balance = amount;
  state.balanceCurrency = currency || 'USD';
  if (elStatBalance) {
    elStatBalance.textContent = `$${parseFloat(amount).toFixed(2)} ${state.balanceCurrency}`;
  }
  // Variação desde o início da sessão
  const elDelta = $('stat-balance-delta');
  if (elDelta && state.initialBalance !== null) {
    const delta = parseFloat(amount) - state.initialBalance;
    elDelta.textContent = `${delta >= 0 ? '+' : ''}$${Math.abs(delta).toFixed(2)}`;
    elDelta.className = 'stat-value ' + (delta >= 0 ? 'green' : 'red');
  }
}

// ── Estatísticas ──────────────────────────────────────────────────────────────
function updateStats() {
  $('stat-total').textContent = state.totalScheduled;

  // WINS / LOSSES / LUCRO derivados dos resultados filtrados por data
  const filtered = _getDateFilteredResults();
  const filteredWins   = filtered.filter(r => r.won).length;
  const filteredLosses = filtered.filter(r => !r.won).length;
  const filteredContractProfit = filtered.reduce((acc, r) => acc + parseFloat((r.contractProfit ?? r.profit) || 0), 0);
  const filteredNetProfit = filtered.reduce((acc, r) => acc + parseFloat(r.profit || 0), 0);

  $('stat-wins').textContent   = filteredWins;
  $('stat-losses').textContent = filteredLosses;

  const contractProfitEl = $('stat-contract-profit');
  if (contractProfitEl) {
    contractProfitEl.textContent = `${filteredContractProfit >= 0 ? '+' : ''}$${Math.abs(filteredContractProfit).toFixed(2)}`;
    contractProfitEl.className = 'stat-value ' + (filteredContractProfit >= 0 ? 'green' : 'red');
  }

  const profitEl = $('stat-profit');
  profitEl.textContent = `${filteredNetProfit >= 0 ? '+' : '-'}$${Math.abs(filteredNetProfit).toFixed(2)}`;
  profitEl.className = 'stat-value ' + (filteredNetProfit >= 0 ? 'green' : 'red');
  saveStats();
}

// ── Status de Conexão ─────────────────────────────────────────────────────────
function setConnectedUI(connected) {
  state.connected = connected;
  elStatusBadge.textContent  = connected ? 'Conectado' : 'Desconectado';
  elStatusBadge.className    = `badge ${connected ? 'badge-online' : 'badge-offline'}`;
  elBtnConnect.disabled      = connected;
  elBtnDisconnect.disabled   = !connected;
  elBtnSchedule.disabled     = !connected;
  elBtnCancelAll.disabled    = !connected;

  if (!connected) {
    elSectionAccount.classList.add('hidden');
    elApiHealthBadge.textContent = 'API ●';
    elApiHealthBadge.className   = 'badge badge-offline';
  }
}

// ── API Health Badge ──────────────────────────────────────────────────────────
socket.on('api:health', ({ ok, message }) => {
  if (ok) {
    elApiHealthBadge.className   = 'badge badge-api-ok';
    elApiHealthBadge.textContent = 'API ✓';
    elApiHealthBadge.title       = message || 'API respondendo normalmente';
  } else {
    elApiHealthBadge.className   = 'badge badge-api-fail';
    elApiHealthBadge.textContent = 'API ✗';
    elApiHealthBadge.title       = message || 'API sem resposta';
    addLog(`⚠️ Health check da API: ${message || 'sem resposta'}`, 'warn');
  }
});

socket.on('api:precheck:fail', ({ signal, message }) => {
  addLog(`🔴 PRÉ-CHECK FALHOU para ${signal?.rawSymbol || '?'} às ${signal?.scheduledTimeLabel || '?'}: ${message}`, 'error');
});

socket.on('api:precheck:ok', ({ signal }) => {
  addLog(`🟢 Pré-check OK para ${signal?.rawSymbol || '?'} às ${signal?.scheduledTimeLabel || '?'}`, 'muted');
});

socket.on('api:reconnecting', ({ message }) => {
  elApiHealthBadge.className   = 'badge badge-api-warn';
  elApiHealthBadge.textContent = 'API ↻';
  addLog(message || '🔄 Reconectando à API...', 'warn');
});

socket.on('api:reconnected', ({ message }) => {
  elApiHealthBadge.className   = 'badge badge-api-ok';
  elApiHealthBadge.textContent = 'API ✓';
  addLog(message || '🟢 Reconectado com sucesso', 'success');
});

socket.on('api:reconnect:fail', ({ message }) => {
  elApiHealthBadge.className   = 'badge badge-api-fail';
  elApiHealthBadge.textContent = 'API ✗';
  addLog(message || '❌ Falha ao reconectar', 'error');
});

// ── Tabela de Agendamentos ─────────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    waiting:   { cls: 'status-waiting',   label: '⏳ Aguardando' },
    executing: { cls: 'status-running',   label: '🚀 Executando' },
    done:      { cls: 'status-done',      label: '✅ Concluído' },
    cancelled: { cls: 'status-cancelled', label: '🛑 Cancelado' },
    expired:   { cls: 'status-expired',   label: '⚠️ Expirado' },
    rejected:  { cls: 'status-rejected',  label: '🚫 Rejeitado' },
  };
  const s = map[status] || map.waiting;
  return `<span class="status-badge ${s.cls}">${s.label}</span>`;
}

function _buildScheduleRow(d) {
  const dirClass = d.direction === 'CALL' ? 'direction-call' : 'direction-put';
  const tr = document.createElement('tr');
  tr.dataset.signalId = d.id;
  tr.innerHTML =
    `<td class="idx-cell">—</td>` +
    `<td>${escapeHtml(d.scheduledTime)}</td>` +
    `<td>${escapeHtml(d.rawSymbol)}</td>` +
    `<td class="${dirClass}">${d.direction === 'CALL' ? '⬆️ CALL' : '⬇️ PUT'}</td>` +
    `<td>${escapeHtml(d.duration)}</td>` +
    `<td>${escapeHtml(d.stake)}</td>` +
    `<td class="sch-gale-cell">${escapeHtml(d.galeLabel)}</td>` +
    `<td class="sch-status-cell">${statusBadge(d.status)}</td>` +
    `<td class="sch-payout-cell">${escapeHtml(d.payout || '—')}</td>` +
    `<td><button class="btn btn-ghost btn-cancel-signal" data-id="${escapeHtml(d.id)}"${d.status !== 'waiting' ? ' disabled' : ''}>Cancelar</button></td>`;
  return tr;
}

function _setScheduleRowStatus(tr, status, galeLabel) {
  if (!tr) return;
  const statusCell = tr.querySelector('.sch-status-cell');
  if (statusCell) statusCell.innerHTML = statusBadge(status);
  if (galeLabel !== undefined) {
    const galeCell = tr.querySelector('.sch-gale-cell');
    if (galeCell) galeCell.textContent = galeLabel;
  }
  const btn = tr.querySelector('.btn-cancel-signal');
  if (btn) btn.disabled = status !== 'waiting';
}

function _applyScheduleFilters(data) {
  if (schedFilters.size === 0) return data;
  return data.filter(d => {
    const row = [
      d.scheduledTime,
      d.rawSymbol,
      d.direction === 'CALL' ? 'CALL' : 'PUT',
      d.duration,
      d.stake,
      d.galeLabel,
      d.status,
      d.payout || '—',
    ];
    for (const [col, allowed] of schedFilters) {
      if (!allowed || allowed.size === 0) continue;
      const cell = row[parseInt(col, 10)] || '—';
      if (!allowed.has(cell)) return false;
    }
    return true;
  });
}

function _applyScheduleSort(data) {
  if (!schedSort.dir) return data;
  return [...data].sort((a, b) => {
    const aMs = a.scheduledAtMs || (a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0);
    const bMs = b.scheduledAtMs || (b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0);
    return schedSort.dir === 'asc' ? aMs - bMs : bMs - aMs;
  });
}

function renderScheduleTable() {
  const filtered   = _applyScheduleFilters(_scheduleData);
  const sorted     = _applyScheduleSort(filtered);
  const total      = sorted.length;
  const perPage    = schedPagination.perPage;
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  schedPagination.page = Math.min(schedPagination.page, totalPages - 1);

  const start = schedPagination.page * perPage;
  const slice = sorted.slice(start, start + perPage);

  elScheduleBody.innerHTML = '';
  slice.forEach((d, i) => {
    let tr = scheduleRows.get(d.id);
    if (!tr) {
      tr = _buildScheduleRow(d);
      scheduleRows.set(d.id, tr);
    }
    const idxCell = tr.querySelector('.idx-cell');
    if (idxCell) idxCell.textContent = d.signalIndex != null ? d.signalIndex : (start + i + 1);
    elScheduleBody.appendChild(tr);
  });

  const pagDiv   = $('schedule-pagination');
  const pageInfo = $('sch-page-info');
  const btnPrev  = $('sch-prev');
  const btnNext  = $('sch-next');

  if (total > perPage) {
    pagDiv.classList.remove('hidden');
    pageInfo.textContent = `Página ${schedPagination.page + 1} de ${totalPages} (${total} itens)`;
    btnPrev.disabled = schedPagination.page === 0;
    btnNext.disabled = schedPagination.page >= totalPages - 1;
  } else {
    pagDiv.classList.add('hidden');
  }
}

$('sch-prev').addEventListener('click', () => {
  if (schedPagination.page > 0) { schedPagination.page--; renderScheduleTable(); }
});
$('sch-next').addEventListener('click', () => {
  schedPagination.page++;
  renderScheduleTable();
});
$('res-prev').addEventListener('click', () => {
  if (resultsPagination.page > 0) { resultsPagination.page--; renderResultsTable(); }
});
$('res-next').addEventListener('click', () => {
  resultsPagination.page++;
  renderResultsTable();
});
$('blk-prev').addEventListener('click', () => {
  if (blockedPagination.page > 0) { blockedPagination.page--; renderBlockedTable(); }
});
$('blk-next').addEventListener('click', () => {
  blockedPagination.page++;
  renderBlockedTable();
});

function _formatScheduledTime(isoOrDate) {
  const d = new Date(isoOrDate);
  const dd  = String(d.getDate()).padStart(2, '0');
  const mon = String(d.getMonth() + 1).padStart(2, '0');
  const hh  = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mon} ${hh}:${min}`;
}

function addScheduleRow(data) {
  const { signal, expired, baseStake } = data;
  const scheduledDate = new Date(signal.scheduledAt);
  const scheduledTime = _formatScheduledTime(scheduledDate);
  const scheduledAtMs = scheduledDate.getTime();
  const status = expired ? 'expired' : 'waiting';
  const stakeDisplay = `$${parseFloat(baseStake || 1).toFixed(2)}`;
  const duration = `${signal.duration}${signal.duration_unit}`;

  // Deduplicar: se já existe entrada com mesmo id, atualiza em vez de duplicar
  const existingIdx = _scheduleData.findIndex(d => d.id === signal.id);
  if (existingIdx !== -1) {
    const existing = _scheduleData[existingIdx];
    existing.status    = status;
    existing.stake     = stakeDisplay;
    existing.galeLabel = '—';
    existing.payout    = '—';
    const tr = _buildScheduleRow(existing);
    scheduleRows.set(signal.id, tr);
    renderScheduleTable();
    saveSchedule();
    return;
  }

  const entry = {
    id: signal.id,
    scheduledTime,
    scheduledAt:  scheduledDate.toISOString(),
    scheduledAtMs,
    signalIndex:  signal.signalIndex ?? null,
    rawSymbol:    signal.rawSymbol,
    direction:    signal.direction,
    duration,
    stake:        stakeDisplay,
    galeLabel:    '—',
    payout:       '—',
    status,
    signalData: {
      id:            signal.id,
      raw:           signal.raw || '',
      symbol:        signal.symbol,
      rawSymbol:     signal.rawSymbol,
      direction:     signal.direction,
      duration:      signal.duration,
      duration_unit: signal.duration_unit,
      scheduledAt:   scheduledDate.toISOString(),
      contract_type: signal.contract_type || signal.direction,
      signalIndex:   signal.signalIndex ?? null,
    },
  };
  _scheduleData.unshift(entry);
  if (_scheduleData.length > 500) _scheduleData.splice(500);

  const tr = _buildScheduleRow(entry);
  scheduleRows.set(signal.id, tr);

  renderScheduleTable();
  saveSchedule();
}

function updateScheduleStatus(signalId, status, galeLabel) {
  const entry = _scheduleData.find(d => d.id === signalId);
  if (entry) {
    entry.status = status;
    if (galeLabel !== undefined) entry.galeLabel = galeLabel;
  }

  const tr = scheduleRows.get(signalId);
  if (tr) _setScheduleRowStatus(tr, status, galeLabel);

  saveSchedule();
}

function removeScheduleRow(signalId) {
  const tr = scheduleRows.get(signalId);
  if (tr) { tr.remove(); scheduleRows.delete(signalId); }
  const idx = _scheduleData.findIndex(d => d.id === signalId);
  if (idx !== -1) _scheduleData.splice(idx, 1);
  renderScheduleTable();
  saveSchedule();
}

// ── Ordenação por Horário ─────────────────────────────────────────────────────
$('sort-sch-time').addEventListener('click', () => {
  const btn = $('sort-sch-time');
  if (schedSort.dir === 'asc') {
    schedSort.dir = 'desc'; btn.textContent = '▼'; btn.className = 'sort-btn desc';
  } else if (schedSort.dir === 'desc') {
    schedSort.dir = null;   btn.textContent = '⇅'; btn.className = 'sort-btn';
  } else {
    schedSort.dir = 'asc';  btn.textContent = '▲'; btn.className = 'sort-btn asc';
  }
  schedPagination.page = 0;
  renderScheduleTable();
});

$('sort-res-time').addEventListener('click', () => {
  const btn = $('sort-res-time');
  if (resultsSort.dir === 'asc') {
    resultsSort.dir = 'desc'; btn.textContent = '▼'; btn.className = 'sort-btn desc';
  } else if (resultsSort.dir === 'desc') {
    resultsSort.dir = null;   btn.textContent = '⇅'; btn.className = 'sort-btn';
  } else {
    resultsSort.dir = 'asc';  btn.textContent = '▲'; btn.className = 'sort-btn asc';
  }
  resultsPagination.page = 0;
  renderResultsTable();
});

// ── Filtros Dropdown nas tabelas ────────────────────────────────────────────
function _getColValues(tableKey, col) {
  const data = tableKey === 'schedule' ? _scheduleData : _getDateFilteredResults();
  const values = new Set();
  const colIdx = parseInt(col, 10);
  data.forEach(d => {
    let val;
    if (tableKey === 'schedule') {
      const row = [
        d.scheduledTime, d.rawSymbol,
        d.direction === 'CALL' ? 'CALL' : 'PUT',
        d.duration, d.stake, d.galeLabel, d.status, d.payout || '—',
      ];
      val = row[colIdx] || '—';
    } else {
      const row = [
        d.scheduledTime, d.rawSymbol,
        d.direction === 'CALL' ? 'CALL' : 'PUT',
        d.duration,
        `$${parseFloat(d.stake).toFixed(2)}`,
        d.galeRound > 0 ? `G${d.galeRound}` : '—',
        d.won ? 'WIN' : 'LOSS',
        `${d.profit >= 0 ? '+' : ''}$${parseFloat(d.profit).toFixed(2)}`,
        d.payout || '—',
      ];
      val = row[colIdx] || '—';
    }
    values.add(val);
  });
  return values;
}

function _updateFilterBtnLabel(wrapper) {
  const col = parseInt(wrapper.dataset.col, 10);
  const tableKey = wrapper.dataset.table;
  const filtersMap = tableKey === 'schedule' ? schedFilters : resultsFilters;
  const btn = wrapper.querySelector('.th-filter-btn');
  const allowed = filtersMap.get(col);
  if (!allowed || allowed.size === 0) {
    btn.textContent = 'Todos ▾';
    btn.classList.remove('filter-active');
  } else {
    btn.textContent = `${allowed.size} sel. ▾`;
    btn.classList.add('filter-active');
  }
}

function _populateDropdown(wrapper) {
  const col = parseInt(wrapper.dataset.col, 10);
  const tableKey = wrapper.dataset.table;
  const filtersMap = tableKey === 'schedule' ? schedFilters : resultsFilters;
  const allowed = filtersMap.get(col);
  const values = _getColValues(tableKey, col);
  const menu = wrapper.querySelector('.th-filter-menu');
  menu.innerHTML = '';

  // Opção "Todos"
  const allLabel = document.createElement('label');
  allLabel.className = 'th-filter-option';
  const allCb = document.createElement('input');
  allCb.type = 'checkbox';
  allCb.dataset.value = '__all__';
  allCb.checked = !allowed || allowed.size === 0;
  allLabel.append(allCb, ' (Todos)');
  menu.appendChild(allLabel);

  const sortedVals = [...values].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
  sortedVals.forEach(v => {
    const lbl = document.createElement('label');
    lbl.className = 'th-filter-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.value = v;
    cb.checked = !allowed || allowed.size === 0 || allowed.has(v);
    lbl.append(cb, ' ' + v);
    menu.appendChild(lbl);
  });

  menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', (e) => _onDropdownChange(e, wrapper, menu, col, tableKey, filtersMap));
  });
}

function _onDropdownChange(e, wrapper, menu, col, tableKey, filtersMap) {
  const allCb = menu.querySelector('input[data-value="__all__"]');
  const itemCbs = [...menu.querySelectorAll('input:not([data-value="__all__"])')]; 
  if (e.target === allCb) {
    itemCbs.forEach(c => c.checked = allCb.checked);
    if (allCb.checked) filtersMap.delete(col);
    else filtersMap.set(col, new Set());
  } else {
    const checkedVals = itemCbs.filter(c => c.checked).map(c => c.dataset.value);
    const allChecked = checkedVals.length === itemCbs.length;
    allCb.checked = allChecked;
    if (allChecked) filtersMap.delete(col);
    else filtersMap.set(col, new Set(checkedVals));
  }
  _updateFilterBtnLabel(wrapper);
  if (tableKey === 'schedule') { schedPagination.page = 0; renderScheduleTable(); }
  else { resultsPagination.page = 0; renderResultsTable(); }
}

document.querySelectorAll('.th-dropdown-filter').forEach(wrapper => {
  const btn = wrapper.querySelector('.th-filter-btn');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = wrapper.querySelector('.th-filter-menu');
    const isOpen = !menu.classList.contains('hidden');
    document.querySelectorAll('.th-filter-menu').forEach(m => m.classList.add('hidden'));
    if (!isOpen) {
      _populateDropdown(wrapper);
      menu.classList.remove('hidden');
    }
  });
});

document.addEventListener('click', () => {
  document.querySelectorAll('.th-filter-menu').forEach(m => m.classList.add('hidden'));
});

// ── Tabela de Resultados ──────────────────────────────────────────────────────
function _applyResultsFilter(data) {
  if (resultsFilters.size === 0) return data;
  return data.filter(r => {
    const row = [
      r.scheduledTime,
      r.rawSymbol,
      r.direction === 'CALL' ? 'CALL' : 'PUT',
      r.duration,
      `$${parseFloat(r.stake).toFixed(2)}`,
      r.galeRound > 0 ? `G${r.galeRound}` : '—',
      r.won ? 'WIN' : 'LOSS',
      `${r.profit >= 0 ? '+' : ''}$${parseFloat(r.profit).toFixed(2)}`,
      r.payout || '—',
    ];
    for (const [col, allowed] of resultsFilters) {
      if (!allowed || allowed.size === 0) continue;
      const cell = row[parseInt(col, 10)] || '—';
      if (!allowed.has(cell)) return false;
    }
    return true;
  });
}

function _applyResultsSort(data) {
  if (!resultsSort.dir) return data;
  return [...data].sort((a, b) => {
    const aMs = a.scheduledAtMs || (a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0);
    const bMs = b.scheduledAtMs || (b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0);
    return resultsSort.dir === 'asc' ? aMs - bMs : bMs - aMs;
  });
}

function renderResultsTable() {
  const dateFiltered = _getDateFilteredResults();
  const filtered = _applyResultsFilter(dateFiltered);
  const sorted   = _applyResultsSort(filtered);
  const total    = sorted.length;
  const perPage  = resultsPagination.perPage;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  resultsPagination.page = Math.min(resultsPagination.page, totalPages - 1);
  const start = resultsPagination.page * perPage;
  const slice = sorted.slice(start, start + perPage);

  elResultsBody.innerHTML = '';
  slice.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.className = r.won ? 'win' : 'loss';
    const profitClass = r.profit >= 0 ? 'profit-positive' : 'profit-negative';
    const dirClass    = r.direction === 'CALL' ? 'direction-call' : 'direction-put';
    tr.innerHTML =
      `<td class="idx-cell">${r.signalIndex != null ? r.signalIndex : (start + i + 1)}</td>` +
      `<td>${escapeHtml(r.scheduledTime)}</td>` +
      `<td>${escapeHtml(r.rawSymbol)}</td>` +
      `<td class="${dirClass}">${r.direction === 'CALL' ? '⬆️ CALL' : '⬇️ PUT'}</td>` +
      `<td>${escapeHtml(r.duration)}</td>` +
      `<td>$${parseFloat(r.stake).toFixed(2)}</td>` +
      `<td>${r.galeRound > 0 ? 'G' + r.galeRound : '—'}</td>` +
      `<td>${r.won ? '✅ WIN' : '❌ LOSS'}</td>` +
      `<td class="${profitClass}">${r.profit >= 0 ? '+' : ''}$${parseFloat(r.profit).toFixed(2)}</td>` +
      `<td>${escapeHtml(r.payout || '—')}</td>`;
    elResultsBody.appendChild(tr);
  });

  const pagDiv   = $('results-pagination');
  const pageInfo = $('res-page-info');
  const btnPrev  = $('res-prev');
  const btnNext  = $('res-next');
  if (total > perPage) {
    pagDiv?.classList.remove('hidden');
    pageInfo.textContent = `Página ${resultsPagination.page + 1} de ${totalPages} (${total} itens)`;
    btnPrev.disabled = resultsPagination.page === 0;
    btnNext.disabled = resultsPagination.page >= totalPages - 1;
  } else {
    pagDiv?.classList.add('hidden');
  }
}

function addResultRow({ signal, won, profit, contractProfit, stake, galeRound, payoutPct, contractId }) {
  const scheduledDate = new Date(signal.scheduledAt);
  const scheduledTime = _formatScheduledTime(scheduledDate);

  _resultRows.unshift({
    scheduledTime,
    scheduledAt:  scheduledDate.toISOString(),
    scheduledAtMs: scheduledDate.getTime(),
    signalIndex:  signal.signalIndex ?? null,
    rawSymbol: signal.rawSymbol,
    direction: signal.direction,
    duration:  signal.duration + signal.duration_unit,
    stake,
    galeRound,
    won,
    profit,
    contractProfit: Number(contractProfit ?? profit) || 0,
    payout: payoutPct || '—',
    contractId: contractId ? String(contractId) : null,
  });

  renderResultsTable();
  renderReportSummary();
  saveResults();
}

// ── Relatório: Resumo ─────────────────────────────────────────────────────────
function renderReportSummary() {
  const rows  = _getDateFilteredResults();
  const total = rows.length;
  const wins  = rows.filter(r => r.won).length;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) + '%' : '—';
  const profit  = rows.reduce((acc, r) => acc + parseFloat(r.profit || 0), 0);
  const contractProfit = rows.reduce((acc, r) => acc + parseFloat((r.contractProfit ?? r.profit) || 0), 0);

  let maxWinStreak = 0, curWin = 0;
  let maxLossStreak = 0, curLoss = 0;
  [...rows].reverse().forEach(r => {
    if (r.won) { curWin++; curLoss = 0; maxWinStreak  = Math.max(maxWinStreak,  curWin); }
    else       { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
  });

  const repWinrate = $('rep-winrate');
  const repTotal   = $('rep-total');
  const repContractProfit = $('rep-contract-profit');
  const repProfit  = $('rep-profit');
  const repStrW    = $('rep-streak-win');
  const repStrL    = $('rep-streak-loss');
  const repG1      = $('rep-g1');
  const repG2      = $('rep-g2');

  const g1Count = rows.filter(r => r.galeRound === 1).length;
  const g2Count = rows.filter(r => r.galeRound === 2).length;

  if (repWinrate) repWinrate.textContent = winRate;
  if (repTotal)   repTotal.textContent   = total;
  if (repContractProfit) {
    repContractProfit.textContent = `${contractProfit >= 0 ? '+' : ''}$${Math.abs(contractProfit).toFixed(2)}`;
    repContractProfit.className = 'stat-value ' + (contractProfit >= 0 ? 'green' : 'red');
  }
  if (repProfit) {
    repProfit.textContent = `${profit >= 0 ? '+' : ''}$${Math.abs(profit).toFixed(2)}`;
    repProfit.className   = 'stat-value ' + (profit >= 0 ? 'green' : 'red');
  }
  if (repStrW) repStrW.textContent = maxWinStreak;
  if (repStrL) repStrL.textContent = maxLossStreak;
  if (repG1)   repG1.textContent   = g1Count;
  if (repG2)   repG2.textContent   = g2Count;
}

// ── Exportar CSV ──────────────────────────────────────────────────────────────
$('btn-export-csv')?.addEventListener('click', () => {
  if (_resultRows.length === 0) return addLog('⚠️ Sem resultados para exportar.', 'warn');
  const headers = ['#', 'Horário', 'Par', 'Direção', 'Duração', 'Stake', 'Gale', 'Resultado', 'Lucro', 'Payout %'];
  const rows = [..._resultRows].reverse().map((r, i) => [
    i + 1,
    r.scheduledTime,
    r.rawSymbol,
    r.direction,
    r.duration,
    r.stake,
    r.galeRound > 0 ? `G${r.galeRound}` : '—',
    r.won ? 'WIN' : 'LOSS',
    `${r.profit >= 0 ? '+' : ''}${parseFloat(r.profit).toFixed(2)}`,
    r.payout || '—',
  ]);
  const csv = [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `eltoro-resultados-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  addLog('📥 CSV exportado com sucesso.', 'success');
});

// ── Navegação por Abas ────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    const panel = $(btn.dataset.tab);
    if (panel) panel.classList.remove('hidden');
  });
});

const LS = {
  FORM:     'eltoro_form',
  STATS:    'eltoro_stats',
  RESULTS:  'eltoro_results',
  SCHEDULE: 'eltoro_schedule',
  LOG:      'eltoro_log',
  BLOCKED:  'eltoro_blocked',
  GALE_MAP: 'eltoro_gale_map',
};

function saveForm() {
  try {
    localStorage.setItem(LS.FORM, JSON.stringify({
      token:       $('input-token')?.value  || '',
      appId:       $('input-appid')?.value  || '',
      accountId:   $('input-accountid')?.value || '',
      stake:       $('input-stake')?.value  || '1',
      maxGales:    $('input-maxgales')?.value || '1',
      galeMultiplier: $('input-galemultiplier')?.value || '2',
      stopLoss:    $('input-stoploss')?.value  || '0',
      takeProfit:  $('input-takeprofit')?.value || '0',
      minPayout:   $('input-minpayout')?.value  || '0',
      signalsText: $('input-signals')?.value || '',
      date:        $('input-date')?.value   || '',
    }));
  } catch (_) {}
}

function saveStats() {
  try {
    localStorage.setItem(LS.STATS, JSON.stringify({
      wins:           state.wins,
      losses:         state.losses,
      totalProfit:    state.totalProfit,
      contractProfit: state.contractProfit,
      totalScheduled: state.totalScheduled,
      statsDate:      _todayLocal(),
    }));
  } catch (_) {}
}

function saveResults() {
  try {
    localStorage.setItem(LS.RESULTS, JSON.stringify(_resultRows.slice(0, 200)));
  } catch (_) {}
}

function saveSchedule() {
  try {
    localStorage.setItem(LS.SCHEDULE, JSON.stringify(_scheduleData.slice(0, 200)));
  } catch (_) {}
}

function saveLog() {
  try {
    localStorage.setItem(LS.LOG, JSON.stringify(_logEntries.slice(-200)));
  } catch (_) {}
}

function saveBlocked() {
  try {
    localStorage.setItem(LS.BLOCKED, JSON.stringify(_blockedRows.slice(0, 200)));
  } catch (_) {}
}

function saveGaleMap() {
  try {
    localStorage.setItem(LS.GALE_MAP, JSON.stringify(_galeProfitMap));
  } catch (_) {}
}

// ── Operações Bloqueadas ─────────────────────────────────────────────────────────────────────────
function renderBlockedTable() {
  const elBody = $('blocked-body');
  if (!elBody) return;
  const total    = _blockedRows.length;
  const perPage  = blockedPagination.perPage;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  blockedPagination.page = Math.min(blockedPagination.page, totalPages - 1);
  const start = blockedPagination.page * perPage;
  const slice = _blockedRows.slice(start, start + perPage);

  elBody.innerHTML = '';
  slice.forEach((b, i) => {
    const tr = document.createElement('tr');
    const dirClass   = b.direction === 'CALL' ? 'direction-call' : 'direction-put';
    const votesClass = `votes-${b.votes}`;
    const roundLabel = b.galeRound === 0 ? 'Entrada' : `G${b.galeRound}`;
    const reasonsHtml = b.reasons && b.reasons.length
      ? b.reasons.map(r => `<span>${escapeHtml(r)}</span>`).join('<br>')
      : '<span style="color:var(--text-muted)">—</span>';
    tr.innerHTML =
      `<td class="idx-cell">${start + i + 1}</td>` +
      `<td>${escapeHtml(b.scheduledTime)}</td>` +
      `<td>${escapeHtml(b.rawSymbol)}</td>` +
      `<td class="${dirClass}">${b.direction === 'CALL' ? '⬆️ CALL' : '⬇️ PUT'}</td>` +
      `<td>${escapeHtml(roundLabel)}</td>` +
      `<td><span class="votes-badge ${votesClass}">${b.votes}/3</span></td>` +
      `<td class="blocked-reasons">${reasonsHtml}</td>`;
    elBody.appendChild(tr);
  });

  const pagDiv   = $('blocked-pagination');
  const pageInfo = $('blk-page-info');
  const btnPrev  = $('blk-prev');
  const btnNext  = $('blk-next');
  if (total > perPage) {
    pagDiv?.classList.remove('hidden');
    pageInfo.textContent = `Página ${blockedPagination.page + 1} de ${totalPages} (${total} itens)`;
    btnPrev.disabled = blockedPagination.page === 0;
    btnNext.disabled = blockedPagination.page >= totalPages - 1;
  } else {
    pagDiv?.classList.add('hidden');
  }
}

function addBlockedRow({ signal, galeRound, votes, reasons }) {
  const scheduledDate = new Date(signal.scheduledAt);
  const scheduledTime = _formatScheduledTime(scheduledDate);
  _blockedRows.unshift({
    scheduledTime,
    scheduledAt:  scheduledDate.toISOString(),
    rawSymbol:    signal.rawSymbol,
    direction:    signal.direction,
    galeRound:    galeRound ?? 0,
    votes:        votes ?? 0,
    reasons:      reasons ?? [],
  });
  blockedPagination.page = 0;
  renderBlockedTable();
  saveBlocked();
}

$('btn-export-blocked-csv')?.addEventListener('click', () => {
  if (_blockedRows.length === 0) return addLog('⚠️ Sem operações bloqueadas para exportar.', 'warn');
  const headers = ['#', 'Horário', 'Par', 'Direção', 'Rodada', 'Votos Contra', 'Motivos'];
  const rows = [..._blockedRows].reverse().map((b, i) => [
    i + 1,
    b.scheduledTime,
    b.rawSymbol,
    b.direction,
    b.galeRound === 0 ? 'Entrada' : `G${b.galeRound}`,
    `${b.votes}/3`,
    (b.reasons || []).join(' | '),
  ]);
  const csv = [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `eltoro-bloqueadas-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  addLog('📥 CSV de bloqueadas exportado.', 'success');
});

$('btn-reconcile')?.addEventListener('click', () => {
  addLog('🔍 Iniciando reconciliação — buscando contratos de hoje na Deriv...', 'muted');
  socket.emit('account:reconcile');
});

function restoreState() {
  try {
    const form = JSON.parse(localStorage.getItem(LS.FORM) || 'null');
    if (form) {
      if (form.token)        $('input-token').value      = form.token;
      if (form.appId)        $('input-appid').value      = form.appId;
      if (form.accountId)    $('input-accountid').value  = form.accountId;
      if (form.stake)        $('input-stake').value      = form.stake;
      if (form.maxGales)     $('input-maxgales').value   = form.maxGales;
      if (form.galeMultiplier != null) $('input-galemultiplier').value = form.galeMultiplier;
      if (form.stopLoss != null)   $('input-stoploss').value    = form.stopLoss;
      if (form.takeProfit != null) $('input-takeprofit').value  = form.takeProfit;
      if (form.minPayout != null)  $('input-minpayout').value   = form.minPayout;
      if (form.signalsText)  $('input-signals').value    = form.signalsText;
      if (form.date)         $('input-date').value       = form.date;
    }
  } catch (_) {}

  try {
    const stats = JSON.parse(localStorage.getItem(LS.STATS) || 'null');
    if (stats) {
      const today = _todayLocal();
      if (stats.statsDate && stats.statsDate !== today) {
        // Novo dia: zera as stats diárias
        state.wins = 0; state.losses = 0; state.totalProfit = 0; state.totalScheduled = 0;
        state.contractProfit = 0;
      } else {
        state.wins           = stats.wins           || 0;
        state.losses         = stats.losses         || 0;
        state.totalProfit    = stats.totalProfit    || 0;
        state.contractProfit = stats.contractProfit || 0;
        state.totalScheduled = stats.totalScheduled || 0;
      }
    }
  } catch (_) {}

  try {
    const entries = JSON.parse(localStorage.getItem(LS.LOG) || '[]');
    entries.forEach(({ time, message, type }) => {
      const el = document.createElement('div');
      el.className = `log-entry ${type}`;
      el.innerHTML = `<span class="log-time">${escapeHtml(time)}</span>${escapeHtml(message)}`;
      elLog.appendChild(el);
      _logEntries.push({ time, message, type });
    });
    elLog.scrollTop = elLog.scrollHeight;
  } catch (_) {}

  try {
    const results = JSON.parse(localStorage.getItem(LS.RESULTS) || '[]');
    results.forEach(r => _resultRows.push(r));
    renderResultsTable();
    renderReportSummary();
  } catch (_) {}

  try {
    const schedule = JSON.parse(localStorage.getItem(LS.SCHEDULE) || '[]');
    const nowMs = Date.now();
    schedule.forEach(d => {
      let status = d.status;
      if (status === 'waiting') {
        const atMs = d.scheduledAtMs || (d.scheduledAt ? new Date(d.scheduledAt).getTime() : 0);
        status = atMs > nowMs ? 'waiting' : 'expired';
      } else if (status === 'executing') {
        status = 'executing';
      }
      const entry = { ...d, status };
      _scheduleData.push(entry);
      scheduleRows.set(d.id, _buildScheduleRow(entry));
  });
  renderScheduleTable();
  } catch (_) {}

  try {
    const blocked = JSON.parse(localStorage.getItem(LS.BLOCKED) || '[]');
    blocked.forEach(b => _blockedRows.push(b));
    renderBlockedTable();
  } catch (_) {}

  try {
    const galeMap = JSON.parse(localStorage.getItem(LS.GALE_MAP) || '{}');
    if (galeMap && typeof galeMap === 'object') Object.assign(_galeProfitMap, galeMap);
  } catch (_) {}
}

// ── Filtro de Data ────────────────────────────────────────────────────────────
function initDateFilter() {
  const fromEl = $('filter-from');
  const toEl   = $('filter-to');

  // Inicia com filtro de hoje — o usuário pode remover com "Tudo"
  const t = _todayLocal();
  fromEl.value = t;
  toEl.value   = t;

  fromEl.addEventListener('change', _applyDateFilter);
  toEl.addEventListener('change',   _applyDateFilter);

  $('btn-filter-today')?.addEventListener('click', () => {
    const t = _todayLocal();
    fromEl.value = t;
    toEl.value   = t;
    _applyDateFilter();
  });

  $('btn-filter-all')?.addEventListener('click', () => {
    fromEl.value = '';
    toEl.value   = '';
    _applyDateFilter();
  });

  // Aplica o filtro inicial (hoje)
  _applyDateFilter();
}

// ── Formulário de Configuração ────────────────────────────────────────────────
elFormConfig.addEventListener('submit', (e) => {
  e.preventDefault();
  const token     = $('input-token').value.trim();
  const appId     = $('input-appid').value.trim();
  const accountId = ($('input-accountid')?.value || '').trim() || undefined;
  const stake     = parseFloat($('input-stake').value) || 1;
  const maxGales  = parseInt($('input-maxgales').value, 10) || 0;
  const galeMultiplier = parseFloat($('input-galemultiplier')?.value) || 2;
  const stopLoss  = parseFloat($('input-stoploss')?.value) || 0;
  const takeProfit = parseFloat($('input-takeprofit')?.value) || 0;

  if (!token) return addLog('⚠️ Informe o Token da API.', 'warn');
  if (!appId)  return addLog('⚠️ Informe o App ID.', 'warn');

  const isNewToken    = token.startsWith('pat_');
  const isNumericAppId = /^\d+$/.test(appId);
  if (isNewToken && isNumericAppId) {
    return addLog(
      '❌ App ID numérico ("' + appId + '") não funciona com token pat_. ' +
      'Acesse developers.deriv.com, registre seu app e use o App ID alfanumérico gerado.',
      'error'
    );
  }

  addLog('🔌 Conectando à Deriv...', 'muted');
  socket.emit('config:connect', { token, appId, accountId, stake, maxGales, galeMultiplier, stopLoss, takeProfit });
});

elBtnDisconnect.addEventListener('click', () => {
  socket.emit('config:disconnect');
  setConnectedUI(false);
  addLog('🔌 Desconectado.', 'muted');
});

// ── Trocar Conta ──────────────────────────────────────────────────────────────
elBtnSwitch && elBtnSwitch.addEventListener('click', () => {
  const selectedAccountId = elSelectAccount?.value?.trim();
  const inputToken        = $('input-switch-token')?.value?.trim();
  const tokenOrId         = selectedAccountId || inputToken;
  if (!tokenOrId) return addLog('⚠️ Selecione ou informe a conta destino.', 'warn');
  socket.emit('account:switch', { token: tokenOrId });
});

// ── Formulário de Sinais ──────────────────────────────────────────────────────
elFormSignals.addEventListener('submit', (e) => {
  e.preventDefault();
  const signalsText = $('input-signals').value.trim();
  const date        = $('input-date').value;
  const stake       = parseFloat($('input-stake').value) || 1;
  const maxGales    = parseInt($('input-maxgales').value, 10) || 0;
  const galeMultiplier = parseFloat($('input-galemultiplier')?.value) || 2;

  if (!signalsText) return addLog('⚠️ Cole os sinais antes de agendar.', 'warn');

  const [y, m, d] = date.split('-');
  const dateFormatted = `${d}/${m}/${y}`;
  const stopLoss   = parseFloat($('input-stoploss')?.value) || 0;
  const takeProfit = parseFloat($('input-takeprofit')?.value) || 0;

  const minPayout = parseFloat($('input-minpayout')?.value) || 0;
  socket.emit('signals:submit', { signalsText, date: dateFormatted, stake, maxGales, galeMultiplier, stopLoss, takeProfit, minPayout });
});

elBtnCancelAll.addEventListener('click', () => {
  socket.emit('trades:cancel');
});

// Cancelamento individual (event delegation)
elScheduleBody.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-cancel-signal');
  if (!btn) return;
  const signalId = btn.dataset.id;
  if (signalId) {
    btn.disabled = true;
    socket.emit('signal:cancel', { signalId });
  }
});

// ── Persistência de formulário ────────────────────────────────────────────
['input-token', 'input-appid', 'input-accountid', 'input-stake', 'input-maxgales', 'input-galemultiplier', 'input-stoploss', 'input-takeprofit', 'input-minpayout'].forEach(id => {
  $(id)?.addEventListener('input', saveForm);
});
$('input-signals')?.addEventListener('input', saveForm);
$('input-date')?.addEventListener('change', saveForm);

// ── Eventos do Socket.io ──────────────────────────────────────────────────────

socket.on('connection:status', (data) => {
  setConnectedUI(data.connected);

  if (data.connected) {
    const { account, balance } = data;
    $('acc-loginid').textContent = account.loginid;
    $('acc-type').textContent    = account.is_virtual ? '🎮 Demo' : '💵 Real';
    $('acc-balance').textContent = `$${parseFloat(balance.amount).toFixed(2)} ${balance.currency}`;
    updateBalance(balance.amount, balance.currency);
    state.initialBalance = parseFloat(balance.amount);
    elSectionAccount.classList.remove('hidden');

    const others = (account.accountList || []).filter(a => a.loginid !== account.loginid);
    if (others.length > 0) {
      elSelectAccount.innerHTML = others
        .map(a => `<option value="${a.loginid}">${a.loginid} (${a.is_virtual ? 'Demo' : 'Real'})</option>`)
        .join('');
      $('account-switch-section').classList.remove('hidden');
    }

    // Re-agenda silenciosamente sinais pendentes (ex: após refresh da página)
    _autoRescheduleIfNeeded();
  }

  if (data.message) addLog(data.message, data.connected ? 'success' : 'error');
});

// Re-agendamento automático após reconexão
function _autoRescheduleIfNeeded() {
  const nowMs = Date.now();
  const pending = _scheduleData.filter(d =>
    d.status === 'waiting' &&
    d.signalData &&
    (d.scheduledAtMs || new Date(d.scheduledAt || 0).getTime()) > nowMs
  );
  if (pending.length === 0) return;
  const minPayout = parseFloat($('input-minpayout')?.value) || 0;
  const signals = pending.map(d => d.signalData);
  addLog(`🔄 ${pending.length} sinal(is) pendente(s) detectado(s) — re-agendando automaticamente...`, 'muted');
  socket.emit('signals:reschedule', { signals, minPayout });
}

socket.on('signals:reschedule:ack', (data) => {
  addLog(data.message, 'muted');
});

socket.on('signals:parsed', (data) => {
  if (data.source !== 'reschedule') state.totalScheduled += data.count;
  updateStats();
  addLog(data.message, 'info');
});

socket.on('trade:scheduled', (data) => {
  addLog(data.message, data.expired ? 'warn' : 'muted');
  addScheduleRow(data);
});

socket.on('trade:executing', (data) => {
  addLog(data.message, 'info');
  const galeLabel = data.galeRound > 0 ? `G${data.galeRound}` : undefined;
  updateScheduleStatus(data.signal.id, 'executing', galeLabel);
});

socket.on('trade:bought', (data) => {
  addLog(data.message, 'info');
  // Fallback visual: se a linha ainda não refletiu o executing, reforça o status
  if (data.signal?.id) {
    const galeLabel = data.galeRound > 0 ? `G${data.galeRound}` : undefined;
    updateScheduleStatus(data.signal.id, 'executing', galeLabel);
  }
});

socket.on('trade:update', (_data) => {});

socket.on('trade:payout', ({ signalId, payoutPct }) => {
  const entry = _scheduleData.find(d => d.id === signalId);
  if (entry) entry.payout = `${payoutPct.toFixed(1)}%`;
  const tr = scheduleRows.get(signalId);
  if (tr) {
    const cell = tr.querySelector('.sch-payout-cell');
    if (cell) cell.textContent = `${payoutPct.toFixed(1)}%`;
  }
});

socket.on('balance:update', ({ amount, currency }) => {
  updateBalance(amount, currency);
  const accBalEl = $('acc-balance');
  if (accBalEl && state.connected) {
    accBalEl.textContent = `$${parseFloat(amount).toFixed(2)} ${currency}`;
  }
});

socket.on('trade:sl_hit', (data) => {
  addLog(data.message, 'warn');
  playSound('loss');
});

socket.on('trade:tp_hit', (data) => {
  addLog(data.message, 'success');
  playSound('win');
});

socket.on('trade:result', (data) => {
  const type = data.won ? 'success' : 'error';
  addLog(data.message, type);

  // Acumula perdas de rounds intermediários do Gale (isFinal = false)
  const sigId = data.signal?.id;
  if (!data.isFinal) {
    const currentProfit = Number(data.profit) || 0;
    _galeProfitMap[sigId] = Number((Number(_galeProfitMap[sigId] || 0) + currentProfit).toFixed(2));
    saveGaleMap();
    return;
  }

  // Lucro líquido = resultado final + perdas acumuladas nos rounds anteriores do Gale
  const currentProfit = Number(data.profit) || 0;
  const previousGaleProfit = Number(_galeProfitMap[sigId] || 0);
  const netProfit = Number((currentProfit + previousGaleProfit).toFixed(2));
  delete _galeProfitMap[sigId];
  saveGaleMap();

  playSound(data.won ? 'win' : 'loss');

  if (data.won) {
    state.wins++;
  } else {
    state.losses++;
  }
  state.contractProfit += parseFloat(data.contractProfit ?? data.profit ?? 0);
  state.totalProfit += netProfit;

  const schEntry = _scheduleData.find(d => d.id === data.signal.id);
  const payoutPct = schEntry?.payout || '—';

  removeScheduleRow(data.signal.id);
  addResultRow({
    ...data,
    profit: netProfit,
    contractProfit: Number(data.contractProfit ?? data.profit) || 0,
    payoutPct,
  });
  updateStats();
});

socket.on('trade:gale_limit', (data) => {
  addLog(data.message, 'warn');
});

socket.on('candle:analyzing', ({ signal, galeRound, label }) => {
  const sym = signal?.symbol || '?';
  addLog(`🔍 Analisando velas — ${sym} (${label})...`, 'muted');
});

socket.on('candle:analysis', (data) => {
  const { signal, galeRound, proceed, votes, reasons, warnings, summary } = data;
  if (proceed) {
    addLog(summary, 'info');
    if (warnings && warnings.length) {
      addLog(`⚠️ Avisos de contexto: ${warnings.join(' | ')}`, 'warn');
    }
  } else {
    addLog(summary, 'warn');
    if (signal?.id) updateScheduleStatus(signal.id, 'rejected');
    if (signal) addBlockedRow({ signal, galeRound: galeRound ?? 0, votes: votes ?? 0, reasons: reasons ?? [] });
  }
});

socket.on('trade:result_lost', (data) => {
  addLog(data.message, 'warn');
  if (data.signal?.id && data.signal.id in _galeProfitMap) {
    delete _galeProfitMap[data.signal.id];
    saveGaleMap();
  }
});

socket.on('account:reconcile:result', ({ transactions }) => {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    addLog('🔍 Nenhum contrato concluído encontrado hoje na Deriv.', 'muted');
    return;
  }

  const todayResults = _getDateFilteredResults();
  const knownIds = new Set(todayResults.map(r => r.contractId).filter(Boolean));

  // Fallback por minuto+direção para registros sem contractId (dados antigos)
  const knownByKey = new Set(
    todayResults.filter(r => !r.contractId).map(r => {
      const ms  = r.scheduledAtMs || (r.scheduledAt ? new Date(r.scheduledAt).getTime() : 0);
      const dir = r.direction === 'CALL' ? 'CALL' : 'PUT';
      return `${dir}_${Math.floor(ms / 60000)}`;
    })
  );

  const missing = transactions.filter(t => {
    if (knownIds.has(String(t.contract_id))) return false;
    const ms  = (t.purchase_time || 0) * 1000;
    const dir = (t.contract_type || '').includes('CALL') ? 'CALL' : 'PUT';
    return !knownByKey.has(`${dir}_${Math.floor(ms / 60000)}`);
  });

  if (missing.length === 0) {
    addLog(`✅ Reconciliação: ${transactions.length} contrato(s) verificado(s) — nenhum ausente.`, 'success');
    return;
  }

  addLog(`⚠️ ${missing.length} contrato(s) não registrado(s) encontrado(s). Adicionando...`, 'warn');

  missing.forEach(t => {
    const won       = parseFloat(t.profit) >= 0;
    const profit    = parseFloat(t.profit);
    const stake     = parseFloat(t.buy_price);
    const parts     = (t.shortcode || '').split('_');
    const rawSymbol = parts[1] || '?';
    const dir       = (t.contract_type || '').includes('CALL') ? 'CALL' : 'PUT';
    const purchaseDate = new Date((t.purchase_time || 0) * 1000);
    const payoutPct = stake > 0 && t.payout != null
      ? `${(((parseFloat(t.payout) / stake) - 1) * 100).toFixed(1)}%` : '—';

    const fakeSignal = {
      id:            `reconciled_${t.contract_id}`,
      rawSymbol,
      direction:     dir,
      duration:      5,
      duration_unit: 'm',
      scheduledAt:   purchaseDate.toISOString(),
      signalIndex:   null,
    };

    addResultRow({
      signal: fakeSignal,
      won,
      profit,
      stake,
      galeRound: 0,
      payoutPct,
      contractId: String(t.contract_id),
    });

    if (won) state.wins++;
    else state.losses++;
    state.contractProfit += profit;
    state.totalProfit += profit;

    addLog(
      `📋 [Reconciliado] #${t.contract_id} ${rawSymbol} ${dir} | ${won ? '✅ WIN' : '❌ LOSS'} ${profit >= 0 ? '+' : ''}$${Math.abs(profit).toFixed(2)}`,
      won ? 'success' : 'error'
    );
  });

  updateStats();
  addLog(`✅ Reconciliação concluída. ${missing.length} contrato(s) adicionado(s).`, 'success');
});

socket.on('trades:cancelled', (data) => {
  addLog(data.message, 'warn');
  state.totalScheduled = 0;
  updateStats();
  _scheduleData.forEach(d => {
    if (d.status === 'waiting' || d.status === 'executing') {
      d.status = 'cancelled';
      const tr = scheduleRows.get(d.id);
      if (tr) {
        const statusCell = tr.querySelector('.sch-status-cell');
        if (statusCell) statusCell.innerHTML = statusBadge('cancelled');
        const btn = tr.querySelector('.btn-cancel-signal');
        if (btn) btn.disabled = true;
      }
    }
  });
  // Limpa mapa de gale — todos os sinais foram cancelados
  for (const key of Object.keys(_galeProfitMap)) { delete _galeProfitMap[key]; }
  saveGaleMap();
  saveSchedule();
});

socket.on('signal:cancelled', (data) => {
  updateScheduleStatus(data.signalId, 'cancelled');
  addLog('🛑 Sinal cancelado individualmente.', 'warn');
  if (data.signalId in _galeProfitMap) {
    delete _galeProfitMap[data.signalId];
    saveGaleMap();
  }
});

socket.on('error', (data) => {
  addLog(`❌ ${data.message}`, 'error');
});

socket.on('trade:error', (data) => {
  addLog(data.message, 'error');
  if (data.signal?.id) {
    updateScheduleStatus(data.signal.id, 'expired');
    if (data.signal.id in _galeProfitMap) {
      delete _galeProfitMap[data.signal.id];
      saveGaleMap();
    }
  }
});

socket.on('trade:skipped', (data) => {
  addLog(data.message, 'warn');
  if (data.signal?.id) {
    updateScheduleStatus(data.signal.id, 'rejected');
    if (data.signal.id in _galeProfitMap) {
      delete _galeProfitMap[data.signal.id];
      saveGaleMap();
    }
  }
});

// ── Reset de Dados ───────────────────────────────────────────────────────────
$('btn-reset-data')?.addEventListener('click', () => {
  if (!confirm('Tem certeza? Isso apagará todos os resultados, agendamentos, estatísticas e log. A configuração de conexão será mantida.')) return;

  _resultRows.length = 0;
  _scheduleData.length = 0;
  _logEntries.length = 0;
  _blockedRows.length = 0;
  scheduleRows.clear();
  for (const key of Object.keys(_galeProfitMap)) { delete _galeProfitMap[key]; }

  state.wins = 0;
  state.losses = 0;
  state.totalProfit = 0;
  state.contractProfit = 0;
  state.totalScheduled = 0;

  localStorage.removeItem(LS.RESULTS);
  localStorage.removeItem(LS.SCHEDULE);
  localStorage.removeItem(LS.LOG);
  localStorage.removeItem(LS.STATS);
  localStorage.removeItem(LS.BLOCKED);
  localStorage.removeItem(LS.GALE_MAP);

  elResultsBody.innerHTML = '';
  elScheduleBody.innerHTML = '';
  elLog.innerHTML = '';
  const elBlockedBody = $('blocked-body');
  if (elBlockedBody) elBlockedBody.innerHTML = '';

  renderScheduleTable();
  renderResultsTable();
  renderReportSummary();
  updateStats();

  addLog('🗑️ Todos os dados foram resetados.', 'warn');
});

// ── Inicialização ─────────────────────────────────────────────────────────────
restoreState();
initDateFilter();
setConnectedUI(false);
updateStats();

// Auto-reconexão: se há credenciais salvas, reconecta automaticamente ao (re)carregar a página.
// O evento 'connect' do socket.io dispara assim que a conexão WebSocket é estabelecida.
socket.on('connect', () => {
  socket.emit('session:init', _sessionId);
  try {
    const form = JSON.parse(localStorage.getItem(LS.FORM) || 'null');
    if (form?.token && form?.appId) {
      addLog('🔄 Reconectando automaticamente...', 'muted');
      socket.emit('config:connect', {
        token:       form.token,
        appId:       form.appId,
        accountId:   form.accountId  || undefined,
        stake:       parseFloat(form.stake)      || 1,
        maxGales:    parseInt(form.maxGales, 10) || 0,
        galeMultiplier: parseFloat(form.galeMultiplier) || 2,
        stopLoss:    parseFloat(form.stopLoss)   || 0,
        takeProfit:  parseFloat(form.takeProfit) || 0,
        minPayout:   parseFloat(form.minPayout)  || 0,
      });
      return;
    }
  } catch (_) {}
  addLog('🐂 ElToroDeriv iniciado. Configure sua API token para começar.', 'muted');
});
