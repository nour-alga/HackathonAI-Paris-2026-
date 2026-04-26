// Démo locale — réplique simplifiée de la logique du service FastAPI.
// IsolationForest n'est pas embarqué côté navigateur ; on simule un score
// avec une heuristique calibrée sur le baseline (gamma volume, poisson tx).

const vol = document.getElementById('vol');
const tx  = document.getElementById('tx');
const volOut = document.getElementById('volOut');
const txOut  = document.getElementById('txOut');
const fire   = document.getElementById('fire');
const term   = document.getElementById('termBody');

const THRESHOLD = -0.15;
const DESTRUCTIVE_ETH = 50;

function fmt(v, unit = '') { return `${v}${unit}`; }
function ts() { return new Date().toISOString().slice(11, 23); }

function refresh() {
  volOut.textContent = `${vol.value} ETH`;
  txOut.textContent  = tx.value;
}
vol.addEventListener('input', refresh);
tx.addEventListener('input', refresh);
refresh();

/**
 * Score heuristique : plus le couple (volume, tx_count) s'éloigne du baseline
 * (~3 ETH/s, ~15 tx/s), plus le score décroît vers les négatifs.
 */
function fakeScore(volEth, txCount) {
  const dv = Math.max(0, volEth - 3) / 25;
  const dt = Math.max(0, txCount - 15) / 80;
  const dist = Math.sqrt(dv * dv + dt * dt);
  return +(0.10 - dist).toFixed(4);
}

function append(line, cls = '') {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = line + '\n';
  term.appendChild(span);
  term.scrollTop = term.scrollHeight;
}

function clearTerm() {
  term.textContent = '';
}

function fakeTxHash() {
  const hex = '0123456789abcdef';
  let s = '0x';
  for (let i = 0; i < 64; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

fire.addEventListener('click', async () => {
  const volEth = +vol.value;
  const txCount = +tx.value;
  const score = fakeScore(volEth, txCount);
  const isAnomaly = score < THRESHOLD;
  const isDestructive = volEth >= DESTRUCTIVE_ETH;

  clearTerm();
  append(`[${ts()}] POST /predict`);
  append(`  payload = { volume_1s: ${volEth} ETH, tx_count_1s: ${txCount} }`);
  await sleep(180);
  append(`[${ts()}] isolation_forest.decision_function → score=${score}`);
  await sleep(140);

  if (isAnomaly) append(`[${ts()}] anomaly=true (score < ${THRESHOLD})`, 'line-warn');
  else append(`[${ts()}] anomaly=false — flux nominal`, 'line-ok');

  if (isAnomaly && isDestructive) {
    await sleep(120);
    append(`[${ts()}] DESTRUCTIVE_VOLUME franchi (${volEth} ≥ ${DESTRUCTIVE_ETH} ETH)`, 'line-warn');
    await sleep(100);
    append(`[${ts()}] HaltExecutor.trigger()`, 'line-warn');
    await sleep(140);
    append(`  fees: maxPriorityFeePerGas +50%  /  maxFeePerGas +50%`);
    await sleep(160);
    const hash = fakeTxHash();
    append(`[${ts()}] >> CIRCUIT BREAKER FIRED  tx=${hash}`, 'line-fire');
    append(`  VaultClient.emergencyHalt() broadcasté ✔`, 'line-fire');
  } else if (isAnomaly && !isDestructive) {
    await sleep(80);
    append(`[${ts()}] anomalie sans seuil destructeur — observe & log`, 'line-warn');
  }

  await sleep(80);
  append(`[${ts()}] response 200 OK  latency_ms=${(Math.random() * 4 + 2).toFixed(2)}`, 'line-ok');
});
