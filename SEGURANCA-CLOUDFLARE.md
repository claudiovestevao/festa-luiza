# Seguranca do site da festa da Luiza

Este repositório agora inclui um Cloudflare Worker para proteger `claudiocode.dev/festa-luiza/`.

O fluxo configurado no código é:

1. O convidado informa nome e WhatsApp.
2. O Worker gera um codigo de 6 digitos.
3. O codigo e enviado pelo WhatsApp Business Cloud API.
4. O convidado informa o codigo recebido.
5. O Worker cria um cookie seguro e libera o site e as fotos.
6. A senha master configurada no Cloudflare libera a entrada sem depender do WhatsApp.

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
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
```

Valores:

- `COOKIE_SECRET`: qualquer texto longo e aleatorio.
- `MASTER_PASSWORD`: a senha master combinada para entrada manual.
- `WHATSAPP_TOKEN`: token da Meta WhatsApp Cloud API.
- `WHATSAPP_PHONE_NUMBER_ID`: ID do numero de telefone no WhatsApp Cloud API.

Na Meta, crie e aprove um template chamado `festa_luiza_codigo`, idioma `pt_BR`, com um parametro no corpo para o codigo.

Depois publique:

```powershell
npx wrangler deploy
```

## Observacao importante

Este Worker protege o caminho `https://claudiocode.dev/festa-luiza/`.

Se as fotos continuarem publicas em `https://claudiovestevao.github.io/festa-luiza/`, alguem que descobrir esse endereco ainda pode acessar por fora do Cloudflare. Para seguranca real das fotos, mova as imagens para um lugar privado, como Cloudflare R2 privado, ou deixe de publicar a versao direta do GitHub Pages.
