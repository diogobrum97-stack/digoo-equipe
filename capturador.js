const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const FD_TOKEN = "fd_3813f2de25cff4c516fb78d1ef99dcf9bf362287dbf9e88781458018655b50e2";
const FD_BASE = "https://fiscaldefender.com.br/api/v1";
const FIREBASE_URL = "https://digoo-equipe-default-rtdb.firebaseio.com";

async function processarNfse(nfse) {
  const chaveRaw = nfse.chaveAcesso || nfse.numero || ("fd_" + Date.now());
  const chave = chaveRaw.split(".").join("_").split("#").join("_").split("$").join("_").split("[").join("_").split("]").join("_").split("/").join("_");
  const competencia = (nfse.competencia || nfse.dataEmissao || "").slice(0, 7) || new Date().toISOString().slice(0, 7);
  const mesPath = competencia.slice(0,4) + "/" + competencia.slice(5,7);
  const existeR = await fetch(FIREBASE_URL + "/contas_pagar/" + mesPath + "/" + chave + ".json");
  const existe = await existeR.json();
  if (existe && existe.fornecedor) return false;
  const historico = (nfse.descricaoServico || nfse.discriminacao || "").split("|").join("").trim();
  const entrada = {
    fornecedor: nfse.prestadorRazaoSocial || "",
    cnpj: (nfse.prestadorCnpj || "").split(".").join("").split("/").join("").split("-").join(""),
    numeroDoc: nfse.numero || "",
    valor: Number(nfse.valorServicos || 0),
    competencia: competencia,
    vencimento: (nfse.dataEmissao || "").slice(0, 10),
    historico: historico,
    categoriaId: "",
    categoriaLabel: "",
    situacao: "rascunho",
    origem: "fiscal-defender",
    chaveAcesso: chaveRaw,
    criadoEm: Date.now(),
  };
  await fetch(FIREBASE_URL + "/contas_pagar/" + mesPath + "/" + chave + ".json", {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(entrada)
  });
  return true;
}

async function sincronizar() {
  const agora = new Date();
  const meses = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
    meses.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
  }
  console.log("[" + new Date().toISOString() + "] Sincronizando: " + meses.join(", "));
  for (const mes of meses) {
    let pagina = 1;
    let importadas = 0;
    while (true) {
      const url = FD_BASE + "/nfse?page=" + pagina + "&limit=100&situacao=NORMAL&startDate=" + mes + "-01&endDate=" + mes + "-31";
      const r = await fetch(url, {headers: {Authorization: "Bearer " + FD_TOKEN}});
      if (!r.ok) { console.error("Erro " + r.status + " em " + mes); break; }
      const data = await r.json();
      const notas = data && data.data ? data.data : [];
      if (!notas.length) break;
      for (const nfse of notas) {
        const ok = await processarNfse(nfse);
        if (ok) importadas++;
      }
      if (notas.length < 100) break;
      pagina++;
    }
    console.log("  " + mes + ": " + importadas + " novas");
  }
  console.log("[" + new Date().toISOString() + "] Concluido");
}

sincronizar().catch(console.error);
