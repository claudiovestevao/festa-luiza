export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/festa-luiza/api/")) {
      return handleApi(request, env, url);
    }

    const session = await readSession(request, env);
    if (!session) {
      return new Response(loginPage(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow, noarchive"
        }
      });
    }

    return proxySite(request, env, url);
  }
};

async function handleApi(request, env, url) {
  if (request.method !== "POST") return json({ ok: false, error: "Metodo nao permitido." }, 405);
  if (!env.COOKIE_SECRET) return json({ ok: false, error: "COOKIE_SECRET nao configurado no Cloudflare." }, 500);

  try {
    if (url.pathname.endsWith("/request-code")) {
      const input = await readJson(request);
      const name = cleanName(input.name);
      const delivery = normalizeDelivery(input.delivery);
      const contact = delivery === "whatsapp" ? normalizePhone(input.phone) : normalizeEmail(input.email);
      if (!name) return json({ ok: false, error: "Digite seu nome." }, 400);
      if (!contact) return json({ ok: false, error: delivery === "whatsapp" ? "Digite um WhatsApp valido com DDD." : "Digite um email valido." }, 400);

      const identity = `${delivery}:${contact}`;
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
      const codeHash = await digest(`${identity}:${code}:${env.COOKIE_SECRET}`);
      const ttl = Number(env.OTP_TTL_SECONDS || 600);

      if (delivery === "whatsapp") {
        await env.FESTA_LUIZA_KV.put(`otp:${identity}`, JSON.stringify({
          name,
          delivery,
          contact,
          codeHash,
          createdAt: Date.now(),
          attempts: 0
        }), { expirationTtl: ttl });
        try {
          await sendWhatsAppCode(env, contact, name, code);
        } catch (error) {
          await env.FESTA_LUIZA_KV.delete(`otp:${identity}`);
          throw error;
        }
        return json({ ok: true, message: "Codigo enviado pelo WhatsApp." });
      }

      await env.FESTA_LUIZA_KV.put(`otp:${identity}`, JSON.stringify({
        name,
        delivery,
        contact,
        codeHash,
        createdAt: Date.now(),
        attempts: 0
      }), { expirationTtl: ttl });
      await sendEmailCode(env, contact, name, code);
      return json({ ok: true, message: "Codigo enviado por email." });
    }

    if (url.pathname.endsWith("/verify-code")) {
      const input = await readJson(request);
      const name = cleanName(input.name);
      const delivery = normalizeDelivery(input.delivery);
      const contact = delivery === "whatsapp" ? normalizePhone(input.phone) : normalizeEmail(input.email);
      const code = String(input.code || "").trim();
      if (!code) return json({ ok: false, error: "Digite o codigo." }, 400);

      if (env.MASTER_PASSWORD && code === env.MASTER_PASSWORD) {
        const sessionName = name || "Convidado master";
        return grantSession(env, sessionName, delivery, contact || "master", true);
      }

      if (!contact) return json({ ok: false, error: delivery === "whatsapp" ? "Digite o WhatsApp usado no cadastro." : "Digite o email usado no cadastro." }, 400);
      const identity = `${delivery}:${contact}`;

      const raw = await env.FESTA_LUIZA_KV.get(`otp:${identity}`);
      if (!raw) return json({ ok: false, error: "Codigo expirado. Solicite outro." }, 400);

      const record = JSON.parse(raw);
      if (record.attempts >= 5) {
        await env.FESTA_LUIZA_KV.delete(`otp:${identity}`);
        return json({ ok: false, error: "Muitas tentativas. Solicite outro codigo." }, 429);
      }

      const codeHash = await digest(`${identity}:${code}:${env.COOKIE_SECRET}`);
      if (codeHash !== record.codeHash) {
        record.attempts += 1;
        await env.FESTA_LUIZA_KV.put(`otp:${identity}`, JSON.stringify(record), { expirationTtl: Number(env.OTP_TTL_SECONDS || 600) });
        return json({ ok: false, error: "Codigo incorreto." }, 400);
      }

      await env.FESTA_LUIZA_KV.delete(`otp:${identity}`);
      await env.FESTA_LUIZA_KV.put(`guest:${identity}`, JSON.stringify({
        name: record.name,
        delivery,
        contact,
        verifiedAt: Date.now()
      }));
      return grantSession(env, record.name, delivery, contact, false);
    }

    if (url.pathname.endsWith("/logout")) {
      return json({ ok: true }, 200, clearSessionCookie());
    }
  } catch (error) {
    return json({ ok: false, error: error.message || "Erro ao processar solicitacao." }, 500);
  }

  return json({ ok: false, error: "Rota nao encontrada." }, 404);
}

