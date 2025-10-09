// server.js — Soccer Impostor (v1.6.0)
// Global public lobby matchmaking: regions, public/private, maxPlayers, ready states,
// host migration, lobby expiry, in-progress lock, rejoin grace, real-time lobby list.

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

/* =========================
   Matchmaking configuration
   ========================= */
const REGIONS = ["GLOBAL","NA","SA","EU","AF","AS","OC"]; // simple region tags
const LOBBY_IDLE_MS = 10 * 60 * 1000;    // WAITING: close if inactive 10 min
const GAME_MAX_MS  = 2 * 60 * 60 * 1000; // IN_PROGRESS hard stop 2h
const REJOIN_GRACE_MS = 25 * 1000;       // keep player slot for ~25s after disconnect

/* =========================
   Static secret list
   ========================= */
const ALL_PLAYERS = [
  "Lionel Messi","Kylian Mbappe","Erling Haaland","Vinicius Junior","Mohamed Salah","Harry Kane","Jude Bellingham","Lautaro Martinez","Antoine Griezmann","Robert Lewandowski","Son Heung-min","Bukayo Saka","Jamal Musiala","Florian Wirtz","Rafael Leao","Khvicha Kvaratskhelia","Rodrygo","Ousmane Dembele","Leroy Sane","Kingsley Coman","Marcus Rashford","Jack Grealish","Christopher Nkunku","Kai Havertz","Joao Felix","Darwin Nunez","Victor Osimhen","Alexander Isak","Randal Kolo Muani","Dusan Vlahovic","Alvaro Morata","Federico Chiesa","Julian Alvarez","Paulo Dybala","Angel Di Maria","Kenan Yildiz","Dayro Moreno",
  "Kevin De Bruyne","Bernardo Silva","Martin Odegaard","Bruno Fernandes","Federico Valverde","Pedri","Gavi","Frenkie de Jong","Ilkay Gundogan","Toni Kroos","Luka Modric","Declan Rice","Casemiro","Adrien Rabiot","Nicolo Barella","Hakan Calhanoglu","Sandro Tonali","Sergej Milinkovic-Savic","James Maddison","Mason Mount","Dominik Szoboszlai","Dani Olmo","Youssouf Fofana","Aurelien Tchouameni","Eduardo Camavinga","Marco Verratti","Martin Zubimendi","Mikel Merino","Alexis Mac Allister","Enzo Fernandez","Moises Caicedo","Joao Palhinha","Teun Koopmeiners","Scott McTominay","Weston McKennie","Christian Pulisic","Giovanni Reyna","Luis Diaz","Rodrigo De Paul","Leandro Paredes",
  "Virgil van Dijk","Ruben Dias","Marquinhos","Eder Militao","David Alaba","William Saliba","Josko Gvardiol","Antonio Rudiger","Matthijs de Ligt","Milan Skriniar","Kim Min-jae","Dayot Upamecano","Ronald Araujo","Jules Kounde","Raphael Varane","Pau Cubarsi","Alejandro Balde","Giovanni Di Lorenzo","Khephren Thuram","Joshua Kimmich","Leon Goretzka","Benjamin Pavard","Raphael Guerreiro",
  "Joao Cancelo","Trent Alexander-Arnold","Andrew Robertson","Achraf Hakimi","Theo Hernandez","Alphonso Davies","Reece James","Dani Carvajal",
  "Emiliano Dibu Martinez","Thibaut Courtois","Alisson Becker","Ederson","Mike Maignan","Marc-Andre ter Stegen","Jan Oblak","Andre Onana","Diogo Costa","Yassine Bounou",
  "Nico Williams","Alejandro Garnacho","Cole Palmer","Xavi Simons","Rodrigo Bentancur","Nicolo Fagioli","Joao Neves","Lamine Yamal"
];

/* =========================
   In-memory model
   ========================= */
