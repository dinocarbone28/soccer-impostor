// public/client.js
(function () {
  const $ = (sel) => document.querySelector(sel);
  const show = (id) => {
    document.querySelectorAll("section").forEach((s) => s.classList.add("hide"));
    $(id).classList.remove("hide");
  };
  const toast = (msg, type = "info") => {
    const t = $("#toaster");
    t.textContent = msg;
    t.className = type;
    setTimeout(() => {
      t.textContent = "";
      t.className = "";
    }, 2000);
  };

  // Socket
  const socket = io();

  // State
  let isHost = false;
  let myId = null;
  let currentRoomCode = null;
  let myRole = { isImpostor: false, secretPlayer: null };
  let roundState = { round: 0, maxRounds: 3 };
  let roster = [];
  let aliveRoster = [];
  let hasVoted = false;
  let youAlive = true;

  // ===== Role/Secret banners (NEW) =====
  function updateSecretBanner() {
    const impRole = $("#impostorBadge"); // role reveal screen
    const impDescribe = $("#impostorBadgeDescribe");
    const impVote = $("#impostorBadgeVote");
    const secretDescribe = $("#secretBig");
    const secretVote = $("#secretBigVote");

    if (myRole.isImpostor) {
      impRole?.classList.remove("hide");
      impDescribe?.classList.remove("hide");
      impVote?.classList.remove("hide");

      [secretDescribe, secretVote].forEach((el) => {
        if (!el) return;
        el.textContent = "";
        el.classList.add("hide");
      });
    } else {
      impRole?.classList.add("hide");
      impDescribe?.classList.add("hide");
      impVote?.classList.add("hide");

      [secretDescribe, secretVote].forEach((el) => {
        if (!el) return;
        el.textContent = myRole.secretPlayer || "";
        myRole.secretPlayer ? el.classList.remove("hide") : el.classList.add("hide");
      });
    }
  }

  // ===== Buttons =====
  $("#createRoomBtn")?.addEventListener("click", () => {
    const hostName = ($("#hostName")?.value || "Host").trim();
    const maxPlayers = ($("#maxPlayers")?.value || "8").trim();
    socket.emit("hostCreateRoom", { hostName, maxPlayers });
  });

  $("#joinRoomBtn")?.addEventListener("click", () => {
    const roomCode = ($("#joinCode")?.value || "").toUpperCase().trim();
    const name = ($("#joinName")?.value || "Player").trim();
    socket.emit("joinRoom", { roomCode, name });
  });

  $("#btnCopyLink")?.addEventListener("click", async () => {
    if (!currentRoomCode) return;
    const link = `${location.origin}/?room=${currentRoomCode}`;
    try {
      await navigator.clipboard.writeText(link);
      toast("Link copied!", "success");
    } catch {
      toast(link, "info");
    }
  });

  $("#btnStart")?.addEventListener("click", () => socket.emit("startGame"));

  $("#btnSubmitDesc")?.addEventListener("click", () => {
    if (!youAlive) {
      alert("You were eliminated.");
      return;
    }
    const text = ($("#descInput")?.value || "").trim();
    if (!text) return;
    socket.emit("submitDescription", { text });
    $("#descInput").value = "";
    toast("Hint submitted!", "success");
  });

  $("#btnNextPhase")?.addEventListener("click", () => socket.emit("hostNextPhase"));
  $("#btnEndVoting")?.addEventListener("click", () => socket.emit("hostEndVoting"));

  $("#btnGuess")?.addEventListener("click", () => {
    const guess = ($("#guessInput")?.value || "").trim();
    if (!guess) return;
    socket.emit("impostorGuess", { guess });
  });

  $("#btnRestart")?.addEventListener("click", () => socket.emit("hostRestartToLobby"));

  // ===== Socket Events =====
  socket.on("toast", ({ type, message }) => toast(message, type));

  socket.on("roomCreated", ({ code }) => {
    isHost = true;
    currentRoomCode = code;
    myId = socket.id;
    $("#roomCodeBadge").textContent = `#${code}`;
    $("#shareLinkRow").textContent = `Share this link: ${location.origin}/?room=${code}`;
    document.querySelectorAll(".hostOnly").forEach((el) => el.classList.remove("hide"));
    show("#lobby");
  });

  socket.on("joinedRoom", ({ code, you }) => {
    isHost = false;
    currentRoomCode = code;
    myId = you?.id || socket.id;
    $("#roomCodeBadge").textContent = `#${code}`;
    $("#shareLinkRow").textContent = `Ask the host for the link: ${location.origin}/?room=${code}`;
    document.querySelectorAll(".hostOnly").forEach((el) => el.classList.add("hide"));
    show("#lobby");
  });

  socket.on("joinError", ({ message }) => toast(message, "error"));

  socket.on("lobbyUpdate", ({ code, players }) => {
    currentRoomCode = code;
    roster = players.slice();
    const ul = $("#playerList");
    ul.innerHTML = "";
    roster.forEach((p) => {
      const li = document.createElement("li");
      li.textContent = `${p.name}${p.isHost ? " (Host)" : ""}${p.alive === false ? " — eliminated" : ""}`;
      ul.appendChild(li);
      if (p.id === socket.id) isHost = !!p.isHost;
    });
    document.querySelectorAll(".hostOnly").forEach((el) =>
      isHost ? el.classList.remove("hide") : el.classList.add("hide")
    );
  });

  socket.on("aliveUpdate", ({ players }) => {
    aliveRoster = players.slice();
    youAlive = !!aliveRoster.find((p) => p.id === socket.id);
  });

  socket.on("roleAssigned", ({ isImpostor, secretPlayer, round, maxRounds }) => {
    myRole.isImpostor = !!isImpostor;
    myRole.secretPlayer = secretPlayer || null;
    roundState.round = round;
    roundState.maxRounds = maxRounds;
    youAlive = true;

    // role screen text
    $("#roleText").textContent = isImpostor ? "You are the Impostor." : "You are Innocent.";
    $("#secretText").textContent = isImpostor
      ? "You do NOT know the secret player."
      : `Secret Player: ${secretPlayer}`;
    $("#roundInfo").textContent = `Round ${round}/${maxRounds}`;

    // update banners everywhere it matters
    updateSecretBanner();

    show("#role");
    setTimeout(() => show("#describe"), 800);
  });

  socket.on("phaseChange", ({ phase, round, maxRounds }) => {
    if (round) roundState.round = round;
    if (maxRounds) roundState.maxRounds = maxRounds;

    if (phase === "lobby") {
      hasVoted = false;
      // hide banners in lobby/results
      ["#secretBig", "#secretBigVote"].forEach((id) => {
        const el = $(id);
        if (el) {
          el.textContent = "";
          el.classList.add("hide");
        }
      });
      ["#impostorBadgeDescribe", "#impostorBadgeVote"].forEach((id) => $(id)?.classList.add("hide"));
      show("#lobby");
    } else if (phase === "describing") {
      hasVoted = false;
      $("#hintList").innerHTML = "";
      $("#subCount").textContent = `Round ${roundState.round}/${roundState.maxRounds} — 0 submitted`;

      updateSecretBanner(); // SHOW secret/impostor on describe
      show("#describe");
    } else if (phase === "voting") {
      hasVoted = false;
      buildVoteList();
      $("#voteCount").textContent = "Votes: 0";

      updateSecretBanner(); // SHOW secret/impostor on vote
      show("#vote");
    } else if (phase === "finalGuess") {
      // clear banners here (finalGuess/results handled separately)
      ["#secretBig", "#secretBigVote"].forEach((id) => $(id)?.classList.add("hide"));
      ["#impostorBadgeDescribe", "#impostorBadgeVote"].forEach((id) => $(id)?.classList.add("hide"));

      if (myRole.isImpostor) show("#finalGuess");
      else {
        $("#resultText").textContent = "Impostor is making a final guess...";
        $("#revealSecret").textContent = "";
        show("#results");
      }
    }
    document.querySelectorAll(".hostOnly").forEach((el) =>
      isHost ? el.classList.remove("hide") : el.classList.add("hide")
    );
  });

  socket.on("submissionUpdate", ({ round, count }) => {
    $("#subCount").textContent = `Round ${round}/${roundState.maxRounds} — ${count} submitted`;
  });

  socket.on("hintsUpdate", ({ round, hints }) => {
    if (round !== roundState.round) return;
    const list = $("#hintList");
    list.innerHTML = "";
    hints.forEach((h) => {
      const li = document.createElement("li");
      li.textContent = h;
      list.appendChild(li);
    });
  });

  socket.on("voteCountUpdate", ({ totalVotes }) => {
    $("#voteCount").textContent = `Votes: ${totalVotes}`;
  });

  socket.on("voteResults", ({ ejectedId, ejectedName, neededForMajority }) => {
    const needText = neededForMajority ? ` (needed ${neededForMajority})` : "";
    $("#resultText").textContent = ejectedId
      ? `${ejectedName} was ejected${needText}.`
      : `No majority${needText}. Back to hints.`;
    $("#revealSecret").textContent = "";

    // hide banners on results
    ["#secretBig", "#secretBigVote"].forEach((id) => {
      const el = $(id);
      if (el) {
        el.textContent = "";
        el.classList.add("hide");
      }
    });
    ["#impostorBadgeDescribe", "#impostorBadgeVote"].forEach((id) => $(id)?.classList.add("hide"));

    show("#results");
  });

  socket.on("playerEliminated", ({ id, name }) => {
    if (id === myId) {
      youAlive = false;
      toast("You were eliminated.", "error");
    } else {
      toast(`${name} was eliminated.`, "info");
    }
  });

  socket.on("youEliminated", () => {
    youAlive = false;
    hasVoted = true;
    alert("You were voted off.");
  });

  socket.on("gameOver", ({ winner, reason, secret }) => {
    let text = winner === "impostor" ? "Impostor WINS!" : "Innocents WIN!";
    const why =
      {
        wrong_vote: "Innocents voted wrong.",
        impostor_early_guess: "Impostor guessed during play.",
        impostor_final_guess_correct: "Impostor guessed correctly after being ejected.",
        impostor_final_guess_wrong: "Impostor guessed wrong after being ejected.",
        impostor_ejected: "Impostor was ejected.",
        impostor_outnumbers: "Impostor outnumbers civilians.",
      }[reason] || "";
    $("#resultText").textContent = `${text} ${why}`;
    $("#revealSecret").textContent = secret ? `Secret Player was: ${secret}` : "";

    // clear banners
    ["#secretBig", "#secretBigVote"].forEach((id) => $(id)?.classList.add("hide"));
    ["#impostorBadgeDescribe", "#impostorBadgeVote"].forEach((id) => $(id)?.classList.add("hide"));

    show("#results");
  });

  function buildVoteList() {
    const list = $("#voteList");
    list.innerHTML = "";
    const src = (aliveRoster && aliveRoster.length) ? aliveRoster : roster.filter((p) => p.alive !== false);
    src
      .filter((p) => p.id !== socket.id)
      .forEach((p) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.textContent = `Vote ${p.name}`;
        btn.className = "primary";
        btn.disabled = hasVoted || !youAlive;
        btn.onclick = () => {
          if (hasVoted || !youAlive) return;
          socket.emit("castVote", { targetId: p.id });
          hasVoted = true;
          list.querySelectorAll("button").forEach((b) => (b.disabled = true));
          toast(`Voted for ${p.name}`, "success");
        };
        li.appendChild(btn);
        list.appendChild(li);
      });
  }

  // === Auto-join support if url has ?room=CODE ===
  (function autoJoinFromQuery() {
    const p = new URLSearchParams(location.search);
    const code = (p.get("room") || "").toUpperCase();
    if (code) {
      show("#home"); // visible inputs
      $("#joinCode").value = code;
    }
  })();
})();
