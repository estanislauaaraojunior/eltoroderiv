'use strict';

/**
 * Scheduler de operações — agenda cada sinal via setTimeout.
 * Ao disparar, executa a operação na Deriv e aplica Gale se necessário.
 */
class Scheduler {
  constructor() {
    // Map<signalId, timeoutHandle>
    this._timers = new Map();
    // Set de chaves compostas já agendadas (evita duplicatas)
    this._scheduledKeys = new Set();
    this._emit = null;
    this._derivClient = null;
    this._galeManager = null;
    this.slAmount = 0;
    this.tpAmount = 0;
    this.minPayout = 0;
    this._sessionProfit = 0;
  }

  /**
   * Inicializa o scheduler com as dependências necessárias.
   * @param {DerivClient}  derivClient
   * @param {GaleManager}  galeManager
   * @param {Function}     emit         Função para emitir eventos ao cliente Socket.io
   */
  init(derivClient, galeManager, emit, slAmount = 0, tpAmount = 0) {
    this._derivClient = derivClient;
    this._galeManager = galeManager;
    this._emit = emit;
    this.slAmount = parseFloat(slAmount) || 0;
    this.tpAmount = parseFloat(tpAmount) || 0;
    this._sessionProfit = 0;
  }

  /** Reseta o scheduler sem emitir eventos (usado em reconexão). */
  reset() {
    for (const [, handle] of this._timers) {
      clearTimeout(handle);
    }
    this._timers.clear();
    this._scheduledKeys.clear();
    this._emit = null;
    this._derivClient = null;
    this._galeManager = null;
  }

  /**
   * Agenda uma lista de sinais.
   * @param {Signal[]} signals Array parseado por signalParser
   */
  schedule(signals) {
    const now = Date.now();

    for (const signal of signals) {
      // Chave composta para evitar reagendamento do mesmo sinal
      const slotKey = `${signal.rawSymbol}_${signal.scheduledAt.getTime()}_${signal.direction}`;
      if (this._scheduledKeys.has(slotKey)) {
        this._emit('trade:scheduled', {
          signal,
          message: `⚠️ Sinal já agendado (ignorado): ${signal.rawSymbol} ${signal.direction} às ${this._formatTime(signal.scheduledAt)}`,
          expired: false,
          skipped: true,
          baseStake: this._galeManager.baseStake,
        });
        continue;
      }

      const delay = signal.scheduledAt.getTime() - now;

      if (delay <= 0) {
        // Sinal já expirou
        signal.status = 'expired';
        this._emit('trade:scheduled', {
          signal,
          message: `⚠️ Sinal expirado: ${signal.rawSymbol} ${signal.direction} às ${this._formatTime(signal.scheduledAt)}`,
          expired: true,
          baseStake: this._galeManager.baseStake,
        });
        continue;
      }

      signal.status = 'scheduled';
      this._scheduledKeys.add(slotKey);
      this._emit('trade:scheduled', {
        signal,
        message: `📅 Agendado: ${signal.rawSymbol} ${signal.direction} às ${this._formatTime(signal.scheduledAt)} (em ${this._formatDelay(delay)})`,
        expired: false,
        scheduledAt: signal.scheduledAt.toISOString(),
        baseStake: this._galeManager.baseStake,
      });

      // Pré-check 1 minuto antes da entrada
      const preCheckDelay = delay - 60_000;
      if (preCheckDelay > 0) {
        setTimeout(async () => {
          if (!this._derivClient || !this._emit) return;
          const label = this._formatTime(signal.scheduledAt);
          try {
            const ok = await this._derivClient.ping(5_000);
            if (ok) {
              this._emit('api:precheck:ok', {
                signal: { ...signal, scheduledTimeLabel: label },
              });
            } else {
              this._emit('api:precheck:fail', {
                signal: { ...signal, scheduledTimeLabel: label },
                message: 'Sem resposta (ping timeout) — tentando reconectar...',
              });
              await this._tryReconnect(signal, label);
            }
          } catch (err) {
            this._emit('api:precheck:fail', {
              signal: { ...signal, scheduledTimeLabel: label },
              message: `${err.message} — tentando reconectar...`,
            });
            await this._tryReconnect(signal, label);
          }
        }, preCheckDelay);
      }

      const handle = setTimeout(() => {
        this._timers.delete(signal.id);
        this._scheduledKeys.delete(slotKey);
        this._executeTrade(signal, this._galeManager.getStake(signal.id), 0);
      }, delay);

      this._timers.set(signal.id, handle);
    }
  }

