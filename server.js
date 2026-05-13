'use strict';

const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const DerivClient = require('./src/derivClient');
const GaleManager = require('./src/galeManager');
const Scheduler = require('./src/scheduler');
const TelegramSignalSource = require('./src/telegramSignalSource');
const { parseSignals } = require('./src/signalParser');

const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, 'public')));

const telegramSessions = new Map();

function parseBaseDate(date) {
  if (!date) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
  }

  const parts = date.includes('/') ? date.split('/').reverse() : date.split('-');
  if (parts.length !== 3) return null;

  const [year, month, day] = parts;
  const parsed = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`);
  if (isNaN(parsed.getTime())) return null;
  return parsed;
}

function scheduleSignalsForSession({
  derivClient,
  galeManager,
  scheduler,
  emit,
  signalsText,
  date,
  stake,
  maxGales,
  stopLoss,
  takeProfit,
  minPayout,
  source = 'manual',
}) {
  const fromTelegram = source === 'telegram';

  if (!derivClient?.isConnected) {
    if (!fromTelegram) {
      emit('error', { message: 'Conecte-se à Deriv antes de agendar sinais.' });
    }
    return { ok: false, reason: 'not_connected' };
  }

  if (stake != null) galeManager.baseStake = parseFloat(stake) || galeManager.baseStake;
  if (maxGales != null) {
    const parsedMaxGales = parseInt(maxGales, 10);
    galeManager.maxGales = parsedMaxGales >= 0 ? parsedMaxGales : galeManager.maxGales;
  }
  if (stopLoss != null) scheduler.slAmount = parseFloat(stopLoss) || 0;
  if (takeProfit != null) scheduler.tpAmount = parseFloat(takeProfit) || 0;
  if (minPayout != null) scheduler.minPayout = parseFloat(minPayout) || 0;

  const baseDate = parseBaseDate(date);
  if (!baseDate) {
    emit('error', { message: 'Data inválida. Use o formato DD/MM/AAAA.' });
    return { ok: false, reason: 'invalid_date' };
  }

  if (!signalsText || typeof signalsText !== 'string') {
    const message = fromTelegram
      ? 'Telegram recebido sem texto de sinal.'
      : 'Nenhum sinal foi enviado.';
    emit('error', { message });
    return { ok: false, reason: 'empty_signals' };
  }

  const { signals, skipped } = parseSignals(signalsText, baseDate);
  if (signals.length === 0) {
    const message = fromTelegram
      ? `Telegram recebido, mas nenhum sinal válido foi identificado. ${skipped} linha(s) ignorada(s).`
      : `Nenhum sinal válido encontrado. ${skipped} linhas ignoradas.`;
    emit('error', { message });
    return { ok: false, reason: 'no_valid_signals', skipped };
  }

  const message = fromTelegram
    ? `📨 Telegram: ${signals.length} sinal(is) identificado(s). ${skipped > 0 ? `${skipped} linha(s) ignorada(s).` : ''}`
    : `📋 ${signals.length} sinal(is) identificado(s). ${skipped > 0 ? `${skipped} linha(s) ignorada(s).` : ''}`;

  emit('signals:parsed', {
    count: signals.length,
    skipped,
    source,
    message,
  });

  scheduler.schedule(signals);
  return { ok: true, count: signals.length, skipped };
}

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
const telegramChatId = process.env.TELEGRAM_CHAT_ID?.trim();

const telegramSource = telegramBotToken
  ? new TelegramSignalSource({
      botToken: telegramBotToken,
      chatId: telegramChatId,
      onLog: (level, msg) => {
        const logger = level === 'error' ? console.error : console.log;
        logger(`[Telegram] ${msg}`);
      },
    })
  : null;

// ─── Sessão por Socket ────────────────────────────────────────────────────────
// Cada conexão Socket.io tem sua própria instância de DerivClient + state.

io.on('connection', (socket) => {
  console.log(`[+] Cliente conectado: ${socket.id}`);

  let derivClient = null;
  const galeManager = new GaleManager();
  const scheduler = new Scheduler();
  let healthCheckTimer = null;

  /** Inicia o health check periódico da API (a cada 30s) */
  function startHealthCheck() {
    if (healthCheckTimer) clearInterval(healthCheckTimer);
    healthCheckTimer = setInterval(async () => {
      if (!derivClient?.isConnected) return;
      try {
        const ok = await derivClient.ping(5_000);
        emit('api:health', {
          ok,
          message: ok ? 'API respondendo normalmente' : 'API não respondeu ao ping',
        });
      } catch (err) {
        emit('api:health', { ok: false, message: err.message });
      }
    }, 30_000);
  }

  /** Utilitário: emite evento ao socket que iniciou a ação */
  const emit = (event, data) => socket.emit(event, data);
  const scheduleFromPayload = (payload) => scheduleSignalsForSession({
    derivClient,
    galeManager,
    scheduler,
    emit,
    ...payload,
  });

  telegramSessions.set(socket.id, {
    isConnected: () => !!derivClient?.isConnected,
    scheduleFromPayload,
  });

  // ─── Conectar à Deriv ─────────────────────────────────────────────────────

  socket.on('config:connect', async ({ token, appId, accountId, stake, maxGales, stopLoss, takeProfit }) => {
    try {
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        return emit('error', { message: 'Token da API é obrigatório.' });
      }
      if (!appId || typeof appId !== 'string' || appId.trim().length === 0) {
        return emit('error', { message: 'App ID é obrigatório.' });
      }

      // Desconecta sessão anterior se existir
      if (derivClient) {
        scheduler.reset(); // cancela timers sem emitir (emit pode não estar inicializado)
        galeManager.resetAll();
        derivClient.disconnect();
      }

      derivClient = new DerivClient(appId.trim());
      const isNewAPI = token.trim().startsWith('pat_');

      let accountInfo;

      if (isNewAPI) {
        // ── Nova API: fluxo OTP ────────────────────────────────────────────
        const { selectedAccount, accounts } = await derivClient.connectNewAPI(
          token.trim(),
          appId.trim(),
          accountId?.trim() || undefined
        );
        accountInfo = derivClient.accountInfo;

        // Inicializa gale e scheduler
        galeManager.init(stake || 1, maxGales || 0);
        scheduler.init(derivClient, galeManager, emit, stopLoss || 0, takeProfit || 0);
        const selAcc = accounts.find(a => a.account_id === selectedAccount.account_id);
        const balanceAmount = parseFloat(selAcc?.balance ?? 0);
        const currency = selAcc?.currency ?? 'USD';

        emit('connection:status', {
          connected: true,
          account: {
            loginid: accountInfo.loginid,
            fullname: accountInfo.loginid,
            email: '',
            currency,
            is_virtual: accountInfo.is_virtual,
            accountList: accounts.map(a => ({
              loginid: a.account_id,
              currency: a.currency,
              is_virtual: a.account_type === 'demo' ? 1 : 0,
              token: a.account_id, // account_id serve de identificador para troca
            })),
          },
          balance: {
            amount: balanceAmount,
            currency,
          },
          message: `✅ Conectado como ${accountInfo.loginid} (${accountInfo.is_virtual ? 'Demo' : 'Real'}) via nova API`,
        });

        startHealthCheck();

      } else {
        // ── API Legada ─────────────────────────────────────────────────────
        await derivClient.connect();
        accountInfo = await derivClient.authorize(token.trim());

        // Inicializa gale e scheduler
        galeManager.init(stake || 1, maxGales || 0);
        scheduler.init(derivClient, galeManager, emit, stopLoss || 0, takeProfit || 0);
        const balance = await derivClient.getBalance();

        emit('connection:status', {
          connected: true,
          account: {
            loginid: accountInfo.loginid,
            fullname: accountInfo.fullname,
            email: accountInfo.email,
            currency: accountInfo.currency,
            is_virtual: accountInfo.is_virtual,
            accountList: derivClient.getAccountList(),
          },
          balance: {
            amount: balance.balance,
            currency: balance.currency,
          },
          message: `✅ Conectado como ${accountInfo.fullname || accountInfo.loginid} (${accountInfo.is_virtual ? 'Demo' : 'Real'})`,
        });

        startHealthCheck();
      }

    } catch (err) {
      console.error('[config:connect] Erro:', err.message);
      emit('error', { message: `Erro ao conectar: ${err.message}` });
    }
  });

  // ─── Trocar de conta (Demo ↔ Real) ────────────────────────────────────────

  socket.on('account:switch', async ({ token }) => {
    try {
      if (!derivClient?.isConnected) {
        return emit('error', { message: 'Não conectado à Deriv.' });
      }
      if (!token || typeof token !== 'string') {
        return emit('error', { message: 'Token ou ID de conta inválido.' });
      }

      scheduler.cancelAll();
      galeManager.resetAll();

      const accountInfo = await derivClient.switchAccount(token.trim());

      // Para a nova API, o saldo vem dos metadados da conta
      let balanceAmount, currency;
      if (derivClient.accountInfo?._patToken) {
        const acc = derivClient.accountInfo._allAccounts.find(a => a.account_id === token.trim());
        balanceAmount = parseFloat(acc?.balance ?? 0);
        currency = acc?.currency ?? derivClient.accountInfo.currency;
      } else {
        const balance = await derivClient.getBalance();
        balanceAmount = balance.balance;
        currency = balance.currency;
      }

      emit('connection:status', {
        connected: true,
        account: {
          loginid: accountInfo.loginid,
          fullname: accountInfo.fullname || accountInfo.loginid,
          email: accountInfo.email || '',
          currency: accountInfo.currency,
          is_virtual: accountInfo.is_virtual,
          accountList: derivClient.getAccountList(),
        },
        balance: {
          amount: balanceAmount,
          currency,
        },
        message: `🔄 Conta trocada para ${accountInfo.loginid} (${accountInfo.is_virtual ? 'Demo' : 'Real'})`,
      });
    } catch (err) {
      console.error('[account:switch] Erro:', err.message);
      emit('error', { message: `Erro ao trocar conta: ${err.message}` });
    }
  });

  // ─── Submeter lista de sinais ─────────────────────────────────────────────

  socket.on('signals:submit', ({ signalsText, date, stake, maxGales, stopLoss, takeProfit, minPayout }) => {
    try {
      scheduleFromPayload({
        signalsText,
        date,
        stake,
        maxGales,
        stopLoss,
        takeProfit,
        minPayout,
        source: 'manual',
      });
    } catch (err) {
      console.error('[signals:submit] Erro:', err.message);
      emit('error', { message: `Erro ao processar sinais: ${err.message}` });
    }
  });

  // ─── Cancelar todos os agendamentos ──────────────────────────────────────

  socket.on('trades:cancel', () => {
    scheduler.cancelAll();
    galeManager.resetAll();
  });

  socket.on('signal:cancel', ({ signalId }) => {
    if (!signalId || typeof signalId !== 'string') return;
    const cancelled = scheduler.cancelSignal(signalId);
    if (cancelled) {
      emit('signal:cancelled', { signalId, message: `🛑 Agendamento cancelado.` });
    }
  });

  // ─── Re-agendar sinais pendentes após reconexão (refresh de página) ───────

  socket.on('signals:reschedule', ({ signals, minPayout }) => {
    try {
      if (!derivClient?.isConnected) return;
      if (!Array.isArray(signals) || signals.length === 0) return;

      if (minPayout != null) scheduler.minPayout = parseFloat(minPayout) || 0;

      const now = Date.now();
      const parsedSignals = signals
        .map(s => {
          if (!s || typeof s !== 'object') return null;
          const scheduledAt = new Date(s.scheduledAt);
          if (isNaN(scheduledAt.getTime())) return null;
          if (scheduledAt.getTime() <= now) return null;
          const direction = (s.direction || '').toUpperCase();
          if (direction !== 'CALL' && direction !== 'PUT') return null;
          return {
            id: s.id,
            raw: s.raw || '',
            symbol: s.symbol,
            rawSymbol: s.rawSymbol,
            duration: parseInt(s.duration, 10) || 5,
            duration_unit: s.duration_unit || 'm',
            scheduledAt,
            direction,
            contract_type: s.contract_type || direction,
            signalIndex: s.signalIndex ?? null,
            status: 'pending',
          };
        })
        .filter(Boolean);

      if (parsedSignals.length === 0) return;

      emit('signals:reschedule:ack', {
        count: parsedSignals.length,
        message: `🔄 Re-agendando ${parsedSignals.length} sinal(is) pendente(s)...`,
      });

      scheduler.schedule(parsedSignals);
    } catch (err) {
      console.error('[signals:reschedule] Erro:', err.message);
    }
  });

  // ─── Desconectar da Deriv (solicitado pelo usuário) ─────────────────────

  socket.on('config:disconnect', () => {
    scheduler.cancelAll();
    galeManager.resetAll();
    if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
    if (derivClient) {
      derivClient.disconnect();
      derivClient = null;
    }
    console.log(`[~] Sessão Deriv encerrada pelo usuário: ${socket.id}`);
  });

  // ─── Desconexão do Socket.io (browser fechado / aba recarregada) ──────────

  socket.on('disconnect', () => {
    console.log(`[-] Cliente desconectado: ${socket.id}`);
    telegramSessions.delete(socket.id);
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer);
      healthCheckTimer = null;
    }
    scheduler.cancelAll();
    if (derivClient) {
      derivClient.disconnect();
      derivClient = null;
    }
  });
});

if (telegramSource) {
  telegramSource.start(({ text, chatId, from, messageId }) => {
    let delivered = 0;

    for (const session of telegramSessions.values()) {
      if (!session.isConnected()) continue;
      const result = session.scheduleFromPayload({
        signalsText: text,
        source: 'telegram',
      });
      if (result.ok) delivered++;
    }

    if (delivered > 0) {
      console.log(`[Telegram] Mensagem #${messageId} de ${from} (chat ${chatId}) aplicada em ${delivered} sessão(ões).`);
    } else {
      console.log(`[Telegram] Mensagem #${messageId} recebida, mas sem sessão Deriv conectada.`);
    }
  });
} else {
  console.log('[Telegram] Automação desativada. Defina TELEGRAM_BOT_TOKEN para ativar.');
}

const shutdown = () => {
  if (telegramSource) telegramSource.stop();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Iniciar servidor ─────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n🐂 ElToroDeriv rodando em http://localhost:${PORT}\n`);
});
