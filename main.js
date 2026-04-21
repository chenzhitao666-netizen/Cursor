/* eslint-disable no-use-before-define */
const CONFIG = {
  rounds: 5,
  players: ["球员 1", "球员 2", "球员 3"],
  animMs: 1150,
};

const DIRS = /** @type {const} */ ({
  TL: { label: "左上", col: 0, row: 0 },
  TC: { label: "中上", col: 1, row: 0 },
  TR: { label: "右上", col: 2, row: 0 },
  ML: { label: "左中", col: 0, row: 1 },
  MC: { label: "中路", col: 1, row: 1 },
  MR: { label: "右中", col: 2, row: 1 },
  BL: { label: "左下", col: 0, row: 2 },
  BC: { label: "中下", col: 1, row: 2 },
  BR: { label: "右下", col: 2, row: 2 },
});

/** @typedef {"GOAL"|"SAVE"|"MISS"} ShotOutcome */

const state = {
  round: 1,
  shooterIdx: 0,
  shotsTaken: 0,
  busy: false,
  // per player: array of outcomes length <= rounds
  history: CONFIG.players.map(() => /** @type {ShotOutcome[]} */ ([])),
  // animation transient
  anim: {
    running: false,
    startTs: 0,
    from: { x: 0, y: 0 },
    to: { x: 0, y: 0 },
    curve: 0,
    goalieFrom: { x: 0, y: 0 },
    goalieTo: { x: 0, y: 0 },
    outcome: /** @type {ShotOutcome} */ ("MISS"),
    goalieDir: "MC",
    shotDir: "MC",
    speed: 70,
    lastGoalQuote: "",
  },
  aim: {
    active: false,
    x: 0,
    y: 0,
  },
  meter: {
    active: false,
    locked: false,
    startTs: 0,
    pos01: 0,
  },
  hudMsg: {
    text: "请选择方向并射门",
    tone: "neutral",
    untilTs: 0,
  },
  stamp: {
    visible: false,
    mode: /** @type {"label"|"quote"} */ ("label"),
    outcome: /** @type {ShotOutcome} */ ("MISS"),
    quote: "",
    goalieDir: "MC",
    shotDir: "MC",
    timeouts: /** @type {number[]} */ ([]),
  },
};

// DOM
const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const $$ = (sel) => /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(sel));

const pitch = /** @type {HTMLCanvasElement} */ ($("#pitch"));
const ctx = pitch.getContext("2d");
if (!ctx) throw new Error("Canvas 不支持");

const shootBtn = /** @type {HTMLButtonElement} */ ($("#shootBtn"));
const resetBtn = /** @type {HTMLButtonElement} */ ($("#resetBtn"));
const skipAnimBtn = /** @type {HTMLButtonElement} */ ($("#skipAnimBtn"));
const soundBtn = /** @type {HTMLButtonElement|null} */ (document.querySelector("#soundBtn"));
const powerInput = /** @type {HTMLInputElement} */ ($("#power"));
const curveInput = /** @type {HTMLInputElement} */ ($("#curve"));
const powerMeter = /** @type {HTMLDivElement|null} */ (document.querySelector("#powerMeter"));
const powerBall = /** @type {HTMLDivElement|null} */ (document.querySelector("#powerBall"));

const powerValue = $("#powerValue");
const curveValue = $("#curveValue");
const currentPlayerName = $("#currentPlayerName");
const resultText = /** @type {HTMLElement|null} */ (document.querySelector("#resultText"));
const roundPill = $("#roundPill");
const scoreRows = $("#scoreRows");

// Pitch geometry (canvas coordinates)
const geom = {
  w: pitch.width,
  h: pitch.height,
  // goal mouth rectangle
  goal: { x: 300, y: 70, w: 380, h: 160 },
  // penalty spot
  spot: { x: 490, y: 420 },
};

const GOAL_QUOTES = [
  "这脚有点东西！",
  "角度刁钻，门将只能目送。",
  "球网：我裂开了。",
  "一脚世界波（点球版）。",
  "门将：我尽力了。",
  "冷静，像训练一样。",
  "这脚踢得很“教科书”。",
  "稳！像装了导航。",
  "球：直奔幸福而去。",
  "这不是射门，这是宣言。",
  "门柱：还好没找我麻烦。",
  "请给门将一点尊重（但不多）。",
];

const SFX = (() => {
  /** @type {AudioContext|null} */
  let ac = null;
  let enabled = true;

  function ensure() {
    if (!enabled) return null;
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === "suspended") ac.resume().catch(() => {});
    return ac;
  }

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled && ac && ac.state !== "closed") {
      // keep context; just don't play
    }
  }

  function getEnabled() {
    return enabled;
  }

  function tone(freq, ms, type = "sine", gain = 0.06) {
    const ctx = ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + ms / 1000 + 0.02);
  }

  function sweep(f0, f1, ms, type = "square", gain = 0.05) {
    const ctx = ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + ms / 1000);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + ms / 1000 + 0.02);
  }

  return {
    setEnabled,
    getEnabled,
    unlock: ensure,
    kick() {
      // "thump"
      sweep(180, 70, 90, "sine", 0.11);
      tone(120, 70, "triangle", 0.05);
    },
    meterStart() {
      tone(880, 70, "sine", 0.04);
      tone(660, 70, "sine", 0.035);
    },
    meterStop(ok) {
      if (ok) {
        tone(880, 90, "sine", 0.05);
        tone(1175, 120, "sine", 0.05);
      } else {
        tone(220, 140, "sawtooth", 0.06);
      }
    },
    goal() {
      // short cheer-like arpeggio
      tone(523, 120, "triangle", 0.06);
      tone(659, 160, "triangle", 0.065);
      tone(784, 220, "triangle", 0.07);
    },
    save() {
      // glove slap
      sweep(420, 180, 120, "square", 0.06);
      tone(160, 110, "triangle", 0.05);
    },
    miss() {
      // disappointed "boo"
      sweep(260, 140, 220, "sawtooth", 0.05);
    },
  };
})();

