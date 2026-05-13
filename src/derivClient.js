'use strict';

const WebSocket = require('ws');

// ─── URLs da nova API (developers.deriv.com) ─────────────────────────────────
const NEW_API_BASE_URL = 'https://api.derivws.com';
const NEW_API_WS_PUBLIC = 'wss://api.derivws.com/trading/v1/options/ws/public';

// ─── URL da API legada (legacy-api.deriv.com) ────────────────────────────────
const LEGACY_WS_URL = 'wss://ws.derivws.com/websockets/v3';

const DEFAULT_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 25_000;

/**
 * Wrapper da API WebSocket da Deriv.
 *
 * Suporta duas modalidades:
 *  - Nova API (PAT token `pat_xxx` + alphanumeric App ID): usa fluxo OTP via REST
 *  - API legada (token `a1-xxx` + App ID numérico): usa authorize via WebSocket
 *
 * Uso (nova API):
 *   const client = new DerivClient();
 *   const accounts = await client.connectNewAPI('pat_xxx', 'APP_ID', 'DOT12345');
 *   const balance = await client.getBalance();
 *
 * Uso (API legada):
 *   const client = new DerivClient('1089');
 *   await client.connect();
 *   const account = await client.authorize('a1-xxx');
 */
class DerivClient {
  constructor(appId = '1089') {
    this.appId = appId;
    this._ws = null;
    this._pending = new Map(); // req_id → { resolver, rejeitar, temporizador }
    this._subscriptions = new Map(); // subscription_id → função de retorno
    this._subscriptionRejects = new Map(); // subscription_id → reject fn (para limpar ao fechar WS)
    this._reqId = 1;
    this._pingTimer = null;
    this._authorized = false;
    this.accountInfo = null;
  }

  // ─── Nova API: fluxo OTP ─────────────────────────────────────────────────

  /**
   * Conecta usando a nova API (pat_ token + App ID alfanumérico).
   * Automaticamente busca a lista de contas e seleciona a primeira correspondente.
   *
   * @param {string} patToken   Token PAT (começa com "pat_")
   * @param {string} appId      App ID alfanumérico registrado em developers.deriv.com
   * @param {string} [accountId] Opcional: ID da conta (ex: "DOT12345", "DEM67890", "ROT99999")
   *                             Se omitido, usa a primeira conta demo disponível, ou real se não houver demo.
   * @returns {Promise<{ accounts: Array, selectedAccount: object }>}
   */
  async connectNewAPI(patToken, appId, accountId) {
    this.appId = appId;

    // Valida: App ID numérico pertence à API legada, não à nova API
    if (/^\d+$/.test(appId.trim())) {
      throw new Error(
        `App ID "${appId}" é numérico (API legada). ` +
        'Para usar token pat_, registre um App ID em developers.deriv.com e use o ID alfanumérico gerado.'
      );
    }

    // 1. Busca lista de contas
    const accounts = await this._fetchAccounts(patToken, appId);
    if (!accounts || accounts.length === 0) {
      throw new Error('Nenhuma conta disponível para este token. Verifique as credenciais.');
    }

    // 2. Seleciona conta: prioriza a especificada, depois demo, depois real
    let selected;
    if (accountId) {
      selected = accounts.find(a => a.account_id === accountId);
      if (!selected) throw new Error(`Conta "${accountId}" não encontrada. Contas disponíveis: ${accounts.map(a => a.account_id).join(', ')}`);
    } else {
      selected = accounts.find(a => a.account_type === 'demo') || accounts[0];
    }

    // 3. Obtém URL WebSocket via OTP
    const wsUrl = await this._getOTPUrl(patToken, appId, selected.account_id);

    // 4. Conecta ao WebSocket usando a URL com OTP
    await this._connectToUrl(wsUrl);

    // 5. Popula accountInfo compatível com o restante do sistema
    this._authorized = true;
    this.accountInfo = {
      loginid: selected.account_id,
      fullname: selected.account_id,
      email: '',
      currency: selected.currency,
      is_virtual: selected.account_type === 'demo' ? 1 : 0,
      balance: parseFloat(selected.balance),
      account_list: accounts.map(a => ({
        loginid: a.account_id,
        currency: a.currency,
        is_virtual: a.account_type === 'demo' ? 1 : 0,
        account_type: a.account_type,
      })),
      // Guarda dados originais para uso futuro
      _patToken: patToken,
      _appId: appId,
      _allAccounts: accounts,
    };

    return { accounts, selectedAccount: selected };
  }

