'use strict';

/**
 * Script de diagnóstico para testar a comunicação com a API Deriv.
 *
 * Uso:
 *   node test-connection.js <TOKEN> [APP_ID]
 *
 * Exemplos:
 *   node test-connection.js SEU_TOKEN_AQUI
 *   node test-connection.js SEU_TOKEN_AQUI 1089
 */

const WebSocket = require('ws');

const TOKEN  = process.argv[2];
const APP_ID = process.argv[3] || '1089';
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

if (!TOKEN) {
  console.error('⚠️  Uso: node test-connection.js <TOKEN> [APP_ID]');
  process.exit(1);
}

console.log(`\n🔌 Conectando a: ${WS_URL}`);
console.log(`🔑 Token: ${TOKEN.slice(0, 4)}${'*'.repeat(TOKEN.length - 8)}${TOKEN.slice(-4)}\n`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('✅ WebSocket aberto com sucesso.\n');

  // 1) Ping para checar latência
  const pingPayload = JSON.stringify({ ping: 1, req_id: 1 });
  console.log(`[→] Enviando ping: ${pingPayload}`);
  ws.send(pingPayload);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log(`[←] Resposta:`, JSON.stringify(msg, null, 2));

  if (msg.req_id === 1 && msg.ping) {
    // Ping respondeu — agora testa authorize
    const authPayload = JSON.stringify({ authorize: TOKEN, req_id: 2 });
    console.log(`\n[→] Enviando authorize: { authorize: "${TOKEN.slice(0,4)}***", req_id: 2 }`);
    ws.send(authPayload);
    return;
  }

  if (msg.req_id === 2) {
    if (msg.error) {
      console.error(`\n❌ Falha na autorização!`);
      console.error(`   Código: ${msg.error.code}`);
      console.error(`   Mensagem: ${msg.error.message}`);
      console.error(`\n💡 Possíveis causas:`);
      console.error(`   • Token expirado ou inválido — gere um novo em app.deriv.com/account/api-token`);
      console.error(`   • App ID ${APP_ID} pode não aceitar este token — registre seu app em api.deriv.com/app-registration`);
    } else {
      console.log(`\n✅ Autorização bem-sucedida!`);
      console.log(`   Login ID : ${msg.authorize.loginid}`);
      console.log(`   Nome     : ${msg.authorize.fullname}`);
      console.log(`   Moeda    : ${msg.authorize.currency}`);
      console.log(`   Tipo     : ${msg.authorize.is_virtual ? 'Demo' : 'Real'}`);
    }
    ws.close();
  }
});

ws.on('error', (err) => {
  console.error(`\n❌ Erro no WebSocket: ${err.message}`);
});

ws.on('close', (code, reason) => {
  console.log(`\n🔌 Conexão encerrada (code=${code})`);
  process.exit(0);
});

// Timeout global de 15 segundos
setTimeout(() => {
  console.error('\n⏱️  Timeout: sem resposta em 15 segundos.');
  ws.terminate();
  process.exit(1);
}, 15_000);
