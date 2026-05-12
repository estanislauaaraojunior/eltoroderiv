'use strict';

// ── Socket.io ─────────────────────────────────────────────────────────────────
const socket = io();

// ── Estado da UI ──────────────────────────────────────────────────────────────
const state = {
  connected: false,
  wins: 0,
  losses: 0,
  totalProfit: 0,
  totalScheduled: 0,
};

// ── Elementos ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const elStatusBadge    = $('status-badge');
const elBtnConnect     = $('btn-connect');
const elBtnDisconnect  = $('btn-disconnect');
const elBtnSchedule    = $('btn-schedule');
const elBtnCancelAll   = $('btn-cancel-all');
const elBtnClearLog    = $('btn-clear-log');
const elBtnSwitch      = $('btn-switch');
const elFormConfig     = $('form-config');
const elFormSignals    = $('form-signals');
const elSectionAccount = $('section-account');
const elLog            = $('log');
const elResultsBody    = $('results-body');
const elScheduleBody   = $('schedule-body');
const elSelectAccount  = $('select-account');

// Rastreia linhas da tabela de agendamentos por signalId
const scheduleRows = new Map();

// Dados para persistência
const _resultRows   = [];
const _scheduleData = [];
const _logEntries   = [];

// Inicializa campo de data com hoje
const today = new Date();
$('input-date').value = today.toISOString().slice(0, 10);

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
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

elBtnClearLog.addEventListener('click', () => {
  elLog.innerHTML = '';
  _logEntries.length = 0;
  saveLog();
});

// ── Estatísticas ──────────────────────────────────────────────────────────────
function updateStats() {
  $('stat-total').textContent   = state.totalScheduled;
  $('stat-wins').textContent    = state.wins;
  $('stat-losses').textContent  = state.losses;

  const profitEl = $('stat-profit');
  profitEl.textContent = `$${Math.abs(state.totalProfit).toFixed(2)}`;
  profitEl.className = 'stat-value ' + (state.totalProfit >= 0 ? 'green' : 'red');
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
  }
}
// ── Tabela de Agendamentos ─────────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    waiting:   { cls: 'status-waiting',   label: '⏳ Aguardando' },
    executing: { cls: 'status-running',   label: '🚀 Executando' },
    done:      { cls: 'status-done',      label: '✅ Concluído' },
    cancelled: { cls: 'status-cancelled', label: '🛑 Cancelado' },
    expired:   { cls: 'status-expired',   label: '⚠️ Expirado' },
  };
  const s = map[status] || map.waiting;
  return `<span class="status-badge ${s.cls}">${s.label}</span>`;
}