const SAVE_QUOTES = [
  "门将开挂了！！",
  "这手速，离谱。",
  "被读心了！",
  "门将：拿捏。",
  "差一点点就进了！",
  "这球有，但不多。",
  "门将：谢谢你送温暖。",
  "手套：值回票价。",
];

const MISS_QUOTES = [
  "这脚…有点飘。",
  "球：我想去看台。",
  "偏了偏了！！",
  "门框：今天不营业。",
  "这球先放你一马。",
  "风太大了（甩锅）。",
  "观众：哇——（倒吸气）",
  "下一脚一定进！",
];

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickGoalQuote() {
  // avoid repeating the same quote consecutively
  const prev = state.anim?.lastGoalQuote ?? "";
  if (GOAL_QUOTES.length === 0) return "";
  if (GOAL_QUOTES.length === 1) return GOAL_QUOTES[0];

  const seed = (Date.now() ^ ((state.shotsTaken + 11) * 2246822519)) >>> 0;
  const rnd = mulberry32(seed);
  let q = GOAL_QUOTES[Math.floor(rnd() * GOAL_QUOTES.length)];
  if (q === prev) q = GOAL_QUOTES[(GOAL_QUOTES.indexOf(q) + 1) % GOAL_QUOTES.length];
  state.anim.lastGoalQuote = q;
  return q;
}

function pickOutcomeQuote(outcome) {
  const key = outcome === "GOAL" ? "GOAL" : outcome === "SAVE" ? "SAVE" : "MISS";
  const pools = {
    GOAL: GOAL_QUOTES,
    SAVE: SAVE_QUOTES,
    MISS: MISS_QUOTES,
  };
  const pool = pools[key] || [];
  if (pool.length === 0) return "";
  if (pool.length === 1) return pool[0];

  const prev =
    key === "GOAL"
      ? (state.anim?.lastGoalQuote ?? "")
      : key === "SAVE"
        ? (state.anim?.lastSaveQuote ?? "")
        : (state.anim?.lastMissQuote ?? "");

  const seed = (Date.now() ^ ((state.shotsTaken + 17) * 3266489917)) >>> 0;
  const rnd = mulberry32(seed);
  let q = pool[Math.floor(rnd() * pool.length)];
  if (q === prev) q = pool[(pool.indexOf(q) + 1) % pool.length];

  if (key === "GOAL") state.anim.lastGoalQuote = q;
  if (key === "SAVE") state.anim.lastSaveQuote = q;
  if (key === "MISS") state.anim.lastMissQuote = q;
  return q;
}

function dirFromUI() {
  const el = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="dir"]:checked'));
  return (el?.value || "MC");
}

function setDirToUI(dirKey) {
  const key = DIRS[dirKey] ? dirKey : "MC";
  const el = /** @type {HTMLInputElement|null} */ (document.querySelector(`input[name="dir"][value="${key}"]`));
  if (!el) return;
  el.checked = true;
}

function dirToCoord(dirKey) {
  const d = DIRS[dirKey] ?? DIRS.MC;
  return { col: d.col, row: d.row };
}

function coordToDir(col, row) {
  const c = clamp(col, 0, 2);
  const r = clamp(row, 0, 2);
  for (const [k, v] of Object.entries(DIRS)) {
    if (v.col === c && v.row === r) return k;
  }
  return "MC";
}

function moveDirBy(dx, dy) {
  const cur = dirFromUI();
  const { col, row } = dirToCoord(cur);
  const next = coordToDir(col + dx, row + dy);
  if (next !== cur) {
    setDirToUI(next);
    drawStatic();
  }
}

function pickDirFromCanvasPointer(clientX, clientY) {
  const rect = pitch.getBoundingClientRect();
  const sx = (clientX - rect.left) / rect.width;
  const sy = (clientY - rect.top) / rect.height;
  if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return null;

  const x = sx * geom.w;
  const y = sy * geom.h;

  // Map a tap to a 3x3 cell of the goal mouth. If you tap outside the goal,
  // still project into the goal rectangle for easier mobile aiming.
  const gx = geom.goal.x;
  const gy = geom.goal.y;
  const gw = geom.goal.w;
  const gh = geom.goal.h;

  const px = clamp(x, gx, gx + gw);
  const py = clamp(y, gy, gy + gh);

  const relX = (px - gx) / gw;
  const relY = (py - gy) / gh;

  const col = clamp(Math.floor(relX * 3), 0, 2);
  const row = clamp(Math.floor(relY * 3), 0, 2);
  return coordToDir(col, row);
}

