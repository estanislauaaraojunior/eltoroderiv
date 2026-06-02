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
    this._sessionExposure = 0;
    this._sessionLossStreak = 0;
    this._sessionTradeTimes = [];
    this.maxSessionExposure = 0;
    this.maxLossStreak = 0;
    this.maxTradesPerHour = 0;
    this.edgeThreshold = 1;
    this.maxGaleRounds = 1;
    // Serializa proposal+buy para evitar requisições simultâneas que causam fechamento 1006
    this._proposalLock = Promise.resolve();
  }

  /**
   * Inicializa o scheduler com as dependências necessárias.
   * @param {DerivClient}  derivClient
   * @param {GaleManager}  galeManager
   * @param {Function}     emit         Função para emitir eventos ao cliente Socket.io
   */
  init(derivClient, galeManager, emit, slAmount = 0, tpAmount = 0, options = {}) {
    this._derivClient = derivClient;
    this._galeManager = galeManager;
    this._emit = emit;
    this.slAmount = parseFloat(slAmount) || 0;
    this.tpAmount = parseFloat(tpAmount) || 0;
    this.maxSessionExposure = parseFloat(options.maxSessionExposure) || 0;
    this.maxLossStreak = parseInt(options.maxLossStreak, 10) || 0;
    this.maxTradesPerHour = parseInt(options.maxTradesPerHour, 10) || 0;
    this.edgeThreshold = parseFloat(options.edgeThreshold) || 1;
    this.maxGaleRounds = parseInt(options.maxGaleRounds, 10);
    if (!Number.isFinite(this.maxGaleRounds) || this.maxGaleRounds < 0) {
      this.maxGaleRounds = 1;
    }
    this._sessionExposure = 0;
    this._sessionLossStreak = 0;
    this._sessionTradeTimes = [];
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

  _registerTradeAttempt(stake) {
    const now = Date.now();
    this._sessionTradeTimes.push(now);
    this._sessionExposure = parseFloat((this._sessionExposure + Math.abs(stake || 0)).toFixed(2));
    this._sessionTradeTimes = this._sessionTradeTimes.filter(ts => now - ts <= 60 * 60 * 1000);
  }

  _evaluateEdge(signal, candles, payoutPct, stake, galeRound) {
    const result = this._analyzeCandlesForGale(candles, signal.direction);
    const blockers = [];
    const warnings = [];
    let score = 0;

    if (this.minPayout > 0 && payoutPct !== null) {
      if (payoutPct < this.minPayout) {
        blockers.push(`Payout ${payoutPct.toFixed(1)}% abaixo do mínimo ${this.minPayout}%`);
      } else {
        score += 1;
      }
    }

    const hour = new Date(signal.scheduledAt).getHours();
    const inLiquidWindow = (hour >= 7 && hour <= 11) || (hour >= 13 && hour <= 17);
    if (inLiquidWindow) {
      score += 1;
    } else {
      warnings.push('Fora da janela de maior liquidez');
    }

    if (result.proceed) {
      score += 1;
    } else {
      blockers.push(...result.reasons);
    }

    const candleCount = Array.isArray(candles) ? candles.length : 0;
    const closes = (candles || []).slice(0, Math.max(0, Math.min(candleCount - 1, 6)));
    if (closes.length >= 5) {
      const highs = closes.map(c => parseFloat(c.high));
      const lows = closes.map(c => parseFloat(c.low));
      const range = Math.max(...highs) - Math.min(...lows);
      const firstClose = parseFloat(closes[closes.length - 1].close);
      const lastClose = parseFloat(closes[0].close);
      const directionalMove = Math.abs(lastClose - firstClose);
      if (range > 0 && directionalMove / range >= 0.35) {
        score += 1;
      } else {
        warnings.push('Movimento direcional fraco para a janela observada');
      }
    }

    if (galeRound > this.maxGaleRounds) {
      blockers.push(`Gale acima do limite configurado (${galeRound} > ${this.maxGaleRounds})`);
    }

    return {
      proceed: blockers.length === 0 && score >= this.edgeThreshold,
      score,
      reasons: blockers,
      warnings,
    };
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

    if (galeRound > this.maxGaleRounds) {
      this._emit('trade:gale_limit', {
        signal,
        message: `🚫 Gale ${galeRound} acima do limite configurado (${this.maxGaleRounds}).`,
      });
      return;
    }

    if (this.maxLossStreak > 0 && this._sessionLossStreak >= this.maxLossStreak) {
      this._emit('trade:sl_hit', {
        signal,
        message: `🛑 Sequência máxima de perdas atingida (${this._sessionLossStreak}/${this.maxLossStreak}). Agendamentos cancelados.`,
      });
      this.cancelAll();
      return;
    }

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

    // ── Análise de Velas (M2 + M3 + M4) ──────────────────────────────────────
    // Executada antes de qualquer proposta/compra, cobre entrada original e gales.
    try {
      this._emit('candle:analyzing', { signal, galeRound, label });
      const candles = await this._derivClient.getCandles(signal.symbol, 900, 7);
      const proposalPreview = await this._derivClient.proposal({
        symbol: signal.symbol,
        contract_type: signal.contract_type,
        duration: signal.duration,
        duration_unit: signal.duration_unit,
        amount: stake,
        currency: this._derivClient.accountInfo?.currency || 'USD',
      });
      const payoutPct = proposalPreview.payout != null && proposalPreview.ask_price > 0
        ? ((proposalPreview.payout / proposalPreview.ask_price) - 1) * 100
        : null;
      const analysis = this._evaluateEdge(signal, candles, payoutPct, stake, galeRound);
      this._emit('candle:analysis', {
        signal,
        galeRound,
        proceed: analysis.proceed,
        votes: analysis.score,
        reasons: analysis.reasons,
        warnings: analysis.warnings,
        summary: analysis.proceed
          ? `✅ Edge aprovada (score ${analysis.score})${analysis.warnings.length ? ` | Avisos: ${analysis.warnings.join(' | ')}` : ''}`
          : `🚫 Edge rejeitada: ${analysis.reasons.join(' | ')}`,
      });
      if (!analysis.proceed) {
        if (galeRound === 0) {
          signal.status = 'rejected';
          this._emit('trade:skipped', {
            signal,
            message: `🚫 Entrada bloqueada por edge insuficiente: ${analysis.reasons.join(' | ')}`,
          });
        } else {
          // Gale bloqueado após round(s) anterior(es): fecha o sinal para que
          // a perda acumulada no _galeProfitMap do frontend seja contabilizada.
          this._galeManager.reset(signal.id);
          this._emit('trade:result', {
            signal,
            won: false,
            profit: 0,
            isFinal: true,
            galeRound,
            stake,
            contractId: null,
            payout: 0,
            message: `🚫 Gale ${galeRound} bloqueado por análise de velas — prejuízo do round anterior contabilizado.`,
          });
        }
        return;
      }
    } catch (candleErr) {
      // Fail-open: se a análise falhar, prossegue com a operação
      this._emit('candle:analysis', {
        signal,
        galeRound,
        proceed: true,
        votes: 0,
        reasons: [],
        summary: `⚠️ Análise de velas indisponível (${candleErr.message}) — prosseguindo`,
      });
    }
    // ────────────────────────────────────────────────────────────────────────────

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

    // ── Fase 1: Proposta + Compra (serializada) ──────────────────────────────
    // Serializa via _proposalLock para evitar requisições simultâneas ao WebSocket
    // que podem causar fechamento 1006 pela API Deriv.
    let buyResult;
    let payoutPct = null;

    const buyPhase = this._proposalLock.then(async () => {
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
      let pct = null;
      if (proposalData.payout != null && proposalData.ask_price > 0) {
        pct = ((proposalData.payout / proposalData.ask_price) - 1) * 100;
        this._emit('trade:payout', { signalId: signal.id, payoutPct: pct });
      }

      // Filtro de Payout mínimo
      if (this.minPayout > 0 && pct !== null && pct < this.minPayout) {
        this._emit('trade:skipped', {
          signal,
          payoutPct: pct,
          minPayout: this.minPayout,
          message: `⏩ Ignorado: ${signal.rawSymbol} — Payout ${pct.toFixed(1)}% < mínimo ${this.minPayout}%`,
        });
        return { skipped: true };
      }

      // 2. Comprar
      const result = await this._derivClient.buy(proposalData.id, proposalData.ask_price);
      return { skipped: false, buyResult: result, payoutPct: pct };
    });

    // A próxima operação só entra na fila depois que esta terminar (sucesso ou falha)
    this._proposalLock = buyPhase.then(() => {}, () => {});

    let buyPhaseResult;
    try {
      buyPhaseResult = await buyPhase;
    } catch (err) {
      // Erro antes da compra: contrato nunca foi aberto
      signal.status = 'error';
      this._emit('trade:error', {
        signal,
        error: err.message,
        galeRound,
        message: `💥 Erro na operação ${signal.rawSymbol}: ${err.message}`,
      });
      return;
    }

    if (buyPhaseResult.skipped) return;

    buyResult = buyPhaseResult.buyResult;
    payoutPct = buyPhaseResult.payoutPct;

    this._emit('trade:bought', {
      signal,
      contractId: buyResult.contract_id,
      buyPrice: buyResult.buy_price,
      galeRound,
      message: `✅ Ordem aberta: contrato #${buyResult.contract_id} | Pago: $${buyResult.buy_price}`,
    });

    // ── Fase 2: Aguardar resultado (independente, com recovery pós-WS drop) ──
    // A partir daqui o contrato já está aberto na Deriv.
    // Se o WebSocket cair, tentamos reconectar e buscar o resultado via polling.
    let finalContract;
    try {
      finalContract = await this._waitForContractResult(signal, buyResult.contract_id);
    } catch (resultErr) {
      // Último recurso: emite erro mas indica que o contrato foi aberto
      signal.status = 'error';
      this._emit('trade:error', {
        signal,
        error: resultErr.message,
        galeRound,
        contractId: buyResult.contract_id,
        message: `💥 Contrato #${buyResult.contract_id} aberto, mas resultado não recuperado: ${resultErr.message}`,
      });
      return;
    }

    const won = parseFloat(finalContract.profit) > 0;
    const profit = parseFloat(finalContract.profit);

    // 4. Processar gale ANTES de emitir o resultado final
    const galeDecision = this._galeManager.onResult(signal.id, won);
    const isFinal = won || !galeDecision.shouldGale;

    // Acumula lucro/prejuízo da sessão (para SL/TP) — inclui rounds intermediários do Gale
    this._sessionProfit = parseFloat((this._sessionProfit + profit).toFixed(2));

    if (profit < 0) this._sessionLossStreak += 1;
    else this._sessionLossStreak = 0;
    if (isFinal) this._registerTradeAttempt(stake);

    this._emit('trade:result', {
      signal,
      won,
      profit,
      contractProfit: profit,
      isFinal,
      sessionProfit: this._sessionProfit,
      galeRound,
      stake,
      contractId: finalContract.contract_id || null,
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
  }

  /**
   * Aguarda o resultado de um contrato já comprado.
   * Se o WebSocket cair durante a espera, tenta reconectar e buscar via polling.
   * @param {object} signal
   * @param {number} contractId
   * @returns {Promise<object>} Dados finais do contrato (is_sold === 1)
   */
  async _waitForContractResult(signal, contractId) {
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, s: 1_000 };
    const contractDurationMs = signal.duration * (unitMs[signal.duration_unit] || 60_000);
    const fallbackMs = contractDurationMs + 2 * 60_000;

    let settled = false;

    const subscribePromise = this._derivClient.subscribeContractResult(
      contractId,
      (update) => {
        if (!update.is_sold) {
          this._emit('trade:update', {
            signal,
            contractId,
            currentSpot: update.current_spot,
            profit: update.profit,
          });
        }
      }
    ).then(r => { settled = true; return r; });

    const fallbackPromise = new Promise(async (resolve, reject) => {
      await this._sleep(fallbackMs);
      if (settled) return;
      this._emit('trade:update', {
        signal,
        contractId,
        message: `⚠️ Contrato #${contractId} (${signal.rawSymbol}) não finalizou — verificando resultado...`,
      });
      for (let i = 0; i < 6 && !settled; i++) {
        await this._sleep(10_000);
        if (settled) return;
        try {
          const status = await this._derivClient.checkContractStatus(contractId);
          if (status?.is_sold) {
            settled = true;
            return resolve(status);
          }
        } catch (_) {}
      }
      if (!settled) {
        settled = true;
        reject(new Error(`Contrato #${contractId} não finalizou após verificações de fallback.`));
      }
    });

    try {
      return await Promise.race([subscribePromise, fallbackPromise]);
    } catch (err) {
      // Se o erro for queda do WebSocket, tenta reconectar e fazer polling
      const isWsDrop = err.message.includes('WebSocket fechado') ||
                       err.message.includes('WebSocket não está conectado') ||
                       err.message.includes('1006') ||
                       err.message.includes('ECONNRESET') ||
                       err.message.includes('closed before') ||
                       err.message.includes('connection lost');
      if (!isWsDrop) throw err;

      this._emit('trade:update', {
        signal,
        contractId,
        message: `🔄 Conexão perdida após abertura do contrato #${contractId}. Reconectando para recuperar resultado...`,
      });

      try {
        await this._derivClient.reconnect();
      } catch (reconnErr) {
        throw new Error(`Reconexão falhou após queda durante contrato #${contractId}: ${reconnErr.message}`);
      }

      // Polling após reconexão (até 10 minutos: 60 tentativas × 10s)
      for (let i = 0; i < 60; i++) {
        await this._sleep(10_000);
        try {
          const status = await this._derivClient.checkContractStatus(contractId);
          if (status?.is_sold) {
            this._emit('trade:update', {
              signal,
              contractId,
              message: `✅ Resultado recuperado para contrato #${contractId} após reconexão.`,
            });
            return status;
          }
        } catch (_) {}
      }

      // Emite evento dedicado para facilitar acompanhamento manual pelo usuário
      this._emit('trade:result_lost', {
        signal,
        contractId,
        message: `⚠️ Contrato #${contractId} (${signal.rawSymbol}) aberto, mas resultado não recuperado. Verifique manualmente na plataforma Deriv.`,
      });
      throw new Error(`Contrato #${contractId} aberto, mas resultado não recuperado após reconexão.`);
    }
  }

  // ─── Análise de Velas ─────────────────────────────────────────────────────

  /**
   * Analisa as últimas velas M15 e decide se a direção do contrato ainda é válida.
   * Usa 3 métodos independentes com votação 2-de-3 para bloquear.
   *
   * @param {Array} candles  Array retornado por getCandles() (7 velas, usa 6 fechadas)
   * @param {string} direction  'CALL' ou 'PUT'
   * @returns {{ proceed: boolean, votes: number, reasons: string[], summary: string }}
   */
  _analyzeCandlesForGale(candles, direction) {
    if (!candles || candles.length < 5) {
      return { proceed: true, votes: 0, reasons: [], summary: 'Dados insuficientes — prosseguindo' };
    }

    // Descarta a última vela (pode estar ainda em formação) → usa 6 fechadas
    const c = candles.slice(0, Math.min(candles.length - 1, 6));
    if (c.length < 5) {
      return { proceed: true, votes: 0, reasons: [], summary: 'Velas insuficientes — prosseguindo' };
    }

    const isBullishContra = direction === 'PUT';  // contra PUT = alta
    const isBearishContra = direction === 'CALL'; // contra CALL = queda
    const reasons = [];
    let votes = 0;

    // ── Método 2: Inclinação de fechamentos ──────────────────────────────────
    const trend = c[c.length - 1].close - c[0].close;
    const trendDesc = trend.toFixed(5);
    if (isBearishContra && trend < 0) {
      votes++;
      reasons.push(`M2: tendência de queda (${trendDesc})`);
    } else if (isBullishContra && trend > 0) {
      votes++;
      reasons.push(`M2: tendência de alta (+${trendDesc})`);
    }

    // ── Método 3: MA(3) vs MA(5) ────────────────────────────────────────────
    const len = c.length;
    const ma3 = (c[len - 1].close + c[len - 2].close + c[len - 3].close) / 3;
    const ma5 = (c[len - 1].close + c[len - 2].close + c[len - 3].close + c[len - 4].close + c[len - 5].close) / 5;
    const ma3f = ma3.toFixed(5);
    const ma5f = ma5.toFixed(5);
    if (isBearishContra && ma3 < ma5) {
      votes++;
      reasons.push(`M3: MA3(${ma3f}) < MA5(${ma5f})`);
    } else if (isBullishContra && ma3 > ma5) {
      votes++;
      reasons.push(`M3: MA3(${ma3f}) > MA5(${ma5f})`);
    }

    // ── Método 4: Força por corpo de vela ───────────────────────────────────
    let bullForce = 0;
    let bearForce = 0;
    for (const candle of c) {
      const body = Math.abs(candle.close - candle.open);
      if (candle.close > candle.open) bullForce += body;
      else bearForce += body;
    }
    const totalForce = bullForce + bearForce;
    const ratioBear = totalForce > 0 ? bearForce / totalForce : 0.5;
    const ratioBull = totalForce > 0 ? bullForce / totalForce : 0.5;
    if (isBearishContra && ratioBear > 0.60) {
      votes++;
      reasons.push(`M4: força baixista ${(ratioBear * 100).toFixed(0)}%`);
    } else if (isBullishContra && ratioBull > 0.60) {
      votes++;
      reasons.push(`M4: força altista ${(ratioBull * 100).toFixed(0)}%`);
    }

    const proceed = votes < 2;
    const dirLabel = direction === 'CALL' ? 'CALL' : 'PUT';
    const roundLabel = reasons.length === 0
      ? `tendência compatível com ${dirLabel}`
      : reasons.join(' | ');
    const summary = proceed
      ? `📊 Velas OK para ${dirLabel} (${votes}/3 votos contra): ${roundLabel}`
      : `📊 ${dirLabel} bloqueado (${votes}/3 votos contra): ${roundLabel}`;

    return { proceed, votes, reasons, summary };
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
