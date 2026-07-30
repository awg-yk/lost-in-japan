// main.js — 初期化、ゲームループの起点

const MODE_ICON = { walk: '🚶', rail: '🚃', flight: '✈️', ferry: '⛴️', hitchhike: '🚗' };
const MODE_LABEL = { walk: '徒歩', rail: '鉄道', flight: '飛行機', ferry: 'フェリー', hitchhike: 'ヒッチハイク' };

function fmtKm(km) { return km < 10 ? `${km.toFixed(2)} km` : `${km.toFixed(1)} km`; }
function fmtMoney(n) { return `¥${Math.floor(n).toLocaleString()}`; }
function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(msg, ms = 3200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function setLoading(visible, text) {
  const el = document.getElementById('loading');
  if (text) el.textContent = text;
  el.classList.toggle('hidden', !visible);
}

function showOverlay(id) { document.getElementById(id).classList.remove('hidden'); }
function hideOverlay(id) { document.getElementById(id).classList.add('hidden'); }

async function loadData() {
  const [placesRes, stationsRes, blockReachabilityRes] = await Promise.all([
    fetch('data/places.json'),
    fetch('data/stations.json'),
    fetch('data/blockReachability.json'),
  ]);
  const placesJson = await placesRes.json();
  const stationsJson = await stationsRes.json();
  const blockReachability = await blockReachabilityRes.json();
  const places = placesJson.places;
  const stations = stationsJson.nodes;

  DataUtils.ensureReciprocalConnections(stations);

  return {
    places,
    stations,
    placesById: new Map(places.map(p => [p.id, p])),
    stationsById: new Map(stations.map(s => [s.id, s])),
    spatialIndex: Movement.buildSpatialIndex(places, stations),
    blockReachability,
  };
}

function renderHud() {
  const s = Game.state;
  const dest = Game.destinationNode();
  const cur = Game.currentNode();
  if (dest && cur) {
    const d = Movement.haversineKm(cur.lat, cur.lng, dest.lat, dest.lng);
    document.getElementById('stat-distance').textContent = fmtKm(d);
  }
  document.getElementById('stat-money').textContent = fmtMoney(s.money);
  document.getElementById('stat-time').textContent = fmtTime(s.playTimeSec);
  document.getElementById('gauge-hunger').style.width = s.hunger + '%';
  document.getElementById('gauge-stamina').style.width = s.stamina + '%';
}

function candidateMetaText(c) {
  const parts = [fmtKm(c.distanceKm)];
  if (c.mode === 'hitchhike') {
    parts.push(`成功率 ${Math.round(c.successRate * 100)}%`);
  } else if (c.cost > 0) {
    parts.push(c.isBudget ? '格安便' : MODE_LABEL[c.mode]);
  } else {
    parts.push(MODE_LABEL[c.mode]);
  }
  return parts.join(' ・ ');
}

// 徒歩の場合のみ、移動すると空腹/体力がどれだけ減るかを事前に見せる
// (体力は徒歩による消耗のみ発生するため、徒歩以外では表示しない)。
function candidatePreviewText(c) {
  if (c.mode !== 'walk') return '';
  const hungerLoss = Math.round(c.distanceKm * window.HUNGER_DECAY_PER_KM);
  const staminaLoss = Math.round(c.distanceKm * window.STAMINA_DECAY_PER_KM_WALK);
  const fmt = (n) => (n > 0 ? `-${n}` : '0');
  return `空腹 ${fmt(hungerLoss)} ・ 体力 ${fmt(staminaLoss)}`;
}

function buildWorkCard() {
  const preview = Game.workPreview();
  const card = document.createElement('button');
  card.className = 'candidate-card';
  card.innerHTML = `
    <div class="candidate-cost earn">+${fmtMoney(preview.wage)}</div>
    <div class="candidate-icon">💼</div>
    <div class="candidate-body">
      <div class="candidate-name">アルバイトする</div>
      <div class="candidate-meta">ここであと${preview.remaining}回まで(全${preview.max}回)</div>
      <div class="candidate-preview">空腹 -${preview.hungerCost} ・ 体力 -${preview.staminaCost}</div>
    </div>
  `;
  card.addEventListener('click', onWork);
  return card;
}

// 食事・温泉は、実際の地点ごとの飲食店/温泉データが無い暫定実装として、
// 駅・空港であれば一律に利用できる候補として出す(§実装時の裁量)。
function buildEatCard() {
  const card = document.createElement('button');
  card.className = 'candidate-card';
  card.innerHTML = `
    <div class="candidate-cost"><span class="cost-label">料金</span>${fmtMoney(window.EAT_COST)}</div>
    <div class="candidate-icon">🍙</div>
    <div class="candidate-body">
      <div class="candidate-name">食事をとる</div>
      <div class="candidate-meta">空腹を回復</div>
      <div class="candidate-preview">空腹 +${window.EAT_HUNGER_GAIN}</div>
    </div>
  `;
  card.addEventListener('click', onEat);
  return card;
}

function buildRestCard() {
  const card = document.createElement('button');
  card.className = 'candidate-card';
  card.innerHTML = `
    <div class="candidate-cost"><span class="cost-label">料金</span>${fmtMoney(window.REST_COST)}</div>
    <div class="candidate-icon">♨️</div>
    <div class="candidate-body">
      <div class="candidate-name">温泉に入る</div>
      <div class="candidate-meta">体力を回復</div>
      <div class="candidate-preview">体力 +${window.REST_STAMINA_GAIN}</div>
    </div>
  `;
  card.addEventListener('click', onRest);
  return card;
}

function renderCandidates() {
  const list = document.getElementById('candidate-list');
  list.innerHTML = '';
  MapView.clearCandidatePreview();
  const candidates = Game.getCandidates();
  const canWork = Game.canWork();
  const canEat = Game.canAffordEat();
  const canRest = Game.canAffordRest();

  if (candidates.length === 0 && !canWork && !canEat && !canRest) {
    list.innerHTML = '<div class="candidate-meta">近くに移動できる場所が見つかりません。</div>';
    return;
  }

  // アルバイト・食事・温泉は「移動」ではなく「その場での行動」なので、選択肢の先頭に別枠で出す。
  if (canWork) list.appendChild(buildWorkCard());
  if (canEat) list.appendChild(buildEatCard());
  if (canRest) list.appendChild(buildRestCard());

  candidates.forEach(c => {
    const card = document.createElement('button');
    card.className = 'candidate-card';
    const preview = candidatePreviewText(c);
    card.innerHTML = `
      <div class="candidate-cost">${c.cost > 0 ? `<span class="cost-label">運賃</span>${fmtMoney(c.cost)}` : '無料'}</div>
      <div class="candidate-icon">${MODE_ICON[c.mode] || '📍'}</div>
      <div class="candidate-body">
        <div class="candidate-name">${c.targetName}${c.isNew ? '<span class="new-badge">未発見</span>' : ''}</div>
        <div class="candidate-meta">${candidateMetaText(c)}</div>
        ${preview ? `<div class="candidate-preview">${preview}</div>` : ''}
      </div>
    `;
    card.addEventListener('click', () => onChooseCandidate(c));

    // カーソルを合わせている間、現在地→候補地の直線と候補地点を地図上で強調表示する。
    const targetNode = c.targetType === 'place' ? Game.data.placesById.get(c.targetId) : Game.data.stationsById.get(c.targetId);
    const currentNode = Game.currentNode();
    if (targetNode && currentNode) {
      card.addEventListener('mouseenter', () => MapView.showCandidatePreview(currentNode, targetNode));
      card.addEventListener('mouseleave', () => MapView.clearCandidatePreview());
    }

    list.appendChild(card);
  });
}

function onWork() {
  const result = Game.work();
  toast(result.message);
  renderHud();
  renderCandidates();
}

function onEat() {
  const result = Game.eat();
  toast(result.message);
  renderHud();
  renderCandidates();
}

function onRest() {
  const result = Game.rest();
  toast(result.message);
  renderHud();
  renderCandidates();
}

function onChooseCandidate(candidate) {
  MapView.clearCandidatePreview();
  const result = Game.chooseCandidate(candidate);
  toast(result.message);
  renderHud();

  // ヒッチハイク失敗や所持金不足の場合は現在地が変わっていないため、
  // 地図上のマーカーも動かさない(移動した見た目にならないようにする)。
  if (!result.ok) {
    renderCandidates();
    return;
  }

  const node = candidate.targetType === 'place' ? Game.data.placesById.get(candidate.targetId) : Game.data.stationsById.get(candidate.targetId);
  MapView.markVisited(node, candidate.isNew);
  MapView.setCurrent(node, true);

  if (result.arrived) {
    showResult();
    return;
  }
  renderCandidates();
}

function showResult() {
  const s = Game.state;
  document.getElementById('res-time').textContent = fmtTime(s.playTimeSec);
  document.getElementById('res-distance').textContent = fmtKm(s.totalDistanceKm);
  document.getElementById('res-visited').textContent = s.visitedIds.length;
  document.getElementById('res-prefectures').textContent = Game.prefectureCount();
  document.getElementById('res-discovered').textContent = s.discoveredIds.length;
  document.getElementById('res-money').textContent = fmtMoney(s.money);

  const breakdown = Game.transportBreakdown();
  const breakdownText = Object.entries(breakdown)
    .map(([mode, count]) => `${MODE_LABEL[mode] || mode}: ${count}回`)
    .join(' / ');
  document.getElementById('res-breakdown').textContent = `利用交通機関: ${breakdownText || 'なし'}`;

  const coords = s.moveHistory.map(m => {
    const node = m.fromType === 'place' ? Game.data.placesById.get(m.fromId) : Game.data.stationsById.get(m.fromId);
    return node ? [node.lat, node.lng] : null;
  }).filter(Boolean);
  const lastNode = Game.currentNode();
  if (lastNode) coords.push([lastNode.lat, lastNode.lng]);
  MapView.drawRoute(coords);

  document.getElementById('candidate-panel').classList.add('hidden');
  showOverlay('overlay-result');
}

function renderNewGameOnMap() {
  MapView.setDestination(Game.destinationNode());
  MapView.setCurrent(Game.currentNode(), true);
  Game.state.visitedIds.forEach(id => {
    const node = Game.data.placesById.get(id) || Game.data.stationsById.get(id);
    if (node) MapView.markVisited(node, Game.state.discoveredIds.includes(id));
  });
}

function startNewGame(difficulty) {
  Game.newGame(difficulty);
  MapView.clearRoute();
  MapView.visitedLayer.clearLayers();
  renderNewGameOnMap();
  renderHud();
  document.getElementById('candidate-panel').classList.remove('hidden');
  renderCandidates();
  toast(`旅の始まり: ${Game.currentNode().name} から ${Game.destinationNode().name} を目指します。`);
}

function setupResetButton() {
  document.getElementById('fab-reset').addEventListener('click', () => {
    if (confirm('セーブデータを削除して、タイトル画面に戻ります。よろしいですか？')) {
      Save.clear();
      location.reload();
    }
  });
}

function setupPlayAgain() {
  document.getElementById('btn-play-again').addEventListener('click', () => {
    hideOverlay('overlay-result');
    showOverlay('overlay-title');
  });
}

function setupDifficultyButtons() {
  ['easy', 'normal', 'hard'].forEach((difficulty) => {
    document.getElementById(`btn-${difficulty}`).addEventListener('click', () => {
      hideOverlay('overlay-title');
      startNewGame(difficulty);
    });
  });
}

function setupIntervals() {
  setInterval(() => {
    if (Game.state && !Game.state.arrived) {
      Game.tickPlayTime();
      renderHud();
    }
  }, 1000);
  setInterval(() => { if (Game.state && !Game.state.arrived) Save.write(Game.state); }, 5000);
  window.addEventListener('beforeunload', () => { if (Game.state && !Game.state.arrived) Save.write(Game.state); });
}

async function init() {
  setLoading(true, 'データを読み込んでいます...');
  const data = await loadData();
  Game.init(data);
  MapView.init();
  setLoading(false);

  Save.clear();
  showOverlay('overlay-title');

  setupDifficultyButtons();
  setupResetButton();
  setupPlayAgain();
  setupIntervals();
}

init();
