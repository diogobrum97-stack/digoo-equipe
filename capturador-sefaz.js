const https = require('https');
const fs = require('fs');
const zlib = require('zlib');

const FIREBASE_URL = "https://digoo-equipe-default-rtdb.firebaseio.com";
const PASSPHRASE = "Digoo7560";

const EMPRESAS = [
  { nome: "Matriz", pfx: "/opt/digoo-capturador/matriz_new.pfx", cnpj: "40981026000182" },
  { nome: "Filial", pfx: "/opt/digoo-capturador/filial_new.pfx", cnpj: "40981026000344" },
];

function limparChave(str) {
  return (str || "sefaz_" + Date.now())
    .split(".").join("_").split("#").join("_")
    .split("$").join("_").split("[").join("_")
    .split("]").join("_").split("/").join("_");
}

function mesPath(dataStr) {
  const s = (dataStr || "").replace("T", " ").trim();
  const ano = s.slice(0, 4);
  const mes = s.slice(5, 7);
  if (!ano || !mes) return "2026/09";
  return ano + "/" + mes;
}

function extrairXml(tag, xml) {
  const patterns = [
    new RegExp("<" + tag + ">([\\s\\S]*?)<\\/" + tag + ">", "i"),
    new RegExp("<[^:>]+:" + tag + ">([\\s\\S]*?)<\\/[^:>]+:" + tag + ">", "i"),
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m) return m[1].trim();
  }
  return "";
}

