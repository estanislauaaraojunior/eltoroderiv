'use strict';

const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const DerivClient = require('./src/derivClient');
const GaleManager = require('./src/galeManager');
const Scheduler = require('./src/scheduler');
const { parseSignals } = require('./src/signalParser');

const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, 'public')));

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

  // ─── Conectar à Deriv ─────────────────────────────────────────────────────

  socket.on('config:connect', async ({ token, appId, accountId, stake, maxGales }) => {
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
        scheduler.init(derivClient, galeManager, emit);

        // Saldo vem da lista de contas
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
        scheduler.init(derivClient, galeManager, emit);

        // Busca saldo
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

  socket.on('signals:submit', ({ signalsText, date, stake, maxGales }) => {
    try {
      if (!derivClient?.isConnected) {
        return emit('error', { message: 'Conecte-se à Deriv antes de agendar sinais.' });
      }

      // Atualiza stake/gale se fornecidos (sem cancelar agendamentos existentes)
      if (stake != null) galeManager.baseStake = parseFloat(stake) || galeManager.baseStake;
      if (maxGales != null) galeManager.maxGales = parseInt(maxGales, 10) >= 0 ? parseInt(maxGales, 10) : galeManager.maxGales;

      // Determina a data-base (usa a data enviada pelo cliente ou hoje)
      let baseDate;
      if (date) {
        // Formato esperado: "DD/MM/YYYY" ou "YYYY-MM-DD"
        const parts = date.includes('/') ? date.split('/').reverse() : date.split('-');
        baseDate = new Date(`${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}T00:00:00`);
      } else {
        baseDate = new Date();
        baseDate.setHours(0, 0, 0, 0);
      }

      if (isNaN(baseDate.getTime())) {
        return emit('error', { message: 'Data inválida. Use o formato DD/MM/AAAA.' });
      }

      if (!signalsText || typeof signalsText !== 'string') {
        return emit('error', { message: 'Nenhum sinal foi enviado.' });
      }

      const { signals, skipped } = parseSignals(signalsText, baseDate);

      if (signals.length === 0) {
        return emit('error', {
          message: `Nenhum sinal válido encontrado. ${skipped} linhas ignoradas.`,
        });
      }

      emit('signals:parsed', {
        count: signals.length,
        skipped,
        message: `📋 ${signals.length} sinal(is) identificado(s). ${skipped > 0 ? `${skipped} linha(s) ignorada(s).` : ''}`,
      });

      scheduler.schedule(signals);
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

  // ─── Cancelar agendamento individual ─────────────────────────────────────

  socket.on('signal:cancel', ({ signalId }) => {
    if (!signalId || typeof signalId !== 'string') return;
    const cancelled = scheduler.cancelSignal(signalId);
    if (cancelled) {
      emit('signal:cancelled', { signalId, message: `🛑 Agendamento cancelado.` });
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

// ─── Iniciar servidor ─────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n🐂 ElToroDeriv rodando em http://localhost:${PORT}\n`);
});
