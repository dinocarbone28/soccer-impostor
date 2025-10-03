// server.js — Express + Socket.IO (CommonJS)
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ---------- Player pool (ASCII only) ----------
const PLAYER_POOL = [
  "Lionel Messi","Kylian Mbappe","Erling Haaland","Vinicius Junior","Mohamed Salah","Harry Kane",
  "Jude Bellingham","Lautaro Martinez","Antoine Griezmann","Robert Lewandowski","Son Heung-min",
  "Bukayo Saka","Jamal Musiala","Florian Wirtz","Rafael Leao","Khvicha Kvaratskhelia","Rodrygo",
  "Ousmane Dembele","Leroy Sane","Kingsley Coman","Marcus Rashford","Jack Grealish","Christopher Nkunku",
  "Kai Havertz","Joao Felix","Darwin Nunez","Victor Osimhen","Alexander Isak","Randal Kolo Muani",
  "Dusan Vlahovic","Alvaro Morata","Federico Chiesa","Julian Alvarez","Paulo Dybala","Angel Di Maria",
  "Kenan Yildiz","Dayro Moreno",
  "Kevin De Bruyne","Bernardo Silva","Martin Odegaard","Bruno Fernandes","Federico Valverde","Pedri","Gavi",
  "Frenkie de Jong","Ilkay Gundogan","Toni Kroos","Luka Modric","Declan Rice","Casemiro","Adrien Rabiot",
  "Nicolo Barella","Hakan Calhanoglu","Sandro Tonali","Sergej Milinkovic-Savic","James Maddison","Mason Mount",
  "Dominik Szoboszlai","Dani Olmo","Youssouf Fofana","Aurelien Tchouameni","Eduardo Camavinga","Marco Verratti",
  "Martin Zubimendi","Mikel Merino","Alexis Mac Allister","Enzo Fernandez","Moises Caicedo","Joao Palhinha",
  "Teun Koopmeiners","Scott McTominay","Weston McKennie","Christian Pulisic","Giovanni Reyna","Luis Diaz",
  "Rodrigo De Paul","Leandro Paredes",
  "Virgil van Dijk","Ruben Dias","Marquinhos","Eder Militao","David Alaba","William Saliba","Josko Gvardiol",
  "Antonio Rudiger","Matthijs de Ligt","Milan Skriniar","Kim Min-jae","Dayot Upamecano","Ronald Araujo",
  "Jules Kounde","Raphael Varane","Pau Cubarsi","Alejandro Balde","Giovanni Di Lorenzo","Khephren Thuram",
  "Joshua Kimmich","Leon Goretzka","Benjamin Pavard","Raphael Guerreiro",
  "Joao Cancelo","Trent Alexander-Arnold","Andrew Robertson","Achraf Hakimi","Theo Hernandez","Alphonso Davies",
  "Reece James","Dani Carvajal",
  "Emiliano Dibu Martinez","Thibaut Courtois","Alisson Becker","Ederson","Mike Maignan","Marc-Andre ter Stegen",
  "Jan Oblak","Andre Onana","Diogo Costa","Yassine Bounou",
  "Nico Williams","Alejandro Garnacho","Cole Palmer","Xavi Simons","Rodrigo Bentancur","Nicolo Fagioli",
  "Joao Neves","Lamine Yamal"
];

// ---------- In-memory state ----------
/*
rooms = {
  CODE: {
    code, hostId, maxPlayers,
    status: 'lobby'|'describing'|'voting'|'ended',
    round, secretPlayer,
    players: { id: {id,name,isHost,isImpostor,alive} },
    submissions: { [round]: { socketId: "hint" } },
    votes: { voterId: targetId }
  }
}
*/
const rooms = {};
const getRoom = c => rooms[c];
const livingPlayers = r => Object.values(r.players).filter(p => p.alive);
const aliveCount   = r => livingPlayers(r).length;

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do { code = Array.from({length:4},()=>alphabet[Math.floor(Math.random()*alphabet.length)]).join(""); }
  while (rooms[code]);
  return code;
}

function roomPlayerList(room){
  return Object.values(room.players).map(p => ({
    id:p.id, name:p.name, isHost:!!p.isHost, alive:!!p.alive
  }));
}
function broadcastLobby(room){
  io.to(room.code).emit("lobbyUpdate", { code:room.code, players:roomPlayerList(room), maxPlayers:room.maxPlayers });
}
function broadcastAlive(room){
  io.to(room.code).emit("aliveUpdate", {
    players: livingPlayers(room).map(p=>({id:p.id,name:p.name}))
  });
}

