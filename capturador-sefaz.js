const https = require('https');
const fs = require('fs');
const zlib = require('zlib');

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
  const s = (dataStr || "").replace("T", " ").trim();
  const ano = s.slice(0, 4);
  const mes = s.slice(5, 7);
  if (!ano || !mes) return "2026/09";
  return ano + "/" + mes;
}

function extrairXml(tag, xml) {
  // Tenta com namespace e sem
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

async function processarDoc(doc, empresa) {
  if (doc.TipoDocumento !== "NFSE") return false; // só NFS-e no Contas a Pagar

  const chave = limparChave(doc.ChaveAcesso || String(doc.NSU));
  const xml = descomprimirXml(doc.ArquivoXml || "");

  if (!xml || xml.length < 50) {
    console.log("  XML vazio para NSU", doc.NSU);
    return false;
  }

  // Debug: mostra trecho do XML na primeira nota
  if (doc.NSU === 1) {
    console.log("  XML amostra:", xml.slice(0, 300));
  }

  // Extrai campos conforme estrutura real do PNFS-e
  // Prestador: dentro de <emit> ou <prest>
  const emitMatch = xml.match(/<emit[^>]*>([\s\S]*?)<\/emit>/i) || xml.match(/<prest[^>]*>([\s\S]*?)<\/prest>/i);
  const emitXml = emitMatch ? emitMatch[1] : xml;
  const prestadorNome = extrairXml("xNome", emitXml) || extrairXml("xNome", xml) || "";
  const prestadorCnpj = extrairXml("CNPJ", emitXml) || extrairXml("Cnpj", emitXml) || extrairXml("CNPJ", xml) || "";

  // Valor: vLiq ou vBC dentro de <valores>
  const valoresMatch = xml.match(/<valores[^>]*>([\s\S]*?)<\/valores>/i);
  const valoresXml = valoresMatch ? valoresMatch[1] : xml;
  const valorStr = extrairXml("vLiq", valoresXml) || extrairXml("vBC", valoresXml) || extrairXml("ValorServicos", xml) || "0";
  const valor = parseFloat(valorStr.replace(",", ".")) || 0;

  // Serviço: dentro de <serv> ou <xDescServ>
  const servMatch = xml.match(/<serv[^>]*>([\s\S]*?)<\/serv>/i);
  const servXml = servMatch ? servMatch[1] : xml;
  const discriminacao = (extrairXml("xDescServ", servXml) || extrairXml("Discriminacao", xml) || extrairXml("xTribNac", xml) || "").split("|").join("").trim().toUpperCase().slice(0, 300);

  // Data e competência
  const dataEmissao = (extrairXml("dhEmi", xml) || extrairXml("DataEmissao", xml) || "").slice(0, 10);
  const competencia = (extrairXml("dCompet", xml) || dataEmissao).slice(0, 7);
  const numero = extrairXml("nNFSe", xml) || extrairXml("nDFSe", xml) || extrairXml("Numero", xml) || String(doc.NSU);

  const mp = mesPath(competencia || dataEmissao);

  // Verifica se já existe
  const existe = await fbGet("nfse_tomadas/" + mp + "/" + chave);
  if (existe && existe.nsu) return false;

  const entrada = {
    nsu: doc.NSU,
    chaveAcesso: doc.ChaveAcesso || "",
    numero, dataEmissao, competencia,
    prestadorCnpj: prestadorCnpj.replace(/\D/g, ""),
    prestadorRazaoSocial: prestadorNome,
    tomadorCnpj: empresa.cnpj,
    valorServicos: valor,
    discriminacao,
    criadoEm: Date.now(),
  };

  await fbPut("nfse_tomadas/" + mp + "/" + chave, entrada);
  await fbPut("contas_pagar/" + mp + "/" + chave, {
    fornecedor: prestadorNome,
    cnpj: prestadorCnpj.replace(/\D/g, ""),
    tomadorCnpj: empresa.cnpj,
    empresa: empresa.nome,
    numeroDoc: numero,
    valor,
    competencia,
    vencimento: dataEmissao,
    historico: discriminacao,
    categoriaId: "", categoriaLabel: "",
    situacao: "pendente",
    origem: "sefaz-pnfse",
    chaveAcesso: doc.ChaveAcesso || "",
    xmlBase64: doc.ArquivoXml || "",
    criadoEm: Date.now(),
  });

  return true;
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
  console.log("[" + new Date().toISOString() + "] Capturador SEFAZ PNFS-e v2");
  let total = 0;
  for (const empresa of EMPRESAS) {
    total += await sincronizarEmpresa(empresa);
  }
  console.log("\n[" + new Date().toISOString() + "] Concluído — " + total + " notas novas.");
}

main().catch(console.error);
