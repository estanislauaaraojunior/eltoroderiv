'use strict';

const WebSocket = require('ws');

const DERIV_WS_URL = 'wss://ws.binaryws.com/websockets/v3';
const DEFAULT_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 25_000;

/**
 * Wrapper da API WebSocket oficial da Deriv.
 *
 * Uso:
 *   const client = new DerivClient(appId);
 *   await client.connect();
 *   const account = await client.authorize(token);
 *   const proposal = await client.proposal({ ... });
 *   const result = await client.buy(proposal.id, proposal.ask_price);
 *   await client.subscribeContractResult(contractId, cb);
 *   client.disconnect();
 */
class DerivClient {
  constructor(appId = '1089') {
    this.appId = appId;
    this._ws = null;
    this._pending = new Map(); // req_id → { resolver, rejeitar, temporizador }
    this._subscriptions = new Map(); // subscription_id → função de retorno
    this._reqId = 1;
    this._pingTimer = null;
    this._authorized = false;
    this.accountInfo = null;
  }

  // ─── Conexão ────────────────────────────────────────────────────────────────

  connect() {
    return new Promise((resolve, reject) => {
      const url = `${DERIV_WS_URL}?app_id=${this.appId}`;
      const ws = new WebSocket(url);
      this._ws = ws;

      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('Timeout ao conectar ao WebSocket da Deriv'));
      }, DEFAULT_TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(timer);
        this._startPing();
        resolve();
      });

      ws.on('message', (data) => this._handleMessage(data));

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.on('close', (code, reason) => {
        this._stopPing();
        this._authorized = false;
        // Rejeita todas as chamadas pendentes
        for (const [, pending] of this._pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`WebSocket fechado (${code}): ${reason}`));
        }
        this._pending.clear();
      });
    });
  }

  disconnect() {
    this._stopPing();
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
    this._authorized = false;
    this.accountInfo = null;
  }

  get isConnected() {
    return this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  // ─── Autenticação ───────────────────────────────────────────────────────────

  async authorize(token) {
    const response = await this._send({ authorize: token });
    if (response.error) throw new Error(response.error.message);

    this._authorized = true;
    this.accountInfo = response.authorize;
    return response.authorize;
  }

  /**
   * Lista as contas disponíveis (retornadas na resposta de authorize).
   * Requer que authorize() já tenha sido chamado.
   */
  getAccountList() {
    if (!this.accountInfo) throw new Error('Cliente não autenticado');
    return this.accountInfo.account_list || [];
  }

  /**
   * Troca para outra conta (demo/real) usando o token correspondente.
   * @param {string} token Token da conta alvo
   */
  async switchAccount(token) {
    const response = await this._send({ authorize: token });
    if (response.error) throw new Error(response.error.message);

    this.accountInfo = response.authorize;
    return response.authorize;
  }

  // ─── Saldo ──────────────────────────────────────────────────────────────────

  async getBalance() {
    const response = await this._send({ balance: 1, account: 'current' });
    if (response.error) throw new Error(response.error.message);
    return response.balance;
  }

  // ─── Operações ──────────────────────────────────────────────────────────────

  /**
   * Solicita proposta de contrato.
   * @param {object} params
   *   symbol (par de moedas), contract_type ('CALL'|'PUT'), duration (duração), duration_unit (unidade),
   *   amount (valor da entrada), basis ('stake' = entrada fixa | 'payout' = pagamento fixo)
   */
  async proposal(params) {
    const payload = {
      proposal: 1,
      symbol: params.symbol,
      contract_type: params.contract_type,
      duration: params.duration,
      duration_unit: params.duration_unit,
      amount: params.amount,
      basis: 'stake',
      currency: params.currency || 'USD',
    };

    const response = await this._send(payload);
    if (response.error) throw new Error(response.error.message);
    return response.proposal;
  }

  /**
   * Compra um contrato a partir de uma proposta.
   * @param {string|number} proposalId
   * @param {number} price Preço máximo aceito (normalmente proposal.ask_price)
   */
  async buy(proposalId, price) {
    const response = await this._send({ buy: proposalId, price });
    if (response.error) throw new Error(response.error.message);
    return response.buy;
  }

  /**
   * Monitora o resultado de um contrato aberto.
   * Chama o callback com o objeto `proposal_open_contract` a cada atualização.
   * Resolve a Promise quando o contrato for finalizado (is_sold === 1).
   *
   * @param {number}   contractId  ID do contrato retornado pelo método buy()
   * @param {function} onUpdate    Callback chamado a cada atualização do contrato
   * @returns {Promise<object>} Dados finais do contrato
   */
  subscribeContractResult(contractId, onUpdate) {
    return new Promise((resolve, reject) => {
      const reqId = this._nextReqId();

      const payload = {
        proposal_open_contract: 1,
        contract_id: contractId,
        subscribe: 1,
        req_id: reqId,
      };

      // Registra no mapa de pendentes para capturar a resposta inicial
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error('Timeout aguardando resultado do contrato'));
      }, DEFAULT_TIMEOUT_MS * 6); // contratos podem durar vários minutos

      this._pending.set(reqId, {
        resolve: (res) => {
          clearTimeout(timer);
          // A primeira resposta confirma a subscription; o resultado virá depois
          if (res.error) {
            this._pending.delete(reqId);
            reject(new Error(res.error.message));
            return;
          }

          const contract = res.proposal_open_contract;
          if (onUpdate) onUpdate(contract);

          if (contract && contract.is_sold) {
            this._subscriptions.delete(res.subscription?.id);
            resolve(contract);
          } else {
            // Aguarda atualizações via subscription
            this._pending.delete(reqId);
            if (res.subscription?.id) {
              this._subscriptions.set(res.subscription.id, (update) => {
                if (onUpdate) onUpdate(update.proposal_open_contract);
                if (update.proposal_open_contract?.is_sold) {
                  this._subscriptions.delete(res.subscription.id);
                  clearTimeout(timer);
                  resolve(update.proposal_open_contract);
                }
              });
            }
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });

      this._ws.send(JSON.stringify(payload));
    });
  }

  // ─── Internos ───────────────────────────────────────────────────────────────

  _nextReqId() {
    return this._reqId++;
  }

  _send(payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        return reject(new Error('WebSocket não está conectado'));
      }

      const reqId = payload.req_id || this._nextReqId();
      payload.req_id = reqId;

      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error(`Timeout na requisição (req_id: ${reqId})`));
      }, timeoutMs);

      this._pending.set(reqId, { resolve, reject, timer });

      try {
        this._ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(err);
      }
    });
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Roteamento por req_id (resposta a uma requisição pendente)
    if (msg.req_id && this._pending.has(msg.req_id)) {
      const { resolve, timer } = this._pending.get(msg.req_id);
      this._pending.delete(msg.req_id);
      clearTimeout(timer);
      resolve(msg);
      return;
    }

    // Roteamento por subscription_id (updates de assinaturas ativas)
    if (msg.subscription?.id && this._subscriptions.has(msg.subscription.id)) {
      this._subscriptions.get(msg.subscription.id)(msg);
      return;
    }
  }

  _startPing() {
    this._pingTimer = setInterval(() => {
      if (this.isConnected) {
        this._ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }
}

module.exports = DerivClient;
