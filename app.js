
/* Artist Chain — MVP */

const CONFIG = {
  supabaseUrl: "https://ngibhruxpeawcfhpgceh.supabase.co",
  supabaseAnonKey: "sb_publishable_aJegxcTVMOnvak_IMxRVVw_eSwOet1h"
};

const $ = (id) => document.getElementById(id);
const screens = ["home", "game", "result"];

let mode = "local";
let state = null;
let supabaseClient = null;
let channel = null;
let roomId = null;
let myPlayerId = null;
let busy = false;

function showScreen(id) {
  screens.forEach(s => $(s).classList.toggle("hidden", s !== id));
  window.scrollTo(0, 0);
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

function cleanName(s) {
  return s.trim().replace(/\s+/g, " ");
}

function norm(s) {
  return cleanName(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function setMode(m) {
  mode = m;

  document.querySelectorAll(".mode-btn").forEach(b =>
    b.classList.toggle("selected", b.dataset.mode === m)
  );

  $("local-options").classList.toggle("hidden", m !== "local");
  $("online-options").classList.toggle("hidden", m !== "online");
  $("start-local").classList.toggle("hidden", m !== "local");
}

document.querySelectorAll(".mode-btn").forEach(b =>
  b.addEventListener("click", () => setMode(b.dataset.mode))
);

function newState(names) {
  return {
    players: names.map((name, i) => ({
      id: "p" + i,
      name,
      alive: true,
      score: 0
    })),
    turn: 0,
    chain: [],
    status: "playing",
    lastEvidence: null,
    turnNo: 1,
    createdAt: Date.now()
  };
}

function activePlayers() {
  return state.players.filter(p => p.alive);
}

function currentPlayer() {
  return state.players[state.turn];
}

function nextAliveIndex(from) {
  for (let i = 1; i <= state.players.length; i++) {
    const j = (from + i) % state.players.length;
    if (state.players[j].alive) return j;
  }

  return from;
}

function startLocal() {
  const names = $("player-names").value
    .split("\n")
    .map(cleanName)
    .filter(Boolean);

  if (names.length < 2) {
    toast("Inserisci almeno due giocatori.");
    return;
  }

  if (names.length > 12) {
    toast("Per questa versione il massimo è 12 giocatori.");
    return;
  }

  mode = "local";
  roomId = null;
  state = newState(names);

  renderGame();
  showScreen("game");
  $("artist-answer").focus();
}

$("start-local").addEventListener("click", startLocal);

$("answer-form").addEventListener("submit", e => {
  e.preventDefault();
  roomId ? onlineSubmit() : submitAnswer();
});

$("quit-game").addEventListener("click", () => {
  if (confirm("Vuoi uscire dalla partita?")) {
    if (channel) supabaseClient.removeChannel(channel);

    channel = null;
    state = null;
    roomId = null;

    showScreen("home");
  }
});

$("new-game").addEventListener("click", () => {
  state = null;
  roomId = null;
  showScreen("home");
});

/* --------------------------------
   VERIFICA DEI COLLEGAMENTI
-------------------------------- */

async function verifyConnection(previous, candidate) {
  const endpoint = CONFIG.supabaseUrl
    ? `${CONFIG.supabaseUrl}/functions/v1/verify`
    : "";

  if (!endpoint) {
    return {
      status: "inconclusive",
      message: "Il servizio di verifica non è configurato."
    };
  }

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": CONFIG.supabaseAnonKey,
      "Authorization": `Bearer ${CONFIG.supabaseAnonKey}`
    },
    body: JSON.stringify({
      artistA: previous,
      artistB: candidate
    })
  });

  if (!r.ok) {
    throw new Error(
      "Servizio di verifica non disponibile (" + r.status + ")."
    );
  }

  return await r.json();
}

/* --------------------------------
   FEEDBACK E PROVE
-------------------------------- */

function showFeedback(kind, msg) {
  const f = $("feedback");

  f.className = "feedback " + kind;
  f.textContent = msg;
  f.classList.remove("hidden");
}

