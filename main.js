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
const powerInput = /** @type {HTMLInputElement} */ ($("#power"));
const curveInput = /** @type {HTMLInputElement} */ ($("#curve"));

const powerValue = $("#powerValue");
const curveValue = $("#curveValue");
const currentPlayerName = $("#currentPlayerName");
const resultText = $("#resultText");
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

function setHUD(text, tone = "neutral") {
  resultText.textContent = text;
  resultText.style.color =
    tone === "good"
      ? "rgba(34, 197, 94, 0.95)"
      : tone === "bad"
        ? "rgba(239, 68, 68, 0.95)"
        : tone === "warn"
          ? "rgba(245, 158, 11, 0.95)"
          : "rgba(255, 255, 255, 0.92)";
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
  state.round = 1;
  state.shooterIdx = 0;
  state.shotsTaken = 0;
  state.busy = false;
  state.history = CONFIG.players.map(() => []);
  state.anim.running = false;
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
}

function drawStatic() {
  drawScene({
    ball: null,
    goalie: { x: geom.goal.x + geom.goal.w / 2, y: geom.goal.y + geom.goal.h * 0.62 },
    aim: goalTargetForDir(dirFromUI(), Number(curveInput.value) * 0.6),
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
  if (outcome && !state.anim.running) {
    drawOutcomeStamp(outcome);
  }
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

  // small indicator text (debug-ish but subtle)
  if (!state.anim.running && goalieDir && shotDir && outcome) {
    ctx.globalAlpha = 0.9;
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.86)";
    ctx.fillText(`${goalieDir} vs ${shotDir}`, 0, 52);
  }
  ctx.restore();
}

function drawOutcomeStamp(outcome) {
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "800 54px ui-sans-serif, system-ui";

  const label = outcome === "GOAL" ? "进球！" : outcome === "SAVE" ? "扑出！" : "踢偏！";
  const color =
    outcome === "GOAL"
      ? "rgba(34, 197, 94, 0.98)"
      : outcome === "SAVE"
        ? "rgba(245, 158, 11, 0.98)"
        : "rgba(239, 68, 68, 0.98)";

  ctx.strokeStyle = "rgba(0,0,0,0.32)";
  ctx.lineWidth = 10;
  ctx.strokeText(label, geom.w / 2, 62);
  ctx.fillStyle = color;
  ctx.fillText(label, geom.w / 2, 62);
  ctx.restore();
}

function startShot() {
  if (state.busy || isGameOver()) return;

  const shotDir = dirFromUI();
  const speed = Number(powerInput.value);
  const curve = Number(curveInput.value);

  const goalieDir = chooseGoalieDir(shotDir, speed, curve);
  const outcome = outcomeForShot(shotDir, goalieDir, speed, curve);

  // store now (so skip animation still consistent)
  state.history[state.shooterIdx].push(outcome);

  state.anim.running = true;
  state.anim.startTs = performance.now();
  state.anim.from = { x: geom.spot.x, y: geom.spot.y };
  state.anim.to = goalTargetForDir(shotDir, curve * 0.75);
  state.anim.curve = curve;
  state.anim.goalieFrom = goalieTargetForDir("MC");
  state.anim.goalieTo = goalieTargetForDir(goalieDir);
  state.anim.outcome = outcome;
  state.anim.goalieDir = goalieDir;
  state.anim.shotDir = shotDir;
  state.anim.speed = speed;

  lockUI(true);
  skipAnimBtn.disabled = false;

  const dirLabel = DIRS[shotDir]?.label ?? "中路";
  setHUD(`射向 ${dirLabel}…`, "neutral");
  renderScoreboard();

  requestAnimationFrame(tick);
}

function finalizeShot() {
  state.anim.running = false;
  lockUI(false);
  skipAnimBtn.disabled = true;

  const outcome = state.anim.outcome;
  const dirLabel = DIRS[state.anim.shotDir]?.label ?? "中路";
  const goalieLabel = DIRS[state.anim.goalieDir]?.label ?? "中路";

  if (outcome === "GOAL") setHUD(`进球！你射向 ${dirLabel}，守门员扑向 ${goalieLabel}。`, "good");
  else if (outcome === "SAVE") setHUD(`被扑出！你射向 ${dirLabel}，守门员扑对了方向（${goalieLabel}）。`, "warn");
  else setHUD(`踢偏！你想射 ${dirLabel}，但球偏出了门框。`, "bad");

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
  } else {
    // draw end frame with stamp
    drawScene({
      ball: null,
      goalie: goalieTargetForDir(state.anim.goalieDir),
      aim: goalTargetForDir(dirFromUI(), Number(curveInput.value) * 0.6),
      outcome: state.anim.outcome,
      goalieDir: state.anim.goalieDir,
      shotDir: state.anim.shotDir,
    });
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
    drawScene({
      ball: null,
      goalie: { x: gTo.x, y: gTo.y },
      aim: null,
      outcome: state.anim.outcome,
      goalieDir: state.anim.goalieDir,
      shotDir: state.anim.shotDir,
    });

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
  drawScene({
    ball: null,
    goalie: state.anim.goalieTo,
    aim: null,
    outcome: state.anim.outcome,
    goalieDir: state.anim.goalieDir,
    shotDir: state.anim.shotDir,
  });
  finalizeShot();
}

function wireEvents() {
  shootBtn.addEventListener("click", () => startShot());
  resetBtn.addEventListener("click", () => resetGame());
  skipAnimBtn.addEventListener("click", () => skipAnimation());

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

    if (k === "Enter") {
      startShot();
      return;
    }
    if (k === " ") {
      e.preventDefault();
      startShot();
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