  /** Cancela todos os agendamentos pendentes. */
  cancelAll() {
    for (const [, handle] of this._timers) {
      clearTimeout(handle);
    }
    const pendingCount = this._timers.size;
    this._timers.clear();
    this._scheduledKeys.clear();
    if (this._emit) {
      const msg = pendingCount > 0
        ? `🛑 ${pendingCount} agendamento(s) cancelado(s).`
        : '🛑 Nenhum agendamento pendente para cancelar.';
      this._emit('trades:cancelled', { message: msg, pendingCount });
    }
  }

  /**
   * Cancela o agendamento de um sinal específico.
   * @param {string} signalId
   * @returns {boolean} true se o sinal existia e foi cancelado
   */
  cancelSignal(signalId) {
    const handle = this._timers.get(signalId);
    if (!handle) return false;
    clearTimeout(handle);
    this._timers.delete(signalId);
    return true;
  }

  /** Quantos sinais ainda estão na fila. */
  get pendingCount() {
    return this._timers.size;
  }

  // ─── Execução ───────────────────────────────────────────────────────────────

  /**
   * Executa uma operação (e aplica gale recursivamente se necessário).
   * @param {Signal}  signal
   * @param {number}  stake    Valor da entrada nesta tentativa
   * @param {number}  galeRound Número do gale atual (0 = entrada original)
   */
  /**
   * Tenta reconectar ao WebSocket e emite eventos de status ao front-end.
   */
  async _tryReconnect(signal, label) {
    if (!this._derivClient || !this._emit) return;
    this._emit('api:reconnecting', {
      signal: { ...signal, scheduledTimeLabel: label },
      message: `🔄 Reconectando à API antes de ${label}...`,
    });
    try {
      await this._derivClient.reconnect();
      this._emit('api:reconnected', {
        signal: { ...signal, scheduledTimeLabel: label },
        message: `🟢 Reconectado com sucesso antes de ${label}`,
      });
    } catch (reconnErr) {
      this._emit('api:reconnect:fail', {
        signal: { ...signal, scheduledTimeLabel: label },
        message: `❌ Falha ao reconectar: ${reconnErr.message}`,
      });
    }
  }

