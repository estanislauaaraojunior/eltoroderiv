# ElToroDeriv

## Automação de sinais via Telegram

Agora o servidor pode ler mensagens de um grupo/canal no Telegram e agendar os sinais automaticamente, usando o mesmo parser já existente (`M5;USDJPY;15:05;CALL`).

### 1. Criar bot e obter token

1. Crie um bot com o **@BotFather**.
2. Copie o token gerado.
3. Adicione o bot no grupo/canal onde os sinais chegam.

### 2. Descobrir o chat ID

Envie uma mensagem no grupo/canal e consulte:

```bash
curl "https://api.telegram.org/botSEU_TOKEN/getUpdates"
```

Use o `chat.id` retornado (em grupos costuma ser algo como `-100...`).

### 3. Subir o ElToroDeriv com variáveis

```bash
export TELEGRAM_BOT_TOKEN="SEU_TOKEN"
export TELEGRAM_CHAT_ID="-1001234567890"   # opcional, mas recomendado
npm start
```

Se `TELEGRAM_CHAT_ID` for informado, só mensagens desse chat serão processadas.

### 4. Formato da mensagem no Telegram

Use o mesmo padrão já usado no painel:

```txt
M5;USDJPY;15:05;CALL
M5;EURUSD;15:10;PUT
```

O servidor vai parsear, emitir os eventos para o front e agendar automaticamente nas sessões conectadas à Deriv.
