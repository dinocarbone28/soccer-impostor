// client.js — Soccer Impostor (v1.6.2)
// Adds: Start Game host gating, auto redirect after create, global browser polish,
// ready toggle, host settings, matchmaking name support.

const socket = io();
const $ = id => document.getElementById(id);

// ----- DOM refs -----
const lobbyListEl = $("lobbyList");
const lobbyRefreshBtn = $("lobbyRefreshBtn");
const regionFilterEl = $("lobbyRegionFilter");
const onlyOpenFilterEl = $("lobbyOnlyOpen");

const voteCountdownEl = $("voteCountdown");
const chatLogEl = $("chatLog");
const chatInputEl = $("chatInput");
const chatSendBtn = $("chatSendBtn");

// Start screen
const hostNameEl = $("hostName");
const hostImpostorsEl = $("hostImpostors");
const hostHintSecEl = $("hostHintSec");
const hostPublicEl = $("hostPublic");
const hostRegionEl = $("hostRegion");
const hostMaxPlayersEl = $("hostMaxPlayers");

// Lobby
const readyToggleEl = $("readyToggle");
const updateSettingsBtn = $("updateSettingsBtn");
const startBtn = $("startGameBtn");
const startReqMsg = $("startReqMsg");

// Game/phase globals
let voteTimerInt = null;
let serverOffsetMs = 0;
let myId = null;
let roomCode = null;
let mySecret = null;
let currentTurnId = null;
let latestSnap = null;

// Existing screen show()
const screens = { start:$("start"), lobby:$("lobby"), hint:$("hint"), vote:$("vote"), over:$("over") };
function show(name){ for(const k of Object.keys(screens)) screens[k].classList.remove("active"); screens[name].classList.add("active"); }

// ----- Lobby browser rendering -----
function renderLobbyList(items) {
  if (!lobbyListEl) return;
  lobbyListEl.innerHTML = "";
  if (!items || !items.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No public rooms. Click Create or Refresh.";
    lobbyListEl.appendChild(li);
    return;
  }
  items.forEach(it => {
    const pct = Math.min(100, Math.round((it.playerCount / it.maxPlayers) * 100));
    const li = document.createElement("li");
    li.className = "voteCard";
    li.innerHTML = `
      <div>
        <div><strong>#${it.code}</strong> <span class="muted small">• ${it.playerCount}/${it.maxPlayers} • ${it.status} • ${it.region}</span></div>
        <div class="small muted">${new Date(it.updatedAt).toLocaleTimeString()}</div>
      </div>
      <div class="row" style="gap:.5rem">
        <div class="small muted" style="min-width:120px">[${"█".repeat(Math.round(pct/10))}${"░".repeat(10-Math.round(pct/10))}]</div>
        <button class="btn small joinFromListBtn" data-code="${it.code}" ${it.status!=="WAITING"?"disabled":""}>Join</button>
      </div>
    `;
    lobbyListEl.appendChild(li);
  });

  lobbyListEl.querySelectorAll(".joinFromListBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-code");
      const name = $("matchName")?.value?.trim() || $("joinName")?.value?.trim() || "Player";
      socket.emit("player:join", { code, name }, (res) => {
        if (!res?.ok) return alert(res?.error || "Could not join");
        roomCode = code;
        $("roomCode").textContent = `Room: ${roomCode}`;
        show("lobby");
      });
    });
  });
}

// ----- Create / Join -----
$("createBtn").onclick = () => {
  const name = hostNameEl.value.trim();
  const impostors = Number(hostImpostorsEl.value || 1);
  const hintSeconds = Number(hostHintSecEl.value || 30);
  const isPublic = !!hostPublicEl?.checked;
  const region = hostRegionEl?.value || "GLOBAL";
  const maxPlayers = Number(hostMaxPlayersEl?.value || 10);

  if (!name) return alert("Enter your name");
  socket.emit("host:create", { name, impostors, hintSeconds, isPublic, region, maxPlayers }, (res)=>{
    if(!res?.ok) return alert(res?.error||"Could not create");
    roomCode = res.code;
    $("roomCode").textContent = `Room: ${roomCode}`;
    // Auto-navigate to Lobby
    show("lobby");
  });
};

$("joinBtn").onclick = () => {
  const name = $("matchName")?.value?.trim() || $("joinName")?.value?.trim();
  const code = $("joinCode").value.trim().toUpperCase();
  if(!name || code.length!==5) return alert("Enter your name and the 5-letter code");
  socket.emit("player:join", { name, code }, (res)=>{
    if(!res?.ok) return alert(res?.error||"Could not join");
    roomCode = code;
    $("roomCode").textContent = `Room: ${roomCode}`;
    show("lobby");
  });
};

