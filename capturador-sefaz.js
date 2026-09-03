const https = require('https');
const fs = require('fs');
const zlib = require('zlib');
const { DOMParser } = require('@xmldom/xmldom');

const FIREBASE_URL = "https://digoo-equipe-default-rtdb.firebaseio.com";
const PASSPHRASE = "Digoo7560";

const EMPRESAS = [
  { nome: "Matriz", pfx: "./matriz_new.pfx", cnpj: "40981026000182" },
  { nome: "Filial", pfx: "./filial_new.pfx", cnpj: "40981026000344" },
];

function limparChave(str) {
  return (str || "sefaz_" + Date.now())
    .split(".").join("_").split("#").join("_")
    .split("$").join("_").split("[").join("_")
    .split("]").join("_").split("/").join("_");
}

function mesPath(dataStr) {
  const mes = (dataStr || "").slice(0, 7);
  if (!mes || mes.length < 7) return "2026/09";
  return mes.slice(0, 4) + "/" + mes.slice(5, 7);
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

function extrairCampoXml(xml, tag) {
  const re = new RegExp("<(?:[^:>]+:)?" + tag + "[^>]*>([^<]*)<", "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function buscarSefaz(pfxPath, nsu) {
  return new Promise((resolve, reject) => {
    const pfx = fs.readFileSync(pfxPath);
    const opts = {
      hostname: "adn.nfse.gov.br",
      path: "/contribuintes/DFe/" + nsu,
      method: "GET",
      pfx: pfx,
      passphrase: PASSPHRASE,
      headers: { "Accept": "application/json" }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve(JSON.parse(raw));
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function processarNota(nsu, chaveAcesso, xmlGz, empresa) {
  // Descomprime o XML (base64 → buffer → gunzip)
  const buf = Buffer.from(xmlGz, "base64");
  let xml;
  try {
    xml = zlib.gunzipSync(buf).toString("utf-8");
  } catch(e) {
    xml = buf.toString("utf-8");
  }

  const chave = limparChave(chaveAcesso || String(nsu));

  // Extrai campos do XML
  const prestadorCnpj = extrairCampoXml(xml, "Cnpj") || extrairCampoXml(xml, "CPFCNPJPrestador");
  const prestadorNome = extrairCampoXml(xml, "RazaoSocial") || extrairCampoXml(xml, "NomeRazaoSocial");
  const valorServico = parseFloat(extrairCampoXml(xml, "ValorServicos") || extrairCampoXml(xml, "Valor") || "0");
  const discriminacao = extrairCampoXml(xml, "Discriminacao").toUpperCase();
  const dataEmissao = extrairCampoXml(xml, "DataEmissao") || extrairCampoXml(xml, "Competencia") || "";
  const numero = extrairCampoXml(xml, "Numero") || String(nsu);
  const competencia = (extrairCampoXml(xml, "Competencia") || dataEmissao).slice(0, 7);
  const mp = mesPath(competencia || dataEmissao);

  // Verifica se já existe
  const existe = await fbGet("nfse_tomadas/" + mp + "/" + chave);
  if (existe && existe.nsu) return false;

  const entrada = {
    nsu, chaveAcesso: chaveAcesso || "",
    numero, dataEmissao: dataEmissao.slice(0, 10),
    competencia, prestadorCnpj, prestadorRazaoSocial: prestadorNome,
    tomadorCnpj: empresa.cnpj, tomadorRazaoSocial: empresa.nome === "Matriz"
      ? "DIGOO BRASIL IMPORTACAO E DISTRIBUICAO LTDA"
      : "DIGOO BRASIL IMPORTACAO E DISTRIBUICAO LTDA",
    valorServicos: valorServico, discriminacao,
    criadoEm: Date.now(),
  };

  await fbPut("nfse_tomadas/" + mp + "/" + chave, entrada);
  await fbPut("contas_pagar/" + mp + "/" + chave, {
    fornecedor: prestadorNome, cnpj: prestadorCnpj,
    numeroDoc: numero, valor: valorServico,
    competencia, vencimento: dataEmissao.slice(0, 10),
    historico: discriminacao.slice(0, 200),
    categoriaId: "", categoriaLabel: "",
    situacao: "pendente", origem: "sefaz-pnfse",
    chaveAcesso: chaveAcesso || "", criadoEm: Date.now(),
  });

  return true;
}

async function sincronizarEmpresa(empresa) {
  console.log("\n[" + empresa.nome + "] Sincronizando...");

  // Lê último NSU processado
  const ultimoNsu = (await fbGet("capturador_nsu/" + empresa.cnpj)) || 0;
  console.log("  Último NSU: " + ultimoNsu);

  let nsuAtual = ultimoNsu;
  let totalNovas = 0;
  let continuar = true;

  while (continuar) {
    let resp;
    try {
      resp = await buscarSefaz(empresa.pfx, nsuAtual);
    } catch(e) {
      console.error("  Erro na SEFAZ:", e.message);
      break;
    }

    if (resp.StatusProcessamento === "SEM_DOCUMENTOS") {
      console.log("  Sem novos documentos.");
      break;
    }

    if (resp.StatusProcessamento === "CONSUMO_INDEVIDO") {
      console.log("  Limite SEFAZ — aguardar 1 hora.");
      break;
    }

    const lote = resp.LoteDFe || [];
    if (!lote.length) break;

    for (const doc of lote) {
      if (doc.TipoDocumento === "NFSE") {
        const ok = await processarNota(doc.NSU, doc.ChaveAcesso, doc.ArquivoXml, empresa);
        if (ok) totalNovas++;
      }
      nsuAtual = Math.max(nsuAtual, doc.NSU);
    }

    // Salva NSU mais alto
    await fbPut("capturador_nsu/" + empresa.cnpj, nsuAtual);
    console.log("  NSU atual: " + nsuAtual + " | Novas: " + totalNovas);

    // Se veio menos de 50, chegou no fim
    if (lote.length < 50) break;

    // Pausa entre páginas
    await new Promise(r => setTimeout(r, 500));
  }

  return totalNovas;
}

async function main() {
  console.log("[" + new Date().toISOString() + "] Capturador SEFAZ PNFS-e iniciando...");
  let total = 0;
  for (const empresa of EMPRESAS) {
    total += await sincronizarEmpresa(empresa);
  }
  console.log("\n[" + new Date().toISOString() + "] Concluído — " + total + " notas novas.");
}

main().catch(console.error);
