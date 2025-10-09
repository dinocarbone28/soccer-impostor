// client.js — Soccer Impostor (v1.4.0) — adds SKIP vote, vote-screen hints, robust replay

const socket = io();
const $ = id => document.getElementById(id);
// Global lobby
const lobbyListEl = document.getElementById("lobbyList");
const lobbyRefreshBtn = document.getElementById("lobbyRefreshBtn");

// Vote timer + chat
const voteCountdownEl = document.getElementById("voteCountdown");
const chatLogEl = document.getElementById("chatLog");
const chatInputEl = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

// Local state
let voteTimerInt = null;
let serverOffsetMs = 0; // serverNow - clientNow (computed on vote:start)
function renderLobbyList(items) {
  if (!lobbyListEl) return;
  lobbyListEl.innerHTML = "";
  if (!items || !items.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No rooms yet. Host a room or click Refresh.";
    lobbyListEl.appendChild(li);
    return;
  }
  items.forEach(it => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="row space-between">
        <div>
          <strong>${it.code}</strong>
          <span class="muted small">• Host: ${it.hostName || "?"}</span>
          <span class="muted small">• Players: ${it.playerCount}/${it.maxPlayers || 10}</span>
          <span class="muted small">• ${it.status}</span>
        </div>
        <div><button class="btn small joinFromListBtn" data-code="${it.code}">Join</button></div>
      </div>
    `;
    lobbyListEl.appendChild(li);
  });

  lobbyListEl.querySelectorAll(".joinFromListBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-code");
      const name = document.getElementById("joinName")?.value?.trim() || "Player";
      socket.emit("player:join", { code, name }, (res) => {
        if (!res?.ok) return alert(res?.error || "Could not join");
        // switch to lobby view (you already have code to do this on 'lobby:update')
      });
    });
  });
}
if (lobbyRefreshBtn) {
  lobbyRefreshBtn.addEventListener("click", () => {
    socket.emit("lobby:list", (items) => renderLobbyList(items));
  });
}

// On entering START view, load once and start watch:
socket.emit("lobby:list", (items) => renderLobbyList(items));
socket.emit("lobby:watch");
socket.on("lobby:changed", (items) => renderLobbyList(items));
function startVoteCountdown(endsAtMs) {
  clearInterval(voteTimerInt);
  voteTimerInt = setInterval(() => {
    const now = Date.now() + serverOffsetMs;
    let left = Math.max(0, Math.floor((endsAtMs - now) / 1000));
    if (voteCountdownEl) voteCountdownEl.textContent = `${left}s`;
    if (left <= 0) clearInterval(voteTimerInt);
  }, 250);
}
// Server announces vote window
socket.on("vote:start", ({ endsAt, serverNow, seconds }) => {
  // compute offset once per announcement
  serverOffsetMs = (serverNow || Date.now()) - Date.now();
  startVoteCountdown(endsAt);
});
socket.on("phase", (snap) => {
  // ... your existing phase handling ...
  if (snap.phase !== "VOTE") {
    clearInterval(voteTimerInt);
    if (voteCountdownEl) voteCountdownEl.textContent = "—";
  }
});
function appendChatLine(name, text) {
  if (!chatLogEl) return;
  const line = document.createElement("div");
  line.className = "line";
  line.innerHTML = `<span class="name">${name}:</span> <span>${text}</span>`;
  chatLogEl.appendChild(line);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

if (chatSendBtn && chatInputEl) {
  chatSendBtn.addEventListener("click", () => {
    const text = chatInputEl.value.trim();
    if (!text) return;
    const code = window.currentRoomCode || document.getElementById("roomCode")?.textContent?.trim();
    socket.emit("chat:send", { code, text }, (res) => {
      if (!res?.ok && res?.error) alert(res.error);
    });
    chatInputEl.value = "";
  });
  chatInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") chatSendBtn.click();
  });
}

// Receive full history and new messages
socket.on("chat:load", (msgs) => {
  if (!chatLogEl) return;
  chatLogEl.innerHTML = "";
  (msgs || []).forEach(m => appendChatLine(m.name, m.text));
});
socket.on("chat:new", (m) => appendChatLine(m.name, m.text));
let myId = null;
let roomCode = null;
let mySecret = null;
let currentTurnId = null;
let currentTurnName = "—";
let hintTimerHandle = null;
let latestSnap = null;

// screen manager with smooth transitions
const screens = { start:$("start"), lobby:$("lobby"), hint:$("hint"), vote:$("vote"), over:$("over") };
function show(name){
  for(const k of Object.keys(screens)) screens[k].classList.remove("active");
  screens[name].classList.add("active");
}

// --- Start screen handlers ---
$("createBtn").onclick = () => {
  const name = $("hostName").value.trim();
  const impostors = Number($("hostImpostors").value || 1);
  const hintSeconds = Number($("hostHintSec").value || 30);
  if(!name) return alert("Enter your name");
  socket.emit("host:create", { name, impostors, hintSeconds }, (res)=>{
    if(!res?.ok) return alert(res?.error||"Could not create");
    roomCode = res.code;
    $("roomCode").textContent = `Room: ${roomCode}`;
    show("lobby");
  });
};

$("joinBtn").onclick = () => {
  const name = $("joinName").value.trim();
  const code = $("joinCode").value.trim().toUpperCase();
  if(!name || code.length!==5) return alert("Enter your name and the 5-letter code");
  socket.emit("player:join", { name, code }, (res)=>{
    if(!res?.ok) return alert(res?.error||"Could not join");
    roomCode = code;
    $("roomCode").textContent = `Room: ${roomCode}`;
    show("lobby");
  });
};

// --- Socket lifecycle ---
socket.on("connect", ()=>{ myId = socket.id; });

socket.on("lobby:update", (snap)=>{
  latestSnap = snap;
  $("roomCode").textContent = snap.code ? `Room: ${snap.code}` : "";
  $("playerList").innerHTML = snap.players.map(p =>
    `<li>${escapeHtml(p.name)} ${p.alive?'<span class="muted">(alive)</span>':'<span class="muted">(out)</span>'}${p.id===snap.hostId?' <strong>(host)</strong>':''}</li>`
  ).join("");
  $("hostControls").classList.toggle("hidden", !(snap.hostId && snap.hostId===myId));
});

socket.on("phase", (snap)=>{
  latestSnap = snap;
  mySecret = null; // will be re-sent privately to innocents via 'secret' event

  if(snap.phase==="LOBBY"){ show("lobby"); return; }

  if(snap.phase==="HINT"){
    const me = snap.players.find(p=>p.id===myId);
    $("roleBanner").textContent = me?.role==="impostor" ? "You are IMPOSTOR. Try to blend in." : "You are INNOCENT. Watch your wording.";
    $("secretBox").classList.add("hidden");
    $("secretName").textContent = "";
    $("hintList").innerHTML = snap.hints.map(h=>`<li><strong>${escapeHtml(h.name)}:</strong> ${escapeHtml(h.text)}</li>`).join("");
    $("hintInputRow").style.display = (currentTurnId===myId) ? "flex" : "none";
    show("hint");
    return;
  }

  if(snap.phase==="VOTE"){
    const alive = snap.players.filter(p=>p.alive);
    // render hints for quick reference
    $("voteHints").innerHTML = snap.hints.map(h=>`<li><strong>${escapeHtml(h.name)}:</strong> ${escapeHtml(h.text)}</li>`).join("");

    $("voteList").innerHTML = alive.map(p => `
      <label class="voteCard">
        <span>${escapeHtml(p.name)}</span>
        <input type="radio" name="voteTarget" value="${p.id}">
      </label>
    `).join("");

    $("voteStatus").textContent = "Cast your vote. Majority required; no majority or Skip majority = next hint round.";
    $("submitVoteBtn").disabled=false;
    // keep the separate SKIP radio that exists in HTML
    show("vote"); return;
  }

  if(snap.phase==="GAME_OVER"){
    const impostors = snap.players.filter(p=>p.role==="impostor").map(p=>p.name).join(", ");
    $("overTitle").textContent = snap.winners==="INNOCENTS" ? "Game Over — INNOCENTS WIN" : "Game Over — IMPOSTORS WIN";
    $("overDetails").innerHTML = `Secret player: <strong>${escapeHtml(snap.secretPlayer||"-")}</strong><br>Impostor(s): <strong>${escapeHtml(impostors)}</strong>`;
    show("over"); return;
  }
});

// Secret comes privately only to innocents
socket.on("secret", ({ secretPlayer })=>{
  mySecret = secretPlayer || null;
  if(latestSnap?.phase === "HINT"){
    const me = latestSnap.players.find(p=>p.id===myId);
    if(me?.role === "innocent" && mySecret){
      $("secretBox").classList.remove("hidden");
      $("secretName").textContent = mySecret;
    }
  }
});

// Turn info (includes player name)
socket.on("turn", ({ turnId, turnName, seconds })=>{
  currentTurnId = turnId;
  currentTurnName = turnName || "—";
  $("turnName").textContent = currentTurnName;
  let left = seconds || 30;
  $("turnTimer").textContent = `${left}s`;
  $("hintInputRow").style.display = (turnId===myId) ? "flex" : "none";

  if(hintTimerHandle) clearInterval(hintTimerHandle);
  hintTimerHandle = setInterval(()=>{
    left -= 1;
    $("turnTimer").textContent = `${Math.max(0,left)}s`;
    if(left <= 0){ clearInterval(hintTimerHandle); }
  }, 1000);
});

$("submitHintBtn").onclick = ()=>{
  const txt = $("hintInput").value.trim();
  $("hintInput").value = "";
  socket.emit("hint:submit", { code: roomCode, text: txt }, (res)=>{
    if(!res?.ok) alert(res?.error||"Could not submit");
  });
};

socket.on("hint:update", ({ hints })=>{
  $("hintList").innerHTML = hints.map(h=>`<li><strong>${escapeHtml(h.name)}:</strong> ${escapeHtml(h.text)}</li>`).join("");
});

$("submitVoteBtn").onclick = ()=>{
  const picked = document.querySelector('input[name="voteTarget"]:checked');
  if(!picked) return alert("Pick someone or choose Skip");
  socket.emit("vote:cast", { code: roomCode, targetId: picked.value }, (res)=>{
    if(!res?.ok) alert(res?.error||"Vote failed");
    else {
      $("voteStatus").textContent = "Your vote is cast.";
      $("submitVoteBtn").disabled = true;
      document.querySelectorAll('input[name="voteTarget"]').forEach(r=>r.disabled=true);
    }
  });
};

socket.on("vote:update", ({ votes })=>{
  $("voteStatus").textContent = `Votes cast: ${votes}`;
});

// host buttons (host can act even if eliminated)
$("startGameBtn").onclick  = ()=> socket.emit("host:start",        { code: roomCode }, r => { if(!r?.ok) alert(r?.error||"Cannot start"); });
$("forceNextBtn").onclick  = ()=> socket.emit("host:forceNextTurn",{ code: roomCode });
$("forceRestartBtn").onclick = ()=> socket.emit("host:forceRestart",{ code: roomCode }); // randomize roles & secret
$("playAgainBtn").onclick  = ()=> socket.emit("host:forceRestart",{ code: roomCode });
// MAIN MENU BUTTON — return to home screen
document.getElementById("mainMenuBtn")?.addEventListener("click", () => {
  try {
    socket.disconnect(); // end the current session
  } catch (e) {}

  // force reload from scratch to show the main screen
  window.location.replace(window.location.origin);
});
// helpers
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g,m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m])); }
