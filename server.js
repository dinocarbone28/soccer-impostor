// server.js — Soccer Impostor (v1.6.2)
// Public lobby matchmaking + auto-cleanup + host start gating.

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 25000, pingTimeout: 60000 });

app.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// Regions / timing
const REGIONS = ["GLOBAL","NA","SA","EU","AF","AS","OC"];
const LOBBY_IDLE_MS = 10 * 60 * 1000;
const GAME_MAX_MS  = 2 * 60 * 60 * 1000;
const REJOIN_GRACE_MS = 25 * 1000;

// Sample player pool
const ALL_PLAYERS = ["Lionel Messi","Kylian Mbappe","Erling Haaland","Kevin De Bruyne","Virgil van Dijk","Alisson Becker","Jude Bellingham","Vinicius Junior","Harry Kane","Son Heung-min","Bukayo Saka","Lamine Yamal"];

// Model
const rooms = Object.create(null);
const lobbyIndex = Object.create(null);

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => Array.from({ length: 5 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
function shuffle(a) { a = [...a]; for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
const alivePlayers = r => Object.values(r.players).filter(p => p.alive);
const countImpostors = r => alivePlayers(r).filter(p => p.role === "impostor").length;
const countInnocents = r => alivePlayers(r).filter(p => p.role === "innocent").length;
const majorityNeeded = n => Math.floor(n/2)+1;
const now = () => Date.now();

function pickNewSecret(prev) {
  if (ALL_PLAYERS.length <= 1) return ALL_PLAYERS[0];
  let candidate = prev;
  while (candidate === prev) candidate = ALL_PLAYERS[Math.floor(Math.random() * ALL_PLAYERS.length)];
  return candidate;
}
function cleanMsg(s){ return String(s||"").replace(/<\/?[^>]+(>|$)/g,"").slice(0,200).trim(); }

function snapshot(code) {
  const r = rooms[code]; if (!r) return null;
  return {
    code: r.code, hostId: r.hostId, settings: r.settings, phase: r.phase,
    players: Object.values(r.players).map(p => ({ id:p.id, name:p.name, alive:p.alive, role:p.role, ready: !!p.ready })),
    order: r.order.map(id => ({ id, name: r.players[id]?.name || "?" })), orderStartIndex: r.orderStartIndex,
    currentTurnIdx: r.currentTurnIdx, hints: r.hints, votes: r.votes, winners: r.winners,
    secretPlayer: r.phase === "GAME_OVER" ? r.secretPlayer : null
  };
}
function updateLobbyIndexSnapshot(r){
  if (!lobbyIndex[r.code]) return;
  lobbyIndex[r.code].playerCount = Object.keys(r.players).length;
  lobbyIndex[r.code].maxPlayers  = r.settings.maxPlayers;
  lobbyIndex[r.code].status = r.phase === "LOBBY" ? "WAITING" :
                              r.phase === "STARTING" ? "STARTING" :
                              (r.phase === "HINT" || r.phase === "VOTE" || r.phase === "IN_PROGRESS") ? "IN_PROGRESS" :
                              "WAITING";
  lobbyIndex[r.code].updatedAt = now();
}
function publicLobbyList(filter = {}) {
  const { region = null, onlyOpen = false } = filter || {};
  const items = Object.values(lobbyIndex)
    .filter(x => x.public)
    .filter(x => !region || region === "GLOBAL" || x.region === region)
    .filter(x => !onlyOpen || (x.status === "WAITING" && x.playerCount < x.maxPlayers));
  return items.sort((a,b)=>{
    if (a.status !== b.status) return a.status === "WAITING" ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}
function closeLobby(code){
  const r = rooms[code]; if (!r) return;
  r.phase = "CLOSED";
  clearTimeout(r.turnTimer); clearTimeout(r.voteTimer);
  delete rooms[code];
  delete lobbyIndex[code];
  io.emit("lobby:changed", publicLobbyList());
}

// Roles / phases
function setRoles(r) {
  const ids = Object.keys(r.players);
  ids.forEach(id => { r.players[id].alive = true; r.players[id].role = "innocent"; });
  const shuffled = shuffle(ids);
  const maxImpostors = Math.max(1, Math.floor(ids.length / 3));
  const impostorCount = Math.min(r.settings.impostors || 1, maxImpostors);
  const impostors = new Set();
  while (impostors.size < impostorCount) {
    const randomId = shuffled[Math.floor(Math.random() * shuffled.length)];
    impostors.add(randomId);
  }
  ids.forEach(id => { r.players[id].role = impostors.has(id) ? "impostor" : "innocent"; });
}
function sendSecretToInnocents(code){
  const r = rooms[code]; if (!r) return;
  for (const p of Object.values(r.players)) if (p.role==="innocent" && p.alive) io.to(p.id).emit("secret", { secretPlayer: r.secretPlayer });
}

function startGame(code, keepRotation=false, randomize=true){
  const r = rooms[code]; if (!r) return;
  r.phase = "HINT";
  r.hints=[]; r.votes={}; r.winners=null; clearTimeout(r.voteTimer); r.voteTimer=null; r.voteEndsAt=null; r.chatLog=[]; r.startedAt=now();

  const ids = Object.keys(r.players);
  if (!keepRotation) { r.order = ids; r.orderStartIndex = 0; }
  else { r.order = r.order.filter(id => ids.includes(id)); r.orderStartIndex = 0; }

  Object.values(r.players).forEach(p => p.ready = false);

  setRoles(r);
  const prev = r.lastSecret || null;
  r.secretPlayer = randomize ? pickNewSecret(prev) : ALL_PLAYERS[Math.floor(Math.random()*ALL_PLAYERS.length)];
  r.lastSecret = r.secretPlayer;

  r.phase = "IN_PROGRESS";
  io.to(code).emit("phase", snapshot(code));
  updateLobbyIndexSnapshot(r);
  io.emit("lobby:changed", publicLobbyList());
  sendSecretToInnocents(code);

  r.currentTurnIdx = 0;
  announceTurn(code);
}

function announceTurn(code) {
  const r = rooms[code]; if (!r || (r.phase !== "HINT" && r.phase !== "IN_PROGRESS")) return;
  const aliveIds = r.order.filter(id => r.players[id]?.alive);
  if (aliveIds.length < 2) return checkEndConditions(code);

  if (r.currentTurnIdx >= aliveIds.length) {
    r.phase = "VOTE"; r.votes = {};
    clearTimeout(r.voteTimer);
    const vs = Math.max(10, Number(r.settings.voteSeconds || 45));
    r.voteEndsAt = now() + vs * 1000;
    io.to(code).emit("vote:start", { endsAt: r.voteEndsAt, serverNow: now(), seconds: vs });
    r.voteTimer = setTimeout(() => concludeVote(code), vs * 1000);
    io.to(code).emit("phase", snapshot(code));
    updateLobbyIndexSnapshot(r);
    return;
  }

  const turnId = aliveIds[r.currentTurnIdx];
  const turnName = r.players[turnId]?.name || "—";

  io.to(code).emit("turn", { turnId, turnName, seconds: r.settings.hintSeconds });

  clearTimeout(r.turnTimer);
  r.turnTimer = setTimeout(() => {
    const p = r.players[turnId];
    if (p && p.alive) {
      r.hints.push({ by: turnId, name: p.name, text: "(no hint)" });
      io.to(code).emit("hint:update", { hints: r.hints });
    }
    advanceTurn(code);
  }, (r.settings.hintSeconds || 30) * 1000);
}
function advanceTurn(code){ const r = rooms[code]; if (!r || r.phase==="CLOSED") return; clearTimeout(r.turnTimer); r.currentTurnIdx += 1; announceTurn(code); }
function concludeVote(code){
  const r = rooms[code]; if (!r) return;
  const aliveCount = alivePlayers(r).length;
  const need = majorityNeeded(aliveCount);
  const tally = {};
  Object.values(r.votes).forEach(t => tally[t] = (tally[t]||0) + 1);
  const entries = Object.entries(tally).sort((a,b)=>b[1]-a[1]);
  const [topId, topCount] = entries[0] || [null, 0];
  const skipCount = tally["SKIP"] || 0;

  if (skipCount >= need) return rotateAndNextHintRound(code, r);
  if (topId && topId !== "SKIP" && topCount >= need) return eliminateAndContinue(code, topId);
  rotateAndNextHintRound(code, r);
}
function eliminateAndContinue(code, targetId) {
  const r = rooms[code]; if (!r) return;
  const t = r.players[targetId]; if (!t) return;
  t.alive = false;
  io.to(code).emit("lobby:update", snapshot(code));
  if (t.role === "impostor" && countImpostors(r) === 0) return endGame(code, "INNOCENTS");
  if (countInnocents(r) <= 1) return endGame(code, "IMPOSTORS");
  rotateAndNextHintRound(code, r);
}
function endGame(code, winners){
  const r = rooms[code]; if (!r) return;
  clearTimeout(r.voteTimer); r.voteTimer = null; r.voteEndsAt = null;
  r.phase = "GAME_OVER"; r.winners = winners;
  io.to(code).emit("phase", snapshot(code));
  updateLobbyIndexSnapshot(r);
  io.emit("lobby:changed", publicLobbyList());
}
function checkEndConditions(code) {
  const r = rooms[code]; if (!r) return;
  if (countImpostors(r) === 0) return endGame(code, "INNOCENTS");
  if (countInnocents(r) <= 1) return endGame(code, "IMPOSTORS");
}
function rotateAndNextHintRound(code, r){
  r.phase = "HINT";
  r.hints = []; r.votes = {}; clearTimeout(r.voteTimer); r.voteTimer=null; r.voteEndsAt=null;
  r.order = r.order.filter(id => r.players[id]); // keep only present
  if (r.order.length) { r.order.push(r.order.shift()); }
  r.currentTurnIdx = 0;
  io.to(code).emit("phase", snapshot(code));
  sendSecretToInnocents(code);
  announceTurn(code);
}

// Socket handlers
io.on("connection", (socket) => {
  socket.on("lobby:list", (filter, ack) => ack?.(publicLobbyList(filter || {})));
  socket.on("lobby:watch", (filter) => {
    socket.data.watchFilter = filter || {};
    socket.emit("lobby:changed", publicLobbyList(socket.data.watchFilter));
  });

  socket.on("host:create", (payload, ack) => {
    const { name, impostors=1, hintSeconds=30, voteSeconds=45, maxPlayers=10, region="GLOBAL", isPublic=true } = payload || {};
    const code = makeCode();
    const safeName = (name || "Host").trim() || "Host";
    const safeRegion = REGIONS.includes(region) ? region : "GLOBAL";
    const cap = Math.min(10, Math.max(3, Number(maxPlayers) || 10));

    rooms[code] = {
      code, hostId: socket.id,
      settings: { impostors: Math.max(1,+impostors||1), hintSeconds: Math.max(5,+hintSeconds||30), voteSeconds: Math.max(10,+voteSeconds||45), maxPlayers: cap, region: safeRegion, public: !!isPublic },
      players: { [socket.id]: { id: socket.id, name: safeName, alive: true, role: "innocent", ready: false, lastSeen: now() } },
      ghosts: {},
      order: [socket.id], orderStartIndex:0, phase:"LOBBY",
      secretPlayer:"", hints:[], currentTurnIdx:0, votes:{}, winners:null,
      turnTimer:null, voteTimer:null, voteEndsAt:null, chatLog:[], lastSecret:null,
      createdAt: now(), updatedAt: now()
    };

    lobbyIndex[code] = { code, hostName: safeName, playerCount: 1, maxPlayers: cap, status:"WAITING", region: safeRegion, public: !!isPublic, createdAt: now(), updatedAt: now() };

    socket.join(code);
    ack?.({ ok:true, code });
    io.to(code).emit("lobby:update", snapshot(code));
    io.emit("lobby:changed", publicLobbyList());
  });

  socket.on("player:join", ({ code, name }, ack) => {
    code = (code||"").toUpperCase();
    const r = rooms[code];
    if (!r) return ack?.({ ok:false, error:"Room not found" });
    const trimmed = (name||"").trim();
    if (!trimmed) return ack?.({ ok:false, error:"Name required" });
    if (r.phase !== "LOBBY") return ack?.({ ok:false, error:"Game already started" });
    if (Object.keys(r.players).length >= r.settings.maxPlayers) return ack?.({ ok:false, error:"Room full" });
    if (Object.values(r.players).some(p => p.name.toLowerCase() === trimmed.toLowerCase())) return ack?.({ ok:false, error:"Name already taken" });

    r.players[socket.id] = { id: socket.id, name: trimmed, alive: true, role: "innocent", ready: false, lastSeen: now() };
    r.order.push(socket.id);
    socket.join(code);

    if (lobbyIndex[code]) { lobbyIndex[code].playerCount = Object.keys(r.players).length; lobbyIndex[code].updatedAt = now(); }

    ack?.({ ok:true });
    io.to(code).emit("lobby:update", snapshot(code));
    io.emit("lobby:changed", publicLobbyList());
  });

  socket.on("player:ready", ({ code, ready }, ack) => {
    const r = rooms[code]; if (!r || r.phase !== "LOBBY") return ack?.({ ok:false });
    const me = r.players[socket.id]; if (!me) return ack?.({ ok:false });
    me.ready = !!ready; me.lastSeen = now();
    io.to(code).emit("lobby:update", snapshot(code));
    ack?.({ ok:true });
  });

  socket.on("host:updateSettings", ({ code, patch }, ack) => {
    const r = rooms[code]; if (!r || r.phase !== "LOBBY") return ack?.({ ok:false });
    if (socket.id !== r.hostId) return ack?.({ ok:false, error:"Only host" });
    const s = r.settings;
    if (patch?.impostors != null) s.impostors = Math.max(1, Math.min(3, +patch.impostors||1));
    if (patch?.hintSeconds != null) s.hintSeconds = Math.max(5, +patch.hintSeconds||30);
    if (patch?.voteSeconds != null) s.voteSeconds = Math.max(10, +patch.voteSeconds||45);
    if (patch?.maxPlayers != null) s.maxPlayers = Math.min(10, Math.max(3, +patch.maxPlayers||10));
    if (patch?.region && REGIONS.includes(patch.region)) s.region = patch.region;
    if (patch?.public != null) s.public = !!patch.public;
    if (lobbyIndex[code]) { lobbyIndex[code].maxPlayers = s.maxPlayers; lobbyIndex[code].region = s.region; lobbyIndex[code].public = s.public; lobbyIndex[code].updatedAt = now(); }
    io.to(code).emit("lobby:update", snapshot(code));
    io.emit("lobby:changed", publicLobbyList());
    ack?.({ ok:true });
  });

  socket.on("host:start", ({ code }, ack) => {
    const r = rooms[code]; if (!r) return ack?.({ ok:false });
    if (socket.id !== r.hostId) return ack?.({ ok:false, error:"Only host can start" });
    if (r.phase !== "LOBBY") return ack?.({ ok:false, error:"Already started" });

    const playerCount = Object.keys(r.players).length;
    if (playerCount < 3) return ack?.({ ok:false, error:"Need at least 3 players" });

    const readyCount = Object.values(r.players).filter(p => p.ready || p.id === r.hostId).length;
    const seventyPct = Math.ceil(playerCount * 0.7);
    if (!(readyCount >= playerCount || readyCount >= seventyPct)) return ack?.({ ok:false, error:"Not enough players ready (70% required)" });

    if (lobbyIndex[code]) { lobbyIndex[code].status = "STARTING"; lobbyIndex[code].updatedAt = now(); }
    io.emit("lobby:changed", publicLobbyList());

    startGame(code, false, true);
    ack?.({ ok:true });
  });

  socket.on("host:forceRestart", ({ code }, ack) => {
    const r = rooms[code]; if (!r || socket.id !== r.hostId) return;
    if (lobbyIndex[code]) { lobbyIndex[code].status = "IN_PROGRESS"; lobbyIndex[code].updatedAt = now(); }
    startGame(code, true, true);
    ack?.({ ok:true });
  });

  socket.on("host:forceNextTurn", ({ code }) => {
    const r = rooms[code]; if (!r || socket.id !== r.hostId) return;
    if (r.phase === "HINT" || r.phase === "IN_PROGRESS") advanceTurn(code);
  });

  socket.on("hint:submit", ({ code, text }, ack) => {
    const r = rooms[code]; if (!r || (r.phase !== "HINT" && r.phase !== "IN_PROGRESS")) return ack?.({ ok:false });
    const currentId = r.order.filter(id => r.players[id]?.alive)[r.currentTurnIdx];
    if (socket.id !== currentId) return ack?.({ ok:false, error:"Not your turn" });
    const me = r.players[socket.id]; if (!me || !me.alive) return ack?.({ ok:false });
    r.hints.push({ by: socket.id, name: me.name, text: cleanMsg(text) });
    io.to(code).emit("hint:update", { hints: r.hints });
    ack?.({ ok:true });
    advanceTurn(code);
  });

  socket.on("chat:send", ({ code, text }, ack) => {
    const r = rooms[code]; if (!r) return ack?.({ ok:false });
    if (r.phase !== "VOTE") return ack?.({ ok:false, error:"Chat only during voting" });
    const me = r.players[socket.id]; if (!me || !me.alive) return ack?.({ ok:false });
    const body = cleanMsg(text); if (!body) return ack?.({ ok:false });
    if (!r.chatLog) r.chatLog = [];
    const msg = { by: me.id, name: me.name, text: body, at: now() };
    r.chatLog.push(msg); if (r.chatLog.length > 200) r.chatLog.shift();
    io.to(code).emit("chat:new", msg);
    ack?.({ ok:true });
  });

  socket.on("vote:cast", ({ code, targetId }, ack) => {
    const r = rooms[code]; if (!r || r.phase !== "VOTE") return ack?.({ ok:false });
    const voter = r.players[socket.id]; if (!voter || !voter.alive) return ack?.({ ok:false });
    if (r.votes[socket.id]) return ack?.({ ok:false, error:"Vote already cast" });
    if (targetId !== "SKIP" && (!r.players[targetId] || !r.players[targetId].alive)) return ack?.({ ok:false, error:"Invalid target" });

    r.votes[socket.id] = targetId;
    io.to(code).emit("vote:update", { votes: Object.keys(r.votes).length });

    const aliveCount = alivePlayers(r).length;
    if (Object.keys(r.votes).length >= aliveCount) { concludeVote(code); return ack?.({ ok:true }); }
    ack?.({ ok:true });
  });

  socket.on("host:close", ({ code }, ack) => { const r = rooms[code]; if (!r) return ack?.({ ok:false }); if (socket.id !== r.hostId) return ack?.({ ok:false, error:"Only host" }); closeLobby(code); ack?.({ ok:true }); });

  socket.on("disconnect", () => {
    for (const code of Object.keys(rooms)) {
      const r = rooms[code];
      if (!r.players[socket.id]) continue;

      const wasHost = r.hostId === socket.id;
      delete r.players[socket.id];
      r.order = r.order.filter(id => id !== socket.id);

      if (lobbyIndex[code]) { lobbyIndex[code].playerCount = Object.keys(r.players).length; lobbyIndex[code].updatedAt = now(); }

      // If lobby emptied, close immediately (so browser list cleans within ~1–2s)
      if (Object.keys(r.players).length === 0) { closeLobby(code); continue; }

      if (wasHost) r.hostId = r.order[0] || Object.keys(r.players)[0] || null;

      if (r.phase !== "LOBBY") checkEndConditions(code);
      io.to(code).emit("lobby:update", snapshot(code));
      io.emit("lobby:changed", publicLobbyList());
    }
  });
});

// Fast janitor (3s) so closed/empty rooms disappear quickly
setInterval(() => {
  const t = now();
  for (const code of Object.keys(rooms)) {
    const r = rooms[code];
    const empty = Object.keys(r.players).length === 0;
    if (empty) { closeLobby(code); continue; }
    if (r.phase === "LOBBY") {
      const recent = Object.values(r.players).some(p => (t - (p.lastSeen||0)) < LOBBY_IDLE_MS);
      if (!recent && (t - r.updatedAt) > LOBBY_IDLE_MS) closeLobby(code);
    } else if (r.phase === "IN_PROGRESS" || r.phase === "HINT" || r.phase === "VOTE") {
      if (r.startedAt && (t - r.startedAt) > GAME_MAX_MS) closeLobby(code);
    }
  }
}, 3000);

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
