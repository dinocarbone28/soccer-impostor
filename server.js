// server.js (CommonJS) — Express + Socket.IO
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// --- Sanitized player pool (ASCII only; accents/quotes removed) ---
const PLAYER_POOL = [
  // Forwards & Attackers
  "Lionel Messi","Kylian Mbappe","Erling Haaland","Vinicius Junior","Mohamed Salah","Harry Kane","Jude Bellingham",
  "Lautaro Martinez","Antoine Griezmann","Robert Lewandowski","Son Heung-min","Bukayo Saka","Jamal Musiala","Florian Wirtz",
  "Rafael Leao","Khvicha Kvaratskhelia","Rodrygo","Ousmane Dembele","Leroy Sane","Kingsley Coman","Marcus Rashford",
  "Jack Grealish","Christopher Nkunku","Kai Havertz","Joao Felix","Darwin Nunez","Victor Osimhen","Alexander Isak",
  "Randal Kolo Muani","Dusan Vlahovic","Alvaro Morata","Federico Chiesa","Julian Alvarez","Paulo Dybala","Angel Di Maria",
  "Kenan Yildiz","Dayro Moreno",
  // Midfielders
  "Kevin De Bruyne","Bernardo Silva","Martin Odegaard","Bruno Fernandes","Federico Valverde","Pedri","Gavi",
  "Frenkie de Jong","Ilkay Gundogan","Toni Kroos","Luka Modric","Declan Rice","Casemiro","Adrien Rabiot",
  "Nicolo Barella","Hakan Calhanoglu","Sandro Tonali","Sergej Milinkovic-Savic","James Maddison","Mason Mount",
  "Dominik Szoboszlai","Dani Olmo","Youssouf Fofana","Aurelien Tchouameni","Eduardo Camavinga","Marco Verratti",
  "Martin Zubimendi","Mikel Merino","Alexis Mac Allister","Enzo Fernandez","Moises Caicedo","Joao Palhinha",
  "Teun Koopmeiners","Scott McTominay","Weston McKennie","Christian Pulisic","Giovanni Reyna","Luis Diaz",
  "Rodrigo De Paul","Leandro Paredes",
  // Defenders
  "Virgil van Dijk","Ruben Dias","Marquinhos","Eder Militao","David Alaba","William Saliba","Josko Gvardiol",
  "Antonio Rudiger","Matthijs de Ligt","Milan Skriniar","Kim Min-jae","Dayot Upamecano","Ronald Araujo",
  "Jules Kounde","Raphael Varane","Pau Cubarsi","Alejandro Balde","Giovanni Di Lorenzo","Khephren Thuram",
  "Joshua Kimmich","Leon Goretzka","Benjamin Pavard","Raphael Guerreiro",
  // Fullbacks/Wingbacks
  "Joao Cancelo","Trent Alexander-Arnold","Andrew Robertson","Achraf Hakimi","Theo Hernandez","Alphonso Davies",
  "Reece James","Dani Carvajal",
  // Goalkeepers
  "Emiliano Dibu Martinez","Thibaut Courtois","Alisson Becker","Ederson","Mike Maignan","Marc-Andre ter Stegen",
  "Jan Oblak","Andre Onana","Diogo Costa","Yassine Bounou",
  // Rising/Notable
  "Nico Williams","Alejandro Garnacho","Cole Palmer","Xavi Simons","Rodrigo Bentancur","Nicolo Fagioli",
  "Joao Neves","Lamine Yamal"
];

// --- In-memory game state ---
const rooms = {};

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms[code]);
  return code;
}

function getRoom(code) { return rooms[code]; }

function roomPlayerList(room) {
  return Object.values(room.players).map(p => ({ id: p.id, name: p.name, isHost: !!p.isHost }));
}

function broadcastLobby(room) {
  io.to(room.code).emit("lobbyUpdate", {
    code: room.code,
    players: roomPlayerList(room),
    maxPlayers: room.maxPlayers
  });
}

