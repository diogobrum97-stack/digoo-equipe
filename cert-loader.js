// ════════════════════════════════════════════════════════════════════════════
// Certificado digital dos capturadores (SEFAZ / NFS-e).
// O certificado é enviado pelo OPS (Configurações → Certificado digital), chega
// criptografado em /certificados_cripto/{conta} e só esta VPS consegue abrir,
// com a chave privada /opt/digoo-capturador/cert-privada.pem (nunca sai daqui).
// Se não houver certificado no sistema, usa o .pfx antigo do disco
// (senha em /opt/digoo-capturador/senha.txt ou na variável CERT_SENHA).
// ════════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");

const DIR = "/opt/digoo-capturador";
const PRIVADA = DIR + "/cert-privada.pem";
const FB_HOST = "digoo-equipe-default-rtdb.firebaseio.com";

// Acesso de ADMIN ao Firebase (as regras bloqueiam acesso anônimo a /certificados_*):
// usa a conta de serviço que já existe na VPS para pegar um token OAuth (sem dependências).
const CONTA_SERVICO = process.env.FIREBASE_SA || "/opt/digoo-picking-sync/serviceAccount.json";
let tokenCache = null;
function postForm(url, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString(), u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("resposta inválida do Google")); } });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}
async function tokenAdmin() {
  if (tokenCache && tokenCache.ate > Date.now() + 60e3) return tokenCache.token;
  const sa = JSON.parse(fs.readFileSync(CONTA_SERVICO, "utf8"));
  const agora = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const corpo = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: sa.client_email, aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat: agora, exp: agora + 3600,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
  });
  const jwt = corpo + "." + crypto.sign("RSA-SHA256", Buffer.from(corpo), sa.private_key).toString("base64url");
  const r = await postForm(sa.token_uri || "https://oauth2.googleapis.com/token", { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt });
  if (!r.access_token) throw new Error("não consegui o acesso de admin ao Firebase: " + (r.error_description || r.error || "?"));
  tokenCache = { token: r.access_token, ate: Date.now() + (r.expires_in || 3600) * 1000 };
  return tokenCache.token;
}
// Lê/grava no Firebase como admin. Lança erro se o Firebase recusar.
async function fb(method, path, dados) {
  const token = await tokenAdmin();
  return new Promise((resolve, reject) => {
    const body = dados === undefined ? null : JSON.stringify(dados);
    const req = https.request({
      hostname: FB_HOST, path: "/" + path + ".json?access_token=" + encodeURIComponent(token), method,
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode >= 300) return reject(new Error("Firebase " + res.statusCode + " " + d.slice(0, 120)));
        try { resolve(JSON.parse(d)); } catch (e) { resolve(null); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const fbSilencioso = (m, p, d) => fb(m, p, d).catch(e => console.error("  Firebase: " + e.message));

// Cria o par de chaves na primeira vez e publica a chave PÚBLICA para o OPS usar
async function garantirChave() {
  if (!fs.existsSync(PRIVADA)) {
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 3072,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    try { fs.writeFileSync(PRIVADA, privateKey, { mode: 0o600, flag: "wx" }); } catch (e) { /* outro processo criou */ }
  }
  const privada = fs.readFileSync(PRIVADA, "utf8");
  const publica = crypto.createPublicKey(privada).export({ type: "spki", format: "pem" });
  const atual = await fb("GET", "certificados_chave/publica");
  if (atual !== publica) await fb("PUT", "certificados_chave", { publica, criada_em: Date.now() });
  return privada;
}

function senhaDoArquivo() {
  if (process.env.CERT_SENHA) return process.env.CERT_SENHA;
  try { return fs.readFileSync(DIR + "/senha.txt", "utf8").trim(); } catch (e) { return undefined; }
}

const memo = {};
// Opções de TLS (key/cert ou pfx/passphrase) para a empresa — uma vez por rodada
async function opcoesCertificado(empresa) {
  const conta = empresa.nome === "Filial" ? "filial" : "matriz";
  if (memo[conta]) return memo[conta];
  try {
    const privada = await garantirChave();
    const c = await fb("GET", "certificados_cripto/" + conta);
    if (c && c.k) {
      const k = crypto.privateDecrypt({ key: privada, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(c.k, "base64"));
      const dec = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(c.iv, "base64"));
      dec.setAuthTag(Buffer.from(c.tag, "base64"));
      const p = JSON.parse(Buffer.concat([dec.update(Buffer.from(c.dados, "base64")), dec.final()]).toString("utf8"));
      crypto.createPrivateKey(p.key);                      // confere se abriu certo
      console.log("  Certificado: o do sistema (" + conta + ")");
      fbSilencioso("PATCH", "certificados_info/" + conta, { usado_em: Date.now(), erro: null });
      return (memo[conta] = { key: p.key, cert: p.cert });
    }
  } catch (e) {
    console.error("  Certificado do sistema não abriu (" + conta + "): " + e.message + " — usando o arquivo do disco");
    fbSilencioso("PATCH", "certificados_info/" + conta, { erro: "A VPS não conseguiu abrir: " + e.message, erro_em: Date.now() });
  }
  console.log("  Certificado: arquivo do disco " + empresa.pfx);
  return (memo[conta] = { pfx: fs.readFileSync(empresa.pfx), passphrase: senhaDoArquivo() });
}

module.exports = { opcoesCertificado, garantirChave, fbAdmin: fb };
