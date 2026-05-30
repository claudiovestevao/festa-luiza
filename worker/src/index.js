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
    const phone = normalizePhone(input.phone);
    if (!name) return json({ ok: false, error: "Digite seu nome." }, 400);
    if (!phone) return json({ ok: false, error: "Digite um WhatsApp valido com DDD." }, 400);

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
    const codeHash = await digest(`${phone}:${code}:${env.COOKIE_SECRET}`);
    const ttl = Number(env.OTP_TTL_SECONDS || 600);
    await env.FESTA_LUIZA_KV.put(`otp:${phone}`, JSON.stringify({
      name,
      phone,
      codeHash,
      createdAt: Date.now(),
      attempts: 0
    }), { expirationTtl: ttl });

    await sendWhatsAppCode(env, phone, code);
    return json({ ok: true, message: "Codigo enviado pelo WhatsApp." });
    }

    if (url.pathname.endsWith("/verify-code")) {
    const input = await readJson(request);
    const name = cleanName(input.name);
    const phone = normalizePhone(input.phone);
    const code = String(input.code || "").trim();
    if (!code) return json({ ok: false, error: "Digite o codigo." }, 400);

    if (env.MASTER_PASSWORD && code === env.MASTER_PASSWORD) {
      const sessionName = name || "Convidado master";
      const sessionPhone = phone || "master";
      return grantSession(env, sessionName, sessionPhone, true);
    }

    if (!phone) return json({ ok: false, error: "Digite o WhatsApp usado no cadastro." }, 400);
    const raw = await env.FESTA_LUIZA_KV.get(`otp:${phone}`);
    if (!raw) return json({ ok: false, error: "Codigo expirado. Solicite outro." }, 400);

    const record = JSON.parse(raw);
    if (record.attempts >= 5) {
      await env.FESTA_LUIZA_KV.delete(`otp:${phone}`);
      return json({ ok: false, error: "Muitas tentativas. Solicite outro codigo." }, 429);
    }

    const codeHash = await digest(`${phone}:${code}:${env.COOKIE_SECRET}`);
    if (codeHash !== record.codeHash) {
      record.attempts += 1;
      await env.FESTA_LUIZA_KV.put(`otp:${phone}`, JSON.stringify(record), { expirationTtl: Number(env.OTP_TTL_SECONDS || 600) });
      return json({ ok: false, error: "Codigo incorreto." }, 400);
    }

    await env.FESTA_LUIZA_KV.delete(`otp:${phone}`);
    await env.FESTA_LUIZA_KV.put(`guest:${phone}`, JSON.stringify({
      name: record.name,
      phone,
      verifiedAt: Date.now()
    }));
    return grantSession(env, record.name, phone, false);
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

async function grantSession(env, name, phone, master) {
  const ttl = Number(env.SESSION_TTL_SECONDS || 604800);
  const payload = {
    name,
    phone,
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

async function sendWhatsAppCode(env, phone, code) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WhatsApp nao configurado no Cloudflare Worker.");
  }

  const templateName = env.WHATSAPP_TEMPLATE_NAME || "festa_luiza_codigo";
  const language = env.WHATSAPP_TEMPLATE_LANGUAGE || "pt_BR";
  const endpoint = `https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: templateName,
        language: { code: language },
        components: [{
          type: "body",
          parameters: [{ type: "text", text: code }]
        }]
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Falha ao enviar WhatsApp: ${detail}`);
  }
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  const withCountry = digits.startsWith("55") ? digits : `55${digits}`;
  return withCountry.length >= 12 && withCountry.length <= 13 ? withCountry : "";
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
  <p>Cadastre seu nome e WhatsApp para receber o codigo de acesso. A senha master tambem libera a entrada.</p>
  <form id="requestForm">
    <label for="name">Nome do convidado</label>
    <input id="name" name="name" autocomplete="name" maxlength="80" required>
    <label for="phone">WhatsApp com DDD</label>
    <input id="phone" name="phone" inputmode="tel" autocomplete="tel" placeholder="11999999999" required>
    <button type="submit">Receber codigo no WhatsApp</button>
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
function data(){return {name:document.getElementById('name').value,phone:document.getElementById('phone').value,code:document.getElementById('code').value};}
async function post(path,body){
  const r=await fetch('./api/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({ok:false,error:'Erro inesperado.'}));
  if(!r.ok||!j.ok) throw new Error(j.error||'Nao foi possivel continuar.');
  return j;
}
requestForm.addEventListener('submit',async e=>{
  e.preventDefault(); msg.textContent='Enviando codigo...';
  try{ await post('request-code',data()); requestForm.classList.add('hidden'); verifyForm.classList.remove('hidden'); document.getElementById('code').focus(); msg.textContent='Codigo enviado. Confira seu WhatsApp.'; }
  catch(err){ msg.textContent=err.message; }
});
verifyForm.addEventListener('submit',async e=>{
  e.preventDefault(); msg.textContent='Verificando...';
  try{ const result=await post('verify-code',data()); location.href=result.redirect||'./'; }
  catch(err){ msg.textContent=err.message; }
});
backBtn.addEventListener('click',()=>{verifyForm.classList.add('hidden');requestForm.classList.remove('hidden');msg.textContent='';});
</script>
</body>
</html>`;
}
