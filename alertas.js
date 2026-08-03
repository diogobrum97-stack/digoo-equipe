// ─── SISTEMA DE ALERTAS v2 ──────────────────────────────────────────────────────

let _alertas = {}; // { tab: [{id, msg, sub, severidade}] }
let _alertasVistos = JSON.parse(localStorage.getItem("digoo_alertas_vistos") || "{}");
let _snapEstoque = JSON.parse(localStorage.getItem("digoo_snap_estoque") || "{}");

function zonaEstoque(dias) {
  if(dias <= 15) return "verde";
  if(dias <= 90) return "amarelo";
  return "vermelho";
}

function registrarAlerta(tab, id, msg, sub, severidade = "normal") {
  if(!_alertas[tab]) _alertas[tab] = [];
  // Evitar duplicatas
  if(_alertas[tab].find(a => a.id === id)) return;
  _alertas[tab].push({ id, msg, sub, severidade });
}

function limparAlerta(tab, id) {
  if(!_alertas[tab]) return;
  _alertas[tab] = _alertas[tab].filter(a => a.id !== id);
}

function marcarVisto(tab) {
  _alertasVistos[tab] = Date.now();
  localStorage.setItem("digoo_alertas_vistos", JSON.stringify(_alertasVistos));
}

function temAlertasNovos(tab) {
  if(!_alertas[tab] || _alertas[tab].length === 0) return false;
  const visto = _alertasVistos[tab] || 0;
  return _alertas[tab].some(a => !a.visto);
}

function contarAlertas(tab) {
  return (_alertas[tab] || []).filter(a => !a.visto).length;
}

// Detectar alertas de estoque/saúde
function detectarAlertasEstoque(rows) {
  if(!rows || rows.length === 0) return;
  const snapAnterior = {..._snapEstoque};
  const snapNovo = {};

  rows.forEach(r => {
    if(!r.sku) return;
    const dias = r.aptas > 0 && r.vendas30 > 0 ? Math.round(r.aptas / (r.vendas30 / 30)) : 999;
    const zona = zonaEstoque(dias);
    snapNovo[r.sku] = { dias, zona, aptas: r.aptas };

    const anterior = snapAnterior[r.sku];
    if(anterior) {
      // Mudança de zona
      if(anterior.zona !== zona) {
        const emoji = zona === "vermelho" ? "🔴" : zona === "amarelo" ? "🟡" : "🟢";
        registrarAlerta(
          "estoque",
          `zona_${r.sku}`,
          `${emoji} ${r.sku} — zona mudou`,
          `${anterior.zona} → ${zona} (${dias}d de estoque)`,
          zona === "vermelho" ? "urgente" : "normal"
        );
      }
      // Estoque crítico (<15d) novo
      if(anterior.dias > 15 && dias <= 15 && r.aptas > 0) {
        registrarAlerta(
          "estoque",
          `critico_${r.sku}`,
          `⚠ ${r.sku} — estoque crítico`,
          `${dias}d restantes, ${r.aptas} unidades`,
          "urgente"
        );
      }
      // Zerou
      if(anterior.aptas > 0 && r.aptas === 0) {
        registrarAlerta(
          "estoque",
          `zerou_${r.sku}`,
          `🚨 ${r.sku} — estoque zerado`,
          `Era ${anterior.aptas} unidades`,
          "urgente"
        );
      }
    }
  });

  _snapEstoque = snapNovo;
  localStorage.setItem("digoo_snap_estoque", JSON.stringify(snapNovo));
}

// Detectar alertas de tarefas
function detectarAlertasTarefas(tasks) {
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  Object.entries(tasks || {}).forEach(([id, t]) => {
    if(!t || t.done || t.member !== "Diogo" || t.delegatedBy) return;
    if((t.prioridade === "urgente" || t.prioridade === "superurgente") && t.prazo) {
      const prazo = new Date(t.prazo); prazo.setHours(0,0,0,0);
      if(prazo <= hoje) {
        registrarAlerta("tarefas", `tarefa_${id}`, `⚠ Tarefa precisa de atenção`, t.text, "urgente");
      }
    }
  });
}

// Detectar alertas de equipe
function detectarAlertasEquipe(tasks, messages) {
  // Novas conversas
  Object.entries(messages || {}).forEach(([id, m]) => {
    if(m && m.recipient === "Diogo" && !_alertasVistos[`msg_${id}`]) {
      registrarAlerta("concluidas", `msg_${id}`, `💬 ${m.from} enviou mensagem`, m.text?.slice(0,50), "normal");
    }
  });
  // Tarefas concluídas por Bruno ou Larissa
  Object.entries(tasks || {}).forEach(([id, t]) => {
    if(t && t.done && t.delegatedBy === "Diogo" && !_alertasVistos[`done_${id}`]) {
      registrarAlerta("concluidas", `done_${id}`, `✓ ${t.member} concluiu tarefa`, t.text?.slice(0,50), "normal");
    }
  });
}

// Detectar alerta de conferência (segunda-feira)
function detectarAlertaConferencia() {
  const hoje = new Date();
  const diaSemana = hoje.getDay(); // 1 = segunda
  const chave = `conf_${hoje.getFullYear()}_${hoje.getMonth()}_semana${Math.ceil(hoje.getDate()/7)}`;

  if(diaSemana === 1 && !_alertasVistos[chave]) {
    const primeiraSemana = hoje.getDate() <= 7;
    const msg = primeiraSemana
      ? `📋 Conferir documentos de ${new Date(hoje.getFullYear(), hoje.getMonth()-1, 1).toLocaleString("pt-BR",{month:"long"})}`
      : `📋 Anexar documentos da semana passada`;
    registrarAlerta("conferencia", chave, msg, "Aba Conferência → Notas de Serviço e Impostos", "normal");
  }
}

// Rodar todos os detectores
function atualizarAlertas() {
  _alertas = {};
  if(state?.tasks) {
    detectarAlertasTarefas(state.tasks);
    detectarAlertasEquipe(state.tasks, state.messages);
  }
  detectarAlertaConferencia();
  if(estoqueExcelData?.rows) detectarAlertasEstoque(estoqueExcelData.rows);
}


function renderAlertasTab(panel, tab) {
  const alertas = (_alertas[tab] || []).filter(a => !a.visto);
  if(alertas.length === 0) return;

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:14px;";

  alertas.forEach(a => {
    const card = document.createElement("div");
    const cor = a.severidade === "urgente" ? "#d4000c" : "#e8aa00";
    card.style.cssText = `background:${cor}10;border:0.5px solid ${cor}33;border-left:3px solid ${cor};border-radius:8px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;`;
    const info = document.createElement("div");
    const title = document.createElement("div");
    title.style.cssText = `font-size:11px;font-weight:600;color:${cor};`;
    title.textContent = a.msg;
    const sub = document.createElement("div");
    sub.style.cssText = "font-size:10px;color:var(--text3);margin-top:2px;";
    sub.textContent = a.sub || "";
    info.appendChild(title);
    if(a.sub) info.appendChild(sub);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px;padding:2px 6px;flex-shrink:0;";
    closeBtn.addEventListener("click", () => { a.visto = true; wrap.removeChild(card); });
    card.appendChild(info);
    card.appendChild(closeBtn);
    wrap.appendChild(card);
  });

  panel.appendChild(wrap);
}

// ─── FIM SISTEMA DE ALERTAS ──────────────────────────────────────────────────

fu