async function proxySite(request, env, url) {
  const upstream = new URL(env.UPSTREAM_ORIGIN || "https://claudiovestevao.github.io");
  upstream.pathname = url.pathname;
  upstream.search = url.search;

  const response = await fetch(upstream.toString(), {
    method: request.method,
    headers: request.headers
  });

  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.set("cache-control", response.headers.get("content-type")?.startsWith("text/html") ? "no-store" : "private, max-age=3600");
  headers.delete("set-cookie");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function grantSession(env, name, delivery, contact, master) {
  const ttl = Number(env.SESSION_TTL_SECONDS || 604800);
  const payload = {
    name,
    delivery,
    contact,
    master: Boolean(master),
    exp: Math.floor(Date.now() / 1000) + ttl
  };
  const token = await signPayload(payload, env);
  return json({ ok: true, redirect: "/festa-luiza/" }, 200, sessionCookie(token, ttl));
}

async function readSession(request, env) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const token = cookies.luiza_session;
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = await hmac(parts[0], env.COOKIE_SECRET);
  if (expected !== parts[1]) return null;
  const payload = JSON.parse(base64UrlDecode(parts[0]));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function signPayload(payload, env) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(body, env.COOKIE_SECRET);
  return `${body}.${signature}`;
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(sig);
}

async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncodeBytes(hash);
}

async function sendEmailCode(env, email, name, code) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    throw new Error("Email ainda nao configurado. Configure RESEND_API_KEY e RESEND_FROM_EMAIL no Cloudflare.");
  }

  const fromName = env.RESEND_FROM_NAME || "Festa da Luiza";
  const from = `${fromName} <${env.RESEND_FROM_EMAIL}>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Codigo de entrada da festa da Luiza",
      html: emailHtml(name, code),
      text: `Oi, ${name || "convidado"}! Seu codigo para entrar na festa da Luiza e ${code}. Ele expira em 10 minutos.`
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Falha ao enviar email: ${detail}`);
  }
}

async function sendWhatsAppCode(env, phone, name, code) {
  const token = env.WHATSAPP_TOKEN || env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error("WhatsApp oficial ainda nao configurado. Configure WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID no Cloudflare.");
  }

  const graphVersion = env.WHATSAPP_GRAPH_VERSION || "v24.0";
  const templateName = env.WHATSAPP_TEMPLATE_NAME || "codigo_acesso_festa";
  const templateLanguage = env.WHATSAPP_TEMPLATE_LANGUAGE || "pt_BR";
  const components = [
    {
      type: "body",
      parameters: [{ type: "text", text: code }]
    }
  ];

  if (String(env.WHATSAPP_TEMPLATE_BUTTON || "true").toLowerCase() !== "false") {
    components.push({
      type: "button",
      sub_type: "copy_code",
      index: "0",
      parameters: [{ type: "coupon_code", coupon_code: code }]
    });
  }

  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: templateName,
        language: { code: templateLanguage },
        components
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Falha ao enviar WhatsApp pela Meta Cloud API: ${detail}`);
  }
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 160) : "";
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  const withCountry = digits.startsWith("55") ? digits : `55${digits}`;
  return withCountry.length >= 12 && withCountry.length <= 13 ? withCountry : "";
}

function normalizeDelivery(value) {
  return value === "whatsapp" ? "whatsapp" : "email";
}

function emailHtml(name, code) {
  const safeName = escapeHtml(name || "convidado");
  return `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;background:#100d16;padding:24px;font-family:Arial,sans-serif;color:#21172a;">
  <div style="max-width:520px;margin:0 auto;background:#fff8ef;border-radius:18px;padding:28px;text-align:center;">
    <div style="font-size:40px;margin-bottom:8px;">L</div>
    <h1 style="margin:0 0 10px;font-size:26px;">Entrada da festa da Luiza</h1>
    <p style="font-size:16px;line-height:1.45;color:#6f607d;">Oi, ${safeName}! Use o codigo abaixo para entrar no site da festa.</p>
    <div style="margin:22px auto;padding:16px 22px;background:#21172a;color:#fff;border-radius:14px;font-size:34px;font-weight:800;letter-spacing:6px;">${code}</div>
    <p style="font-size:13px;color:#7a6b86;">Esse codigo expira em 10 minutos.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

