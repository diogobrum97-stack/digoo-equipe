// Claude Chat Flutuante — carregado após o painel principal
(function() {
  'use strict';

  let open = false;
  let history = [];
  let analysed = false;

  function getDashContext() {
    try {
      const lines = [];
      console.log("[Claude Chat] _dashData:", !!window._dashData, "_dashTarefas:", !!window._dashTarefas, "_dashEstoque:", !!window._dashEstoque);
      // Acessar variáveis globais do módulo via window se disponíveis
      if(window._dashData && !window._dashData.erro) {
        const d = window._dashData;
        const fmt = v => `R$ ${Number(v||0).toFixed(2)}`;
        lines.push(`VENDAS ML FILIAL SP:`);
        lines.push(`- Hoje: ${fmt(d.fatHoje)}`);
        lines.push(`- Projeção dia: ${fmt(d.projecaoDia)} (${d.percDia}% do dia)`);
        lines.push(`- Mês atual: ${fmt(d.fatMes)} (${d.pedidosMes} pedidos)`);
        if(d.top5hoje?.length) lines.push(`- Top hoje: ${d.top5hoje.map((p,i)=>`${i+1}.${p.sku}(${p.qty}un,R$${Number(p.revenue||0).toFixed(0)})`).join(', ')}`);
        if(d.top10mes?.length) lines.push(`- Top mês: ${d.top10mes.map((p,i)=>`${i+1}.${p.sku}(${p.qty}un,R$${Number(p.revenue||0).toFixed(0)})`).join(', ')}`);
      }
      if(window._dashTarefas) {
        const t = window._dashTarefas;
        lines.push(`\nTAREFAS: ${t.urgentes} urgentes, ${t.importantes} importantes, ${t.normais} normais`);
        if(t.urgentesTexto?.length) lines.push(`- Urgentes: ${t.urgentesTexto.join('; ')}`);
      }
      if(window._dashEstoque) {
        const e = window._dashEstoque;
        lines.push(`\nESTOQUE FULL: R$ ${e.valor}, ${e.unidades} unidades`);
        if(e.criticos?.length) lines.push(`- Críticos: ${e.criticos.join(', ')}`);
      }
      if(window._dashFiscal?.length) {
        lines.push(`\nFISCAL PRÓXIMOS DIAS: ${window._dashFiscal.join(', ')}`);
      }
      return lines.join('\n') || 'Dados ainda carregando...';
    } catch(e) {
      return 'Dados do painel disponíveis.';
    }
  }

  async function sendToClaud(userMsg) {
    const ctx = getDashContext();
    const system = `Você é assistente da Digoo Brasil, empresa de importação e distribuição de periféricos gamer no ML. Dados do painel:\n${ctx}\n\nResponda em português, direto e objetivo, máximo 3-4 linhas. Use **negrito** para pontos críticos.`;

    history.push({ role: 'user', content: userMsg });

    const res = await fetch('https://digoo-backend.vercel.app/api/claude-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        member: 'Diogo',
        message: userMsg,
        history: history.slice(0, -1),
        context: ctx,
      })
    });

    const data = await res.json();
    const reply = data.reply || 'Erro ao obter resposta.';
    history.push({ role: 'assistant', content: reply });
    return reply;
  }

  function addStyle() {
    if(document.getElementById('cc-style')) return;
    const s = document.createElement('style');
    s.id = 'cc-style';
    s.textContent = `
      #cc-fab { position:fixed;bottom:24px;right:24px;width:46px;height:46px;border-radius:50%;background:#111;border:0.5px solid #2a2a2a;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:9990;box-shadow:0 4px 20px rgba(0,0,0,0.5);transition:border-color .2s; }
      #cc-fab:hover { border-color:#555; }
      #cc-panel { position:fixed;bottom:80px;right:24px;width:320px;max-height:460px;background:#0f0f0f;border:0.5px solid #2a2a2a;border-radius:16px;z-index:9989;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.7);font-family:'Inter',sans-serif; }
      #cc-msgs { flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px; }
      .cc-msg { display:flex;gap:8px;align-items:flex-start; }
      .cc-msg.user { flex-direction:row-reverse; }
      .cc-av { width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex-shrink:0; }
      .cc-av.c { background:linear-gradient(135deg,#1a6be0,#4a9eff);color:#fff; }
      .cc-av.u { background:#222;color:#888; }
      .cc-bubble { max-width:220px;padding:9px 11px;font-size:11px;line-height:1.6; }
      .cc-msg.c .cc-bubble { background:#161616;border:0.5px solid #222;color:#ddd;border-radius:4px 10px 10px 10px; }
      .cc-msg.user .cc-bubble { background:#1a6be022;border:0.5px solid #1a6be044;color:#ccc;border-radius:10px 4px 10px 10px; }
      @keyframes ccDot{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-4px);background:#888}}
      .cc-dot { width:5px;height:5px;border-radius:50%;background:#555;display:inline-block;animation:ccDot 1.2s infinite; }
    `;
    document.head.appendChild(s);
  }

  function addMsg(text, role) {
    const msgs = document.getElementById('cc-msgs');
    if(!msgs) return;
    const isUser = role === 'user';
    const div = document.createElement('div');
    div.className = `cc-msg ${isUser ? 'user' : 'c'}`;
    const av = document.createElement('div');
    av.className = `cc-av ${isUser ? 'u' : 'c'}`;
    av.textContent = isUser ? 'DG' : 'C';
    const bubble = document.createElement('div');
    bubble.className = 'cc-bubble';
    bubble.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    div.appendChild(av);
    div.appendChild(bubble);
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function addTyping() {
    const msgs = document.getElementById('cc-msgs');
    if(!msgs) return;
    const div = document.createElement('div');
    div.className = 'cc-msg c';
    div.id = 'cc-typing';
    div.innerHTML = `<div class="cc-av c">C</div><div class="cc-bubble" style="display:flex;gap:4px;align-items:center;"><span class="cc-dot"></span><span class="cc-dot" style="animation-delay:.2s"></span><span class="cc-dot" style="animation-delay:.4s"></span></div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function removeTyping() {
    document.getElementById('cc-typing')?.remove();
  }

  async function handleSend() {
    const input = document.getElementById('cc-input');
    const val = input?.value?.trim();
    if(!val) return;
    input.value = '';
    addMsg(val, 'user');
    addTyping();
    try {
      const reply = await sendToClaud(val);
      removeTyping();
      addMsg(reply, 'claude');
    } catch(e) {
      removeTyping();
      addMsg('Erro ao conectar.', 'claude');
    }
  }

  function createPanel() {
    if(document.getElementById('cc-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'cc-panel';
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:0.5px solid #1a1a1a;flex-shrink:0;">
        <div class="cc-av c" style="width:26px;height:26px;font-size:12px;">C</div>
        <div style="flex:1;"><div style="font-size:11px;font-weight:600;color:#ddd;">Claude · Análise</div><div style="font-size:9px;color:#555;">dados em tempo real</div></div>
        <button id="cc-close" style="background:none;border:none;color:#444;cursor:pointer;font-size:18px;line-height:1;">×</button>
      </div>
      <div id="cc-msgs"></div>
      <div style="display:flex;gap:8px;padding:11px 13px;border-top:0.5px solid #1a1a1a;flex-shrink:0;">
        <input id="cc-input" type="text" placeholder="Pergunte sobre seus dados..." style="flex:1;background:#161616;border:0.5px solid #222;border-radius:8px;padding:7px 11px;font-size:11px;color:#ddd;font-family:inherit;outline:none;">
        <button id="cc-send" style="background:#1a6be0;border:none;border-radius:8px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;font-size:13px;flex-shrink:0;">↑</button>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('cc-close').addEventListener('click', () => {
      open = false;
      panel.remove();
    });
    document.getElementById('cc-send').addEventListener('click', handleSend);
    document.getElementById('cc-input').addEventListener('keydown', e => { if(e.key === 'Enter') handleSend(); });

    // Análise automática — aguardar dados se necessário
    if(!analysed) {
      analysed = true;
      addTyping();
      const tryAnalyse = (attempts) => {
        const hasData = window._dashData && !window._dashData.erro && window._dashTarefas;
        if(hasData || attempts <= 0) {
          sendToClaud('Analise os dados do dashboard e me dê os 3 pontos mais importantes que preciso saber agora. Seja direto e objetivo.').then(reply => {
            removeTyping();
            addMsg(reply, 'claude');
          }).catch(() => { removeTyping(); addMsg('Não consegui conectar. Tente perguntar algo.', 'claude'); });
        } else {
          setTimeout(() => tryAnalyse(attempts - 1), 1500);
        }
      };
      tryAnalyse(10); // Tenta por até 15 segundos
    }
  }

  function createFab() {
    if(document.getElementById('cc-fab')) return;
    const fab = document.createElement('div');
    fab.id = 'cc-fab';
    fab.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#aaa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    fab.addEventListener('click', () => {
      open = !open;
      if(open) createPanel();
      else document.getElementById('cc-panel')?.remove();
    });
    document.body.appendChild(fab);
  }

  function cleanup() {
    document.getElementById('cc-fab')?.remove();
    document.getElementById('cc-panel')?.remove();
    open = false;
  }

  // Observer para detectar mudança de aba
  let lastTab = null;
  function checkTab() {
    const tab = window._diogotab;
    if(tab === lastTab) return;
    lastTab = tab;
    if(tab === 'dashboard') {
      addStyle();
      createFab();
    } else {
      cleanup();
    }
  }

  setInterval(checkTab, 500);
})();
