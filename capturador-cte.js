const https = require('https');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const FIREBASE_URL = "https://digoo-equipe-default-rtdb.firebaseio.com";
const { opcoesCertificado, fbAdmin } = require("./cert-loader");   // certificado: Configurações → Certificado digital

const EMPRESAS = [
  { nome: "Matriz", pfx: "/opt/digoo-capturador/matriz_new.pfx", cnpj: "40981026000182", uf: "RS" },
  { nome: "Filial", pfx: "/opt/digoo-capturador/filial_new.pfx", cnpj: "40981026000344", uf: "SP" },
];

// Endpoint SEFAZ Nacional DistDFeInt (mesmo para CT-e e NF-e)
const SEFAZ_HOST = "www1.nfe.fazenda.gov.br";
const SEFAZ_PATH = "/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx";

function limparChave(str) {
  return (str || "cte_" + Date.now())
    .replace(/[.#$\[\]\/]/g, "_");
}

function mesPath(dataStr) {
  const s = (dataStr || "").slice(0, 10);
  const ano = s.slice(0, 4);
  const mes = s.slice(5, 7);
  if (!ano || !mes) return "2026/09";
  return ano + "/" + mes;
}

function extrairTag(tag, xml) {
  const re = new RegExp("<(?:[^:>]+:)?" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[^:>]+:)?" + tag + ">", "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function descomprimir(base64) {
  const buf = Buffer.from(base64, "base64");
  try { return zlib.gunzipSync(buf).toString("utf-8"); } catch(e) {}
  try { return zlib.inflateSync(buf).toString("utf-8"); } catch(e) {}
  return buf.toString("utf-8");
}

// Firebase como ADMIN (as regras não aceitam mais acesso anônimo). Erro de leitura PARA a rodada —
// assim nunca volta a consultar a SEFAZ do NSU 0 por engano (o que dava bloqueio 656).
async function fbGet(path) { return fbAdmin("GET", path); }
async function fbPut(path, dados) { return fbAdmin("PUT", path, dados); }

// Código IBGE da UF do interessado (cUFAutor)
const COD_UF = { RS: "43", SP: "35" };

// Envelope SOAP compacto (sem quebras de linha/espaços entre as tags — a SEFAZ valida o esquema à risca)
function montarSoapDistDFe(empresa, ultNSU, variante) {
  const nsu = String(ultNSU).padStart(15, "0");
  const cUF = variante === "uf43" ? "43" : (COD_UF[empresa.uf] || "43");
  const dist = `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><cUFAutor>${cUF}</cUFAutor><CNPJ>${empresa.cnpj}</CNPJ><distNSU><ultNSU>${nsu}</ultNSU></distNSU></distDFeInt>`;
  if (variante === "antigo") return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDadosMsg>
        <distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>1</tpAmb>
          <cUFAutor>43</cUFAutor>
          <CNPJ>${empresa.cnpj}</CNPJ>
          <distNSU>
            <ultNSU>${nsu}</ultNSU>
          </distNSU>
        </distDFeInt>
      </nfeDadosMsg>
    </nfeDistDFeInteresse>
  </soap12:Body>
</soap12:Envelope>`;
  return `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">${dist}</nfeDadosMsg></nfeDistDFeInteresse></soap12:Body></soap12:Envelope>`;
}

async function consultarSefazNacional(empresa, ultNSU, variante) {
  const cert = await opcoesCertificado(empresa);
  return new Promise((resolve, reject) => {
    const soapBody = montarSoapDistDFe(empresa, ultNSU, variante);
    const bodyBuf = Buffer.from(soapBody, "utf-8");

    const opts = {
      hostname: SEFAZ_HOST,
      path: SEFAZ_PATH,
      method: "POST",
      ...cert,
      headers: {
        // SOAP 1.2: a action vai DENTRO do Content-Type (igual à sped-nfe); sem header SOAPAction
        "Content-Type": 'application/soap+xml;charset=utf-8;action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"',
        "Content-Length": bodyBuf.length,
      },
      timeout: 30000,
    };

    const req = https.request(opts, res => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function processarNfe(chave, xmlDoc, empresa) {
  const numero = extrairTag("nNF", xmlDoc) || chave.slice(25, 34);
  const dataEmissao = (extrairTag("dhEmi", xmlDoc) || extrairTag("dEmi", xmlDoc) || "").slice(0, 10);
  const valor = parseFloat(extrairTag("vNF", xmlDoc) || "0");
  const emitNome = extrairTag("xNome", xmlDoc).split("<")[0].slice(0, 100);
  const emitCnpj = extrairTag("CNPJ", xmlDoc).replace(/\D/g, "");
  const mp = mesPath(dataEmissao || new Date().toISOString());
  const chaveKey = limparChave(chave || ("NFE_" + empresa.cnpj + "_" + numero));

  const existe = await fbGet("nfe_tomadas/" + mp + "/" + chaveKey);
  if (existe) return false;

  await fbPut("nfe_tomadas/" + mp + "/" + chaveKey, {
    chaveAcesso: chave,
    numero, dataEmissao,
    emitenteCnpj: emitCnpj,
    emitenteRazaoSocial: emitNome,
    tomadorCnpj: empresa.cnpj,
    empresa: empresa.nome,
    valor, criadoEm: Date.now(),
  });

  console.log("  [NF-e] " + (emitNome||chave) + " R$" + valor + " — " + dataEmissao);
  return true;
}

async function sincronizarEmpresa(empresa) {
  console.log("\n[" + empresa.nome + "] Consultando SEFAZ Nacional...");
  const nsuKey = "capturador_nsu_dist/" + empresa.cnpj;
  // bloqueio de 1h da SEFAZ (656): não consulta antes de passar, senão o relógio do bloqueio recomeça
  const bloqKey = "capturador_bloqueio/" + empresa.cnpj;
  const bloqueio = await fbGet(bloqKey);
  if (bloqueio && Date.now() - bloqueio < 62 * 60e3) {
    console.log("  Bloqueio SEFAZ até " + new Date(bloqueio + 62 * 60e3).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" }) + " — pulando esta rodada.");
    return 0;
  }
  let ultNSU = (await fbGet(nsuKey)) || 0;
  console.log("  Último NSU dist: " + ultNSU);

  let totalNovas = 0;
  let continuar = true;

  while (continuar) {
    let respostaXml;
    try {
      respostaXml = await consultarSefazNacional(empresa, ultNSU);
    } catch(e) {
      console.error("  Erro SEFAZ Nacional:", e.message);
      break;
    }

    // Verificar status
    const cStat = extrairTag("cStat", respostaXml);
    const xMotivo = extrairTag("xMotivo", respostaXml);
    console.log("  Status:", cStat, xMotivo);

    // O NSU só avança quando os documentos foram de fato recebidos (137 = nada novo; 138 = avança doc a doc).
    // No 656 NÃO avança: a SEFAZ devolve o NSU máximo, e salvar ele pularia notas que nunca chegaram.
    if (cStat === "137") {
      const ultNSUResp = parseInt(extrairTag("ultNSU", respostaXml)) || 0;
      if (ultNSUResp > ultNSU) { ultNSU = ultNSUResp; await fbPut(nsuKey, ultNSU); console.log("  NSU salvo:", ultNSU); }
      console.log("  Nenhum documento novo."); break;
    }
    if (cStat === "656") { await fbPut(bloqKey, Date.now()); console.log("  Bloqueio SEFAZ de 1h — NSU mantido em " + ultNSU + "."); break; }
    if (cStat !== "138") { console.log("  Resposta inesperada:", cStat, xMotivo, "|", respostaXml.slice(0, 400)); break; }

    // Extrair NSUs do XML de resposta
    const maxNSU = extrairTag("maxNSU", respostaXml);
    const ultNSURet = extrairTag("ultNSU", respostaXml);

    // (o NSU é salvo documento a documento, abaixo — só depois de cada nota processada)

    // Processar cada docZip — tenta os dois formatos de atributo
    const docZipRe = /<docZip[^>]*>([^<]+)<\/docZip>/g;
    const docZipReAtt = /<docZip([^>]*)>([^<]+)<\/docZip>/g;
    let match;
    let totalDocs = 0;
    while ((match = docZipReAtt.exec(respostaXml)) !== null) {
      totalDocs++;
      const attrs = match[1];
      const base64 = match[2].trim();
      const schemaM = attrs.match(/schema="([^"]+)"/i);
      const nsuM = attrs.match(/NSU="(\d+)"/i);
      const schema = schemaM ? schemaM[1] : "";
      const nsu = nsuM ? parseInt(nsuM[1]) : 0;
      const xmlDoc = descomprimir(base64);
      // Extrair chave — tenta vários campos
      const chaveMatch = xmlDoc.match(/<chNFe>([^<]{44})<\/chNFe>/) ||
                         xmlDoc.match(/Id="NFe([^"]{44})"/) ||
                         xmlDoc.match(/<chave>([^<]{44})<\/chave>/);
      const chave = chaveMatch ? chaveMatch[1] : "";

      console.log("  Doc", totalDocs, "schema:", schema||"(vazio)", "NSU:", nsu, "chave:", chave.slice(0,10)||"(sem chave)", "xmlLen:", xmlDoc.length);

      // Ignorar eventos (cancelamento, carta de correção) — não são documentos fiscais novos
      if (schema.toLowerCase().includes("evento")) {
        console.log("  → Evento ignorado");
      } else {
        let ok = false;
        if (schema.toLowerCase().includes("nfe")) {
          ok = await processarNfe(chave, xmlDoc, empresa);
        } else {
          console.log("  XML amostra:", xmlDoc.slice(0, 300));
        }
        if (ok) totalNovas++;
      }
      if (nsu > ultNSU) {
        ultNSU = nsu;
        await fbPut(nsuKey, ultNSU);
      }
    }
    console.log("  Total docZip encontrados:", totalDocs);
    // lote inteiro processado: avança até o ultNSU do lote (cobre NSUs sem documento para nós)
    if (ultNSURet && parseInt(ultNSURet) > ultNSU) { ultNSU = parseInt(ultNSURet); await fbPut(nsuKey, ultNSU); }
    console.log("  NSU salvo:", ultNSU);

    // Continuar só se há mais documentos — espera 3s entre chamadas
    continuar = maxNSU && parseInt(maxNSU) > ultNSU;
    if (continuar) {
      console.log("  Há mais documentos (max:", maxNSU, "), aguardando 3s...");
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  return totalNovas;
}

// Diagnóstico: node capturador-cte.js --teste  → 1 consulta na Matriz com o NSU salvo, sem gravar nada
async function teste() {
  const empresa = EMPRESAS[0];
  const ult = (await fbGet("capturador_nsu_dist/" + empresa.cnpj)) || 0;
  console.log("NSU salvo:", ult);
  for (const v of ["novo"]) {
    try {
      const r = await consultarSefazNacional(empresa, ult, v);
      console.log(v.padEnd(7), "→", extrairTag("cStat", r), extrairTag("xMotivo", r), "| ultNSU", extrairTag("ultNSU", r), "maxNSU", extrairTag("maxNSU", r));
      if (!extrairTag("cStat", r)) console.log("        resposta:", r.slice(0, 400));
    } catch (e) { console.log(v.padEnd(7), "→ erro", e.message); }
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function main() {
  if (process.argv.includes("--teste")) return teste();
  console.log("[" + new Date().toISOString() + "] Capturador NF-e (entradas) — SEFAZ Nacional DistDFeInt");
  let total = 0;
  for (const empresa of EMPRESAS) {
    try { total += await sincronizarEmpresa(empresa); }
    catch (e) { console.error("  [" + empresa.nome + "] rodada interrompida: " + e.message); }
  }
  console.log("\n[" + new Date().toISOString() + "] Concluído — " + total + " documentos novos.");
}

main().catch(console.error);