// ----- Global lobby feed -----
function requestLobbyList(){
  const filter = {
    region: regionFilterEl?.value || null,
    onlyOpen: !!onlyOpenFilterEl?.checked
  };
  socket.emit("lobby:list", filter, (items) => renderLobbyList(items));
}
if (lobbyRefreshBtn) lobbyRefreshBtn.addEventListener("click", requestLobbyList);
regionFilterEl?.addEventListener("change", () => socket.emit("lobby:watch", { region: regionFilterEl.value, onlyOpen: !!onlyOpenFilterEl?.checked }));
onlyOpenFilterEl?.addEventListener("change", () => socket.emit("lobby:watch", { region: regionFilterEl?.value, onlyOpen: !!onlyOpenFilterEl?.checked }));

socket.emit("lobby:list", {}, (items) => renderLobbyList(items));
socket.emit("lobby:watch", {});
socket.on("lobby:changed", (items) => renderLobbyList(items));

// ----- Vote timer -----
function startVoteCountdown(endsAtMs) {
  clearInterval(voteTimerInt);
  voteTimerInt = setInterval(() => {
    const now = Date.now() + serverOffsetMs;
    let left = Math.max(0, Math.floor((endsAtMs - now) / 1000));
    if (voteCountdownEl) voteCountdownEl.textContent = `${left}s`;
    if (left <= 0) clearInterval(voteTimerInt);
  }, 250);
}
socket.on("vote:start", ({ endsAt, serverNow }) => {
  serverOffsetMs = (serverNow || Date.now()) - Date.now();
  startVoteCountdown(endsAt);
});

// ----- Chat -----
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
    socket.emit("chat:send", { code: roomCode, text }, (res) => {
      if (!res?.ok && res?.error) alert(res.error);
    });
    chatInputEl.value = "";
  });
  chatInputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") chatSendBtn.click(); });
}
socket.on("chat:new", (m) => appendChatLine(m.name, m.text));

// ----- Phase / lobby snapshots -----
socket.on("connect", ()=>{ myId = socket.id; });

function updateHostStartGating(snap){
  if (!startBtn || !startReqMsg) return;
  const isHost = snap.hostId && snap.hostId === myId;
  const inLobby = snap.phase === "LOBBY";
  const players = snap.players || [];
  const playerCount = players.length;

  // 3+ players required
  const enoughPlayers = playerCount >= 3;

  // readiness rule: everyone except host ready OR >=70% ready including host
  const readyCount = players.filter(p => p.ready || p.id === snap.hostId).length;
  const seventy = Math.ceil(playerCount * 0.7);
  const readyOk = (readyCount >= playerCount) || (readyCount >= seventy);

  const canStart = isHost && inLobby && enoughPlayers && readyOk;

  startBtn.disabled = !canStart;
  startReqMsg.textContent = canStart
    ? "Ready to go!"
    : `Need ≥3 players and ≥70% ready. Current: ${playerCount} players, ${readyCount} ready`;
}

socket.on("lobby:update", (snap)=>{
  latestSnap = snap;
  $("roomCode").textContent = snap.code ? `Room: ${snap.code}` : "";

  $("playerList").innerHTML = snap.players.map(p =>
    `<li>${escapeHtml(p.name)} ${p.alive?'<span class="muted">(alive)</span>':'<span class="muted">(out)</span>'}${p.ready?' <span class="small" style="color:#1a9e55">[Ready]</span>':''}${p.id===snap.hostId?' <strong>(host)</strong>':''}</li>`
  ).join("");

  $("hostControls").classList.toggle("hidden", !(snap.hostId && snap.hostId===myId));

  if (readyToggleEl) readyToggleEl.closest(".row")?.classList.toggle("hidden", snap.phase !== "LOBBY");

  updateHostStartGating(snap);
});

