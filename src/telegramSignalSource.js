'use strict';

const DEFAULT_POLL_TIMEOUT_SECONDS = 20;
const DEFAULT_RETRY_DELAY_MS = 3_000;

class TelegramSignalSource {
  constructor({ botToken, chatId, onLog = () => {} }) {
    if (!botToken || typeof botToken !== 'string') {
      throw new Error('TELEGRAM_BOT_TOKEN inválido.');
    }

    this.botToken = botToken.trim();
    this.chatId = chatId != null ? String(chatId).trim() : '';
    this.onLog = onLog;

    this._running = false;
    this._offset = 0;
  }

  start(onSignalText) {
    if (this._running) return;
    if (typeof onSignalText !== 'function') {
      throw new Error('Callback onSignalText é obrigatório.');
    }

    this._running = true;
    this.onLog('info', 'Listener iniciado (getUpdates long polling).');
    this._bootstrapAndLoop(onSignalText);
  }

  stop() {
    this._running = false;
  }

  async _bootstrapAndLoop(onSignalText) {
    try {
      const pending = await this._getUpdates(0);
      if (pending.length > 0) {
        this._offset = pending[pending.length - 1].update_id + 1;
        this.onLog('info', `Ignorando ${pending.length} update(s) antigo(s) no bootstrap.`);
      }
    } catch (err) {
      this.onLog('error', `Falha ao sincronizar offset inicial: ${err.message}`);
    }

    await this._loop(onSignalText);
  }

  async _loop(onSignalText) {
    while (this._running) {
      try {
        const updates = await this._getUpdates();
        for (const update of updates) {
          if (!this._running) break;
          this._offset = update.update_id + 1;

          const event = this._extractEvent(update);
          if (!event) continue;

          try {
            await onSignalText(event);
          } catch (err) {
            this.onLog('error', `Erro no callback de sinal: ${err.message}`);
          }
        }
      } catch (err) {
        this.onLog('error', `Falha no polling: ${err.message}`);
        await this._sleep(DEFAULT_RETRY_DELAY_MS);
      }
    }
  }

  async _getUpdates(timeoutSeconds = DEFAULT_POLL_TIMEOUT_SECONDS) {
    const params = new URLSearchParams({
      timeout: String(timeoutSeconds),
      offset: String(this._offset),
      allowed_updates: JSON.stringify(['message', 'channel_post']),
    });

    const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?${params.toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout((timeoutSeconds + 5) * 1000) });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} ao consultar Telegram: ${body.slice(0, 300)}`);
    }

    const payload = await res.json();
    if (!payload.ok) {
      throw new Error(`Telegram retornou erro: ${payload.description || 'desconhecido'}`);
    }

    if (!Array.isArray(payload.result)) return [];
    return payload.result;
  }

  _extractEvent(update) {
    const msg = update.message || update.channel_post;
    if (!msg) return null;

    const currentChatId = msg.chat?.id != null ? String(msg.chat.id) : '';
    if (this.chatId && this.chatId !== currentChatId) return null;

    const text = (msg.text || msg.caption || '').trim();
    if (!text) return null;

    const from = msg.from?.username
      ? `@${msg.from.username}`
      : [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'desconhecido';

    return {
      updateId: update.update_id,
      chatId: currentChatId,
      messageId: msg.message_id,
      from,
      text,
      receivedAt: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000),
    };
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = TelegramSignalSource;