  /**
   * Troca de conta usando a nova API.
   * @param {string} accountId ID da conta a trocar (ex: "ROT90509620")
   */
  async switchAccountNewAPI(accountId) {
    const info = this.accountInfo;
    if (!info?._patToken) throw new Error('Não conectado via nova API');

    const account = info._allAccounts.find(a => a.account_id === accountId);
    if (!account) throw new Error(`Conta ${accountId} não encontrada`);

    // Desconecta WebSocket atual
    this._stopPing();
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
    this._authorized = false;
    this._pending.clear();

    // Obtém novo OTP e reconecta
    const wsUrl = await this._getOTPUrl(info._patToken, info._appId, accountId);
    await this._connectToUrl(wsUrl);

    this._authorized = true;
    this.accountInfo = {
      ...this.accountInfo,
      loginid: account.account_id,
      fullname: account.account_id,
      currency: account.currency,
      is_virtual: account.account_type === 'demo' ? 1 : 0,
      balance: parseFloat(account.balance),
    };

    return this.accountInfo;
  }

  /** @private Busca lista de contas da nova API */
  async _fetchAccounts(patToken, appId) {
    let res;
    try {
      res = await fetch(`${NEW_API_BASE_URL}/trading/v1/options/accounts`, {
        headers: {
          Authorization: `Bearer ${patToken}`,
          'Deriv-App-ID': appId,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const cause = err.cause?.message || err.cause?.code || err.message;
      throw new Error(`Falha de rede ao buscar contas: ${cause}`);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body.errors?.[0]?.message || body.message || `HTTP ${res.status}`;
      throw new Error(`Erro ao buscar contas (${res.status}): ${msg}`);
    }

    const body = await res.json();
    return body.data;
  }

  /** @private Obtém URL WebSocket com OTP para uma conta */
  async _getOTPUrl(patToken, appId, accountId) {
    let res;
    try {
      res = await fetch(
        `${NEW_API_BASE_URL}/trading/v1/options/accounts/${accountId}/otp`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${patToken}`,
            'Deriv-App-ID': appId,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
        }
      );
    } catch (err) {
      const cause = err.cause?.message || err.cause?.code || err.message;
      throw new Error(`Falha de rede ao gerar OTP: ${cause}`);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body.errors?.[0]?.message || body.message || `HTTP ${res.status}`;
      throw new Error(`Erro ao gerar OTP (${res.status}): ${msg}`);
    }

    const body = await res.json();
    if (!body.data?.url) throw new Error('Resposta OTP inválida: URL ausente');
    return body.data.url;
  }

  /** @private Conecta a uma URL WebSocket (usada tanto pela nova quanto pela legada) */
  _connectToUrl(url) {
    return new Promise((resolve, reject) => {
      console.log(`[WS] Conectando em: ${url.replace(/otp=[^&]+/, 'otp=***')}`);
      const ws = new WebSocket(url);
      this._ws = ws;

      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('Timeout ao conectar ao WebSocket da Deriv'));
      }, DEFAULT_TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(timer);
        console.log('[WS] Conectado com sucesso.');
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
        for (const [, pending] of this._pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`WebSocket fechado (${code}): ${reason}`));
        }
        this._pending.clear();
        // Rejeita subscrições ativas (contratos em andamento)
        for (const [, rejectFn] of this._subscriptionRejects) {
          rejectFn(new Error(`WebSocket fechado (${code})`));
        }
        this._subscriptionRejects.clear();
        this._subscriptions.clear();
      });
    });
  }

  // ─── API Legada: conexão + autorização ──────────────────────────────────────

  connect() {
    const url = `${LEGACY_WS_URL}?app_id=${this.appId}`;
    return this._connectToUrl(url);
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

  // ─── Autenticação (API Legada) ───────────────────────────────────────────────

  async authorize(token) {
    const response = await this._send({ authorize: token });
    if (response.error) {
      const err = response.error;
      throw new Error(`[${err.code}] ${err.message}`);
    }

    this._authorized = true;
    this._legacyToken = token; // armazenado para reconexão automática
    this.accountInfo = response.authorize;
    return response.authorize;
  }

  /**
   * Reconecta automaticamente usando as credenciais já armazenadas.
   * Funciona para nova API (pat_) e API legada (a1-).
   * @returns {Promise<void>}
   */
  async reconnect() {
    this._stopPing();
    if (this._ws) {
      try { this._ws.terminate(); } catch (_) {}
      this._ws = null;
    }
    this._authorized = false;
    this._pending.clear();

    if (this.accountInfo?._patToken) {
      // Nova API: usa OTP armazenado
      const { _patToken, _appId, loginid } = this.accountInfo;
      const wsUrl = await this._getOTPUrl(_patToken, _appId, loginid);
      await this._connectToUrl(wsUrl);
      this._authorized = true;
    } else if (this._legacyToken) {
      // API Legada: reconecta e reautoriza
      await this.connect();
      await this.authorize(this._legacyToken);
    } else {
      throw new Error('Credenciais não disponíveis para reconexão automática');
    }
  }



  /**
   * Lista as contas disponíveis.
   * Requer que authorize() ou connectNewAPI() já tenha sido chamado.
   */
  getAccountList() {
    if (!this.accountInfo) throw new Error('Cliente não autenticado');
    return this.accountInfo.account_list || [];
  }

  /**
   * Troca para outra conta usando seu token (API legada) ou account_id (nova API).
   * @param {string} tokenOrAccountId Token da conta (legada) ou account_id (nova API)
   */
  async switchAccount(tokenOrAccountId) {
    // Nova API: recebe account_id (DOT/DEM/ROT + números)
    if (this.accountInfo?._patToken || /^(DOT|DEM|ROT)\d+$/.test(tokenOrAccountId)) {
      return this.switchAccountNewAPI(tokenOrAccountId);
    }
    // API Legada: recebe token
    const response = await this._send({ authorize: tokenOrAccountId.trim() });
    if (response.error) throw new Error(response.error.message);

    this.accountInfo = response.authorize;
    return response.authorize;
  }

  // ─── Saldo ──────────────────────────────────────────────────────────────────

  async getBalance() {
    // A nova API não aceita o campo "account" — envia apenas {balance: 1}
    const isNewAPI = !!this.accountInfo?._patToken;
    const request = isNewAPI ? { balance: 1 } : { balance: 1, account: 'current' };
    const response = await this._send(request);
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
      underlying_symbol: params.symbol,
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
            this._subscriptionRejects.delete(res.subscription?.id);
            resolve(contract);
          } else {
            // Aguarda atualizações via subscription
            this._pending.delete(reqId);
            if (res.subscription?.id) {
              this._subscriptions.set(res.subscription.id, (update) => {
                if (onUpdate) onUpdate(update.proposal_open_contract);
                if (update.proposal_open_contract?.is_sold) {
                  this._subscriptions.delete(res.subscription.id);
                  this._subscriptionRejects.delete(res.subscription.id);
                  clearTimeout(timer);
                  resolve(update.proposal_open_contract);
                }
              });
              this._subscriptionRejects.set(res.subscription.id, (err) => {
                this._subscriptions.delete(res.subscription.id);
                this._subscriptionRejects.delete(res.subscription.id);
                clearTimeout(timer);
                reject(err);
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

    // Log de debug — remova em produção
    if (process.env.DERIV_DEBUG === '1') {
      console.log('[WS ←]', JSON.stringify(msg));
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

  /**
   * Consulta o estado atual de um contrato sem criar subscription.
   * Usado como fallback quando a subscription trava ou o WebSocket reconecta.
   * @param {number} contractId
   * @returns {Promise<object>} Dados do contrato (proposal_open_contract)
   */
  async checkContractStatus(contractId) {
    const response = await this._send({
      proposal_open_contract: 1,
      contract_id: contractId,
    }, DEFAULT_TIMEOUT_MS);
    if (response.error) throw new Error(response.error.message);
    return response.proposal_open_contract;
  }

  /**
   * Envia um ping à API e retorna true se a API responder dentro do timeout.
   * Usado pelo health check periódico e pré-check antes de trades.
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<boolean>}
   */
  async ping(timeoutMs = 5_000) {
    try {
      const response = await this._send({ ping: 1 }, timeoutMs);
      return response.ping === 'pong' || !!response.pong || !response.error;
    } catch {
      return false;
    }
  }
}

module.exports = DerivClient;