function aimPointFromCanvasPointer(clientX, clientY) {
  const rect = pitch.getBoundingClientRect();
  const sx = (clientX - rect.left) / rect.width;
  const sy = (clientY - rect.top) / rect.height;
  if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return null;

  const x = sx * geom.w;
  const y = sy * geom.h;

  const gx = geom.goal.x;
  const gy = geom.goal.y;
  const gw = geom.goal.w;
  const gh = geom.goal.h;

  const ax = clamp(x, gx + 18, gx + gw - 18);
  const ay = clamp(y, gy + 18, gy + gh - 18);
  return { x: ax, y: ay };
}

function aimPointToDir(aim) {
  const gx = geom.goal.x;
  const gy = geom.goal.y;
  const gw = geom.goal.w;
  const gh = geom.goal.h;
  const relX = clamp((aim.x - gx) / gw, 0, 0.999999);
  const relY = clamp((aim.y - gy) / gh, 0, 0.999999);
  const col = clamp(Math.floor(relX * 3), 0, 2);
  const row = clamp(Math.floor(relY * 3), 0, 2);
  return coordToDir(col, row);
}

function getShotDir() {
  if (state.aim.active) return aimPointToDir({ x: state.aim.x, y: state.aim.y });
  return dirFromUI();
}

function getAimTarget(curvePx) {
  if (state.aim.active) return { x: state.aim.x, y: state.aim.y };
  return goalTargetForDir(dirFromUI(), curvePx);
}

function setHUD(text, tone = "neutral") {
  // Keep as silent state only (HUD element is hidden in CSS).
  state.hudMsg.text = text;
  state.hudMsg.tone = tone;
  state.hudMsg.untilTs = performance.now() + 2600;
}

function getTotals() {
  return state.history.map((arr) => ({
    goals: arr.filter((x) => x === "GOAL").length,
    saves: arr.filter((x) => x === "SAVE").length,
    miss: arr.filter((x) => x === "MISS").length,
  }));
}

function renderScoreboard() {
  scoreRows.innerHTML = "";
  const totals = getTotals();
  CONFIG.players.forEach((name, i) => {
    const row = document.createElement("div");
    row.className = "scoreRow";
    row.setAttribute("role", "listitem");

    const left = document.createElement("div");
    left.className = "scoreRow__left";

    const title = document.createElement("div");
    title.className = "scoreRow__name";
    title.textContent = name;

    const shots = document.createElement("div");
    shots.className = "scoreRow__shots";

    for (let r = 0; r < CONFIG.rounds; r++) {
      const dot = document.createElement("div");
      dot.className = "shotDot";
      const v = state.history[i][r];
      if (v === "GOAL") dot.classList.add("shotDot--goal");
      else if (v === "SAVE") dot.classList.add("shotDot--save");
      else if (v === "MISS") dot.classList.add("shotDot--miss");
      shots.appendChild(dot);
    }

    left.appendChild(title);
    left.appendChild(shots);

    const score = document.createElement("div");
    score.className = "scoreRow__score";
    score.textContent = `进球 ${totals[i].goals} / ${CONFIG.rounds}`;

    row.appendChild(left);
    row.appendChild(score);
    scoreRows.appendChild(row);
  });
}

function updateHeader() {
  roundPill.textContent = `第 ${state.round} 轮`;
  currentPlayerName.textContent = CONFIG.players[state.shooterIdx];
}

function resetGame() {
  clearStampTimers();
  state.stamp.visible = false;
  state.round = 1;
  state.shooterIdx = 0;
  state.shotsTaken = 0;
  state.busy = false;
  state.history = CONFIG.players.map(() => []);
  state.anim.running = false;
  state.aim.active = false;
  state.meter.active = false;
  state.meter.locked = false;
  setPowerBallPos01(0.5);
  powerMeter?.classList.remove("powerMeter--armed");
  powerMeter?.classList.remove("powerMeter--locked");
  setDirToUI("MC");
  powerInput.value = "70";
  curveInput.value = "25";
  powerValue.textContent = "70";
  curveValue.textContent = "25";
  shootBtn.disabled = false;
  setHUD("请选择方向并射门", "neutral");
  renderScoreboard();
  updateHeader();
  drawStatic();
  updateShootButtonLabel();
}

function isGameOver() {
  return state.shotsTaken >= CONFIG.rounds * CONFIG.players.length;
}

function advanceTurn() {
  state.shotsTaken += 1;
  state.shooterIdx = (state.shooterIdx + 1) % CONFIG.players.length;
  state.round = Math.floor(state.shotsTaken / CONFIG.players.length) + 1;
}

function goalTargetForDir(dirKey, curvePx) {
  const d = DIRS[dirKey] ?? DIRS.MC;
  const gx = geom.goal.x;
  const gy = geom.goal.y;
  const cellW = geom.goal.w / 3;
  const cellH = geom.goal.h / 3;

  // aim at center of selected cell
  let x = gx + (d.col + 0.5) * cellW;
  let y = gy + (d.row + 0.55) * cellH;

  // apply curve: left targets drift left, right drift right, center depends on curve sign
  const drift = (d.col - 1) * (curvePx * 0.65);
  x += drift;

  // tiny vertical drift: tops rise a little
  y -= (d.row === 0 ? curvePx * 0.15 : 0);

  // clamp within goal frame (leave small margin)
  x = clamp(x, gx + 18, gx + geom.goal.w - 18);
  y = clamp(y, gy + 18, gy + geom.goal.h - 18);
  return { x, y };
}

