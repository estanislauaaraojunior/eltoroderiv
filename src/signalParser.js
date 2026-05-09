'use strict';

/**
 * Mapeia símbolo de moeda para o formato aceito pela API da Deriv.
 * Forex usa prefixo "frx". Índices sintéticos (ex: R_100) não têm prefixo.
 */
const SYMBOL_PREFIXES = {
  forex: 'frx',
};

const FOREX_PAIRS = new Set([
  'EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','USDCAD','NZDUSD',
  'EURGBP','EURJPY','GBPJPY','EURCHF','AUDJPY','CADJPY','CHFJPY',
  'EURAUD','EURCAD','EURNZD','GBPAUD','GBPCAD','GBPCHF','GBPNZD',
  'AUDCAD','AUDCHF','AUDNZD','NZDCAD','NZDCHF','NZDJPY',
]);

/**
 * Retorna o símbolo no formato da Deriv:
 *  - USDJPY → frxUSDJPY
 *  - R_100  → R_100  (sintético, sem prefixo)
 */
function toDerivSymbol(raw) {
  const upper = raw.toUpperCase();
  if (FOREX_PAIRS.has(upper)) {
    return `frx${upper}`;
  }
  // Já está no formato correto (sintéticos, cryptos, etc.)
  return upper;
}

/**
 * Converte "M5" em { duration: 5, duration_unit: 'm' }
 * Formatos aceitos: M1, M5, M15, M30, H1, H4, D1
 */
function parseDuration(raw) {
  const match = raw.match(/^([MHDS])(\d+)$/i);
  if (!match) return null;

  const unit = match[1].toLowerCase();
  const value = parseInt(match[2], 10);

  const unitMap = { m: 'm', h: 'h', d: 'd', s: 's' };
  if (!unitMap[unit]) return null;

  return { duration: value, duration_unit: unitMap[unit] };
}

/**
 * Converte string de horário "HH:MM" + Data base (Date) em um objeto Date.
 * Se o horário calculado já tiver passado, retorna null (sinal expirado).
 */
function parseScheduledAt(timeStr, baseDate) {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  if (hours > 23 || minutes > 59) return null;

  const scheduledAt = new Date(baseDate);
  scheduledAt.setHours(hours, minutes, 0, 0);

  return scheduledAt;
}

/**
 * Parseia uma linha no formato: M5;USDJPY;15:05;CALL
 * Retorna objeto de sinal ou null se a linha for inválida.
 */
function parseLine(line, baseDate, index) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;

  const parts = trimmed.split(';');
  if (parts.length < 4) return null;

  const [durationStr, symbolStr, timeStr, directionStr] = parts.map(p => p.trim());

  const durationInfo = parseDuration(durationStr);
  if (!durationInfo) return null;

  const symbol = toDerivSymbol(symbolStr);
  if (!symbol) return null;

  const scheduledAt = parseScheduledAt(timeStr, baseDate);
  if (!scheduledAt) return null;

  const direction = directionStr.toUpperCase();
  if (direction !== 'CALL' && direction !== 'PUT') return null;

  return {
    id: `signal_${index}_${Date.now()}`,
    raw: trimmed,
    symbol,
    rawSymbol: symbolStr.toUpperCase(),
    duration: durationInfo.duration,
    duration_unit: durationInfo.duration_unit,
    scheduledAt,
    direction, // 'CALL' (compra) | 'PUT' (venda)
    contract_type: direction, // Deriv usa o mesmo valor
    status: 'pending', // estados: pendente | agendado | expirado | executando | concluído | erro
  };
}

/**
 * Parseia o texto completo da lista de sinais.
 *
 * @param {string} text     - Texto colado pelo usuário
 * @param {Date}   baseDate - Data base para calcular scheduledAt (normalmente hoje)
 * @returns {{ signals: Signal[], skipped: number }}
 */
function parseSignals(text, baseDate) {
  const lines = text.split('\n');
  const signals = [];
  let skipped = 0;

  lines.forEach((line, i) => {
    const signal = parseLine(line, baseDate, i);
    if (signal) {
      signals.push(signal);
    } else if (line.trim().length > 0) {
      skipped++;
    }
  });

  // Ordena por horário de entrada
  signals.sort((a, b) => a.scheduledAt - b.scheduledAt);

  return { signals, skipped };
}

module.exports = { parseSignals, toDerivSymbol, parseDuration };