function descomprimirXml(base64) {
  const buf = Buffer.from(base64, "base64");
  try { return zlib.gunzipSync(buf).toString("utf-8"); } catch(e) {}
  try { return zlib.inflateSync(buf).toString("utf-8"); } catch(e) {}
  try { return zlib.inflateRawSync(buf).toString("utf-8"); } catch(e) {}
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

function buscarSefaz(pfxPath, nsu) {
  return new Promise((resolve, reject) => {
    const pfx = fs.readFileSync(pfxPath);
    const opts = {
      hostname: "adn.nfse.gov.br",
      path: "/contribuintes/DFe/" + nsu,
      method: "GET",
      pfx, passphrase: PASSPHRASE,
      headers: { "Accept": "application/json" },
      timeout: 30000
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
        catch(e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

async function processarNfse(doc, empresa) {
  if (doc.TipoDocumento !== "NFSE") return false;

  const xmlRaw = doc.ArquivoXml ? descomprimirXml(doc.ArquivoXml) : "";
  const numero = extrairXml("Numero", xmlRaw) || extrairXml("NumeroNfse", xmlRaw) || doc.NSU;
  const dataEmissao = (extrairXml("DataEmissao", xmlRaw) || extrairXml("DataEmissaoNfse", xmlRaw) || "").slice(0, 10);
  const competencia = (extrairXml("Competencia", xmlRaw) || dataEmissao || "").slice(0, 7);
  const valorStr = extrairXml("ValorServicos", xmlRaw) || extrairXml("ValorLiquidoNfse", xmlRaw) || "0";
  const valor = parseFloat(valorStr.replace(",", ".")) || 0;
  const discriminacao = (extrairXml("Discriminacao", xmlRaw) || "").slice(0, 300);
  const prestadorCnpj = extrairXml("Cnpj", xmlRaw) || "";
  const prestadorNome = (extrairXml("RazaoSocial", xmlRaw) || extrairXml("NomeFantasia", xmlRaw) || "").slice(0, 100);
  const mp = mesPath(dataEmissao || competencia);
  const chave = limparChave(doc.ChaveAcesso || ("NFSE_" + empresa.cnpj + "_" + numero + "_" + (competencia || doc.NSU)));

  const existe = await fbGet("nfse_tomadas/" + mp + "/" + chave);
  if (existe && existe.nsu) {
    const contaExiste = await fbGet("contas_pagar/" + mp + "/" + chave);
    if (contaExiste && !contaExiste.xmlBase64 && doc.ArquivoXml) {
      await fbPut("contas_pagar/" + mp + "/" + chave, Object.assign({}, contaExiste, { xmlBase64: doc.ArquivoXml }));
      return true;
    }
    return false;
  }

  const entrada = {
    nsu: doc.NSU, chaveAcesso: doc.ChaveAcesso || "",
    numero, dataEmissao, competencia,
    prestadorCnpj: prestadorCnpj.replace(/\D/g, ""),
    prestadorRazaoSocial: prestadorNome,
    tomadorCnpj: empresa.cnpj,
    valorServicos: valor, discriminacao,
    criadoEm: Date.now(),
  };

  await fbPut("nfse_tomadas/" + mp + "/" + chave, entrada);
  await fbPut("contas_pagar/" + mp + "/" + chave, {
    fornecedor: prestadorNome,
    cnpj: prestadorCnpj.replace(/\D/g, ""),
    tomadorCnpj: empresa.cnpj,
    empresa: empresa.nome,
    numeroDoc: numero, valor, competencia,
    vencimento: dataEmissao,
    historico: discriminacao,
    categoriaId: "", categoriaLabel: "",
    situacao: "pendente",
    origem: "sefaz-pnfse",
    chaveAcesso: doc.ChaveAcesso || "",
    xmlBase64: doc.ArquivoXml || "",
    criadoEm: Date.now(),
  });

  console.log("  [NFS-e] " + prestadorNome + " R$" + valor + " — " + dataEmissao);
  return true;
}

async function processarCte(doc, empresa) {
  if (doc.TipoDocumento !== "CTE") return false;

  const xmlRaw = doc.ArquivoXml ? descomprimirXml(doc.ArquivoXml) : "";
  const chaveAcesso = doc.ChaveAcesso || extrairXml("chCTe", xmlRaw) || "";
  const numero = extrairXml("nCT", xmlRaw) || doc.NSU;
  const dataEmissao = (extrairXml("dhEmi", xmlRaw) || "").slice(0, 10);
  const valor = parseFloat(extrairXml("vTPrest", xmlRaw) || extrairXml("vRec", xmlRaw) || "0");
  const emitNome = (extrairXml("xNome", xmlRaw) || "").split("<")[0].slice(0, 100);
  const emitCnpj = extrairXml("CNPJ", xmlRaw) || "";
  const mp = mesPath(dataEmissao);
  const chave = limparChave(chaveAcesso || ("CTE_" + empresa.cnpj + "_" + numero + "_" + (dataEmissao || doc.NSU)));

  const existe = await fbGet("cte_tomados/" + mp + "/" + chave);
  if (existe) return false;

  await fbPut("cte_tomados/" + mp + "/" + chave, {
    nsu: doc.NSU, chaveAcesso,
    numero, dataEmissao,
    emitenteCnpj: emitCnpj.replace(/\D/g, ""),
    emitenteRazaoSocial: emitNome,
    tomadorCnpj: empresa.cnpj,
    empresa: empresa.nome,
    valor, criadoEm: Date.now(),
  });

  console.log("  [CT-e] " + emitNome + " R$" + valor + " — " + dataEmissao);
  return true;
}

async function processarNfe(doc, empresa) {
  if (doc.TipoDocumento !== "NFE") return false;

  const xmlRaw = doc.ArquivoXml ? descomprimirXml(doc.ArquivoXml) : "";
  const chaveAcesso = doc.ChaveAcesso || extrairXml("chNFe", xmlRaw) || "";
  const numero = extrairXml("nNF", xmlRaw) || doc.NSU;
  const dataEmissao = (extrairXml("dhEmi", xmlRaw) || "").slice(0, 10);
  const valor = parseFloat(extrairXml("vNF", xmlRaw) || "0");
  const emitNome = (extrairXml("xNome", xmlRaw) || "").split("<")[0].slice(0, 100);
  const emitCnpj = extrairXml("CNPJ", xmlRaw) || "";
  const mp = mesPath(dataEmissao);
  const chave = limparChave(chaveAcesso || ("NFE_" + empresa.cnpj + "_" + numero + "_" + (dataEmissao || doc.NSU)));

  const existe = await fbGet("nfe_tomadas/" + mp + "/" + chave);
  if (existe) return false;

  await fbPut("nfe_tomadas/" + mp + "/" + chave, {
    nsu: doc.NSU, chaveAcesso,
    numero, dataEmissao,
    emitenteCnpj: emitCnpj.replace(/\D/g, ""),
    emitenteRazaoSocial: emitNome,
    tomadorCnpj: empresa.cnpj,
    empresa: empresa.nome,
    valor, criadoEm: Date.now(),
  });

  console.log("  [NF-e] " + emitNome + " R$" + valor + " — " + dataEmissao);
  return true;
}

async function processarDoc(doc, empresa) {
  switch (doc.TipoDocumento) {
    case "NFSE": return await processarNfse(doc, empresa);
    case "CTE":  return await processarCte(doc, empresa);
    case "NFE":  return await processarNfe(doc, empresa);
    default:
      console.log("  [?] Tipo desconhecido:", doc.TipoDocumento);
      return false;
  }
}

async function sincronizarEmpresa(empresa) {
  console.log("\n[" + empresa.nome + "] Sincronizando...");
  const ultimoNsu = (await fbGet("capturador_nsu/" + empresa.cnpj)) || 0;
  console.log("  Último NSU: " + ultimoNsu);

  let nsuAtual = ultimoNsu;
  let totalNovas = 0;

  while (true) {
    let resp;
    try {
      resp = await buscarSefaz(empresa.pfx, nsuAtual);
    } catch(e) {
      console.error("  Erro SEFAZ:", e.message);
      break;
    }

    if (resp.StatusProcessamento === "SEM_DOCUMENTOS") { console.log("  Sem novos."); break; }
    if (resp.StatusProcessamento === "CONSUMO_INDEVIDO") { console.log("  Limite SEFAZ — aguardar 1h."); break; }

    const lote = resp.LoteDFe || [];
    if (!lote.length) break;

    const tipos = {};
    lote.forEach(d => tipos[d.TipoDocumento] = (tipos[d.TipoDocumento] || 0) + 1);
    console.log("  Tipos:", JSON.stringify(tipos));

    for (const doc of lote) {
      const ok = await processarDoc(doc, empresa);
      if (ok) totalNovas++;
      nsuAtual = Math.max(nsuAtual, doc.NSU);
    }

    await fbPut("capturador_nsu/" + empresa.cnpj, nsuAtual);
    console.log("  NSU: " + nsuAtual + " | Novas: " + totalNovas);

    if (lote.length < 50) break;
    await new Promise(r => setTimeout(r, 500));
  }

  return totalNovas;
}

async function main() {
  console.log("[" + new Date().toISOString() + "] Capturador SEFAZ v3 — NFS-e + CT-e + NF-e");
  let total = 0;
  for (const empresa of EMPRESAS) {
    total += await sincronizarEmpresa(empresa);
  }
  console.log("\n[" + new Date().toISOString() + "] Concluído — " + total + " documentos novos.");
}

main().catch(console.error);
