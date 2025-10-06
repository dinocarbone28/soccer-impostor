// server.js — Soccer Impostor (v1.4.0) — SKIP voting, replay randomization, robust end-game reveals

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

// --- Soccer players ---
const ALL_PLAYERS = [
  "Lionel Messi","Kylian Mbappe","Erling Haaland","Vinicius Junior","Mohamed Salah","Harry Kane","Jude Bellingham","Lautaro Martinez","Antoine Griezmann","Robert Lewandowski","Son Heung-min","Bukayo Saka","Jamal Musiala","Florian Wirtz","Rafael Leao","Khvicha Kvaratskhelia","Rodrygo","Ousmane Dembele","Leroy Sane","Kingsley Coman","Marcus Rashford","Jack Grealish","Christopher Nkunku","Kai Havertz","Joao Felix","Darwin Nunez","Victor Osimhen","Alexander Isak","Randal Kolo Muani","Dusan Vlahovic","Alvaro Morata","Federico Chiesa","Julian Alvarez","Paulo Dybala","Angel Di Maria","Kenan Yildiz","Dayro Moreno",
  "Kevin De Bruyne","Bernardo Silva","Martin Odegaard","Bruno Fernandes","Federico Valverde","Pedri","Gavi","Frenkie de Jong","Ilkay Gundogan","Toni Kroos","Luka Modric","Declan Rice","Casemiro","Adrien Rabiot","Nicolo Barella","Hakan Calhanoglu","Sandro Tonali","Sergej Milinkovic-Savic","James Maddison","Mason Mount","Dominik Szoboszlai","Dani Olmo","Youssouf Fofana","Aurelien Tchouameni","Eduardo Camavinga","Marco Verratti","Martin Zubimendi","Mikel Merino","Alexis Mac Allister","Enzo Fernandez","Moises Caicedo","Joao Palhinha","Teun Koopmeiners","Scott McTominay","Weston McKennie","Christian Pulisic","Giovanni Reyna","Luis Diaz","Rodrigo De Paul","Leandro Paredes",
  "Virgil van Dijk","Ruben Dias","Marquinhos","Eder Militao","David Alaba","William Saliba","Josko Gvardiol","Antonio Rudiger","Matthijs de Ligt","Milan Skriniar","Kim Min-jae","Dayot Upamecano","Ronald Araujo","Jules Kounde","Raphael Varane","Pau Cubarsi","Alejandro Balde","Giovanni Di Lorenzo","Khephren Thuram","Joshua Kimmich","Leon Goretzka","Benjamin Pavard","Raphael Guerreiro",
  "Joao Cancelo","Trent Alexander-Arnold","Andrew Robertson","Achraf Hakimi","Theo Hernandez","Alphonso Davies","Reece James","Dani Carvajal",
  "Emiliano Dibu Martinez","Thibaut Courtois","Alisson Becker","Ederson","Mike Maignan","Marc-Andre ter Stegen","Jan Oblak","Andre Onana","Diogo Costa","Yassine Bounou",
  "Nico Williams","Alejandro Garnacho","Cole Palmer","Xavi Simons","Rodrigo Bentancur","Nicolo Fagioli","Joao Neves","Lamine Yamal"
];

// --- Room model ---
/*
room = {
  code, hostId,
  settings: { impostors, hintSeconds },
  players: { [socketId]: { id, name, alive, role } },
  order: string[], orderStartIndex: number,
  phase: 'LOBBY'|'HINT'|'VOTE'|'GAME_OVER',
  secretPlayer,
  hints: [{by,name,text}],
  currentTurnIdx,
  votes: { [voterId]: targetId },
  winners: 'INNOCENTS'|'IMPOSTORS'|null,
  turnTimer: Timeout,
  lastSecret: string | null
}
*/
const rooms = Object.create(null);

