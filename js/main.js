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

// stations.jsonのconnectionsは片方向のみ定義されているため、
// 起動時に一度だけ逆方向の接続を補完する(通常は双方向に移動できるため)。
function ensureReciprocalConnections(stations) {
  const byId = new Map(stations.map(s => [s.id, s]));
  const originalEdges = [];
  stations.forEach(s => s.connections.forEach(c => originalEdges.push({ from: s.id, ...c })));
  originalEdges.forEach(edge => {
    const target = byId.get(edge.toId);
    if (!target) return;
    const hasReverse = target.connections.some(c => c.toId === edge.from && c.mode === edge.mode && c.cost === edge.cost);
    if (!hasReverse) {
      target.connections.push({ toId: edge.from, mode: edge.mode, requiresTransport: edge.requiresTransport, cost: edge.cost, isBudget: !!edge.isBudget });
    }
  });
}

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

  ensureReciprocalConnections(stations);

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
  document.getElementById('gauge-thirst').style.width = s.thirst + '%';
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

function renderCandidates() {
  const list = document.getElementById('candidate-list');
  list.innerHTML = '';
  const candidates = Game.getCandidates();

  if (candidates.length === 0) {
    list.innerHTML = '<div class="candidate-meta">近くに移動できる場所が見つかりません。食事・水分補給をしてから、再度お試しください。</div>';
    return;
  }

  candidates.forEach(c => {
    const card = document.createElement('button');
    card.className = 'candidate-card';
    card.innerHTML = `
      <div class="candidate-icon">${MODE_ICON[c.mode] || '📍'}</div>
      <div class="candidate-body">
        <div class="candidate-name">${c.targetName}${c.isNew ? '<span class="new-badge">未発見</span>' : ''}</div>
        <div class="candidate-meta">${candidateMetaText(c)}</div>
      </div>
      <div class="candidate-cost">${c.cost > 0 ? `<span class="cost-label">運賃</span>${fmtMoney(c.cost)}` : '無料'}</div>
    `;
    card.addEventListener('click', () => onChooseCandidate(c));
    list.appendChild(card);
  });
}

function onChooseCandidate(candidate) {
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

function startNewGame() {
  Game.newGame();
  MapView.clearRoute();
  MapView.visitedLayer.clearLayers();
  renderNewGameOnMap();
  renderHud();
  document.getElementById('candidate-panel').classList.remove('hidden');
  renderCandidates();
  toast(`旅の始まり: ${Game.currentNode().name} から ${Game.destinationNode().name} を目指します。`);
}

function continueGame(saved) {
  Game.loadFromSave(saved);
  MapView.clearRoute();
  MapView.visitedLayer.clearLayers();
  renderNewGameOnMap();
  renderHud();
  document.getElementById('candidate-panel').classList.remove('hidden');
  renderCandidates();
  toast('前回の続きから再開しました。');
}

function setupHudActions() {
  document.getElementById('btn-eat').addEventListener('click', () => {
    const r = Game.eat();
    toast(r.message);
    renderHud();
    if (r.ok) renderCandidates();
  });
  document.getElementById('btn-drink').addEventListener('click', () => {
    const r = Game.drink();
    toast(r.message);
    renderHud();
    if (r.ok) renderCandidates();
  });
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
    startNewGame();
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

  const saved = Save.load();
  const hasValidSave = !!(saved && data.stationsById.has(saved.destinationId));

  showOverlay('overlay-title');
  document.getElementById('btn-continue').style.display = hasValidSave ? 'block' : 'none';

  document.getElementById('btn-continue').addEventListener('click', () => {
    hideOverlay('overlay-title');
    continueGame(saved);
  }, { once: true });

  document.getElementById('btn-newgame').addEventListener('click', () => {
    hideOverlay('overlay-title');
    Save.clear();
    startNewGame();
  }, { once: true });

  setupHudActions();
  setupResetButton();
  setupPlayAgain();
  setupIntervals();
}

init();