function goalieTargetForDir(dirKey) {
  const d = DIRS[dirKey] ?? DIRS.MC;
  const gx = geom.goal.x;
  const gy = geom.goal.y;
  const cellW = geom.goal.w / 3;
  const cellH = geom.goal.h / 3;

  const x = gx + (d.col + 0.5) * cellW;
  const y = gy + (d.row + 0.72) * cellH;
  return { x, y };
}

function chooseGoalieDir(shotDir, speed, curve) {
  // deterministic-ish randomness so same situation feels consistent per attempt
  const seed = (Date.now() ^ (state.shotsTaken + 1) * 2654435761) >>> 0;
  const rnd = mulberry32(seed);

  // base: mostly random with a slight bias to follow the shot direction when speed is low
  const followBias = clamp(0.18 + (1 - speed / 100) * 0.22, 0.12, 0.4);
  const curveNoise = clamp(curve / 100, 0, 0.6);

  if (rnd() < followBias * (1 - 0.35 * curveNoise)) return shotDir;

  const keys = Object.keys(DIRS);
  return keys[Math.floor(rnd() * keys.length)];
}

function outcomeForShot(shotDir, goalieDir, speed, curve) {
  const d = DIRS[shotDir] ?? DIRS.MC;
  const g = DIRS[goalieDir] ?? DIRS.MC;

  // miss chance: stronger + closer to corners (top corners worst)
  const cornerness = (Math.abs(d.col - 1) + Math.abs(d.row - 1)) / 2; // 0..1
  const topBonus = d.row === 0 ? 0.25 : 0;
  const power = speed / 100;
  const curveFactor = curve / 100;
  const missChance = clamp(0.03 + power * 0.16 + cornerness * 0.18 + topBonus * 0.12 + curveFactor * 0.06, 0.02, 0.42);

  const seed = (Date.now() ^ ((state.shotsTaken + 7) * 1597334677)) >>> 0;
  const rnd = mulberry32(seed);
  if (rnd() < missChance) return /** @type {ShotOutcome} */ ("MISS");

  // save chance depends on whether goalie guessed correct cell + speed/cornerness
  const sameCell = d.col === g.col && d.row === g.row;
  const nearCell = Math.abs(d.col - g.col) + Math.abs(d.row - g.row) === 1;

  let saveChance = 0.08;
  saveChance += sameCell ? 0.52 : nearCell ? 0.14 : 0.0;
  saveChance -= power * 0.26; // fast shots harder to save
  saveChance -= cornerness * 0.18; // corners harder
  saveChance += (1 - curveFactor) * 0.06; // lots of curve is harder
  saveChance = clamp(saveChance, 0.03, 0.78);

  return rnd() < saveChance ? "SAVE" : "GOAL";
}

function lockUI(locked) {
  state.busy = locked;
  shootBtn.disabled = locked || isGameOver();
  skipAnimBtn.disabled = !state.anim.running;
  $$(".dir input").forEach((el) => (/** @type {HTMLInputElement} */ (el).disabled = locked));
  powerInput.disabled = locked;
  curveInput.disabled = locked;
  if (powerMeter) powerMeter.style.pointerEvents = locked ? "none" : "auto";
}

function drawStatic() {
  drawScene({
    ball: null,
    goalie: { x: geom.goal.x + geom.goal.w / 2, y: geom.goal.y + geom.goal.h * 0.62 },
    aim: getAimTarget(Number(curveInput.value) * 0.6),
    outcome: null,
    goalieDir: null,
    shotDir: null,
  });
}