// PLAYER: { id, name, alive, role, ready, lastSeen, rejoinUntil? }
const rooms = Object.create(null);
/*
room = {
  code, hostId,
  settings: { impostors, hintSeconds, voteSeconds, maxPlayers, region, public },
  players: { [socketId]: PLAYER },
  // keep ghost seats for rejoin by name for a short grace period
  ghosts: { [ghostKey]: { name, until, role, wasAlive } },
  order: string[], orderStartIndex: 0,
  phase: 'LOBBY'|'HINT'|'VOTE'|'GAME_OVER'|'CLOSED'|'STARTING'|'IN_PROGRESS',
  secretPlayer,
  hints: [{by,name,text}],
  currentTurnIdx,
  votes: { [voterId]: targetId },
  winners: 'INNOCENTS'|'IMPOSTORS'|null,
  turnTimer: Timeout, voteTimer: Timeout | null, voteEndsAt: number | null,
  chatLog: [{by,name,text,at}],
  lastSecret: string|null,
  createdAt: number, updatedAt: number, startedAt?: number
}
*/

// Lightweight public lobby directory
const lobbyIndex = Object.create(null);
/*
lobbyIndex[code] = {
  code, hostName, playerCount, maxPlayers, status: 'WAITING'|'STARTING'|'IN_PROGRESS',
  region, public: true|false, createdAt, updatedAt, map: 'Stadium' (reserved)
}
*/