function showEvidence(result) {
  const box = $("evidence");

  if (!result) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }

  const evidence = result.evidence;
  const wikipedia = Array.isArray(result.wikipedia)
    ? result.wikipedia
    : [];

  let html = "";

  if (evidence) {
    html += `
      <div class="evidence-main">
        <strong>Collegamento documentato</strong>
        <p class="evidence-title">${escapeHtml(evidence.title || "Pubblicazione condivisa")}</p>
        <p>
          ${evidence.year ? "Anno: " + escapeHtml(evidence.year) : ""}
          ${evidence.country ? " · Paese: " + escapeHtml(evidence.country) : ""}
        </p>
        <p class="evidence-source">
          Fonte: ${escapeHtml(evidence.source || "MusicBrainz")}
        </p>
        ${
          evidence.url
            ? `<a href="${escapeHtml(evidence.url)}" target="_blank" rel="noopener noreferrer">Consulta la pubblicazione ↗</a>`
            : ""
        }
      </div>
    `;
  }

  if (wikipedia.length) {
    html += `
      <div class="evidence-wikipedia">
        <strong>Riscontri Wikipedia da controllare</strong>
        <p>Questi risultati sono riferimenti aggiuntivi, non prove automatiche di una collaborazione.</p>
        <ul>
          ${wikipedia.map(item => `
            <li>
              <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
                ${escapeHtml(item.title)}
              </a>
              ${item.snippet ? `<p>${escapeHtml(item.snippet)}</p>` : ""}
            </li>
          `).join("")}
        </ul>
      </div>
    `;
  }

  if (!html) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }

  box.innerHTML = html;
  box.classList.remove("hidden");
}

/* --------------------------------
   GESTIONE DELLA PARTITA
-------------------------------- */

async function submitAnswer() {
  if (busy || !state || state.status !== "playing") return;

  const candidate = cleanName($("artist-answer").value);

  if (!candidate) return;

  if (!state.chain.length) {
    state.chain.push({
      artist: candidate,
      by: currentPlayer().name,
      evidence: null
    });

    state.players[state.turn].score++;

    advanceTurn();

    $("artist-answer").value = "";

    renderGame();
    return;
  }

  const previous = state.chain[state.chain.length - 1].artist;

  if (
    norm(candidate) === norm(previous) ||
    state.chain.some(x => norm(x.artist) === norm(candidate))
  ) {
    showFeedback(
      "error",
      "Questo artista è già presente nella catena. Scegline un altro."
    );
    return;
  }

  busy = true;

  $("submit-answer").disabled = true;
  $("submit-answer").textContent = "Verifica…";

  try {
    const result = await verifyConnection(previous, candidate);

    state.lastEvidence = result;

    if (result.status === "verified") {
      state.chain.push({
        artist: candidate,
        by: currentPlayer().name,
        evidence: result.evidence || null
      });

      state.players[state.turn].score++;

      advanceTurn();

      $("artist-answer").value = "";

      renderGame();

      showFeedback(
        "success",
        `Collegamento verificato: ${result.evidence?.title || "pubblicazione condivisa"}.`
      );

      showEvidence(result);

    } else if (result.status === "rejected" || result.status === "not_found") {
      eliminateCurrent(
        `Non è stato trovato un collegamento documentato tra ${previous} e ${candidate}.`
      );

    } else {
      renderGame();

      showFeedback(
        "neutral",
        result.message || "Verifica inconcludente: nessun giocatore viene eliminato."
      );

      showEvidence(result);
    }

  } catch (err) {
    showFeedback(
      "neutral",
      err.message || "Errore durante la verifica. Riprova."
    );

  } finally {
    busy = false;

    $("submit-answer").disabled = false;
    $("submit-answer").innerHTML = 'Verifica <span>↗</span>';
  }
}

function advanceTurn() {
  state.turn = nextAliveIndex(state.turn);
  state.turnNo++;

  if (activePlayers().length <= 1) {
    finishGame();
  }
}

function eliminateCurrent(reason) {
  const p = currentPlayer();

  p.alive = false;

  if (activePlayers().length <= 1) {
    finishGame();
    return;
  }

  state.turn = nextAliveIndex(state.turn);
  state.turnNo++;

  renderGame();

  showFeedback("error", `${p.name} è fuori. ${reason}`);
}

function finishGame() {
  state.status = "finished";

  const winner = activePlayers()[0];

  $("result-title").textContent = winner
    ? `${winner.name} vince!`
    : "Partita terminata";

  $("result-description").textContent =
    `La catena si è fermata a ${state.chain.length} artisti.`;

  $("final-score").innerHTML = state.players.map(p =>
    `<div><span>${escapeHtml(p.name)} ${p.alive ? "" : "· eliminato"}</span><b>${p.score}</b></div>`
  ).join("");

  showScreen("result");
}

/* --------------------------------
   RENDER DEL GIOCO
-------------------------------- */