function startGame(room) {
  const playerIds = Object.keys(room.players);
  if (playerIds.length < 3) return { ok: false, error: "Need at least 3 players." };

  room.secretPlayer = PLAYER_POOL[Math.floor(Math.random() * PLAYER_POOL.length)];

  const impostorId = playerIds[Math.floor(Math.random() * playerIds.length)];
  for (const id of playerIds) {
    room.players[id].isImpostor = (id === impostorId);
  }

  room.status = "describing";
  room.round = 1;
  room.maxRounds = 3;
  room.submissions = {};
  room.votes = {};

  for (const id of playerIds) {
    const sock = io.sockets.sockets.get(id);
    if (!sock) continue;
    const you = room.players[id];
    sock.emit("roleAssigned", {
      isImpostor: you.isImpostor,
      secretPlayer: you.isImpostor ? null : room.secretPlayer,
      round: room.round,
      maxRounds: room.maxRounds
    });
  }

  io.to(room.code).emit("phaseChange", { phase: room.status, round: room.round, maxRounds: room.maxRounds });
  return { ok: true };
}

function nextPhase(room) {
  if (room.status === "describing") {
    if (room.round < room.maxRounds) {
      room.round += 1;
      io.to(room.code).emit("phaseChange", { phase: "describing", round: room.round, maxRounds: room.maxRounds });
    } else {
      room.status = "voting";
      room.votes = {};
      io.to(room.code).emit("phaseChange", { phase: "voting", round: room.round, maxRounds: room.maxRounds });
    }
  } else if (room.status === "voting") {
    finishVoting(room);
  }
}

function finishVoting(room) {
  const tally = {};
  for (const voterId of Object.keys(room.votes)) {
    const targetId = room.votes[voterId];
    if (!targetId) continue;
    tally[targetId] = (tally[targetId] || 0) + 1;
  }

  let ejectedId = null;
  let maxVotes = -1;
  for (const targetId of Object.keys(tally)) {
    if (tally[targetId] > maxVotes) { ejectedId = targetId; maxVotes = tally[targetId]; }
  }

  const impostorId = Object.values(room.players).find(p => p.isImpostor)?.id;
  const ejected = ejectedId ? room.players[ejectedId] : null;

  io.to(room.code).emit("voteResults", {
    ejectedId,
    ejectedName: ejected ? ejected.name : null,
    votes: tally
  });

  if (!ejectedId) {
    room.status = "finalGuess";
    io.to(impostorId).emit("yourFinalGuess", { tries: 1 });
    io.to(room.code).emit("phaseChange", { phase: "finalGuess" });
    return;
  }

  if (ejectedId !== impostorId) {
    room.status = "ended";
    io.to(room.code).emit("gameOver", { winner: "impostor", reason: "wrong_vote", secret: room.secretPlayer });
  } else {
    room.status = "finalGuess";
    io.to(impostorId).emit("yourFinalGuess", { tries: 1 });
    io.to(room.code).emit("phaseChange", { phase: "finalGuess" });
  }
}

function cleanRoomIfEmpty(room) {
  if (Object.keys(room.players).length === 0) delete rooms[room.code];
}

