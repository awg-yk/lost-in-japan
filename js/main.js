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
  } else if (c.farHops > 1) {
    // 複数区間(乗り換え)先までの通し候補(2026-07-31、ユーザー指示)。
    parts.push(`乗り換え${c.farHops - 1}回`);
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

// ① アルバイトができない場合も候補として表示だけはし、薄い色にして選べなく
// する(2026-07-31、ユーザー指示。押せない理由が分かりやすいように)。
function buildWorkCard() {
  const canWork = Game.canWork();
  const preview = Game.workPreview();
  const card = document.createElement('button');
  card.className = 'candidate-card candidate-card--action' + (canWork ? '' : ' candidate-card--disabled');
  card.disabled = !canWork;
  const metaText = preview.totalRemaining <= 0
    ? '今回の旅ではもう働けません'
    : `ここであと${preview.remaining}回まで(全${preview.max}回・旅全体であと${preview.totalRemaining}回)`;
  card.innerHTML = `
    <div class="candidate-cost earn">+${fmtMoney(preview.wage)}</div>
    <div class="candidate-icon">💼</div>
    <div class="candidate-body">
      <div class="candidate-name">アルバイトする</div>
      <div class="candidate-meta">${metaText}</div>
      <div class="candidate-preview">空腹 -${preview.hungerCost} ・ 体力 -${preview.staminaCost}</div>
    </div>
  `;
  if (canWork) card.addEventListener('click', onWork);
  return card;
}

// ② 食事も、選べない場合(所持金不足・満腹)は非表示にせず薄い色で表示する
// (2026-07-31、ユーザー指示。アルバイトと同じ扱いに揃えた)。実際の地点ごとの
// 飲食店データが無い暫定実装として、駅・空港・観光名所であれば一律に利用できる
// 候補として出す(§実装時の裁量)。
function buildEatCard() {
  const canEat = Game.canAffordEat();
  const card = document.createElement('button');
  card.className = 'candidate-card candidate-card--action' + (canEat ? '' : ' candidate-card--disabled');
  card.disabled = !canEat;
  card.innerHTML = `
    <div class="candidate-cost"><span class="cost-label">料金</span>${fmtMoney(window.EAT_COST)}</div>
    <div class="candidate-icon">🍙</div>
    <div class="candidate-body">
      <div class="candidate-name">食事をとる</div>
      <div class="candidate-meta">空腹を回復</div>
      <div class="candidate-preview">空腹 +${window.EAT_HUNGER_GAIN}</div>
    </div>
  `;
  if (canEat) card.addEventListener('click', onEat);
  return card;
}

// ③ 「休憩する」がデフォルトの体力回復手段(どこでも利用可、控えめな回復。
// 2026-07-31: 空腹も少し回復するようになった)。②と同様、選べない場合も
// 薄い色で表示する。
function buildRestCard() {
  const canRest = Game.canAffordRest();
  const card = document.createElement('button');
  card.className = 'candidate-card candidate-card--action' + (canRest ? '' : ' candidate-card--disabled');
  card.disabled = !canRest;
  card.innerHTML = `
    <div class="candidate-cost"><span class="cost-label">料金</span>${fmtMoney(window.REST_COST)}</div>
    <div class="candidate-icon">💺</div>
    <div class="candidate-body">
      <div class="candidate-name">休憩する</div>
      <div class="candidate-meta">体力・空腹を回復</div>
      <div class="candidate-preview">体力 +${window.REST_STAMINA_GAIN} ・ 空腹 +${window.REST_HUNGER_GAIN}</div>
    </div>
  `;
  if (canRest) card.addEventListener('click', onRest);
  return card;
}

// ③ 「温泉に入る」は温泉施設(type==='onsen')限定。体力が100%全回復する。
function buildOnsenCard() {
  const canOnsen = Game.canAffordOnsen();
  const card = document.createElement('button');
  card.className = 'candidate-card candidate-card--action' + (canOnsen ? '' : ' candidate-card--disabled');
  card.disabled = !canOnsen;
  card.innerHTML = `
    <div class="candidate-cost"><span class="cost-label">料金</span>${fmtMoney(window.ONSEN_COST)}</div>
    <div class="candidate-icon">♨️</div>
    <div class="candidate-body">
      <div class="candidate-name">温泉に入る</div>
      <div class="candidate-meta">体力が全回復</div>
      <div class="candidate-preview">体力 → 100%</div>
    </div>
  `;
  if (canOnsen) card.addEventListener('click', onOnsen);
  return card;
}

function buildCandidateCard(c) {
  const card = document.createElement('button');
  card.className = 'candidate-card candidate-card--move';
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
  return card;
}

// ④ 候補地をカテゴリー別(移動・歴史・自然・温泉・道の駅・その他)に整理して
// 表示する(2026-07-31、ユーザー指示。カテゴリーごとの横スクロール帯にする
// ことで、候補地をたくさん表示できるようにした)。
const CATEGORY_ICON = { 移動: '🧭', 歴史: '🏯', 自然: '🌲', 温泉: '♨️', 道の駅: '🅿️', その他: '📍' };

function renderCandidates() {
  const list = document.getElementById('candidate-list');
  list.innerHTML = '';
  MapView.clearCandidatePreview();
  const candidates = Game.getCandidates();
  // ①②: アルバイト・食事・休憩は選べない場合も表示だけして薄い色にする
  // (2026-07-31、ユーザー指示)。温泉は温泉施設でのみ意味を持つ行動のため、
  // 引き続き該当施設にいるときだけ表示する(押しても常に意味の無いカードを
  // 全国どこでも表示し続けるのは冗長なため)。
  const actionRow = document.createElement('div');
  actionRow.className = 'candidate-row';
  actionRow.appendChild(buildWorkCard());
  actionRow.appendChild(buildEatCard());
  actionRow.appendChild(buildRestCard());
  if (Game.canAffordOnsen() || Game.atOnsen()) actionRow.appendChild(buildOnsenCard());
  list.appendChild(actionRow);

  if (candidates.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'candidate-meta';
    empty.textContent = '近くに移動できる場所が見つかりません。';
    list.appendChild(empty);
    return;
  }

  const byCategory = new Map();
  for (const c of candidates) {
    const cat = c.category || 'その他';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(c);
  }

  const order = (window.Movement && Movement.CATEGORY_ORDER) || ['移動', '歴史', '自然', '温泉', '道の駅', 'その他'];
  for (const cat of order) {
    const items = byCategory.get(cat);
    if (!items || items.length === 0) continue;
    const group = document.createElement('div');
    group.className = 'candidate-category';
    const title = document.createElement('div');
    title.className = 'candidate-category-title';
    title.textContent = `${CATEGORY_ICON[cat] || '📍'} ${cat}`;
    group.appendChild(title);
    const row = document.createElement('div');
    row.className = 'candidate-row';
    // ③ 候補はカテゴリー内で距離が近い順に並べる(2026-07-31、ユーザー指示。
    // どの候補を残すか自体はmovement.js側のスコア選定のままで、表示順だけ変える)。
    const sorted = [...items].sort((a, b) => a.distanceKm - b.distanceKm);
    sorted.forEach(c => row.appendChild(buildCandidateCard(c)));
    group.appendChild(row);
    list.appendChild(group);
  }
}

function onWork() {
  const result = Game.work();
  toast(result.message);
  renderHud();
  if (result.gameOver) { showGameOver(); return; }
  renderCandidates();
}

function onEat() {
  const result = Game.eat();
  toast(result.message);
  renderHud();
  if (result.gameOver) { showGameOver(); return; }
  renderCandidates();
}

function onRest() {
  const result = Game.rest();
  toast(result.message);
  renderHud();
  if (result.gameOver) { showGameOver(); return; }
  renderCandidates();
}

function onOnsen() {
  const result = Game.onsen();
  toast(result.message);
  renderHud();
  if (result.gameOver) { showGameOver(); return; }
  renderCandidates();
}

function onChooseCandidate(candidate) {
  MapView.clearCandidatePreview();
  const result = Game.chooseCandidate(candidate);
  toast(result.message);
  renderHud();

  // 所持金・空腹・体力が尽きた(行動不能)場合はゲームオーバー画面へ。
  // ヒッチハイク失敗時にもgameOverが立ち得る(現在地は変わらない)。
  if (result.gameOver) { showGameOver(); return; }

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

function showGameOver() {
  const s = Game.state;
  document.getElementById('gameover-time').textContent = fmtTime(s.playTimeSec);
  document.getElementById('gameover-distance').textContent = fmtKm(s.totalDistanceKm);
  document.getElementById('gameover-visited').textContent = s.visitedIds.length;
  MapView.clearCandidatePreview();
  document.getElementById('candidate-panel').classList.add('hidden');
  showOverlay('overlay-gameover');
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

function setupVoronoiButton() {
  const btn = document.getElementById('fab-voronoi');
  if (!btn) return;
  btn.addEventListener('click', () => { MapView.toggleVoronoi(); });
}

function setupPlayAgain() {
  document.getElementById('btn-play-again').addEventListener('click', () => {
    hideOverlay('overlay-result');
    showOverlay('overlay-title');
  });
}

function setupGameOverRetry() {
  document.getElementById('btn-gameover-retry').addEventListener('click', () => {
    hideOverlay('overlay-gameover');
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

function isGameActive() {
  return !!Game.state && !Game.state.arrived && !Game.state.gameOver;
}

function setupIntervals() {
  setInterval(() => {
    if (isGameActive()) {
      Game.tickPlayTime();
      renderHud();
    }
  }, 1000);
  setInterval(() => { if (isGameActive()) Save.write(Game.state); }, 5000);
  window.addEventListener('beforeunload', () => { if (isGameActive()) Save.write(Game.state); });
}

async function init() {
  setLoading(true, 'データを読み込んでいます...');
  const data = await loadData();
  Game.init(data);
  MapView.init();
  MapView.setStations(data.stationsById);
  setLoading(false);

  Save.clear();
  showOverlay('overlay-title');

  setupDifficultyButtons();
  setupResetButton();
  setupVoronoiButton();
  setupPlayAgain();
  setupGameOverRetry();
  setupIntervals();
}

init();