function addScheduleRow(data) {
  const { signal, expired, baseStake } = data;
  const scheduledTime = new Date(signal.scheduledAt).toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit',
  });
  const dirClass = signal.direction === 'CALL' ? 'direction-call' : 'direction-put';
  const status = expired ? 'expired' : 'waiting';
  const stakeDisplay = `$${parseFloat(baseStake || 1).toFixed(2)}`;
  const duration = `${signal.duration}${signal.duration_unit}`;

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${scheduledTime}</td>
    <td>${escapeHtml(signal.rawSymbol)}</td>
    <td class="${dirClass}">${signal.direction === 'CALL' ? '⬆️ CALL' : '⬇️ PUT'}</td>
    <td>${escapeHtml(duration)}</td>
    <td>${escapeHtml(stakeDisplay)}</td>
    <td id="sch-gale-${signal.id}">—</td>
    <td id="sch-status-${signal.id}">${statusBadge(status)}</td>
    <td><button class="btn btn-ghost btn-cancel-signal" data-id="${signal.id}"${status === 'expired' ? ' disabled' : ''}>Cancelar</button></td>
  `;
  scheduleRows.set(signal.id, tr);
  elScheduleBody.prepend(tr);

  _scheduleData.unshift({
    id: signal.id,
    scheduledTime,
    rawSymbol: signal.rawSymbol,
    direction: signal.direction,
    duration,
    stake: stakeDisplay,
    galeLabel: '—',
    status,
  });
  saveSchedule();
}

function updateScheduleStatus(signalId, status, galeLabel) {
  const statusEl = document.getElementById(`sch-status-${signalId}`);
  if (statusEl) statusEl.innerHTML = statusBadge(status);
  if (galeLabel !== undefined) {
    const galeEl = document.getElementById(`sch-gale-${signalId}`);
    if (galeEl) galeEl.textContent = galeLabel;
  }
  // Desabilita botão cancelar quando não está mais aguardando
  if (status !== 'waiting') {
    const tr = scheduleRows.get(signalId);
    const btn = tr?.querySelector('.btn-cancel-signal');
    if (btn) btn.disabled = true;
  }
  const entry = _scheduleData.find(d => d.id === signalId);
  if (entry) {
    entry.status = status;
    if (galeLabel !== undefined) entry.galeLabel = galeLabel;
  }
  saveSchedule();
}

function removeScheduleRow(signalId) {
  const tr = scheduleRows.get(signalId);
  if (tr) {
    tr.remove();
    scheduleRows.delete(signalId);
  }
  const idx = _scheduleData.findIndex(d => d.id === signalId);
  if (idx !== -1) _scheduleData.splice(idx, 1);
  saveSchedule();
}

// ── localStorage ───────────────────────────────────────────────────────────
const LS = {
  FORM:     'eltoro_form',
  STATS:    'eltoro_stats',
  RESULTS:  'eltoro_results',
  SCHEDULE: 'eltoro_schedule',
  LOG:      'eltoro_log',
};

function saveForm() {
  try {
    localStorage.setItem(LS.FORM, JSON.stringify({
      token:       $('input-token')?.value  || '',
      appId:       $('input-appid')?.value  || '',
      accountId:   $('input-accountid')?.value || '',
      stake:       $('input-stake')?.value  || '1',
      maxGales:    $('input-maxgales')?.value || '1',
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
      totalScheduled: state.totalScheduled,
    }));
  } catch (_) {}
}

function saveResults() {
  try {
    localStorage.setItem(LS.RESULTS, JSON.stringify(_resultRows.slice(-200)));
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

function restoreState() {
  try {
    const form = JSON.parse(localStorage.getItem(LS.FORM) || 'null');
    if (form) {
      if (form.token)        $('input-token').value      = form.token;
      if (form.appId)        $('input-appid').value      = form.appId;
      if (form.accountId)    $('input-accountid').value  = form.accountId;
      if (form.stake)        $('input-stake').value      = form.stake;
      if (form.maxGales)     $('input-maxgales').value   = form.maxGales;
      if (form.signalsText)  $('input-signals').value    = form.signalsText;
      if (form.date)         $('input-date').value       = form.date;
    }
  } catch (_) {}

  try {
    const stats = JSON.parse(localStorage.getItem(LS.STATS) || 'null');
    if (stats) {
      state.wins           = stats.wins           || 0;
      state.losses         = stats.losses         || 0;
      state.totalProfit    = stats.totalProfit    || 0;
      state.totalScheduled = stats.totalScheduled || 0;
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
    results.forEach(r => {
      _resultRows.push(r);
      _renderResultRow(r);
    });
  } catch (_) {}

  try {
    const schedule = JSON.parse(localStorage.getItem(LS.SCHEDULE) || '[]');
    schedule.forEach(d => {
      const status = (d.status === 'waiting' || d.status === 'executing') ? 'expired' : d.status;
      const dirClass = d.direction === 'CALL' ? 'direction-call' : 'direction-put';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(d.scheduledTime)}</td>
        <td>${escapeHtml(d.rawSymbol)}</td>
        <td class="${dirClass}">${d.direction === 'CALL' ? '⬆️ CALL' : '⬇️ PUT'}</td>
        <td>${escapeHtml(d.duration)}</td>
        <td>${escapeHtml(d.stake)}</td>
        <td id="sch-gale-${d.id}">${escapeHtml(d.galeLabel)}</td>
        <td id="sch-status-${d.id}">${statusBadge(status)}</td>
        <td><button class="btn btn-ghost btn-cancel-signal" data-id="${d.id}" disabled>Cancelar</button></td>
      `;
      scheduleRows.set(d.id, tr);
      elScheduleBody.appendChild(tr);
      _scheduleData.push({ ...d, status });
    });
  } catch (_) {}
}
// ── Formulário de Configuração ────────────────────────────────────────────────
elFormConfig.addEventListener('submit', (e) => {
  e.preventDefault();
  const token     = $('input-token').value.trim();
  const appId     = $('input-appid').value.trim();
  const accountId = ($('input-accountid')?.value || '').trim() || undefined;
  const stake     = parseFloat($('input-stake').value) || 1;
  const maxGales  = parseInt($('input-maxgales').value, 10) || 0;

  if (!token) return addLog('⚠️ Informe o Token da API.', 'warn');
  if (!appId)  return addLog('⚠️ Informe o App ID.', 'warn');

  // Detecta combinação inválida: token pat_ com App ID numérico (legado)
  const isNewToken = token.startsWith('pat_');
  const isNumericAppId = /^\d+$/.test(appId);
  if (isNewToken && isNumericAppId) {
    return addLog(
      '❌ App ID numérico ("' + appId + '") não funciona com token pat_. ' +
      'Acesse developers.deriv.com, registre seu app e use o App ID alfanumérico gerado.',
      'error'
    );
  }

  addLog('🔌 Conectando à Deriv...', 'muted');
  socket.emit('config:connect', { token, appId, accountId, stake, maxGales });
});