function sessionCookie(token, ttl) {
  return {
    "set-cookie": `luiza_session=${token}; Max-Age=${ttl}; Path=/festa-luiza; HttpOnly; Secure; SameSite=Lax`
  };
}

function clearSessionCookie() {
  return {
    "set-cookie": "luiza_session=; Max-Age=0; Path=/festa-luiza; HttpOnly; Secure; SameSite=Lax"
  };
}

function parseCookies(cookieHeader) {
  return Object.fromEntries(cookieHeader.split(";").map(part => {
    const [key, ...rest] = part.trim().split("=");
    return [key, rest.join("=")];
  }).filter(([key]) => key));
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

function loginPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Entrada da festa da Luiza</title>
<style>
:root{color-scheme:dark;--bg:#100d16;--panel:#fff8ef;--ink:#21172a;--muted:#766987;--pink:#f06292;--lilac:#b57bee;--gold:#f5c842;}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:Nunito,Arial,sans-serif;background:radial-gradient(circle at 50% 0,#2b1746 0,#100d16 58%);color:var(--ink)}
.gate{width:min(100%,420px);background:var(--panel);border-radius:22px;padding:28px 22px;box-shadow:0 24px 80px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.18)}
.avatar{width:92px;height:92px;border-radius:50%;margin:0 auto 14px;background:linear-gradient(135deg,var(--pink),var(--lilac));display:grid;place-items:center;color:white;font-size:42px;box-shadow:0 0 0 6px #100d16,0 12px 34px rgba(181,123,238,.45)}
h1{font-family:Arial,sans-serif;text-align:center;font-size:28px;line-height:1.05;margin:0 0 8px;color:#21172a}
p{margin:0 0 18px;text-align:center;color:var(--muted);font-size:15px;line-height:1.35}
label{display:block;font-weight:800;font-size:13px;margin:14px 0 6px;color:#493c58}
input{width:100%;border:2px solid #eadff2;border-radius:14px;padding:13px 14px;font:inherit;font-size:16px;background:white;color:#21172a;outline:none}
input:focus{border-color:var(--lilac);box-shadow:0 0 0 4px rgba(181,123,238,.16)}
.delivery{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.delivery button{margin:0;border-radius:14px;background:#fff;color:#493c58;border:2px solid #eadff2}
.delivery button.active{background:#21172a;color:#fff;border-color:#21172a}
button{width:100%;border:0;border-radius:999px;padding:14px 18px;margin-top:16px;background:linear-gradient(135deg,var(--pink),var(--lilac));color:white;font-weight:900;font-size:16px;cursor:pointer}
button.secondary{background:#21172a;color:#f3d9ff}
.msg{min-height:22px;margin-top:12px;text-align:center;color:#7a3150;font-weight:800;font-size:13px}
.hidden{display:none}
</style>
</head>
<body>
<main class="gate">
  <div class="avatar">L</div>
  <h1>Entrada da festa</h1>
  <p>Cadastre seu nome e receba o codigo de acesso por WhatsApp ou email. A senha master tambem libera a entrada.</p>
  <form id="requestForm">
    <label for="name">Nome do convidado</label>
    <input id="name" name="name" autocomplete="name" maxlength="80" required>
    <label>Enviar codigo por</label>
    <div class="delivery">
      <button type="button" class="active" id="deliveryWhatsapp">WhatsApp</button>
      <button type="button" id="deliveryEmail">Email</button>
    </div>
    <div id="phoneField">
      <label for="phone">WhatsApp com DDD</label>
      <input id="phone" name="phone" inputmode="tel" autocomplete="tel" placeholder="11999999999">
    </div>
    <div id="emailField" class="hidden">
      <label for="email">Email</label>
      <input id="email" name="email" inputmode="email" autocomplete="email" placeholder="voce@email.com">
    </div>
    <button type="submit" id="sendBtn">Receber codigo pelo WhatsApp</button>
    <button class="secondary" type="button" id="haveCodeBtn">Ja tenho codigo ou senha</button>
  </form>
  <form id="verifyForm" class="hidden">
    <label for="code">Codigo recebido ou senha master</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
    <button type="submit">Entrar</button>
    <button class="secondary" type="button" id="backBtn">Trocar dados</button>
  </form>
  <div class="msg" id="msg"></div>
</main>
<script>
const requestForm=document.getElementById('requestForm');
const verifyForm=document.getElementById('verifyForm');
const msg=document.getElementById('msg');
const backBtn=document.getElementById('backBtn');
const haveCodeBtn=document.getElementById('haveCodeBtn');
const deliveryWhatsapp=document.getElementById('deliveryWhatsapp');
const deliveryEmail=document.getElementById('deliveryEmail');
const phoneField=document.getElementById('phoneField');
const emailField=document.getElementById('emailField');
const sendBtn=document.getElementById('sendBtn');
let delivery='whatsapp';
function setDelivery(next){
  delivery=next;
  deliveryWhatsapp.classList.toggle('active',delivery==='whatsapp');
  deliveryEmail.classList.toggle('active',delivery==='email');
  phoneField.classList.toggle('hidden',delivery!=='whatsapp');
  emailField.classList.toggle('hidden',delivery!=='email');
  sendBtn.textContent=delivery==='whatsapp'?'Receber codigo pelo WhatsApp':'Receber codigo por email';
}
function data(){return {delivery,name:document.getElementById('name').value,phone:document.getElementById('phone').value,email:document.getElementById('email').value,code:document.getElementById('code').value};}
async function post(path,body){
  const r=await fetch('./api/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({ok:false,error:'Erro inesperado.'}));
  if(!r.ok||!j.ok) throw new Error(j.error||'Nao foi possivel continuar.');
  return j;
}
requestForm.addEventListener('submit',async e=>{
  e.preventDefault(); msg.textContent='Enviando codigo...';
  try{ await post('request-code',data()); requestForm.classList.add('hidden'); verifyForm.classList.remove('hidden'); document.getElementById('code').focus(); msg.textContent=delivery==='whatsapp'?'Codigo enviado. Confira seu WhatsApp.':'Codigo enviado. Confira seu email.'; }
  catch(err){ msg.textContent=err.message; }
});
verifyForm.addEventListener('submit',async e=>{
  e.preventDefault(); msg.textContent='Verificando...';
  try{ const result=await post('verify-code',data()); location.href=result.redirect||'./'; }
  catch(err){ msg.textContent=err.message; }
});
backBtn.addEventListener('click',()=>{verifyForm.classList.add('hidden');requestForm.classList.remove('hidden');msg.textContent='';});
haveCodeBtn.addEventListener('click',()=>{requestForm.classList.add('hidden');verifyForm.classList.remove('hidden');document.getElementById('code').focus();msg.textContent='';});
deliveryWhatsapp.addEventListener('click',()=>setDelivery('whatsapp'));
deliveryEmail.addEventListener('click',()=>setDelivery('email'));
</script>
</body>
</html>`;
}
