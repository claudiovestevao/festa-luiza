# Seguranca do site da festa da Luiza

Este repositório agora inclui um Cloudflare Worker para proteger `claudiocode.dev/festa-luiza/`.

O fluxo configurado no código é:

1. O convidado informa nome e escolhe WhatsApp ou email.
2. O Worker gera um codigo de 6 digitos.
3. O codigo e enviado pela API oficial da Meta WhatsApp Cloud API ou por email via Resend.
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
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM_EMAIL
```

Valores:

- `COOKIE_SECRET`: qualquer texto longo e aleatorio.
- `MASTER_PASSWORD`: a senha master combinada para entrada manual.
- `WHATSAPP_TOKEN`: token da Meta com permissao para enviar mensagens pelo WhatsApp Cloud API. Tambem pode ser configurado como `WHATSAPP_ACCESS_TOKEN`.
- `WHATSAPP_PHONE_NUMBER_ID`: ID do numero de telefone verificado no WhatsApp Cloud API.
- `WHATSAPP_TEMPLATE_NAME`: nome do template aprovado na Meta. Default: `codigo_acesso_festa`.
- `WHATSAPP_TEMPLATE_LANGUAGE`: idioma do template aprovado. Default: `pt_BR`.
- `WHATSAPP_TEMPLATE_BUTTON`: use `true` se o template tiver botao de copiar codigo. Use `false` se o template tiver apenas variavel no corpo.
- `RESEND_API_KEY`: chave de API da Resend.
- `RESEND_FROM_EMAIL`: email remetente verificado na Resend, por exemplo `convite@seudominio.com`.

Na Meta, use um numero verificado no WhatsApp Cloud API e crie/aprove um template de autenticacao para envio do codigo. O Worker usa o template `codigo_acesso_festa` por padrao, com uma variavel `{{1}}` para o codigo de 6 digitos.

Template recomendado pela documentacao oficial da Meta para OTP com botao de copiar codigo:

```powershell
$env:META_TOKEN = "COLE_O_TOKEN_AQUI"
$wabaId = "SEU_WHATSAPP_BUSINESS_ACCOUNT_ID"
$body = @{
  name = "codigo_acesso_festa"
  languages = @("pt_BR")
  category = "AUTHENTICATION"
  components = @(
    @{
      type = "BODY"
      add_security_recommendation = $true
    },
    @{
      type = "FOOTER"
      code_expiration_minutes = 10
    },
    @{
      type = "BUTTONS"
      buttons = @(
        @{
          type = "OTP"
          otp_type = "COPY_CODE"
        }
      )
    }
  )
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Method Post `
  -Uri "https://graph.facebook.com/v25.0/$wabaId/upsert_message_templates" `
  -Headers @{ Authorization = "Bearer $env:META_TOKEN"; "Content-Type" = "application/json" } `
  -Body $body
```

Importante: no botao `OTP` com `COPY_CODE`, nao envie texto customizado para o botao. A Meta gera o texto do botao conforme o idioma do template.

Na Resend, verifique o dominio/remetente que sera usado para enviar os codigos.

Depois publique:

```powershell
npx wrangler deploy
```

## Observacao importante

Este Worker protege o caminho `https://claudiocode.dev/festa-luiza/`.

Se as fotos continuarem publicas em `https://claudiovestevao.github.io/festa-luiza/`, alguem que descobrir esse endereco ainda pode acessar por fora do Cloudflare. Para seguranca real das fotos, mova as imagens para um lugar privado, como Cloudflare R2 privado, ou deixe de publicar a versao direta do GitHub Pages.