elBtnDisconnect.addEventListener('click', () => {
  socket.emit('config:disconnect');
  setConnectedUI(false);
  addLog('🔌 Desconectado.', 'muted');
});

// ── Trocar Conta ──────────────────────────────────────────────────────────────
elBtnSwitch && elBtnSwitch.addEventListener('click', () => {
  // Para nova API: usa o loginid (account_id) selecionado no select
  // Para API legada: usa o token digitado no input
  const selectedAccountId = elSelectAccount?.value?.trim();
  const inputToken = $('input-switch-token')?.value?.trim();
  const tokenOrId = selectedAccountId || inputToken;
  if (!tokenOrId) return addLog('⚠️ Selecione ou informe a conta destino.', 'warn');
  socket.emit('account:switch', { token: tokenOrId });
});

// ── Formulário de Sinais ──────────────────────────────────────────────────────
elFormSignals.addEventListener('submit', (e) => {
  e.preventDefault();
  const signalsText = $('input-signals').value.trim();
  const date        = $('input-date').value; // formato AAAA-MM-DD
  const stake       = parseFloat($('input-stake').value) || 1;
  const maxGales    = parseInt($('input-maxgales').value, 10) || 0;

  if (!signalsText) return addLog('⚠️ Cole os sinais antes de agendar.', 'warn');

  // Converte YYYY-MM-DD → DD/MM/YYYY para o servidor
  const [y, m, d] = date.split('-');
  const dateFormatted = `${d}/${m}/${y}`;

  socket.emit('signals:submit', { signalsText, date: dateFormatted, stake, maxGales });
});

elBtnCancelAll.addEventListener('click', () => {
  socket.emit('trades:cancel');
});

// Cancelamento individual de agendamento (event delegation)
elScheduleBody.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-cancel-signal');
  if (!btn) return;
  const signalId = btn.dataset.id;
  if (signalId) {
    btn.disabled = true;
    socket.emit('signal:cancel', { signalId });
  }
});

// ── Tabela de Resultados ──────────────────────────────────────────────────────
function _renderResultRow(r) {
  const tr = document.createElement('tr');
  tr.className = r.won ? 'win' : 'loss';
  const profitClass = r.profit >= 0 ? 'profit-positive' : 'profit-negative';
  const dirClass    = r.direction === 'CALL' ? 'direction-call' : 'direction-put';
  tr.innerHTML =
    `<td>${escapeHtml(r.scheduledTime)}</td>` +
    `<td>${escapeHtml(r.rawSymbol)}</td>` +
    `<td class="${dirClass}">${r.direction === 'CALL' ? '\u2b06\ufe0f CALL' : '\u2b07\ufe0f PUT'}</td>` +
    `<td>${escapeHtml(r.duration)}</td>` +
    `<td>$${parseFloat(r.stake).toFixed(2)}</td>` +
    `<td>${r.galeRound > 0 ? 'G' + r.galeRound : '\u2014'}</td>` +
    `<td>${r.won ? '\u2705 WIN' : '\u274c LOSS'}</td>` +
    `<td class="${profitClass}">${r.profit >= 0 ? '+' : ''}$${parseFloat(r.profit).toFixed(2)}</td>`;
  elResultsBody.prepend(tr);
}

function addResultRow({ signal, won, profit, stake, galeRound }) {
  const scheduledTime = new Date(signal.scheduledAt).toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit',
  });

  const tr = document.createElement('tr');
  tr.className = won ? 'win' : 'loss';

  const profitClass = profit >= 0 ? 'profit-positive' : 'profit-negative';
  const dirClass    = signal.direction === 'CALL' ? 'direction-call' : 'direction-put';

  tr.innerHTML = `
    <td>${scheduledTime}</td>
    <td>${signal.rawSymbol}</td>
    <td class="${dirClass}">${signal.direction === 'CALL' ? '⬆️ CALL' : '⬇️ PUT'}</td>
    <td>${signal.duration}${signal.duration_unit}</td>
    <td>$${parseFloat(stake).toFixed(2)}</td>
    <td>${galeRound > 0 ? `G${galeRound}` : '—'}</td>
    <td>${won ? '✅ WIN' : '❌ LOSS'}</td>
    <td class="${profitClass}">${profit >= 0 ? '+' : ''}$${parseFloat(profit).toFixed(2)}</td>
  `;

  elResultsBody.prepend(tr); // Mais recente no topo

  _resultRows.push({
    scheduledTime,
    rawSymbol:  signal.rawSymbol,
    direction:  signal.direction,
    duration:   signal.duration + signal.duration_unit,
    stake,
    galeRound,
    won,
    profit,
  });
  saveResults();
}
// ── Persistência de formulário ────────────────────────────────────────────
['input-token', 'input-appid', 'input-accountid', 'input-stake', 'input-maxgales'].forEach(id => {
  $(id)?.addEventListener('input', saveForm);
});
$('input-signals')?.addEventListener('input', saveForm);
$('input-date')?.addEventListener('change', saveForm);
// ── Eventos do Socket.io ──────────────────────────────────────────────────────