// utils
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => Array.from({ length: 5 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
function shuffle(a) { a = [...a]; for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
const alivePlayers = r => Object.values(r.players).filter(p => p.alive);
const countImpostors = r => alivePlayers(r).filter(p => p.role === "impostor").length;
const countInnocents = r => alivePlayers(r).filter(p => p.role === "innocent").length;
const majorityNeeded = n => Math.floor(n/2)+1;

function now(){ return Date.now(); }
function pickNewSecret(prev) {
  if (ALL_PLAYERS.length <= 1) return ALL_PLAYERS[0];
  let candidate = prev;
  while (candidate === prev) candidate = ALL_PLAYERS[Math.floor(Math.random() * ALL_PLAYERS.length)];
  return candidate;
}
function cleanMsg(msg) {
  if (!msg) return "";
  return String(msg).replace(/<\/?[^>]+(>|$)/g, "").slice(0, 200).trim();
}
const chatBuckets = new Map();
function canChat(socketId) {
  const t = now();
  const b = chatBuckets.get(socketId) || { last: 0, burst: 0 };
  b.burst = Math.max(0, b.burst - (t - b.last) / 1000);
  b.last = t; b.burst += 1; chatBuckets.set(socketId, b);
  return b.burst <= 5;
}

function touchRoom(r){ r.updatedAt = now(); if (lobbyIndex[r.code]) lobbyIndex[r.code].updatedAt = r.updatedAt; }
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

/* =========================
   Phase helpers (unchanged core with small hooks)
   ========================= */
function snapshot(code) {
  const r = rooms[code]; if (!r) return null;
  return {
    code: r.code,
    hostId: r.hostId,
    settings: r.settings,
    phase: r.phase,
    players: Object.values(r.players).map(p => ({ id:p.id, name:p.name, alive:p.alive, role:p.role, ready: !!p.ready })),
    order: r.order.map(id => ({ id, name: r.players[id]?.name || "?" })),
    orderStartIndex: r.orderStartIndex,
    currentTurnIdx: r.currentTurnIdx,
    hints: r.hints,
    votes: r.votes,
    winners: r.winners,
    secretPlayer: r.phase === "GAME_OVER" ? r.secretPlayer : null
  };
}

function sendSecretToInnocents(code) {
  const r = rooms[code]; if (!r) return;
  for (const p of Object.values(r.players)) {
    if (p.role === "innocent" && p.alive) {
      io.to(p.id).emit("secret", { secretPlayer: r.secretPlayer });
    }
  }
}

function rotateOrderStartIndex(r) {
  if (r.order.length === 0) return;
  r.orderStartIndex = (r.orderStartIndex + 1) % r.order.length;
  r.order = r.order.slice(r.orderStartIndex).concat(r.order.slice(0, r.orderStartIndex));
  r.orderStartIndex = 0;
}

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

function startGame(code, keepRotation = false, randomize = false) {
  const r = rooms[code]; if (!r) return;
  r.phase = "HINT";
  r.hints = []; r.votes = {}; r.winners = null;
  clearTimeout(r.voteTimer); r.voteTimer = null; r.voteEndsAt = null;
  r.chatLog = []; r.startedAt = now();

  const ids = Object.keys(r.players);
  if (!keepRotation) { r.order = ids; r.orderStartIndex = 0; }
  else { r.order = r.order.filter(id => ids.includes(id)); rotateOrderStartIndex(r); }

  // ready flags reset when game starts
  Object.values(r.players).forEach(p => p.ready = false);

  setRoles(r);

  const prev = r.lastSecret || null;
  r.secretPlayer = randomize ? pickNewSecret(prev) : ALL_PLAYERS[Math.floor(Math.random()*ALL_PLAYERS.length)];
  r.lastSecret = r.secretPlayer;

  r.phase = "IN_PROGRESS"; // lobby lock equivalent
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
    r.phase = "VOTE";
    r.votes = {};
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

function advanceTurn(code) {
  const r = rooms[code]; if (!r || r.phase === "CLOSED") return;
  clearTimeout(r.turnTimer);
  r.currentTurnIdx += 1;
  announceTurn(code);
}

function concludeVote(code){
  const r = rooms[code]; if (!r) return;
  const aliveCount = alivePlayers(r).length;
  const need = majorityNeeded(aliveCount);
  const tally = {};
  Object.values(r.votes).forEach(t => tally[t] = (tally[t]||0) + 1);
  const entries = Object.entries(tally).sort((a,b)=>b[1]-a[1]);
  const [topId, topCount] = entries[0] || [null, 0];
  const skipCount = tally["SKIP"] || 0;

  if (skipCount >= need) { rotateAndNextHintRound(code, r); return; }
  if (topId && topId !== "SKIP" && topCount >= need) { eliminateAndContinue(code, topId); return; }
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
  r.hints = [];
  r.votes = {};
  clearTimeout(r.voteTimer); r.voteTimer = null; r.voteEndsAt = null;
  rotateOrderStartIndex(r);
  r.currentTurnIdx = 0;
  io.to(code).emit("phase", snapshot(code));
  sendSecretToInnocents(code);
  announceTurn(code);
}

/* =========================
   Lobby directory helpers
   ========================= */
function publicLobbyList(filter = {}) {
  const { region = null, onlyOpen = false } = filter || {};
  const items = Object.values(lobbyIndex)
    .filter(x => x.public)
    .filter(x => !region || region === "GLOBAL" || x.region === region)
    .filter(x => !onlyOpen || (x.status === "WAITING" && x.playerCount < x.maxPlayers));
  // Sort: WAITING first, then most recent update
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

/* =========================
   Socket handlers
   ========================= */
io.on("connection", (socket) => {
  // ---- Lobby directory API ----
  socket.on("lobby:list", (filter, ack) => {
    ack?.(publicLobbyList(filter || {}));
  });
  socket.on("lobby:watch", (filter) => {
    socket.data.watchFilter = filter || {};
    socket.emit("lobby:changed", publicLobbyList(socket.data.watchFilter));
  });

  // ---- Host creates a lobby (public/private, region, capacity) ----
  socket.on("host:create", (payload, ack) => {
    const {
      name,
      impostors = 1,
      hintSeconds = 30,
      voteSeconds = 45,
      maxPlayers = 10,
      region = "GLOBAL",
      isPublic = true
    } = payload || {};

    const code = makeCode();
    const safeName = (name || "Host").trim() || "Host";
    const safeRegion = REGIONS.includes(region) ? region : "GLOBAL";
    const cap = Math.min(10, Math.max(3, Number(maxPlayers) || 10)); // 3..10

    rooms[code] = {
      code,
      hostId: socket.id,
      settings: {
        impostors: Math.max(1, +impostors||1),
        hintSeconds: Math.max(5, +hintSeconds||30),
        voteSeconds: Math.max(10, +voteSeconds||45),
        maxPlayers: cap,
        region: safeRegion,
        public: !!isPublic
      },
      players: { [socket.id]: { id: socket.id, name: safeName, alive: true, role: "innocent", ready: false, lastSeen: now() } },
      ghosts: {},
      order: [socket.id],
      orderStartIndex: 0,
      phase: "LOBBY",
      secretPlayer: "",
      hints: [],
      currentTurnIdx: 0,
      votes: {},
      winners: null,
      turnTimer: null,
      voteTimer: null,
      voteEndsAt: null,
      chatLog: [],
      lastSecret: null,
      createdAt: now(),
      updatedAt: now()
    };

    lobbyIndex[code] = {
      code,
      hostName: safeName,
      playerCount: 1,
      maxPlayers: cap,
      status: "WAITING",
      region: safeRegion,
      public: !!isPublic,
      createdAt: now(),
      updatedAt: now()
    };

    socket.join(code);
    ack?.({ ok: true, code });
    io.to(code).emit("lobby:update", snapshot(code));
    io.emit("lobby:changed", publicLobbyList());
  });

  // ---- Join lobby (public browser or code) ----
  socket.on("player:join", ({ code, name }, ack) => {
    code = (code||"").toUpperCase();
    const r = rooms[code];
    if (!r) return ack?.({ ok:false, error:"Room not found" });
    const trimmed = (name||"").trim();
    if (!trimmed) return ack?.({ ok:false, error:"Name required" });

    if (r.phase !== "LOBBY") return ack?.({ ok:false, error:"Game already started" });
    if (Object.keys(r.players).length >= r.settings.maxPlayers) return ack?.({ ok:false, error:"Room full" });
    // unique name within room (case-insensitive)
    if (Object.values(r.players).some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
      return ack?.({ ok:false, error:"Name already taken" });
    }
    r.players[socket.id] = { id: socket.id, name: trimmed, alive: true, role: "innocent", ready: false, lastSeen: now() };
    r.order.push(socket.id);
    socket.join(code);

    if (lobbyIndex[code]) {
      lobbyIndex[code].playerCount = Object.keys(r.players).length;
      lobbyIndex[code].updatedAt = now();
    }

    ack?.({ ok: true });
    io.to(code).emit("lobby:update", snapshot(code));
    io.emit("lobby:changed", publicLobbyList());
  });

  // ---- Player ready/unready (LOBBY only) ----
  socket.on("player:ready", ({ code, ready }, ack) => {
    const r = rooms[code]; if (!r || r.phase !== "LOBBY") return ack?.({ ok:false });
    const me = r.players[socket.id]; if (!me) return ack?.({ ok:false });
    me.ready = !!ready; me.lastSeen = now();
    touchRoom(r);
    io.to(code).emit("lobby:update", snapshot(code));
    ack?.({ ok:true });
  });

  // ---- Host updates settings (LOBBY only) ----
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

    // reflect in index
    if (lobbyIndex[code]) {
      lobbyIndex[code].maxPlayers = s.maxPlayers;
      lobbyIndex[code].region = s.region;
      lobbyIndex[code].public = s.public;
      lobbyIndex[code].updatedAt = now();
    }
    io.to(code).emit("lobby:update", snapshot(code));
    io.emit("lobby:changed", publicLobbyList());
    ack?.({ ok:true });
  });

  // ---- Host starts (requires minimum players & readiness) ----
  socket.on("host:start", ({ code }, ack) => {
    const r = rooms[code]; if (!r) return ack?.({ ok:false });
    if (socket.id !== r.hostId) return ack?.({ ok:false, error:"Only host can start" });
    if (r.phase !== "LOBBY") return ack?.({ ok:false, error:"Already started" });

    const playerCount = Object.keys(r.players).length;
    if (playerCount < 3) return ack?.({ ok:false, error:"Need at least 3 players" });

    // Rule: everyone except host must be ready OR at least 70% players ready
    const readyCount = Object.values(r.players).filter(p => p.ready || p.id === r.hostId).length;
    const seventyPct = Math.ceil(playerCount * 0.7);
    if (!(readyCount >= playerCount || readyCount >= seventyPct)) {
      return ack?.({ ok:false, error:"Not enough players ready (70% required)" });
    }

    if (lobbyIndex[code]) { lobbyIndex[code].status = "STARTING"; lobbyIndex[code].updatedAt = now(); }
    io.emit("lobby:changed", publicLobbyList());

    // brief STARTING state could include a countdown; we jump straight to startGame
    startGame(code, false, true);
    ack?.({ ok:true });
  });

  // ---- Replay with randomization (keep rotation) ----
  socket.on("host:forceRestart", ({ code }, ack) => {
    const r = rooms[code]; if (!r || socket.id !== r.hostId) return;
    if (lobbyIndex[code]) { lobbyIndex[code].status = "IN_PROGRESS"; lobbyIndex[code].updatedAt = now(); }
    startGame(code, true, true);
    ack?.({ ok:true });
  });

  // ---- Force next turn (host only) ----
  socket.on("host:forceNextTurn", ({ code }) => {
    const r = rooms[code]; if (!r || socket.id !== r.hostId) return;
    if (r.phase === "HINT" || r.phase === "IN_PROGRESS") advanceTurn(code);
  });

  // ---- Player submits hint (unchanged rule) ----
  socket.on("hint:submit", ({ code, text }, ack) => {
    const r = rooms[code]; if (!r || (r.phase !== "HINT" && r.phase !== "IN_PROGRESS")) return ack?.({ ok:false });
    const currentId = r.order.filter(id => r.players[id]?.alive)[r.currentTurnIdx];
    if (socket.id !== currentId) return ack?.({ ok:false, error:"Not your turn" });
    const me = r.players[socket.id]; if (!me || !me.alive) return ack?.({ ok:false });
    r.hints.push({ by: socket.id, name: me.name, text: (text||"").slice(0, 120) });
    io.to(code).emit("hint:update", { hints: r.hints });
    ack?.({ ok:true });
    advanceTurn(code);
  });

  // ---- Vote chat (during VOTE) ----
  socket.on("chat:send", ({ code, text }, ack) => {
    const r = rooms[code]; if (!r) return ack?.({ ok:false });
    if (r.phase !== "VOTE") return ack?.({ ok:false, error:"Chat only during voting" });
    const me = r.players[socket.id];
    if (!me || !me.alive) return ack?.({ ok:false });
    if (!canChat(socket.id)) return ack?.({ ok:false, error:"Slow down" });
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

    if (targetId !== "SKIP" && (!r.players[targetId] || !r.players[targetId].alive)) {
      return ack?.({ ok:false, error:"Invalid target" });
    }

    r.votes[socket.id] = targetId;
    io.to(code).emit("vote:update", { votes: Object.keys(r.votes).length });

    const aliveCount = alivePlayers(r).length;
    if (Object.keys(r.votes).length >= aliveCount) { concludeVote(code); return ack?.({ ok:true }); }
    ack?.({ ok:true });
  });

  // ---- Close lobby (host) ----
  socket.on("host:close", ({ code }, ack) => {
    const r = rooms[code]; if (!r) return ack?.({ ok:false });
    if (socket.id !== r.hostId) return ack?.({ ok:false, error:"Only host" });
    closeLobby(code);
    ack?.({ ok:true });
  });

  // ---- Disconnection & host migration ----
  socket.on("disconnect", () => {
    for (const code of Object.keys(rooms)) {
      const r = rooms[code];
      if (!r.players[socket.id]) continue;

      const wasHost = r.hostId === socket.id;
      const leaving = r.players[socket.id];
      // create ghost seat for quick rejoin by name
      r.ghosts[leaving.name.toLowerCase()] = {
        name: leaving.name,
        until: now() + REJOIN_GRACE_MS,
        role: leaving.role,
        wasAlive: leaving.alive
      };

      delete r.players[socket.id];
      r.order = r.order.filter(id => id !== socket.id);

      if (lobbyIndex[code]) {
        lobbyIndex[code].playerCount = Object.keys(r.players).length;
        lobbyIndex[code].updatedAt = now();
      }

      // If lobby emptied, close it
      if (Object.keys(r.players).length === 0) { closeLobby(code); continue; }

      // Host migration: promote next player in order
      if (wasHost) {
        const nextHost = r.order[0];
        r.hostId = nextHost || Object.keys(r.players)[0] || null;
        io.to(code).emit("host:left");
      }

      if (r.phase !== "LOBBY") checkEndConditions(code);
      io.to(code).emit("lobby:update", snapshot(code));
      io.emit("lobby:changed", publicLobbyList());
    }
  });

  // ---- Rejoin by name within grace window (LOBBY or IN_PROGRESS) ----
  socket.on("player:rejoin", ({ code, name }, ack) => {
    code = (code||"").toUpperCase();
    const r = rooms[code]; if (!r) return ack?.({ ok:false, error:"Room not found" });
    const key = (name||"").trim().toLowerCase();
    if (!key || !r.ghosts[key]) return ack?.({ ok:false, error:"No rejoin slot" });
    if (r.ghosts[key].until < now()) { delete r.ghosts[key]; return ack?.({ ok:false, error:"Rejoin window expired" }); }

    // prevent duplicate names
    if (Object.values(r.players).some(p => p.name.toLowerCase() === key)) {
      delete r.ghosts[key];
      return ack?.({ ok:false, error:"Name already in use" });
    }

    const ghost = r.ghosts[key];
    delete r.ghosts[key];

    r.players[socket.id] = { id: socket.id, name: ghost.name, alive: ghost.wasAlive, role: ghost.role, ready: false, lastSeen: now() };
    r.order.push(socket.id);
    socket.join(code);

    if (lobbyIndex[code]) {
      lobbyIndex[code].playerCount = Object.keys(r.players).length;
      lobbyIndex[code].updatedAt = now();
    }

    ack?.({ ok:true });
    io.to(code).emit("lobby:update", snapshot(code));
    io.emit("lobby:changed", publicLobbyList());
  });
});

/* =========================
   Expiry janitor
   ========================= */
setInterval(() => {
  const t = now();
  for (const code of Object.keys(rooms)) {
    const r = rooms[code];
    // scrub expired ghosts
    for (const k of Object.keys(r.ghosts)) if (r.ghosts[k].until < t) delete r.ghosts[k];

    const empty = Object.keys(r.players).length === 0;
    if (empty) { closeLobby(code); continue; }

    if (r.phase === "LOBBY") {
      // idle check: no updates and no ready activity
      const readyOrRecent = Object.values(r.players).some(p => (t - (p.lastSeen||0)) < LOBBY_IDLE_MS);
      if (!readyOrRecent && (t - r.updatedAt) > LOBBY_IDLE_MS) closeLobby(code);
    } else if (r.phase === "IN_PROGRESS" || r.phase === "HINT" || r.phase === "VOTE") {
      if (r.startedAt && (t - r.startedAt) > GAME_MAX_MS) closeLobby(code);
    }
  }
}, 10_000);

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
