'use strict';

/**
 * Gerencia a lógica de Gale (Martingale) por sinal.
 *
 * Regras:
 *  - Cada sinal começa com o stake base configurado no painel.
 *  - Se o resultado for perda e ainda houver gales disponíveis,
 *    o stake é dobrado para a próxima tentativa.
 *  - Se ganhar (em qualquer tentativa), o stake é resetado para o base.
 *  - Se atingir o limite de gales, para e emite evento "gale:limit_reached".
 */
class GaleManager {
  constructor() {
    this.baseStake = 1;
    this.maxGales = 1;
    // Map<signalId, { currentStake: number, galeCount: number }>
    this._state = new Map();
  }

  /**
   * Inicializa ou reinicializa o manager com novas configurações.
   * @param {number} baseStake  Stake inicial (em USD/moeda da conta)
   * @param {number} maxGales   Número máximo de gales (0 = sem gale)
   */
  init(baseStake, maxGales) {
    this.baseStake = parseFloat(baseStake) || 1;
    this.maxGales = parseInt(maxGales, 10) || 0;
    this._state.clear();
  }

  /**
   * Retorna o stake atual para o sinal. Se o sinal ainda não foi registrado,
   * inicializa com o stake base.
   * @param {string} signalId
   * @returns {number}
   */
  getStake(signalId) {
    if (!this._state.has(signalId)) {
      this._state.set(signalId, { currentStake: this.baseStake, galeCount: 0 });
    }
    return this._state.get(signalId).currentStake;
  }

  /**
   * Retorna quantos gales já foram usados para o sinal.
   * @param {string} signalId
   * @returns {number}
   */
  getGaleCount(signalId) {
    return this._state.get(signalId)?.galeCount ?? 0;
  }

  /**
   * Processa o resultado de uma operação.
   * @param {string} signalId
   * @param {boolean} won        true se ganhou, false se perdeu
   * @returns {{ shouldGale: boolean, nextStake: number, galeCount: number }}
   */
  onResult(signalId, won) {
    const state = this._state.get(signalId) ?? { currentStake: this.baseStake, galeCount: 0 };

    if (won) {
      // Ganhou → reseta para o stake base
      this._state.set(signalId, { currentStake: this.baseStake, galeCount: 0 });
      return { shouldGale: false, nextStake: this.baseStake, galeCount: 0 };
    }

    // Perdeu
    const galeCount = state.galeCount;

    if (galeCount >= this.maxGales) {
      // Limite de gale atingido → não entra mais
      this._state.set(signalId, { currentStake: this.baseStake, galeCount: 0 });
      return { shouldGale: false, nextStake: this.baseStake, galeCount, limitReached: true };
    }

    // Aplica gale: dobra o stake
    const nextStake = parseFloat((state.currentStake * 2).toFixed(2));
    const nextGaleCount = galeCount + 1;
    this._state.set(signalId, { currentStake: nextStake, galeCount: nextGaleCount });

    return { shouldGale: true, nextStake, galeCount: nextGaleCount };
  }

  /**
   * Força o reset do estado de um sinal específico.
   * @param {string} signalId
   */
  reset(signalId) {
    this._state.delete(signalId);
  }

  /** Reseta todos os estados. */
  resetAll() {
    this._state.clear();
  }
}

module.exports = GaleManager;
