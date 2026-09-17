const https = require('https');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const FIREBASE_URL = "https://digoo-equipe-default-rtdb.firebaseio.com";
const PASSPHRASE = "Digoo7560";

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

async function fbGet(path) {
  return new Promise((resolve) => {
    https.get(FIREBASE_URL + "/" + path + ".json", res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}

async function fbPut(path, dados) {
  return new Promise((resolve) => {
    const body = JSON.stringify(dados);
    const opts = {
      hostname: "digoo-equipe-default-rtdb.firebaseio.com",
      path: "/" + path + ".json",
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      res.on("data", () => {});
      res.on("end", resolve);
    });
    req.on("error", resolve);
    req.write(body);
    req.end();
  });
}

function montarSoapDistDFe(cnpj, ultNSU) {
  const nsuFormatado = String(ultNSU).padStart(15, "0");
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDadosMsg>
        <distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>1</tpAmb>
          <cUFAutor>43</cUFAutor>
          <CNPJ>${cnpj}</CNPJ>
          <distNSU>
            <ultNSU>${nsuFormatado}</ultNSU>
          </distNSU>
        </distDFeInt>
      </nfeDadosMsg>
    </nfeDistDFeInteresse>
  </soap12:Body>
</soap12:Envelope>`;
}

function consultarSefazNacional(empresa, ultNSU) {
  return new Promise((resolve, reject) => {
    const pfxData = fs.readFileSync(empresa.pfx);
    const soapBody = montarSoapDistDFe(empresa.cnpj, ultNSU);
    const bodyBuf = Buffer.from(soapBody, "utf-8");

    const opts = {
      hostname: SEFAZ_HOST,
      path: SEFAZ_PATH,
      method: "POST",
      pfx: pfxData,
      passphrase: PASSPHRASE,
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8",
        "Content-Length": bodyBuf.length,
        "SOAPAction": "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse",
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

async function processarCte(chave, xmlDoc, empresa) {
  const numero = extrairTag("nCT", xmlDoc) || chave.slice(25, 34);
  const dataEmissao = (extrairTag("dhEmi", xmlDoc) || extrairTag("dEmi", xmlDoc) || "").slice(0, 10);
  const valor = parseFloat(extrairTag("vTPrest", xmlDoc) || extrairTag("vRec", xmlDoc) || "0");
  const emitNome = extrairTag("xNome", xmlDoc).split("<")[0].slice(0, 100);
  const emitCnpj = extrairTag("CNPJ", xmlDoc).replace(/\D/g, "");
  const mp = mesPath(dataEmissao || new Date().toISOString());
  const chaveKey = limparChave(chave || ("CTE_" + empresa.cnpj + "_" + numero));

  const existe = await fbGet("cte_tomados/" + mp + "/" + chaveKey);
  if (existe) return false;

  await fbPut("cte_tomados/" + mp + "/" + chaveKey, {
    chaveAcesso: chave,
    numero, dataEmissao,
    emitenteCnpj: emitCnpj,
    emitenteRazaoSocial: emitNome,
    tomadorCnpj: empresa.cnpj,
    empresa: empresa.nome,
    valor, criadoEm: Date.now(),
  });

  console.log("  [CT-e] " + (emitNome||chave) + " R$" + valor + " — " + dataEmissao);
  return true;
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

    if (cStat === "137") { console.log("  Nenhum documento novo."); break; }
    if (cStat !== "138") { console.log("  Resposta inesperada:", cStat, xMotivo); break; }

    // Extrair NSUs do XML de resposta
    const maxNSU = extrairTag("maxNSU", respostaXml);
    const ultNSURet = extrairTag("ultNSU", respostaXml);

    // Atualizar NSU imediatamente com o retornado pela SEFAZ
    if (ultNSURet && parseInt(ultNSURet) > ultNSU) {
      ultNSU = parseInt(ultNSURet);
      await fbPut(nsuKey, ultNSU);
      console.log("  NSU salvo:", ultNSU);
    }

    // Processar cada docZip
    const docZipRe = /<docZip[^>]*schema="([^"]+)"[^>]*NSU="(\d+)"[^>]*>([^<]+)<\/docZip>/g;
    let match;
    while ((match = docZipRe.exec(respostaXml)) !== null) {
      const schema = match[1];
      const nsu = parseInt(match[2]);
      const base64 = match[3];
      const xmlDoc = descomprimir(base64);
      const chaveMatch = xmlDoc.match(/<chCTe>([^<]+)<\/chCTe>|<chNFe>([^<]+)<\/chNFe>|<Id>CTe([^<]+)<\/Id>|<Id>NFe([^<]+)<\/Id>/);
      const chave = chaveMatch ? (chaveMatch[1]||chaveMatch[2]||chaveMatch[3]||chaveMatch[4]||"") : "";

      console.log("  Doc schema:", schema, "NSU:", nsu, "chave:", chave.slice(0,10)||"(sem chave)");

      let ok = false;
      if (schema.toLowerCase().includes("cte")) {
        ok = await processarCte(chave, xmlDoc, empresa);
      } else if (schema.toLowerCase().includes("nfe")) {
        ok = await processarNfe(chave, xmlDoc, empresa);
      } else {
        console.log("  Schema desconhecido:", schema);
      }
      if (ok) totalNovas++;
      if (nsu > ultNSU) {
        ultNSU = nsu;
        await fbPut(nsuKey, ultNSU);
      }
    }

    // Continuar só se há mais documentos — espera 3s entre chamadas
    continuar = maxNSU && parseInt(maxNSU) > ultNSU;
    if (continuar) {
      console.log("  Há mais documentos (max:", maxNSU, "), aguardando 3s...");
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  return totalNovas;
}

async function main() {
  console.log("[" + new Date().toISOString() + "] Capturador CT-e/NF-e v1 — SEFAZ Nacional DistDFeInt");
  let total = 0;
  for (const empresa of EMPRESAS) {
    total += await sincronizarEmpresa(empresa);
  }
  console.log("\n[" + new Date().toISOString() + "] Concluído — " + total + " documentos novos.");
}

main().catch(console.error);