  async _executeTrade(signal, stake, galeRound) {
    const label = galeRound === 0 ? 'Entrada' : `Gale ${galeRound}`;

    // ── Verificação de Stop Loss / Take Profit ───────────────────────────
    if (this.slAmount > 0 && this._sessionProfit <= -Math.abs(this.slAmount)) {
      this._emit('trade:sl_hit', {
        signal,
        message: `🛑 Stop Loss atingido! Prejuízo acumulado: -$${Math.abs(this._sessionProfit).toFixed(2)}. Agendamentos cancelados.`,
      });
      this.cancelAll();
      return;
    }
    if (this.tpAmount > 0 && this._sessionProfit >= Math.abs(this.tpAmount)) {
      this._emit('trade:tp_hit', {
        signal,
        message: `🎯 Take Profit atingido! Lucro acumulado: +$${this._sessionProfit.toFixed(2)}. Agendamentos cancelados.`,
      });
      this.cancelAll();
      return;
    }

    // Se WebSocket caiu, tenta reconectar antes de executar
    if (!this._derivClient?.isConnected) {
      try {
        const timeLabel = this._formatTime(signal.scheduledAt);
        this._emit('api:reconnecting', {
          signal: { ...signal, scheduledTimeLabel: timeLabel },
          message: `🔄 API desconectada — reconectando antes de ${label}...`,
        });
        await this._derivClient.reconnect();
        this._emit('api:reconnected', {
          signal: { ...signal, scheduledTimeLabel: timeLabel },
          message: `🟢 Reconectado — prosseguindo com ${label} (${signal.rawSymbol})`,
        });
      } catch (reconnErr) {
        signal.status = 'error';
        this._emit('trade:error', {
          signal,
          error: reconnErr.message,
          galeRound,
          message: `💥 Sem conexão e falha ao reconectar para ${signal.rawSymbol}: ${reconnErr.message}`,
        });
        return;
      }
    }

    this._emit('trade:executing', {
      signal,
      stake,
      galeRound,
      message: `🚀 ${label}: ${signal.rawSymbol} ${signal.direction} | Stake: $${stake.toFixed(2)}`,
    });

    try {
      // 1. Solicitar proposta
      const currency = this._derivClient.accountInfo?.currency || 'USD';
      const proposalData = await this._derivClient.proposal({
        symbol: signal.symbol,
        contract_type: signal.contract_type,
        duration: signal.duration,
        duration_unit: signal.duration_unit,
        amount: stake,
        currency,
      });

      // Payout %
      let payoutPct = null;
      if (proposalData.payout != null && proposalData.ask_price > 0) {
        payoutPct = ((proposalData.payout / proposalData.ask_price) - 1) * 100;
        this._emit('trade:payout', { signalId: signal.id, payoutPct });
      }

      // Filtro de Payout mínimo
      if (this.minPayout > 0 && payoutPct !== null && payoutPct < this.minPayout) {
        this._emit('trade:skipped', {
          signal,
          payoutPct,
          minPayout: this.minPayout,
          message: `⏩ Ignorado: ${signal.rawSymbol} — Payout ${payoutPct.toFixed(1)}% < mínimo ${this.minPayout}%`,
        });
        return;
      }

      // 2. Comprar
      const buyResult = await this._derivClient.buy(proposalData.id, proposalData.ask_price);

      this._emit('trade:bought', {
        signal,
        contractId: buyResult.contract_id,
        buyPrice: buyResult.buy_price,
        galeRound,
        message: `✅ Ordem aberta: contrato #${buyResult.contract_id} | Pago: $${buyResult.buy_price}`,
      });

      // 3. Aguardar resultado
      const finalContract = await this._derivClient.subscribeContractResult(
        buyResult.contract_id,
        (update) => {
          if (!update.is_sold) {
            this._emit('trade:update', {
              signal,
              contractId: buyResult.contract_id,
              currentSpot: update.current_spot,
              profit: update.profit,
            });
          }
        }
      );

      const won = finalContract.profit >= 0;
      const profit = parseFloat(finalContract.profit);

      // 4. Processar gale ANTES de emitir o resultado final
      const galeDecision = this._galeManager.onResult(signal.id, won);
      const isFinal = won || !galeDecision.shouldGale;

      // Acumula lucro/prejuízo da sessão (para SL/TP)
      if (isFinal) this._sessionProfit = parseFloat((this._sessionProfit + profit).toFixed(2));

      this._emit('trade:result', {
        signal,
        won,
        profit,
        isFinal,
        galeRound,
        stake,
        payout: parseFloat(finalContract.sell_price || 0),
        message: won
          ? `🏆 WIN ${label}: ${signal.rawSymbol} | Lucro: $${Math.abs(profit).toFixed(2)}`
          : `❌ LOSS ${label}: ${signal.rawSymbol} | Prejuízo: -$${Math.abs(profit).toFixed(2)}`,
      });

      // Busca saldo atualizado após resultado final
      if (isFinal && this._derivClient?.isConnected) {
        try {
          const bal = await this._derivClient.getBalance();
          this._emit('balance:update', { amount: bal.balance, currency: bal.currency });
        } catch (_) {}
      }

      if (!won && galeDecision.shouldGale) {
        // Aguarda 1 segundo antes de entrar no gale
        await this._sleep(1000);
        await this._executeTrade(signal, galeDecision.nextStake, galeRound + 1);
      } else if (!won && galeDecision.limitReached) {
        this._emit('trade:gale_limit', {
          signal,
          message: `🚫 Limite de gale atingido para ${signal.rawSymbol}. Encerrando.`,
        });
      }
    } catch (err) {
      signal.status = 'error';
      this._emit('trade:error', {
        signal,
        error: err.message,
        galeRound,
        message: `💥 Erro na operação ${signal.rawSymbol}: ${err.message}`,
      });
    }
  }

  // ─── Utilitários ────────────────────────────────────────────────────────────

  _formatTime(date) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  _formatDelay(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = Scheduler;
