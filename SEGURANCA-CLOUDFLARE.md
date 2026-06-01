# Seguranca do site da festa da Luiza

Este repositório agora inclui um Cloudflare Worker para proteger `claudiocode.dev/festa-luiza/`.

O fluxo configurado no código é:

1. O convidado informa nome e escolhe WhatsApp ou email.
2. O Worker gera um codigo de 6 digitos.
3. O codigo e enviado pelo Twilio Verify WhatsApp ou por email via Resend.
4. O convidado informa o codigo recebido.
5. O Worker cria um cookie seguro e libera o site e as fotos.
6. A senha master configurada no Cloudflare libera a entrada sem depender de codigo.

## O que ainda precisa ser configurado no Cloudflare

Crie um KV namespace:

```powershell
npx wrangler kv namespace create FESTA_LUIZA_KV
```

Copie o `id` gerado e substitua `SUBSTITUA_PELO_ID_DO_KV` em `wrangler.toml`.

Configure os segredos:

```powershell
npx wrangler secret put COOKIE_SECRET
npx wrangler secret put MASTER_PASSWORD
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_VERIFY_SERVICE_SID
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM_EMAIL
```

Valores:

- `COOKIE_SECRET`: qualquer texto longo e aleatorio.
- `MASTER_PASSWORD`: a senha master combinada para entrada manual.
- `TWILIO_ACCOUNT_SID`: Account SID da conta Twilio.
- `TWILIO_AUTH_TOKEN`: Auth Token da conta Twilio.
- `TWILIO_VERIFY_SERVICE_SID`: Service SID do Twilio Verify.
- `RESEND_API_KEY`: chave de API da Resend.
- `RESEND_FROM_EMAIL`: email remetente verificado na Resend, por exemplo `convite@seudominio.com`.

Na Twilio, crie um Verify Service e habilite/teste o canal WhatsApp.

Na Resend, verifique o dominio/remetente que sera usado para enviar os codigos.

Depois publique:

```powershell
npx wrangler deploy
```

## Observacao importante

Este Worker protege o caminho `https://claudiocode.dev/festa-luiza/`.

Se as fotos continuarem publicas em `https://claudiovestevao.github.io/festa-luiza/`, alguem que descobrir esse endereco ainda pode acessar por fora do Cloudflare. Para seguranca real das fotos, mova as imagens para um lugar privado, como Cloudflare R2 privado, ou deixe de publicar a versao direta do GitHub Pages.