socket.on("phase", (snap)=>{
  latestSnap = snap;
  if(snap.phase==="LOBBY"){ show("lobby"); updateHostStartGating(snap); return; }

  if(snap.phase==="HINT" || snap.phase==="IN_PROGRESS"){
    const me = snap.players.find(p=>p.id===myId);
    $("roleBanner").textContent = me?.role==="impostor" ? "You are IMPOSTOR. Try to blend in." : "You are INNOCENT. Watch your wording.";
    $("secretBox").classList.add("hidden");
    $("secretName").textContent = "";
    $("hintList").innerHTML = (snap.hints||[]).map(h=>`<li><strong>${escapeHtml(h.name)}:</strong> ${escapeHtml(h.text)}</li>`).join("");
    $("hintInputRow").style.display = (currentTurnId===myId) ? "flex" : "none";
    show("hint");
    return;
  }

  if(snap.phase==="VOTE"){
    const alive = snap.players.filter(p=>p.alive);
    $("voteHints").innerHTML = (snap.hints||[]).map(h=>`<li><strong>${escapeHtml(h.name)}:</strong> ${escapeHtml(h.text)}</li>`).join("");
    $("voteList").innerHTML = alive.map(p => `
      <label class="voteCard">
        <span>${escapeHtml(p.name)}</span>
        <input type="radio" name="voteTarget" value="${p.id}">
      </label>
    `).join("");
    $("voteStatus").textContent = "Cast your vote. Majority required; Skip = next hint round.";
    $("submitVoteBtn").disabled=false;
    show("vote"); return;
  }

  if(snap.phase==="GAME_OVER"){
    const impostors = snap.players.filter(p=>p.role==="impostor").map(p=>p.name).join(", ");
    $("overTitle").textContent = snap.winners==="INNOCENTS" ? "Game Over — INNOCENTS WIN" : "Game Over — IMPOSTORS WIN";
    $("overDetails").innerHTML = `Secret player: <strong>${escapeHtml(snap.secretPlayer||"-")}</strong><br>Impostor(s): <strong>${escapeHtml(impostors)}</strong>`;
    show("over"); return;
  }
});

// Secret DM to innocents
socket.on("secret", ({ secretPlayer })=>{
  mySecret = secretPlayer || null;
  if(latestSnap && (latestSnap.phase === "HINT" || latestSnap.phase === "IN_PROGRESS")){
    const me = latestSnap.players.find(p=>p.id===myId);
    if(me?.role === "innocent" && mySecret){
      $("secretBox").classList.remove("hidden");
      $("secretName").textContent = mySecret;
    }
  }
});

socket.on("turn", ({ turnId, turnName, seconds })=>{
  currentTurnId = turnId;
  $("turnName").textContent = turnName || "—";
  let left = seconds || 30;
  $("turnTimer").textContent = `${left}s`;
  $("hintInputRow").style.display = (turnId===myId) ? "flex" : "none";
  let handle = window.__hintTimer;
  if (handle) clearInterval(handle);
  window.__hintTimer = setInterval(()=>{
    left -= 1;
    $("turnTimer").textContent = `${Math.max(0,left)}s`;
    if(left <= 0){ clearInterval(window.__hintTimer); }
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
  $("hintList").innerHTML = (hints||[]).map(h=>`<li><strong>${escapeHtml(h.name)}:</strong> ${escapeHtml(h.text)}</li>`).join("");
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

// Host buttons
startBtn?.addEventListener("click", () =>
  socket.emit("host:start", { code: roomCode }, r => { if(!r?.ok) alert(r?.error||"Cannot start"); })
);
$("forceNextBtn")?.addEventListener("click", ()=> socket.emit("host:forceNextTurn",{ code: roomCode }));
$("forceRestartBtn")?.addEventListener("click", ()=> socket.emit("host:forceRestart",{ code: roomCode }));
$("playAgainBtn")?.addEventListener("click", ()=> socket.emit("host:forceRestart",{ code: roomCode }));
$("closeLobbyBtn")?.addEventListener("click", ()=> socket.emit("host:close",{ code: roomCode }, r => { if(!r?.ok) alert(r?.error||""); else window.location.reload(); }));

// Player ready toggle (LOBBY)
readyToggleEl?.addEventListener("change", () => {
  socket.emit("player:ready", { code: roomCode, ready: !!readyToggleEl.checked });
});

// Host settings patch
updateSettingsBtn?.addEventListener("click", ()=>{
  const patch = {};
  if (hostImpostorsEl?.value) patch.impostors = Number(hostImpostorsEl.value);
  if (hostHintSecEl?.value)   patch.hintSeconds = Number(hostHintSecEl.value);
  if (hostMaxPlayersEl?.value)patch.maxPlayers = Number(hostMaxPlayersEl.value);
  if (hostRegionEl?.value)    patch.region = hostRegionEl.value;
  if (hostPublicEl)           patch.public = !!hostPublicEl.checked;
  socket.emit("host:updateSettings", { code: roomCode, patch }, (res)=>{ if(!res?.ok) alert(res?.error||""); });
});

// Rejoin helper
window.tryRejoin = function(name, code){
  if (!name || !code) return;
  socket.emit("player:rejoin", { name, code }, (res)=>{
    if (res?.ok) {
      roomCode = code;
      $("roomCode").textContent = `Room: ${roomCode}`;
      show("lobby");
    }
  });
};

// Main menu
document.getElementById("mainMenuBtn")?.addEventListener("click", () => {
  try { socket.disconnect(); } catch (e) {}
  window.location.replace(window.location.origin);
});

function escapeHtml(s){ return (s||"").replace(/[&<>"']/g,m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m])); }