// Conectado à Deriv
socket.on('connection:status', (data) => {
  setConnectedUI(data.connected);

  if (data.connected) {
    const { account, balance } = data;
    $('acc-loginid').textContent = account.loginid;
    $('acc-type').textContent    = account.is_virtual ? '🎮 Demo' : '💵 Real';
    $('acc-balance').textContent = `$${parseFloat(balance.amount).toFixed(2)} ${balance.currency}`;
    elSectionAccount.classList.remove('hidden');

    // Preenche select de contas alternativas (se houver)
    const others = (account.accountList || []).filter(a => a.loginid !== account.loginid);
    if (others.length > 0) {
      elSelectAccount.innerHTML = others
        .map(a => `<option value="${a.loginid}">${a.loginid} (${a.is_virtual ? 'Demo' : 'Real'})</option>`)
        .join('');
      $('account-switch-section').classList.remove('hidden');
    }
  }

  if (data.message) addLog(data.message, data.connected ? 'success' : 'error');
});

// Sinais processados
socket.on('signals:parsed', (data) => {
  state.totalScheduled += data.count;
  updateStats();
  addLog(data.message, 'info');
});

// Trade agendado
socket.on('trade:scheduled', (data) => {
  addLog(data.message, data.expired ? 'warn' : 'muted');
  addScheduleRow(data);
});

// Trade em execução
socket.on('trade:executing', (data) => {
  addLog(data.message, 'info');
  const galeLabel = data.galeRound > 0 ? `G${data.galeRound}` : undefined;
  updateScheduleStatus(data.signal.id, 'executing', galeLabel);
});

// Ordem aberta
socket.on('trade:bought', (data) => {
  addLog(data.message, 'info');
});

// Atualização em tempo real do contrato
socket.on('trade:update', (data) => {
  // Opcional: atualizar algum indicador de progresso
});

// Resultado final do trade
socket.on('trade:result', (data) => {
  const type = data.won ? 'success' : 'error';
  addLog(data.message, type);

  if (!data.isFinal) {
    // Resultado intermediário de gale — apenas loga; aguarda o resultado final
    return;
  }

  // Resultado final (WIN, ou LOSS sem mais gales)
  if (data.won) {
    state.wins++;
    state.totalProfit += data.profit;
  } else {
    state.losses++;
    state.totalProfit += data.profit; // profit é negativo para perdas
  }

  removeScheduleRow(data.signal.id);
  addResultRow(data);
  updateStats();
});

// Limite de gale atingido
socket.on('trade:gale_limit', (data) => {
  addLog(data.message, 'warn');
});

// Cancelamento
socket.on('trades:cancelled', (data) => {
  addLog(data.message, 'warn');
  state.totalScheduled = 0;
  updateStats();
  _scheduleData.forEach(d => {
    if (d.status === 'waiting' || d.status === 'executing') {
      d.status = 'cancelled';
      const statusEl = document.getElementById(`sch-status-${d.id}`);
      if (statusEl) statusEl.innerHTML = statusBadge('cancelled');
      const tr = scheduleRows.get(d.id);
      const btn = tr?.querySelector('.btn-cancel-signal');
      if (btn) btn.disabled = true;
    }
  });
  saveSchedule();
});

// Cancelamento individual confirmado
socket.on('signal:cancelled', (data) => {
  updateScheduleStatus(data.signalId, 'cancelled');
  addLog(`🛑 Sinal cancelado individualmente.`, 'warn');
});

// Erros gerais
socket.on('error', (data) => {
  addLog(`❌ ${data.message}`, 'error');
});

// Erro em trade específico
socket.on('trade:error', (data) => {
  addLog(data.message, 'error');
  if (data.signal?.id) updateScheduleStatus(data.signal.id, 'expired');
});

// ── Inicialização ─────────────────────────────────────────────────────────────
restoreState();
setConnectedUI(false);
updateStats();
addLog('🐂 ElToroDeriv iniciado. Configure sua API token para começar.', 'muted');
