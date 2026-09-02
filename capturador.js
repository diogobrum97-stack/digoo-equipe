const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const FD_TOKEN = "fd_3813f2de25cff4c516fb78d1ef99dcf9bf362287dbf9e88781458018655b50e2";
const FD_BASE = "https://fiscaldefender.com.br/api/v1";
const FIREBASE_URL = "https://digoo-equipe-default-rtdb.firebaseio.com";

function limparChave(str) {
  return (str || "fd_" + Date.now()).split(".").join("_").split("#").join("_").split("$").join("_").split("[").join("_").split("]").join("_").split("/").join("_");
}

function mesPath(dataStr) {
  const mes = (dataStr || "").slice(0, 7);
  return mes.slice(0, 4) + "/" + mes.slice(5, 7);
}

async function salvarFirebase(caminho, dados) {
  await fetch(FIREBASE_URL + "/" + caminho + ".json", {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(dados)
  });
}

async function jaExiste(caminho) {
  const r = await fetch(FIREBASE_URL + "/" + caminho + ".json");
  const d = await r.json();
  return d && (d.chaveAcesso || d.valor || d.chave);
}

// ── NFS-e ──────────────────────────────────────────────────────────────────
async function processarNfse(nfse) {
  const chave = limparChave(nfse.chaveAcesso || nfse.numero);
  const mp = mesPath(nfse.competencia || nfse.dataEmissao);
  if (await jaExiste("nfse_tomadas/" + mp + "/" + chave)) return false;
  const historico = (nfse.descricaoServico || nfse.discriminacao || "").split("|").join("").trim().toUpperCase();
  const entrada = {
    chaveAcesso: nfse.chaveAcesso || "",
    numero: nfse.numero || "",
    dataEmissao: (nfse.dataEmissao || "").slice(0, 10),
    competencia: (nfse.competencia || nfse.dataEmissao || "").slice(0, 7),
    prestadorCnpj: (nfse.prestadorCnpj || "").split(".").join("").split("/").join("").split("-").join(""),
    prestadorRazaoSocial: nfse.prestadorRazaoSocial || "",
    tomadorCnpj: (nfse.tomadorCnpj || "").split(".").join("").split("/").join("").split("-").join(""),
    tomadorRazaoSocial: nfse.tomadorRazaoSocial || "",
    valorServicos: parseFloat(String(nfse.valorServico || nfse.valorServicos || 0).replace(",", ".")) || 0,
    discriminacao: historico,
    criadoEm: Date.now(),
  };
  await salvarFirebase("nfse_tomadas/" + mp + "/" + chave, entrada);
  // Salva também no contas_pagar como rascunho
  await salvarFirebase("contas_pagar/" + mp + "/" + chave, {
    fornecedor: entrada.prestadorRazaoSocial,
    cnpj: entrada.prestadorCnpj,
    numeroDoc: entrada.numero,
    valor: parseFloat(String(nfse.valorServico || nfse.valorServicos || 0).replace(",", ".")) || 0,
    competencia: entrada.competencia,
    vencimento: entrada.dataEmissao,
    historico: historico,
    categoriaId: "", categoriaLabel: "",
    situacao: "rascunho", origem: "fiscal-defender",
    chaveAcesso: entrada.chaveAcesso, criadoEm: Date.now(),
  });
  return true;
}

// ── CT-e ───────────────────────────────────────────────────────────────────
async function processarCte(cte) {
  const chave = limparChave(cte.chaveAcesso || cte.numero);
  const mp = mesPath(cte.dataEmissao);
  if (await jaExiste("cte_tomados/" + mp + "/" + chave)) return false;
  const entrada = {
    chaveAcesso: cte.chaveAcesso || "",
    numero: cte.numero || "",
    dataEmissao: (cte.dataEmissao || "").slice(0, 10),
    emitenteCnpj: (cte.emitenteCnpj || cte.remetenteCnpj || "").split(".").join("").split("/").join("").split("-").join(""),
    emitenteRazaoSocial: cte.emitenteRazaoSocial || cte.remetenteRazaoSocial || "",
    destinatarioCnpj: (cte.destinatarioCnpj || "").split(".").join("").split("/").join("").split("-").join(""),
    destinatarioRazaoSocial: cte.destinatarioRazaoSocial || "",
    valorTotal: Number(cte.valorTotal || cte.valor || 0),
    cfop: cte.cfop || "",
    criadoEm: Date.now(),
  };
  await salvarFirebase("cte_tomados/" + mp + "/" + chave, entrada);
  return true;
}

// ── NF-e ───────────────────────────────────────────────────────────────────
async function processarNfe(nfe) {
  const chave = limparChave(nfe.chaveAcesso || nfe.numero);
  const mp = mesPath(nfe.dataEmissao);
  if (await jaExiste("nfe_tomadas/" + mp + "/" + chave)) return false;
  const entrada = {
    chaveAcesso: nfe.chaveAcesso || "",
    numero: nfe.numero || "",
    dataEmissao: (nfe.dataEmissao || "").slice(0, 10),
    emitenteCnpj: (nfe.emitenteCnpj || "").split(".").join("").split("/").join("").split("-").join(""),
    emitenteRazaoSocial: nfe.emitenteRazaoSocial || "",
    destinatarioCnpj: (nfe.destinatarioCnpj || "").split(".").join("").split("/").join("").split("-").join(""),
    destinatarioRazaoSocial: nfe.destinatarioRazaoSocial || "",
    valorTotal: Number(nfe.valorTotal || nfe.valor || 0),
    naturezaOperacao: nfe.naturezaOperacao || "",
    criadoEm: Date.now(),
  };
  await salvarFirebase("nfe_tomadas/" + mp + "/" + chave, entrada);
  return true;
}

// ── Busca paginada genérica ─────────────────────────────────────────────────
async function buscarTipo(tipo, processarFn, meses) {
  let totalNovas = 0;
  for (const mes of meses) {
    let pagina = 1;
    let novas = 0;
    while (true) {
      const url = FD_BASE + "/" + tipo + "?page=" + pagina + "&limit=100&startDate=" + mes + "-01&endDate=" + mes + "-31";
      const r = await fetch(url, {headers: {Authorization: "Bearer " + FD_TOKEN}});
      if (!r.ok) { console.error("  Erro " + r.status + " em " + tipo + "/" + mes); break; }
      const data = await r.json();
      const itens = (data && data.data) ? data.data : [];
      if (!itens.length) break;
      for (const item of itens) {
        const ok = await processarFn(item);
        if (ok) novas++;
      }
      if (itens.length < 100) break;
      pagina++;
    }
    if (novas > 0) console.log("  " + tipo + " " + mes + ": " + novas + " novas");
    totalNovas += novas;
  }
  return totalNovas;
}

async function sincronizar() {
  const agora = new Date();
  const meses = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
    meses.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
  }
  console.log("[" + new Date().toISOString() + "] Sincronizando: " + meses.join(", "));

  const nfse = await buscarTipo("nfse", processarNfse, meses);
  const cte = await buscarTipo("cte", processarCte, meses);
  const nfe = await buscarTipo("nfe", processarNfe, meses);

  console.log("[" + new Date().toISOString() + "] Concluido — NFS-e:" + nfse + " CT-e:" + cte + " NF-e:" + nfe);
}

sincronizar().catch(console.error);
