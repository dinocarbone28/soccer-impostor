// client.js
const $ = (sel) => document.querySelector(sel);
const show = (id) => { document.querySelectorAll("section").forEach(s => s.classList.add("hide")); $(id).classList.remove("hide"); };
const toast = (msg, type="info") => { const t=$("#toaster"); t.textContent=msg; t.className=type; setTimeout(()=>{ t.textContent=""; t.className=""; }, 2500); };

const socket = io();

let isHost = false;
let myId = null;
let currentRoomCode = null;
let myRole = { isImpostor: false, secretPlayer: null };
let roundState = { round: 0, maxRounds: 3 };
let roster = []; // [{id,name,isHost}]
let hasVoted = false; // lock vote after casting

// Pre-fill join code if ?room=ABCD
const params = new URLSearchParams(location.search);
const preRoom = (params.get("room") || "").toUpperCase();
if (preRoom) $("#joinCode").value = preRoom;

// HOME buttons
$("#btnHost").onclick = () => {
  const hostName = $("#hostName").value.trim() || "Host";
  const maxPlayers = $("#maxPlayers").value.trim();
  socket.emit("hostCreateRoom", { hostName, maxPlayers });
};

$("#btnJoin").onclick = () => {
  const roomCode = $("#joinCode").value.trim().toUpperCase();
  const name = $("#joinName").value.trim() || "Player";
  socket.emit("joinRoom", { roomCode, name });
};

$("#btnBackHome").onclick = () => location.href = "/";

// LOBBY controls
$("#btnStart").onclick = () => socket.emit("startGame");
$("#btnCopyLink").onclick = async () => {
  const link = `${location.origin}/?room=${currentRoomCode}`;
  await navigator.clipboard.writeText(link);
  toast("Link copied!", "success");
};

// DESCRIBE controls
$("#btnSubmitDesc").onclick = () => {
  const text = $("#descInput").value;
  if (!text.trim()) return;
  socket.emit("submitDescription", { text });
  $("#descInput").value = "";
  toast("Hint submitted!", "success");
};
$("#btnNextPhase").onclick = () => socket.emit("hostNextPhase");

// VOTE controls
$("#btnEndVoting").onclick = () => socket.emit("hostEndVoting");

// FINAL GUESS (after eject)
$("#btnGuess").onclick = () => {
  const guess = $("#guessInput").value.trim();
  if (!guess) return;
  socket.emit("impostorGuess", { guess });
};

// RESULTS controls
$("#btnRestart").onclick = () => socket.emit("hostRestartToLobby");

// --- Socket listeners ---
socket.on("toast", ({ type, message }) => toast(message, type));

socket.on("roomCreated", ({ code }) => {
  isHost = true;
  currentRoomCode = code;
  myId = socket.id;
  $("#roomCodeBadge").textContent = `#${code}`;
  $("#shareLinkRow").textContent = `Share this link: ${location.origin}/?room=${code}`;
  $("#hostControls").classList.remove("hide");
  show("#lobby");
});

socket.on("joinedRoom", ({ code, you }) => {
  isHost = false;
  currentRoomCode = code;
  myId = you.id;
  $("#roomCodeBadge").textContent = `#${code}`;
  $("#shareLinkRow").textContent = `Ask the host for the link: ${location.origin}/?room=${code}`;
  $("#hostControls").classList.add("hide");
  show("#lobby");
});

socket.on("joinError", ({ message }) => toast(message, "error"));

socket.on("lobbyUpdate", ({ code, players }) => {
  currentRoomCode = code;
  roster = players.slice();

  $("#playerList").innerHTML = "";
  roster.forEach(p => {
    const li = document.createElement("li");
    li.textContent = `${p.name}${p.isHost ? " (Host)" : ""}`;
    $("#playerList").appendChild(li);
    if (p.id === socket.id) isHost = !!p.isHost;
  });

  document.querySelectorAll(".hostOnly").forEach(el => {
    if (isHost) el.classList.remove("hide"); else el.classList.add("hide");
  });
});

socket.on("roleAssigned", ({ isImpostor, secretPlayer, round, maxRounds }) => {
  myRole.isImpostor = !!isImpostor;
  myRole.secretPlayer = secretPlayer || null;
  roundState.round = round;
  roundState.maxRounds = maxRounds;

  // Badge visibility
  document.getElementById("impostorBadge").classList.toggle("hide", !myRole.isImpostor);

  $("#roleText").textContent = isImpostor ? "You are the Impostor." : "You are Innocent.";
  $("#secretText").textContent = isImpostor ? "You do NOT know the secret player." : `Secret Player: ${secretPlayer}`;
  $("#roundInfo").textContent = `Round ${round} of ${maxRounds}`;

  // Prepare big secret name for innocents
  if (!myRole.isImpostor && myRole.secretPlayer) {
    const el = document.getElementById("secretBig");
    if (el) { el.textContent = myRole.secretPlayer; el.classList.remove("hide"); }
    const elVote = document.getElementById("secretBigVote");
    if (elVote) { elVote.textContent = myRole.secretPlayer; elVote.classList.add("hide"); }
  } else {
    const el = document.getElementById("secretBig"); if (el) { el.classList.add("hide"); el.textContent = ""; }
    const elVote = document.getElementById("secretBigVote"); if (elVote) { elVote.classList.add("hide"); elVote.textContent = ""; }
  }

  show("#role");
  setTimeout(() => show("#describe"), 900);
});

