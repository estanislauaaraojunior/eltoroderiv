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
const elSelectAccount  = $('select-account');

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
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

elBtnClearLog.addEventListener('click', () => {
  elLog.innerHTML = '';
});

// ── Estatísticas ──────────────────────────────────────────────────────────────
function updateStats() {
  $('stat-total').textContent   = state.totalScheduled;
  $('stat-wins').textContent    = state.wins;
  $('stat-losses').textContent  = state.losses;

  const profitEl = $('stat-profit');
  profitEl.textContent = `$${Math.abs(state.totalProfit).toFixed(2)}`;
  profitEl.className = 'stat-value ' + (state.totalProfit >= 0 ? 'green' : 'red');
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

// ── Formulário de Configuração ────────────────────────────────────────────────
elFormConfig.addEventListener('submit', (e) => {
  e.preventDefault();
  const token    = $('input-token').value.trim();
  const appId    = $('input-appid').value.trim() || '1089';
  const stake    = parseFloat($('input-stake').value) || 1;
  const maxGales = parseInt($('input-maxgales').value, 10) || 0;

  if (!token) return addLog('⚠️ Informe o Token da API.', 'warn');

  addLog('🔌 Conectando à Deriv...', 'muted');
  socket.emit('config:connect', { token, appId, stake, maxGales });
});

elBtnDisconnect.addEventListener('click', () => {
  socket.emit('config:connect', { token: '___INVALID___' }); // força reconexão limpa
  setConnectedUI(false);
  addLog('🔌 Desconectado.', 'muted');
});

// ── Trocar Conta ──────────────────────────────────────────────────────────────
elBtnSwitch && elBtnSwitch.addEventListener('click', () => {
  const token = $('input-switch-token').value.trim();
  if (!token) return addLog('⚠️ Informe o token da conta destino.', 'warn');
  socket.emit('account:switch', { token });
});

// ── Formulário de Sinais ──────────────────────────────────────────────────────
elFormSignals.addEventListener('submit', (e) => {
  e.preventDefault();
  const signalsText = $('input-signals').value.trim();
  const date        = $('input-date').value; // formato AAAA-MM-DD

  if (!signalsText) return addLog('⚠️ Cole os sinais antes de agendar.', 'warn');

  // Converte YYYY-MM-DD → DD/MM/YYYY para o servidor
  const [y, m, d] = date.split('-');
  const dateFormatted = `${d}/${m}/${y}`;

  socket.emit('signals:submit', { signalsText, date: dateFormatted });
});

elBtnCancelAll.addEventListener('click', () => {
  socket.emit('trades:cancel');
});

// ── Tabela de Resultados ──────────────────────────────────────────────────────
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
}

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
});

// Trade em execução
socket.on('trade:executing', (data) => {
  addLog(data.message, 'info');
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

  if (data.won) {
    state.wins++;
    state.totalProfit += data.profit;
  } else {
    // Só conta como loss definitivo se não vai entrar em gale
  }

  addResultRow(data);
  updateStats();
});

// Limite de gale atingido
socket.on('trade:gale_limit', (data) => {
  state.losses++;
  updateStats();
  addLog(data.message, 'warn');
});

// Cancelamento
socket.on('trades:cancelled', (data) => {
  addLog(data.message, 'warn');
  state.totalScheduled = 0;
  updateStats();
});

// Erros gerais
socket.on('error', (data) => {
  addLog(`❌ ${data.message}`, 'error');
});

// Erro em trade específico
socket.on('trade:error', (data) => {
  addLog(data.message, 'error');
});

// ── Inicialização ─────────────────────────────────────────────────────────────
setConnectedUI(false);
updateStats();
addLog('🐂 ElToroDeriv iniciado. Configure sua API token para começar.', 'muted');