function startGame(room){
  const ids = Object.keys(room.players);
  if(ids.length<3) return {ok:false,error:"Need at least 3 players."};

  ids.forEach(id=>{ room.players[id].alive=true; room.players[id].isImpostor=false; });
  room.secretPlayer = PLAYER_POOL[Math.floor(Math.random()*PLAYER_POOL.length)];
  const impostorId = ids[Math.floor(Math.random()*ids.length)];
  room.players[impostorId].isImpostor = true;

  room.status="describing";
  room.round=1;
  room.submissions={};
  room.votes={};

  ids.forEach(id=>{
    const s = io.sockets.sockets.get(id);
    if(!s) return;
    s.emit("roleAssigned", {
      isImpostor: room.players[id].isImpostor,
      secretPlayer: room.players[id].isImpostor?null:room.secretPlayer,
      round:1, maxRounds:3
    });
  });

  broadcastAlive(room);
  io.to(room.code).emit("phaseChange", { phase:"describing", round:1, maxRounds:3 });
  return {ok:true};
}

function nextPhase(room){
  if(room.status==="describing"){
    room.status="voting";
    room.votes={};
    io.to(room.code).emit("phaseChange", { phase:"voting", round:room.round, maxRounds:3 });
    broadcastAlive(room);
  }else if(room.status==="voting"){
    finishVoting(room);
  }
}

function strictMajorityNeeded(room){
  return Math.floor(aliveCount(room)/2)+1;
}

function checkWin(room){
  const alive = livingPlayers(room);
  const impostorAlive = alive.find(p=>p.isImpostor);
  if(!impostorAlive){
    room.status="ended";
    io.to(room.code).emit("gameOver",{winner:"innocents",reason:"impostor_ejected",secret:room.secretPlayer});
    return true;
  }
  if(alive.length<=2){
    room.status="ended";
    io.to(room.code).emit("gameOver",{winner:"impostor",reason:"impostor_outnumbers",secret:room.secretPlayer});
    return true;
  }
  return false;
}

function finishVoting(room){
  const tally={};
  for(const voterId of Object.keys(room.votes)){
    const voter  = room.players[voterId];
    const targetId = room.votes[voterId];
    const target = room.players[targetId];
    if(!voter||!voter.alive) continue;
    if(!target||!target.alive) continue;
    tally[targetId]=(tally[targetId]||0)+1;
  }

  const needed = strictMajorityNeeded(room);
  let ejectedId=null;
  for(const tId of Object.keys(tally)){
    if(tally[tId] >= needed){ ejectedId=tId; break; }
  }

  const ejected = ejectedId?room.players[ejectedId]:null;
  io.to(room.code).emit("voteResults",{
    ejectedId, ejectedName: ejected?ejected.name:null, votes:tally, neededForMajority:needed
  });

  if(!ejectedId){
    room.status="describing";
    room.round+=1; room.submissions={}; room.votes={};
    io.to(room.code).emit("phaseChange",{phase:"describing",round:room.round,maxRounds:3});
    return;
  }

  // eliminate
  room.players[ejectedId].alive=false;
  io.to(ejectedId).emit("youEliminated",{reason:"voted_off"});
  io.to(room.code).emit("playerEliminated",{id:ejectedId,name:room.players[ejectedId].name});

  if(room.players[ejectedId].isImpostor){
    room.status="ended";
    io.to(room.code).emit("gameOver",{winner:"innocents",reason:"impostor_ejected",secret:room.secretPlayer});
    return;
  }

  if(checkWin(room)) return;

  room.status="describing";
  room.round+=1; room.submissions={}; room.votes={};
  io.to(room.code).emit("phaseChange",{phase:"describing",round:room.round,maxRounds:3});
}