socket.on("phaseChange", ({ phase, round, maxRounds }) => {
  roundState.round = round || roundState.round;
  roundState.maxRounds = maxRounds || roundState.maxRounds;

  if (phase === "lobby") {
    hasVoted = false;
    document.getElementById("impostorBadge").classList.toggle("hide", !myRole.isImpostor);
    const el = document.getElementById("secretBig"); if (el) { el.classList.add("hide"); el.textContent = ""; }
    const elVote = document.getElementById("secretBigVote"); if (elVote) { elVote.classList.add("hide"); elVote.textContent = ""; }
    show("#lobby");
  } else if (phase === "describing") {
    hasVoted = false;
    $("#hintList").innerHTML = ""; // clear hints each round
    $("#subCount").textContent = `Round ${roundState.round}/${roundState.maxRounds} — 0 submitted`;
    if (!myRole.isImpostor && myRole.secretPlayer) {
      const el = document.getElementById("secretBig");
      if (el) { el.textContent = myRole.secretPlayer; el.classList.remove("hide"); }
    } else {
      const el = document.getElementById("secretBig"); if (el) { el.classList.add("hide"); el.textContent = ""; }
    }
    const elVote = document.getElementById("secretBigVote"); if (elVote) { elVote.classList.add("hide"); elVote.textContent = ""; }
    show("#describe");
  } else if (phase === "voting") {
    hasVoted = false; // can vote once
    buildVoteList();
    $("#voteCount").textContent = "Votes: 0";
    if (!myRole.isImpostor && myRole.secretPlayer) {
      const elVote = document.getElementById("secretBigVote");
      if (elVote) { elVote.textContent = myRole.secretPlayer; elVote.classList.remove("hide"); }
    } else {
      const elVote = document.getElementById("secretBigVote"); if (elVote) { elVote.classList.add("hide"); elVote.textContent = ""; }
    }
    const el = document.getElementById("secretBig"); if (el) { el.classList.add("hide"); }
    show("#vote");
  } else if (phase === "finalGuess") {
    const el = document.getElementById("secretBig"); if (el) { el.classList.add("hide"); el.textContent = ""; }
    const elVote = document.getElementById("secretBigVote"); if (elVote) { elVote.classList.add("hide"); elVote.textContent = ""; }
    if (myRole.isImpostor) {
      $("#guessInput").value = "";
      show("#finalGuess");
    } else {
      $("#resultText").textContent = "Impostor is making a final guess...";
      $("#revealSecret").textContent = "";
      show("#results");
    }
  }

  // Toggle host controls
  document.querySelectorAll(".hostOnly").forEach(el => {
    if (isHost) el.classList.remove("hide"); else el.classList.add("hide");
  });
});

socket.on("submissionUpdate", ({ round, count }) => {
  $("#subCount").textContent = `Round ${round}/${roundState.maxRounds} — ${count} submitted`;
});

// receive live hints for the round
socket.on("hintsUpdate", ({ round, hints }) => {
  if (round !== roundState.round) return;
  const list = $("#hintList");
  list.innerHTML = "";
  hints.forEach(h => {
    const li = document.createElement("li");
    li.textContent = h;
    list.appendChild(li);
  });
});

socket.on("voteCountUpdate", ({ totalVotes }) => {
  $("#voteCount").textContent = `Votes: ${totalVotes}`;
});

socket.on("voteResults", ({ ejectedId, ejectedName }) => {
  if (!ejectedId) {
    $("#resultText").textContent = "No one was ejected. Impostor gets a final guess!";
  } else {
    $("#resultText").textContent = `${ejectedName} was ejected.`;
  }
  $("#revealSecret").textContent = "";
  const el = document.getElementById("secretBig"); if (el) { el.classList.add("hide"); el.textContent = ""; }
  const elVote = document.getElementById("secretBigVote"); if (elVote) { elVote.classList.add("hide"); elVote.textContent = ""; }
  show("#results");
});

socket.on("yourFinalGuess", () => {
  if (myRole.isImpostor) show("#finalGuess");
});

socket.on("gameOver", ({ winner, reason, secret }) => {
  let text = winner === "impostor" ? "Impostor WINS!" : "Innocents WIN!";
  const why = {
    wrong_vote: "Innocents voted wrong.",
    impostor_early_guess: "Impostor guessed the secret during play.",
    impostor_final_guess_correct: "Impostor guessed correctly after being ejected.",
    impostor_final_guess_wrong: "Impostor guessed wrong after being ejected."
  }[reason] || "";
  $("#resultText").textContent = `${text} ${why}`;
  $("#revealSecret").textContent = secret ? `Secret Player was: ${secret}` : "";
  const el = document.getElementById("secretBig"); if (el) { el.classList.add("hide"); el.textContent = ""; }
  const elVote = document.getElementById("secretBigVote"); if (elVote) { elVote.classList.add("hide"); elVote.textContent = ""; }
  show("#results");
});

// Helpers
function buildVoteList() {
  const list = $("#voteList");
  list.innerHTML = "";
  roster
    .filter(p => p.id !== myId) // cannot vote yourself
    .forEach(p => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.textContent = `Vote ${p.name}`;
      btn.disabled = hasVoted;
      btn.onclick = () => {
        if (hasVoted) return;
        socket.emit("castVote", { targetId: p.id });
        hasVoted = true;
        list.querySelectorAll("button").forEach(b => b.disabled = true);
        toast(`Voted for ${p.name}`, "success");
      };
      li.appendChild(btn);
      list.appendChild(li);
    });
}