// --- utils ---
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => Array.from({ length: 5 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
function shuffle(a) { a = [...a]; for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
const alivePlayers = r => Object.values(r.players).filter(p => p.alive);
const countImpostors = r => alivePlayers(r).filter(p => p.role === "impostor").length;
const countInnocents = r => alivePlayers(r).filter(p => p.role === "innocent").length;
const majorityNeeded = n => Math.floor(n/2)+1;

function pickNewSecret(prev) {
  if (ALL_PLAYERS.length <= 1) return ALL_PLAYERS[0];
  let candidate = prev;
  while (candidate === prev) {
    candidate = ALL_PLAYERS[Math.floor(Math.random() * ALL_PLAYERS.length)];
  }
  return candidate;
}

function snapshot(code) {
  const r = rooms[code]; if (!r) return null;
  return {
    code: r.code,
    hostId: r.hostId,
    settings: r.settings,
    phase: r.phase,
    players: Object.values(r.players).map(p => ({ id:p.id, name:p.name, alive:p.alive, role:p.role })),
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

// --- core phase handlers ---
function startGame(code, keepRotation = false, randomize = false) {
  const r = rooms[code]; if (!r) return;

  r.phase = "HINT";
  r.hints = [];
  r.votes = {};
  r.winners = null;

  const ids = Object.keys(r.players);

  // maintain order (and rotate if continuing rounds), but allow fresh randomization on replay if requested
  if (!keepRotation) {
    r.order = ids;
    r.orderStartIndex = 0;
  } else {
    r.order = r.order.filter(id => ids.includes(id));
    rotateOrderStartIndex(r);
  }

  // reset everyone alive; optionally re-randomize roles/secret
  ids.forEach(id => { r.players[id].alive = true; r.players[id].role = "innocent"; });

  // assign roles (random each start; capped)
  const shuffled = shuffle(ids);
  const maxImpostors = Math.max(1, Math.floor(ids.length / 3));
  const impostorCount = Math.min(r.settings.impostors || 1, maxImpostors);
  const impostors = new Set(shuffled.slice(0, impostorCount));
  ids.forEach(id => { r.players[id].role = impostors.has(id) ? "impostor" : "innocent"; });

  // choose secret (ensure different from last if replay/randomize)
  const prev = r.lastSecret || null;
  r.secretPlayer = randomize ? pickNewSecret(prev) : ALL_PLAYERS[Math.floor(Math.random()*ALL_PLAYERS.length)];
  r.lastSecret = r.secretPlayer;

  io.to(code).emit("phase", snapshot(code));
  sendSecretToInnocents(code);

  r.currentTurnIdx = 0;
  announceTurn(code);
}

function announceTurn(code) {
  const r = rooms[code]; if (!r || r.phase !== "HINT") return;

  const aliveIds = r.order.filter(id => r.players[id]?.alive);
  if (aliveIds.length < 2) return checkEndConditions(code);

  if (r.currentTurnIdx >= aliveIds.length) {
    // move to vote phase
    r.phase = "VOTE";
    r.votes = {};
    io.to(code).emit("phase", snapshot(code));
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
  const r = rooms[code]; if (!r || r.phase !== "HINT") return;
  clearTimeout(r.turnTimer);
  r.currentTurnIdx += 1;
  announceTurn(code);
}

function eliminateAndContinue(code, targetId) {
  const r = rooms[code]; if (!r) return;
  const t = r.players[targetId]; if (!t) return;
  t.alive = false;
  io.to(code).emit("lobby:update", snapshot(code));

  if (t.role === "impostor" && countImpostors(r) === 0) {
    r.phase = "GAME_OVER"; r.winners = "INNOCENTS";
    io.to(code).emit("phase", snapshot(code)); return;
  }
  if (countInnocents(r) <= 1) {
    r.phase = "GAME_OVER"; r.winners = "IMPOSTORS";
    io.to(code).emit("phase", snapshot(code)); return;
  }

  // next hint round
  r.phase = "HINT";
  r.hints = [];
  r.votes = {};
  rotateOrderStartIndex(r);
  r.currentTurnIdx = 0;
  io.to(code).emit("phase", snapshot(code));
  sendSecretToInnocents(code);
  announceTurn(code);
}

function checkEndConditions(code) {
  const r = rooms[code]; if (!r) return;
  if (countImpostors(r) === 0) {
    r.phase = "GAME_OVER"; r.winners = "INNOCENTS";
    io.to(code).emit("phase", snapshot(code)); return;
  }
  if (countInnocents(r) <= 1) {
    r.phase = "GAME_OVER"; r.winners = "IMPOSTORS";
    io.to(code).emit("phase", snapshot(code)); return;
  }
}

// --- sockets ---
io.on("connection", (socket) => {
  socket.on("host:create", ({ name, impostors=1, hintSeconds=30 }, ack) => {
    const code = makeCode();
    rooms[code] = {
      code,
      hostId: socket.id,
      settings: { impostors: Math.max(1, +impostors||1), hintSeconds: Math.max(5, +hintSeconds||30) },
      players: { [socket.id]: { id: socket.id, name: (name||"Host").trim(), alive: true, role: "innocent" } },
      order: [socket.id],
      orderStartIndex: 0,
      phase: "LOBBY",
      secretPlayer: "",
      hints: [],
      currentTurnIdx: 0,
      votes: {},
      winners: null,
      turnTimer: null,
      lastSecret: null
    };
    socket.join(code);
    ack?.({ ok: true, code });
    io.to(code).emit("lobby:update", snapshot(code));
  });

  socket.on("player:join", ({ code, name }, ack) => {
    code = (code||"").toUpperCase();
    const r = rooms[code];
    if (!r) return ack?.({ ok:false, error:"Room not found" });
    const trimmed = (name||"").trim();
    if (!trimmed) return ack?.({ ok:false, error:"Name required" });
    if (Object.values(r.players).some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
      return ack?.({ ok:false, error:"Name already taken" });
    }
    r.players[socket.id] = { id: socket.id, name: trimmed, alive: true, role: "innocent" };
    r.order.push(socket.id);
    socket.join(code);
    ack?.({ ok: true });
    io.to(code).emit("lobby:update", snapshot(code));
  });

  socket.on("host:start", ({ code }, ack) => {
    const r = rooms[code]; if (!r) return;
    if (Object.keys(r.players).length < 3) return ack?.({ ok:false, error:"Need at least 3 players" });
    startGame(code); // fresh game
    ack?.({ ok:true });
  });

  socket.on("host:forceNextTurn", ({ code }) => {
    const r = rooms[code]; if (!r || socket.id !== r.hostId) return;
    if (r.phase === "HINT") advanceTurn(code);
  });

  // Replay with randomization (roles + new secret different from last)
  socket.on("host:forceRestart", ({ code }) => {
    const r = rooms[code]; if (!r || socket.id !== r.hostId) return;
    startGame(code, true, true); // keep rotation, randomize roles/secret
  });

  socket.on("hint:submit", ({ code, text }, ack) => {
    const r = rooms[code]; if (!r || r.phase !== "HINT") return ack?.({ ok:false });
    const currentId = r.order.filter(id => r.players[id]?.alive)[r.currentTurnIdx];
    if (socket.id !== currentId) return ack?.({ ok:false, error:"Not your turn" });
    const me = r.players[socket.id]; if (!me || !me.alive) return ack?.({ ok:false });
    r.hints.push({ by: socket.id, name: me.name, text: (text||"").slice(0, 120) });
    io.to(code).emit("hint:update", { hints: r.hints });
    ack?.({ ok:true });
    advanceTurn(code);
  });

  socket.on("vote:cast", ({ code, targetId }, ack) => {
    const r = rooms[code]; if (!r || r.phase !== "VOTE") return ack?.({ ok:false });
    const voter = r.players[socket.id]; if (!voter || !voter.alive) return ack?.({ ok:false });
    if (r.votes[socket.id]) return ack?.({ ok:false, error:"Vote already cast" });

    // Accept SKIP as a valid choice
    if (targetId !== "SKIP" && (!r.players[targetId] || !r.players[targetId].alive)) {
      return ack?.({ ok:false, error:"Invalid target" });
    }

    r.votes[socket.id] = targetId;
    io.to(code).emit("vote:update", { votes: Object.keys(r.votes).length });

    const aliveCount = alivePlayers(r).length;
    const need = majorityNeeded(aliveCount);

    // Tally
    const tally = {};
    Object.values(r.votes).forEach(t => tally[t] = (tally[t]||0) + 1);

    // Find top (including SKIP), and also check if SKIP has majority
    const entries = Object.entries(tally).sort((a,b)=>b[1]-a[1]); // [ [idOrSKIP, count], ... ]
    const [topId, topCount] = entries[0] || [null,0];
    const skipCount = tally["SKIP"] || 0;

    // If SKIP reaches majority → next hint round
    if (skipCount >= need) {
      rotateAndNextHintRound(code, r);
      ack?.({ ok:true });
      return;
    }

    // If someone (a player) reaches majority → eliminate them
    if (topId && topId !== "SKIP" && topCount >= need) {
      eliminateAndContinue(code, topId);
      ack?.({ ok:true });
      return;
    }

    // If everyone voted but no majority (or a tie, or SKIP just plurality) → next hint round
    if (Object.keys(r.votes).length >= aliveCount) {
      rotateAndNextHintRound(code, r);
      ack?.({ ok:true });
      return;
    }

    ack?.({ ok:true });
  });

  socket.on("disconnect", () => {
    for (const code of Object.keys(rooms)) {
      const r = rooms[code]; if (!r.players[socket.id]) continue;
      const wasHost = r.hostId === socket.id;
      delete r.players[socket.id];
      r.order = r.order.filter(id => id !== socket.id);
      if (r.phase !== "LOBBY") checkEndConditions(code);
      io.to(code).emit("lobby:update", snapshot(code));
      if (wasHost) { r.hostId = null; io.to(code).emit("host:left"); }
    }
  });
});

function rotateAndNextHintRound(code, r){
  r.phase = "HINT";
  r.hints = [];
  r.votes = {};
  rotateOrderStartIndex(r);
  r.currentTurnIdx = 0;
  io.to(code).emit("phase", snapshot(code));
  sendSecretToInnocents(code);
  announceTurn(code);
}

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