// ---------- Sockets ----------
io.on("connection",(socket)=>{
  let joined=null;

  socket.on("hostCreateRoom",({hostName,maxPlayers})=>{
    const code=generateRoomCode();
    rooms[code]={
      code, hostId:socket.id, maxPlayers:Math.max(3,Math.min(Number(maxPlayers)||8,12)),
      status:"lobby", round:0, secretPlayer:null, players:{}, submissions:{}, votes:{}
    };
    const room=rooms[code];
    room.players[socket.id]={id:socket.id,name:(hostName||"Host").slice(0,20),isHost:true,isImpostor:false,alive:true};
    joined=code; socket.join(code);
    socket.emit("roomCreated",{code});
    broadcastLobby(room);
  });

  socket.on("joinRoom",({roomCode,name})=>{
    const code=(roomCode||"").toUpperCase().trim();
    const room=getRoom(code);
    if(!room) return socket.emit("joinError",{message:"Room not found."});
    if(Object.keys(room.players).length>=room.maxPlayers) return socket.emit("joinError",{message:"Room is full."});
    if(room.status!=="lobby") return socket.emit("joinError",{message:"Game already started."});

    room.players[socket.id]={id:socket.id,name:(name||"Player").slice(0,20),isHost:false,isImpostor:false,alive:true};
    joined=code; socket.join(code);
    socket.emit("joinedRoom",{code,you:{id:socket.id,name:room.players[socket.id].name}});
    broadcastLobby(room);
  });

  socket.on("startGame",()=>{
    if(!joined) return;
    const room=getRoom(joined);
    if(!room||room.hostId!==socket.id) return;
    const res=startGame(room);
    if(!res.ok) socket.emit("toast",{type:"error",message:res.error});
  });

  socket.on("submitDescription",({text})=>{
    if(!joined) return;
    const room=getRoom(joined);
    if(!room||room.status!=="describing") return;
    const me=room.players[socket.id];
    if(!me||!me.alive) return;
    const t=(""+(text||"")).trim().slice(0,80);
    if(!t) return;
    if(!room.submissions[room.round]) room.submissions[room.round]={};
    room.submissions[room.round][socket.id]=t;
    const count=Object.keys(room.submissions[room.round]).length;
    io.to(room.code).emit("submissionUpdate",{round:room.round,count});
    const hints=Object.values(room.submissions[room.round]);
    io.to(room.code).emit("hintsUpdate",{round:room.round,hints});
  });

  socket.on("hostNextPhase",()=>{
    if(!joined) return;
    const room=getRoom(joined);
    if(!room||room.hostId!==socket.id) return;
    nextPhase(room);
  });

  socket.on("castVote",({targetId})=>{
    if(!joined) return;
    const room=getRoom(joined);
    if(!room||room.status!=="voting") return;
    const me=room.players[socket.id]; const target=room.players[targetId];
    if(!me||!me.alive||!target||!target.alive||targetId===socket.id) return;
    if(room.votes[socket.id]){ socket.emit("toast",{type:"info",message:"Your vote is already recorded."}); return; }
    room.votes[socket.id]=targetId;
    const totalVotes = Object.keys(room.votes).filter(vId=>room.players[vId]&&room.players[vId].alive).length;
    io.to(room.code).emit("voteCountUpdate",{totalVotes});
  });

  socket.on("hostEndVoting",()=>{
    if(!joined) return;
    const room=getRoom(joined);
    if(!room||room.hostId!==socket.id||room.status!=="voting") return;
    finishVoting(room);
  });

  socket.on("hostRestartToLobby",()=>{
    if(!joined) return;
    const room=getRoom(joined);
    if(!room||room.hostId!==socket.id) return;
    room.status="lobby"; room.round=0; room.secretPlayer=null; room.submissions={}; room.votes={};
    io.to(room.code).emit("phaseChange",{phase:"lobby"}); broadcastLobby(room);
  });

  socket.on("disconnect",()=>{
    if(!joined) return;
    const room=getRoom(joined); if(!room) return;
    const wasHost = room.hostId===socket.id;
    delete room.players[socket.id]; socket.leave(joined);

    if(wasHost){
      const first = Object.keys(room.players)[0];
      if(first){ room.hostId=first; room.players[first].isHost=true; io.to(first).emit("toast",{type:"info",message:"You are the new host."}); }
    }

    if(room.status!=="lobby" && aliveCount(room)<3){
      room.status="lobby"; room.round=0; room.secretPlayer=null; room.submissions={}; room.votes={};
      io.to(room.code).emit("toast",{type:"info",message:"Not enough players. Back to lobby."});
      io.to(room.code).emit("phaseChange",{phase:"lobby"});
    }else{
      broadcastAlive(room);
    }

    broadcastLobby(room);
    if(Object.keys(room.players).length===0) delete rooms[room.code];
  });
});

server.listen(PORT, ()=> {
  console.log(`Soccer Impostor running on http://localhost:${PORT}`);
});
