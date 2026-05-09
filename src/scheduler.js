'use strict';

/**
 * Scheduler de operações — agenda cada sinal via setTimeout.
 * Ao disparar, executa a operação na Deriv e aplica Gale se necessário.
 */
class Scheduler {
  constructor() {
    // Map<signalId, timeoutHandle>
    this._timers = new Map();
    this._emit = null;
    this._derivClient = null;
    this._galeManager = null;
  }

  /**
   * Inicializa o scheduler com as dependências necessárias.
   * @param {DerivClient}  derivClient
   * @param {GaleManager}  galeManager
   * @param {Function}     emit         Função para emitir eventos ao cliente Socket.io
   */
  init(derivClient, galeManager, emit) {
    this._derivClient = derivClient;
    this._galeManager = galeManager;
    this._emit = emit;
  }

  /** Reseta o scheduler sem emitir eventos (usado em reconexão). */
  reset() {
    for (const [, handle] of this._timers) {
      clearTimeout(handle);
    }
    this._timers.clear();
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
      const delay = signal.scheduledAt.getTime() - now;

      if (delay <= 0) {
        // Sinal já expirou
        signal.status = 'expired';
        this._emit('trade:scheduled', {
          signal,
          message: `⚠️ Sinal expirado: ${signal.rawSymbol} ${signal.direction} às ${this._formatTime(signal.scheduledAt)}`,
          expired: true,
        });
        continue;
      }

      signal.status = 'scheduled';
      this._emit('trade:scheduled', {
        signal,
        message: `📅 Agendado: ${signal.rawSymbol} ${signal.direction} às ${this._formatTime(signal.scheduledAt)} (em ${this._formatDelay(delay)})`,
        expired: false,
        scheduledAt: signal.scheduledAt.toISOString(),
      });

      const handle = setTimeout(() => {
        this._timers.delete(signal.id);
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
    const hadPending = this._timers.size > 0;
    this._timers.clear();
    if (this._emit && hadPending) {
      this._emit('trades:cancelled', { message: '🛑 Todos os agendamentos foram cancelados.' });
    }
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
  async _executeTrade(signal, stake, galeRound) {
    const label = galeRound === 0 ? 'Entrada' : `Gale ${galeRound}`;

    this._emit('trade:executing', {
      signal,
      stake,
      galeRound,
      message: `🚀 ${label}: ${signal.rawSymbol} ${signal.direction} | Stake: $${stake.toFixed(2)}`,
    });

    try {
      // 1. Solicitar proposta
      const proposalData = await this._derivClient.proposal({
        symbol: signal.symbol,
        contract_type: signal.contract_type,
        duration: signal.duration,
        duration_unit: signal.duration_unit,
        amount: stake,
      });

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

      this._emit('trade:result', {
        signal,
        won,
        profit,
        galeRound,
        stake,
        payout: parseFloat(finalContract.sell_price || 0),
        message: won
          ? `🏆 WIN ${label}: ${signal.rawSymbol} | Lucro: $${Math.abs(profit).toFixed(2)}`
          : `❌ LOSS ${label}: ${signal.rawSymbol} | Prejuízo: -$${Math.abs(profit).toFixed(2)}`,
      });

      // 4. Processar gale
      const galeDecision = this._galeManager.onResult(signal.id, won);

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
