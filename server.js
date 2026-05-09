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

  /** Utilitário: emite evento ao socket que iniciou a ação */
  const emit = (event, data) => socket.emit(event, data);

  // ─── Conectar à Deriv ─────────────────────────────────────────────────────

  socket.on('config:connect', async ({ token, appId, stake, maxGales }) => {
    try {
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        return emit('error', { message: 'Token da API é obrigatório.' });
      }

      // Desconecta sessão anterior se existir
      if (derivClient) {
        scheduler.cancelAll();
        derivClient.disconnect();
      }

      derivClient = new DerivClient(appId || '1089');
      await derivClient.connect();

      const accountInfo = await derivClient.authorize(token.trim());

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
        return emit('error', { message: 'Token inválido.' });
      }

      scheduler.cancelAll();
      galeManager.resetAll();

      const accountInfo = await derivClient.switchAccount(token.trim());
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
        message: `🔄 Conta trocada para ${accountInfo.loginid} (${accountInfo.is_virtual ? 'Demo' : 'Real'})`,
      });
    } catch (err) {
      console.error('[account:switch] Erro:', err.message);
      emit('error', { message: `Erro ao trocar conta: ${err.message}` });
    }
  });

  // ─── Submeter lista de sinais ─────────────────────────────────────────────

  socket.on('signals:submit', ({ signalsText, date }) => {
    try {
      if (!derivClient?.isConnected) {
        return emit('error', { message: 'Conecte-se à Deriv antes de agendar sinais.' });
      }

      // Cancela qualquer agendamento anterior antes de criar novo
      scheduler.cancelAll();
      galeManager.resetAll();

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

  // ─── Desconectar ──────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    console.log(`[-] Cliente desconectado: ${socket.id}`);
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