function drawScene({ ball, goalie, aim, outcome, goalieDir, shotDir }) {
  ctx.clearRect(0, 0, geom.w, geom.h);

  // pitch background
  const grd = ctx.createLinearGradient(0, 0, 0, geom.h);
  grd.addColorStop(0, "#14321f");
  grd.addColorStop(1, "#0c2417");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, geom.w, geom.h);

  // subtle stripes
  ctx.globalAlpha = 0.14;
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = i % 2 === 0 ? "#2a5f33" : "#1e4a2a";
    ctx.fillRect(i * (geom.w / 10), 0, geom.w / 10, geom.h);
  }
  ctx.globalAlpha = 1;

  // goal + net
  drawGoal();
  drawPenaltyArea();

  // aim indicator
  if (!state.anim.running && aim) {
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.strokeStyle = "rgba(139, 92, 246, 0.95)";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 7]);
    ctx.beginPath();
    ctx.moveTo(geom.spot.x, geom.spot.y);
    ctx.lineTo(aim.x, aim.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(139, 92, 246, 0.22)";
    ctx.beginPath();
    ctx.arc(aim.x, aim.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // goalie
  drawGoalie(goalie.x, goalie.y, goalieDir, shotDir, outcome);

  // ball
  if (ball) drawBall(ball.x, ball.y, ball.scale);

  // player silhouette near spot
  drawShooter(geom.spot.x - 50, geom.spot.y + 20);

  // overlay for outcome at end frame
  if (state.stamp.visible && !state.anim.running) {
    drawOutcomeStamp(state.stamp.outcome, state.stamp.mode, state.stamp.quote);
  }

  // draw message on the goal area (instead of HUD result line)
  // drawGoalMessage();
}

function toneToColor(tone) {
  if (tone === "good") return "rgba(34, 197, 94, 0.98)";
  if (tone === "bad") return "rgba(239, 68, 68, 0.98)";
  if (tone === "warn") return "rgba(245, 158, 11, 0.98)";
  return "rgba(255, 255, 255, 0.94)";
}

function wrapTextLines(text, maxWidth) {
  const words = String(text).split(/\s+/g);
  if (words.length <= 1) {
    // Chinese text usually has no spaces; fallback to char wrapping
    const chars = Array.from(String(text));
    const lines = [];
    let line = "";
    for (const ch of chars) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawGoalMessage() {
  const text = state.hudMsg?.text || "";
  if (!text) return;

  const now = performance.now();
  const until = state.hudMsg.untilTs || 0;

  // If no TTL set yet, keep it visible.
  const remain = until > 0 ? until - now : 999999;
  if (remain <= -200) return;

  const fade = until > 0 ? clamp(remain / 500, 0, 1) : 1; // last 500ms fade out

  const gx = geom.goal.x;
  const gy = geom.goal.y;
  const gw = geom.goal.w;

  const maxWidth = gw - 46;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Bigger + punchier for readability on mobile.
  ctx.font = "800 18px ui-sans-serif, system-ui";

  const lines = wrapTextLines(text, maxWidth);
  const lineH = 18;
  const blockH = lines.length * lineH;
  const cx = gx + gw / 2;
  // Slightly overlap into the goal area (instead of sitting above it).
  const cy = gy + 24;

  // background pill
  ctx.globalAlpha = 0.35 * fade;
  ctx.fillStyle = "rgba(0,0,0,0.38)";
  const padX = 14;
  const padY = 9;
  const boxW = Math.min(gw, Math.max(220, Math.min(gw, maxWidth + padX * 2)));
  const boxH = blockH + padY * 2;
  ctx.beginPath();
  ctx.roundRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH, 14);
  ctx.fill();

  // text
  ctx.globalAlpha = 0.95 * fade;
  const color = toneToColor(state.hudMsg.tone);
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = color;
  for (let i = 0; i < lines.length; i++) {
    const y = cy - (blockH - lineH) / 2 + i * lineH;
    ctx.fillText(lines[i], cx, y);
  }

  ctx.restore();
}

function drawGoal() {
  const { x, y, w, h } = geom.goal;
  // net
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 4;
  ctx.strokeRect(x, y, w, h);

  // net pattern
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 18; i++) {
    const xx = x + (w * i) / 18;
    ctx.beginPath();
    ctx.moveTo(xx, y);
    ctx.lineTo(xx, y + h);
    ctx.stroke();
  }
  for (let i = 0; i <= 10; i++) {
    const yy = y + (h * i) / 10;
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.lineTo(x + w, yy);
    ctx.stroke();
  }
  ctx.restore();

  // posts shadow
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = "#000";
  ctx.fillRect(x + 5, y + h + 2, w, 8);
  ctx.restore();
}

function drawPenaltyArea() {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.9;

  // penalty box
  const box = { x: 190, y: 160, w: 600, h: 300 };
  ctx.strokeRect(box.x, box.y, box.w, box.h);

  // penalty arc
  ctx.beginPath();
  ctx.arc(geom.spot.x, geom.spot.y - 10, 90, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();

  // spot
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.arc(geom.spot.x, geom.spot.y, 4.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBall(x, y, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  // shadow
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(8, 10, 14, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // ball
  const r = 12;
  const g = ctx.createRadialGradient(-4, -5, 2, 0, 0, 18);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(1, "#d8d8d8");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();

  // simple panels
  ctx.fillStyle = "rgba(0,0,0,0.24)";
  ctx.beginPath();
  ctx.moveTo(-2, -2);
  ctx.lineTo(3, -7);
  ctx.lineTo(8, -2);
  ctx.lineTo(3, 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawShooter(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = 0.92;
  // body
  ctx.fillStyle = "rgba(30, 64, 175, 0.95)";
  ctx.beginPath();
  ctx.roundRect(0, -55, 26, 36, 10);
  ctx.fill();
  // head
  ctx.fillStyle = "rgba(255, 224, 189, 0.95)";
  ctx.beginPath();
  ctx.arc(13, -66, 10, 0, Math.PI * 2);
  ctx.fill();
  // legs
  ctx.fillStyle = "rgba(17, 24, 39, 0.95)";
  ctx.beginPath();
  ctx.roundRect(2, -20, 10, 26, 6);
  ctx.roundRect(14, -20, 10, 28, 6);
  ctx.fill();
  ctx.restore();
}

function drawGoalie(x, y, goalieDir, shotDir, outcome) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = 0.95;

  // shadow
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(0, 26, 32, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.95;

  // torso
  ctx.fillStyle = "rgba(22, 163, 74, 0.95)";
  ctx.beginPath();
  ctx.roundRect(-18, -18, 36, 36, 12);
  ctx.fill();

  // head
  ctx.fillStyle = "rgba(255, 224, 189, 0.95)";
  ctx.beginPath();
  ctx.arc(0, -32, 11, 0, Math.PI * 2);
  ctx.fill();

  // gloves
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  const armSpread = 22;
  ctx.beginPath();
  ctx.roundRect(-armSpread - 10, -10, 14, 12, 6);
  ctx.roundRect(armSpread - 4, -10, 14, 12, 6);
  ctx.fill();

  ctx.restore();
}

function drawOutcomeStamp(outcome, mode, quote) {
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const label = outcome === "GOAL" ? "进球！！！" : outcome === "SAVE" ? "扑出！！" : "踢偏！！";

  const color =
    outcome === "GOAL"
      ? "rgba(34, 197, 94, 0.98)"
      : outcome === "SAVE"
        ? "rgba(245, 158, 11, 0.98)"
        : "rgba(239, 68, 68, 0.98)";

  if (mode === "label") {
    ctx.font = "900 58px ui-sans-serif, system-ui";
    ctx.strokeStyle = "rgba(0,0,0,0.32)";
    ctx.lineWidth = 12;
    ctx.strokeText(label, geom.w / 2, 66);
    ctx.fillStyle = color;
    ctx.fillText(label, geom.w / 2, 66);
  }

  if (mode === "quote" && quote) {
    // Quote in the same big "stamp" style (same color).
    ctx.font = "900 42px ui-sans-serif, system-ui";
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = "rgba(0,0,0,0.30)";
    ctx.lineWidth = 10;
    ctx.strokeText(quote, geom.w / 2, 98);
    ctx.fillStyle = color;
    ctx.fillText(quote, geom.w / 2, 98);
  }

  ctx.restore();
}

function updateShootButtonLabel() {
  shootBtn.textContent = state.meter.active ? "点我停球" : "射门（开始力度）";
}

function setPowerBallPos01(pos01) {
  state.meter.pos01 = clamp(pos01, 0, 1);
  if (!powerBall) return;
  powerBall.style.left = `${state.meter.pos01 * 100}%`;
}

function meterInGreen(pos01) {
  return pos01 >= 1 / 3 && pos01 <= 2 / 3;
}

function startMeter() {
  if (!powerMeter || !powerBall) return;
  if (state.meter.active || state.busy || isGameOver()) return;

  state.meter.active = true;
  state.meter.locked = false;
  state.meter.startTs = performance.now();
  powerMeter.classList.add("powerMeter--armed");
  powerMeter.classList.remove("powerMeter--locked");
  setHUD("停在绿色区，才算有效射门", "neutral");
  SFX.meterStart();
  updateShootButtonLabel();
  requestAnimationFrame(tickMeter);
}

function lockMeterAndShoot() {
  if (!powerMeter) return;
  if (!state.meter.active) return;

  state.meter.active = false;
  state.meter.locked = true;
  powerMeter.classList.remove("powerMeter--armed");
  powerMeter.classList.add("powerMeter--locked");
  updateShootButtonLabel();

  const pos = state.meter.pos01;
  const ok = meterInGreen(pos);
  SFX.meterStop(ok);
  if (!ok) {
    // timing failed -> immediate miss, but still play animation
    const shotDir = getShotDir();
    const curve = Number(curveInput.value);
    const target = state.aim.active ? { x: state.aim.x, y: state.aim.y } : goalTargetForDir(shotDir, curve * 0.75);
    const missTarget = { x: target.x + (target.x < geom.goal.x + geom.goal.w / 2 ? -40 : 40), y: target.y + 22 };

    state.history[state.shooterIdx].push("MISS");
    state.anim.stampQuote = pickOutcomeQuote("MISS");

    state.anim.running = true;
    state.anim.startTs = performance.now();
    state.anim.from = { x: geom.spot.x, y: geom.spot.y };
    state.anim.to = missTarget;
    state.anim.curve = curve;
    state.anim.goalieFrom = goalieTargetForDir("MC");
    state.anim.goalieDir = "MC";
    state.anim.goalieTo = goalieTargetForDir("MC");
    state.anim.outcome = "MISS";
    state.anim.shotDir = shotDir;
    state.anim.speed = 74;

    lockUI(true);
    skipAnimBtn.disabled = false;
    renderScoreboard();
    SFX.kick();
    SFX.miss();
    requestAnimationFrame(tick);
    return;
  }

  // timing ok -> map to a speed; closer to center = faster (harder to save)
  const dist = Math.abs(pos - 0.5);
  const halfGreen = 1 / 6;
  const quality = clamp(1 - dist / halfGreen, 0, 1);
  const speed = Math.round(62 + quality * 34);
  powerInput.value = String(speed);
  powerValue.textContent = String(speed);
  startShot();
}

function tickMeter(ts) {
  if (!state.meter.active) return;
  const t = (ts - state.meter.startTs) / 900;
  const pos = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
  setPowerBallPos01(pos);
  requestAnimationFrame(tickMeter);
}

function startShot() {
  if (state.busy || isGameOver()) return;

  const shotDir = getShotDir();
  const speed = Number(powerInput.value);
  const curve = Number(curveInput.value);

  const goalieDir = chooseGoalieDir(shotDir, speed, curve);
  const outcome = outcomeForShot(shotDir, goalieDir, speed, curve);
  state.anim.stampQuote = pickOutcomeQuote(outcome);
  SFX.kick();

  // store now (so skip animation still consistent)
  state.history[state.shooterIdx].push(outcome);

  state.anim.running = true;
  state.anim.startTs = performance.now();
  state.anim.from = { x: geom.spot.x, y: geom.spot.y };
  state.anim.to = state.aim.active ? { x: state.aim.x, y: state.aim.y } : goalTargetForDir(shotDir, curve * 0.75);
  state.anim.curve = curve;
  state.anim.goalieFrom = goalieTargetForDir("MC");
  state.anim.goalieTo = goalieTargetForDir(goalieDir);
  state.anim.outcome = outcome;
  state.anim.goalieDir = goalieDir;
  state.anim.shotDir = shotDir;
  state.anim.speed = speed;

  lockUI(true);
  skipAnimBtn.disabled = false;

  setHUD("起脚！", "neutral");
  renderScoreboard();

  requestAnimationFrame(tick);
}

function finalizeShot() {
  state.anim.running = false;
  lockUI(false);
  skipAnimBtn.disabled = true;

  const outcome = state.anim.outcome;

  if (outcome === "GOAL") {
    const q = pickGoalQuote();
    setHUD(`进球！！！${q ? ` ${q}` : ""}`, "good");
  }
  else if (outcome === "SAVE") setHUD("被扑出！！", "warn");
  else setHUD("踢偏！！", "bad");

  // move turn forward
  advanceTurn();
  updateHeader();
  renderScoreboard();

  if (isGameOver()) {
    shootBtn.disabled = true;
    const totals = getTotals();
    const sum = totals.reduce((acc, t) => acc + t.goals, 0);
    const winnerIdx = totals
      .map((t, i) => ({ goals: t.goals, i }))
      .sort((a, b) => b.goals - a.goals)[0]?.i;
    const winner = winnerIdx !== undefined ? CONFIG.players[winnerIdx] : "—";
    setHUD(`比赛结束：总进球 ${sum}。最佳射手：${winner}。点击“重开”再来一局。`, "neutral");
  }
}

function tick(ts) {
  if (!state.anim.running) return;
  const elapsed = ts - state.anim.startTs;
  const baseT = clamp(elapsed / CONFIG.animMs, 0, 1);
  const t = easeOutCubic(baseT);

  // ball trajectory: quadratic bezier using "curve" as control point offset
  const from = state.anim.from;
  const to = state.anim.to;

  const mid = { x: (from.x + to.x) / 2, y: lerp(from.y, to.y, 0.55) - 80 };
  const curveSigned = (DIRS[state.anim.shotDir]?.col ?? 1) - 1; // -1,0,1
  mid.x += curveSigned * (state.anim.curve * 1.8);

  const bx = bezier2(from.x, mid.x, to.x, t);
  const by = bezier2(from.y, mid.y, to.y, t);

  // scale: ball shrinks as it goes away
  const speed = state.anim.speed / 100;
  const scale = lerp(1.0, 0.55, t) * (1 - speed * 0.06);

  // goalie move
  const gFrom = state.anim.goalieFrom;
  const gTo = state.anim.goalieTo;
  const gDelay = 0.06 + (1 - speed) * 0.06;
  const gt = clamp((baseT - gDelay) / (1 - gDelay), 0, 1);
  const gx = lerp(gFrom.x, gTo.x, easeOutCubic(gt));
  const gy = lerp(gFrom.y, gTo.y, easeOutCubic(gt));

  drawScene({
    ball: { x: bx, y: by, scale },
    goalie: { x: gx, y: gy },
    aim: null,
    outcome: null,
    goalieDir: null,
    shotDir: null,
  });

  if (baseT >= 1) {
    // last frame: show outcome stamp for a moment, then unlock
    state.anim.running = false;
    showStampSequence(state.anim.outcome, state.anim.goalieDir, state.anim.shotDir);
    setTimeout(() => finalizeShot(), 350);
    return;
  }
  requestAnimationFrame(tick);
}

function bezier2(p0, p1, p2, t) {
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  return lerp(a, b, t);
}

function skipAnimation() {
  if (!state.anim.running) return;
  // immediately draw end frame and finalize
  state.anim.running = false;
  showStampSequence(state.anim.outcome, state.anim.goalieDir, state.anim.shotDir);
  finalizeShot();
}

function clearStampTimers() {
  for (const id of state.stamp.timeouts) window.clearTimeout(id);
  state.stamp.timeouts = [];
}

function showStampSequence(outcome, goalieDir, shotDir) {
  clearStampTimers();
  state.stamp.visible = true;
  state.stamp.mode = "label";
  state.stamp.outcome = outcome;
  state.stamp.quote = pickOutcomeQuote(outcome);
  state.stamp.goalieDir = goalieDir;
  state.stamp.shotDir = shotDir;

  // Draw once immediately (label)
  drawScene({
    ball: null,
    goalie: goalieTargetForDir(goalieDir),
    aim: null,
    outcome: null,
    goalieDir,
    shotDir,
  });

  // Fire outcome sound once, synced with the stamp.
  if (outcome === "GOAL") SFX.goal();
  else if (outcome === "SAVE") SFX.save();
  else SFX.miss();

  // After 1s, switch to quote only
  state.stamp.timeouts.push(
    window.setTimeout(() => {
      state.stamp.mode = "quote";
      drawScene({
        ball: null,
        goalie: goalieTargetForDir(goalieDir),
        aim: null,
        outcome: null,
        goalieDir,
        shotDir,
      });
    }, 1000)
  );

  // After additional 1.2s, hide everything and redraw static
  state.stamp.timeouts.push(
    window.setTimeout(() => {
      state.stamp.visible = false;
      drawStatic();
    }, 2200)
  );
}

function wireEvents() {
  shootBtn.addEventListener("click", () => {
    if (state.busy || isGameOver()) return;
    if (!state.meter.active) startMeter();
    else lockMeterAndShoot();
  });
  resetBtn.addEventListener("click", () => resetGame());
  // Unlock audio on first user gesture (mobile browsers require this).
  const unlockOnce = () => {
    SFX.unlock();
    window.removeEventListener("pointerdown", unlockOnce);
    window.removeEventListener("keydown", unlockOnce);
  };
  window.addEventListener("pointerdown", unlockOnce, { once: true });
  window.addEventListener("keydown", unlockOnce, { once: true });

  soundBtn?.addEventListener("click", () => {
    const next = !SFX.getEnabled();
    SFX.setEnabled(next);
    soundBtn.setAttribute("aria-pressed", String(next));
    soundBtn.textContent = next ? "声音：开" : "声音：关";
    if (next) SFX.meterStart();
  });

  skipAnimBtn.addEventListener("click", () => skipAnimation());

  // Mobile-friendly aiming: drag on the goal to move dashed aim.
  pitch.addEventListener("pointerdown", (e) => {
    if (state.busy || isGameOver()) return;
    const aim = aimPointFromCanvasPointer(e.clientX, e.clientY);
    if (!aim) return;
    e.preventDefault();
    pitch.setPointerCapture?.(e.pointerId);
    state.aim.active = true;
    state.aim.x = aim.x;
    state.aim.y = aim.y;
    setDirToUI(aimPointToDir(aim));
    drawStatic();
  });

  pitch.addEventListener("pointermove", (e) => {
    if (!state.aim.active) return;
    if (state.busy || isGameOver()) return;
    const aim = aimPointFromCanvasPointer(e.clientX, e.clientY);
    if (!aim) return;
    e.preventDefault();
    state.aim.x = aim.x;
    state.aim.y = aim.y;
    setDirToUI(aimPointToDir(aim));
    drawStatic();
  });

  const endAim = (e) => {
    if (!state.aim.active) return;
    e.preventDefault?.();
  };
  pitch.addEventListener("pointerup", endAim);
  pitch.addEventListener("pointercancel", endAim);

  powerInput.addEventListener("input", () => {
    powerValue.textContent = String(powerInput.value);
  });
  curveInput.addEventListener("input", () => {
    curveValue.textContent = String(curveInput.value);
    drawStatic();
  });
  $$('input[name="dir"]').forEach((el) => {
    el.addEventListener("change", () => drawStatic());
  });

  powerMeter?.addEventListener("pointerdown", (e) => {
    if (state.busy || isGameOver()) return;
    if (!state.meter.active) return;
    e.preventDefault();
    lockMeterAndShoot();
  });

  window.addEventListener("keydown", (e) => {
    const k = e.key;

    // keyboard aiming (3x3)
    if (!state.busy && !isGameOver()) {
      if (k === "ArrowLeft") {
        e.preventDefault();
        moveDirBy(-1, 0);
        return;
      }
      if (k === "ArrowRight") {
        e.preventDefault();
        moveDirBy(1, 0);
        return;
      }
      if (k === "ArrowUp") {
        e.preventDefault();
        moveDirBy(0, -1);
        return;
      }
      if (k === "ArrowDown") {
        e.preventDefault();
        moveDirBy(0, 1);
        return;
      }
    }

    if (k === "Enter" || k === " ") {
      e.preventDefault();
      if (state.busy || isGameOver()) return;
      if (!state.meter.active) startMeter();
      else lockMeterAndShoot();
      return;
    }
    if (k.toLowerCase() === "r") {
      resetGame();
      return;
    }
  });
}

// Polyfill for roundRect in older browsers
if (!CanvasRenderingContext2D.prototype.roundRect) {
  // @ts-ignore
  CanvasRenderingContext2D.prototype.roundRect = function roundRect(x, y, w, h, r) {
    const rr = typeof r === "number" ? { tl: r, tr: r, br: r, bl: r } : r;
    const tl = rr?.tl ?? 0;
    const tr = rr?.tr ?? 0;
    const br = rr?.br ?? 0;
    const bl = rr?.bl ?? 0;
    this.beginPath();
    this.moveTo(x + tl, y);
    this.lineTo(x + w - tr, y);
    this.quadraticCurveTo(x + w, y, x + w, y + tr);
    this.lineTo(x + w, y + h - br);
    this.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    this.lineTo(x + bl, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - bl);
    this.lineTo(x, y + tl);
    this.quadraticCurveTo(x, y, x + tl, y);
    this.closePath();
    return this;
  };
}

wireEvents();
resetGame();
updateShootButtonLabel();