function renderGame() {
  if (!state) return;

  const p = currentPlayer();

  $("turn-label").textContent =
    `TURNO DI ${p.name.toUpperCase()}`;

  $("turn-number").textContent =
    String(state.turnNo).padStart(2, "0");

  $("current-artist").textContent = state.chain.length
    ? state.chain[state.chain.length - 1].artist
    : "Scegli il primo artista";

  $("current-caption").textContent = state.chain.length
    ? "Trova un altro artista presente in una pubblicazione insieme a questo."
    : "Il primo giocatore sceglie l'artista da cui partire.";

  $("chain-length").textContent = state.chain.length;

  $("chain-list").innerHTML = state.chain.map((x, i) =>
    `<li>${i + 1}. ${escapeHtml(x.artist)}</li>`
  ).join("");

  $("scoreboard").innerHTML = state.players.map((x, i) =>
    `<div class="score-row ${i === state.turn ? "active" : ""} ${x.alive ? "" : "out"}">
      <span class="score-name">
        ${i === state.turn && x.alive ? '<i class="score-dot"></i>' : ""}
        ${escapeHtml(x.name)}
      </span>
      <b>${x.score}</b>
    </div>`
  ).join("");

  $("feedback").classList.add("hidden");

  showEvidence(state.lastEvidence);

  $("pass-device").classList.toggle("hidden", mode !== "local");

  if (mode === "local" && state.chain.length > 0) {
    $("next-player-name").textContent = p.name;
  }
}

$("ready-button").addEventListener("click", () => {
  $("artist-answer").focus();
});

/* --------------------------------
   SUPABASE E MODALITÀ ONLINE
-------------------------------- */

function initSupabase() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) {
    throw new Error("Configura URL e anon key di Supabase in app.js.");
  }

  supabaseClient = window.supabase.createClient(
    CONFIG.supabaseUrl,
    CONFIG.supabaseAnonKey
  );
}

async function createRoom() {
  try {
    initSupabase();

    const nick = cleanName($("nickname").value);

    if (!nick) throw new Error("Inserisci il tuo nome.");

    const roomCode = Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase();

    const s = newState([nick]);
    s.players[0].id = crypto.randomUUID();

    const { data, error } = await supabaseClient
      .from("artist_chain_rooms")
      .insert({
        code: roomCode,
        state: s
      })
      .select()
      .single();

    if (error) throw error;

    roomId = data.id;
    state = s;
    myPlayerId = s.players[0].id;
    mode = "online";

    await subscribeRoom();

    renderGame();
    showScreen("game");

    const share =
      `${location.origin}${location.pathname}?room=${roomCode}`;

    history.replaceState({}, "", `?room=${roomCode}`);

    toast("Stanza creata: " + roomCode);

    prompt("Condividi questo link con gli altri giocatori:", share);

  } catch (e) {
    toast(e.message || "Impossibile creare la stanza.");
  }
}

async function joinRoom() {
  try {
    initSupabase();

    const nick = cleanName($("nickname").value);
    const code = $("room-code").value.trim().toUpperCase();

    if (!nick || !code) {
      throw new Error("Inserisci nome e codice.");
    }

    const { data, error } = await supabaseClient
      .from("artist_chain_rooms")
      .select("*")
      .eq("code", code)
      .single();

    if (error) throw error;

    roomId = data.id;
    state = data.state;
    myPlayerId = crypto.randomUUID();
    mode = "online";

    state.players.push({
      id: myPlayerId,
      name: nick,
      alive: true,
      score: 0
    });

    await saveRoom();
    await subscribeRoom();

    renderGame();
    showScreen("game");

  } catch (e) {
    toast(e.message || "Impossibile entrare nella stanza.");
  }
}

async function saveRoom() {
  const { error } = await supabaseClient
    .from("artist_chain_rooms")
    .update({ state })
    .eq("id", roomId);

  if (error) throw error;
}

async function subscribeRoom() {
  if (channel) {
    supabaseClient.removeChannel(channel);
  }

  channel = supabaseClient
    .channel("room-" + roomId)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "artist_chain_rooms",
        filter: `id=eq.${roomId}`
      },
      payload => {
        state = payload.new.state;
        renderGame();
      }
    )
    .subscribe();
}

$("create-room").addEventListener("click", createRoom);
$("join-room").addEventListener("click", joinRoom);

async function onlineSubmit() {
  if (!state || !currentPlayer() || currentPlayer().id !== myPlayerId) {
    toast("Non è il tuo turno.");
    return;
  }

  await submitAnswer();

  if (roomId && state) {
    try {
      await saveRoom();
    } catch (e) {
      toast("Errore sincronizzazione: " + e.message);
    }
  }
}

/* --------------------------------
   ACCESSO A UNA STANZA DA LINK
-------------------------------- */

const roomFromUrl = new URLSearchParams(location.search).get("room");

if (roomFromUrl) {
  $("room-code").value = roomFromUrl;
  setMode("online");
}