io.on("connection", (socket) => {
  let joinedRoomCode = null;

  socket.on("hostCreateRoom", ({ hostName, maxPlayers }) => {
    const code = generateRoomCode();
    const room = {
      code,
      hostId: socket.id,
      maxPlayers: Math.max(3, Math.min(Number(maxPlayers) || 8, 12)),
      status: "lobby",
      round: 0,
      maxRounds: 3,
      secretPlayer: null,
      players: {},
      submissions: {},
      votes: {}
    };
    rooms[code] = room;

    room.players[socket.id] = { id: socket.id, name: hostName || "Host", isHost: true, isImpostor: false };
    joinedRoomCode = code;
    socket.join(code);
    socket.emit("roomCreated", { code });
    broadcastLobby(room);
  });

  socket.on("joinRoom", ({ roomCode, name }) => {
    const code = (roomCode || "").toUpperCase().trim();
    const room = getRoom(code);
    if (!room) return socket.emit("joinError", { message: "Room not found." });
    if (Object.keys(room.players).length >= room.maxPlayers) return socket.emit("joinError", { message: "Room is full." });
    if (room.status !== "lobby") return socket.emit("joinError", { message: "Game already started." });

    room.players[socket.id] = { id: socket.id, name: (name || "Player").trim().slice(0, 20), isHost: false, isImpostor: false };
    joinedRoomCode = code;
    socket.join(code);
    socket.emit("joinedRoom", { code, you: { id: socket.id, name: room.players[socket.id].name } });
    broadcastLobby(room);
  });

  socket.on("startGame", () => {
    if (!joinedRoomCode) return;
    const room = getRoom(joinedRoomCode);
    if (!room || room.hostId !== socket.id) return;
    const res = startGame(room);
    if (!res.ok) socket.emit("toast", { type: "error", message: res.error });
  });

  socket.on("submitDescription", ({ text }) => {
    if (!joinedRoomCode) return;
    const room = getRoom(joinedRoomCode);
    if (!room || room.status !== "describing") return;
    const me = room.players[socket.id];
    if (!me) return;

    const t = ("" + (text || "")).trim().slice(0, 80);
    if (!t) return;

    if (!room.submissions[room.round]) room.submissions[room.round] = {};
    room.submissions[room.round][socket.id] = t;

    const count = Object.keys(room.submissions[room.round]).length;
    io.to(room.code).emit("submissionUpdate", { round: room.round, count });

    const hints = Object.values(room.submissions[room.round]);
    io.to(room.code).emit("hintsUpdate", { round: room.round, hints });
  });

  socket.on("hostNextPhase", () => {
    if (!joinedRoomCode) return;
    const room = getRoom(joinedRoomCode);
    if (!room || room.hostId !== socket.id) return;
    nextPhase(room);
  });

  socket.on("castVote", ({ targetId }) => {
    if (!joinedRoomCode) return;
    const room = getRoom(joinedRoomCode);
    if (!room || room.status !== "voting") return;
    const me = room.players[socket.id];
    if (!me || !room.players[targetId] || targetId === socket.id) return;

    if (room.votes[socket.id]) {
      socket.emit("toast", { type: "info", message: "Your vote is already recorded." });
      return;
    }

    room.votes[socket.id] = targetId;

    const totalVotes = Object.keys(room.votes).length;
    io.to(room.code).emit("voteCountUpdate", { totalVotes });
  });

  socket.on("hostEndVoting", () => {
    if (!joinedRoomCode) return;
    const room = getRoom(joinedRoomCode);
    if (!room || room.hostId !== socket.id || room.status !== "voting") return;
    finishVoting(room);
  });

  socket.on("impostorGuess", ({ guess }) => {
    if (!joinedRoomCode) return;
    const room = getRoom(joinedRoomCode);
    if (!room) return;
    const me = room.players[socket.id];
    if (!me || !me.isImpostor) return;

    const g = ("" + (guess || "")).trim().toLowerCase();
    const secret = (room.secretPlayer || "").trim().toLowerCase();
    const correct = g && secret && g === secret;

    if (room.status === "finalGuess") {
      room.status = "ended";
      io.to(room.code).emit("gameOver", { winner: correct ? "impostor" : "innocents", reason: correct ? "impostor_final_guess_correct" : "impostor_final_guess_wrong", secret: room.secretPlayer });
    } else if (room.status === "describing" || room.status === "voting") {
      if (correct) {
        room.status = "ended";
        io.to(room.code).emit("gameOver", { winner: "impostor", reason: "impostor_early_guess", secret: room.secretPlayer });
      } else {
        socket.emit("toast", { type: "info", message: "Not correct. Keep trying to blend in." });
      }
    }
  });

  socket.on("hostRestartToLobby", () => {
    if (!joinedRoomCode) return;
    const room = getRoom(joinedRoomCode);
    if (!room || room.hostId !== socket.id) return;

    room.status = "lobby";
    room.round = 0;
    room.secretPlayer = null;
    room.submissions = {};
    room.votes = {};
    io.to(room.code).emit("phaseChange", { phase: "lobby" });
    broadcastLobby(room);
  });

  socket.on("disconnect", () => {
    if (!joinedRoomCode) return;
    const room = getRoom(joinedRoomCode);
    if (!room) return;

    const wasHost = room.hostId === socket.id;
    delete room.players[socket.id];
    socket.leave(joinedRoomCode);

    if (wasHost) {
      const first = Object.keys(room.players)[0];
      if (first) {
        room.hostId = first;
        room.players[first].isHost = true;
        io.to(first).emit("toast", { type: "info", message: "You are the new host." });
      }
    }

    const playerCount = Object.keys(room.players).length;
    if (room.status !== "lobby" && playerCount < 3) {
      room.status = "lobby";
      room.round = 0;
      room.secretPlayer = null;
      room.submissions = {};
      room.votes = {};
      io.to(room.code).emit("toast", { type: "info", message: "Not enough players. Returning to lobby." });
      io.to(room.code).emit("phaseChange", { phase: "lobby" });
    }

    broadcastLobby(room);
    cleanRoomIfEmpty(room);
  });
});

server.listen(PORT, () => {
  console.log(`Soccer Impostor running on port ${PORT}`);
});
