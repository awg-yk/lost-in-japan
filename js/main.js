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

// 都道府県レベルの簡易「住所」表示(2026-08-02、ユーザー指示)。stations.jsonは
// 大半(約93%)にprefectureがあるが、places.json側はほぼ無い(取り込んだ
// データソースにその情報が乏しいため)ので、観光名所にいる場合は最寄り駅の
// prefectureで代用する。それでも不明な場合は地名だけを表示する。
function addressOf(node, nodeType) {
  if (!node) return '--';
  let prefecture = node.prefecture;
  if (!prefecture && nodeType === 'place' && node.nearestStationId) {
    const station = Game.data.stationsById.get(node.nearestStationId);
    prefecture = station && station.prefecture;
  }
  return prefecture ? `${prefecture} ${node.name}` : node.name;
}

function renderHud() {
  const s = Game.state;
  const dest = Game.destinationNode();
  const cur = Game.currentNode();
  if (dest && cur) {
    const d = Movement.haversineKm(cur.lat, cur.lng, dest.lat, dest.lng);
    document.getElementById('stat-distance').textContent = fmtKm(d);
  }
  document.getElementById('stat-current-address').textContent = addressOf(cur, s.currentNodeType);
  document.getElementById('stat-destination-address').textContent = addressOf(dest, 'transport');
  document.getElementById('stat-money').textContent = fmtMoney(s.money);
  document.getElementById('stat-time').textContent = fmtTime(s.playTimeSec);
  document.getElementById('gauge-hunger').style.width = s.hunger + '%';
  document.getElementById('gauge-stamina').style.width = s.stamina + '%';
  renderHudActionButtons();
}

// 空腹/体力ゲージの横に置いた「食事をとる/休憩する/温泉に入る」ボタンの
// 有効・無効と表示/非表示を同期する(2026-08-03、ユーザー指示。以前は
// 下部の候補パネルの別メニューだったカードの代替)。
function renderHudActionButtons() {
  const eatBtn = document.getElementById('hud-btn-eat');
  const restBtn = document.getElementById('hud-btn-rest');
  const onsenBtn = document.getElementById('hud-btn-onsen');
  eatBtn.disabled = !Game.canAffordEat();
  eatBtn.title = `食事をとる(¥${window.EAT_COST}、空腹 +${window.EAT_HUNGER_GAIN}）`;
  restBtn.disabled = !Game.canAffordRest();
  restBtn.title = `休憩する(¥${window.REST_COST}、体力 +${window.REST_STAMINA_GAIN}・空腹 +${window.REST_HUNGER_GAIN}）`;
  const showOnsen = Game.atOnsen();
  onsenBtn.classList.toggle('hidden', !showOnsen);
  if (showOnsen) {
    onsenBtn.disabled = !Game.canAffordOnsen();
    onsenBtn.title = `温泉に入る(¥${window.ONSEN_COST}、体力 → 100%）`;
  }
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

// 移動候補1件分のツールチップHTML(地図マーカーにホバーした際に表示する内容。
// 以前の候補カードと同じ情報を出す)。
function candidateTooltipHtml(c) {
  const preview = candidatePreviewText(c);
  const costText = c.cost > 0 ? `運賃 ${fmtMoney(c.cost)}` : '無料';
  return `
    <div class="map-candidate-tooltip">
      <div class="map-candidate-tooltip-name">${MODE_ICON[c.mode] || '📍'} ${c.targetName}${c.isNew ? '<span class="new-badge">未発見</span>' : ''}</div>
      <div class="map-candidate-tooltip-meta">${costText} ・ ${candidateMetaText(c)}</div>
      ${preview ? `<div class="map-candidate-tooltip-preview">${preview}</div>` : ''}
    </div>
  `;
}

function targetNodeOf(c) {
  return c.targetType === 'place' ? Game.data.placesById.get(c.targetId) : Game.data.stationsById.get(c.targetId);
}

// 観光名所に到着したら、その地点のピン(現在地マーカー)に公式ホームページへの
// リンクをポップアップとして表示する(2026-08-02、ユーザー指示。「ピンを打って
// そこに公式URLを記載し、わかりやすい位置で表示」。以前の画面固定パネル・
// Wikipedia/Googleマップへのリンクは廃止)。公式URLを持つ地点でのみ表示し、
// リンクを開くと対価としてお金がもらえる(Game.viewOfficialSite()、1地点1回のみ)。
function showOfficialSitePinIfAny(node) {
  if (!node || !node.officialUrl) return;
  const alreadyViewed = Game.state.officialSiteViewedIds.includes(node.id);
  const label = alreadyViewed
    ? '🔗 公式ホームページ（確認済み）'
    : `🔗 公式ホームページを見る（+¥${OFFICIAL_SITE_VIEW_REWARD}）`;
  const html = `
    <div class="map-pin-official">
      <div class="map-pin-official-name">📍 ${node.name}</div>
      <a href="${node.officialUrl}" target="_blank" rel="noopener noreferrer" id="map-official-site-link">${label}</a>
    </div>
  `;
  MapView.bindCurrentPopup(html, alreadyViewed ? null : () => {
    const result = Game.viewOfficialSite();
    if (result.ok) {
      toast(result.message);
      renderHud();
      showOfficialSitePinIfAny(node);
    }
  });
}

// 2026-08-03、ユーザー指示によりUIを刷新: 「移動する/観光する/休憩する」の
// 選択メニューを廃止し、常に地図モード(駅・観光地のマーカーを地図上に直接
// 表示し、クリックで移動する)をデフォルト表示にした。食事・休憩・温泉は
// HUDのゲージ横ボタン(renderHudActionButtons参照)に移したため、下部の
// 候補パネルはヒント文だけを表示する軽量なものになっている。
// 表示範囲が「日本全国」に広がったため、地図の表示中の範囲(ビューポート)に
// 入っている駅・観光地だけを描画し、パン/ズームのたびに再描画する
// (setupMapViewportRefresh参照)。

// 徒歩圏外の観光地用のツールチップ(「最寄り駅まで移動してください。」)。
function blockedPlaceTooltipHtml(node, distanceKm) {
  return `
    <div class="map-candidate-tooltip map-candidate-tooltip--blocked">
      <div class="map-candidate-tooltip-name">📍 ${node.name}</div>
      <div class="map-candidate-tooltip-meta">${fmtKm(distanceKm)} ・ 徒歩圏外</div>
      <div class="map-candidate-tooltip-preview">最寄り駅まで移動してください。</div>
    </div>
  `;
}

// 全国規模のデータをビューポートだけで絞っても、日本全体が収まるような
// 低ズーム(国土全体表示)ではほぼ全件がビューポート内に入ってしまい、
// 数百〜数千件のマーカーを毎回作り直すと目に見えて重くなる(実測: 約1600件で
// 描画に160ms以上、パン操作の追従が明らかに遅れる)。そのため、ある程度
// ズームインするまでは観光地マーカーを間引く(駅は数が少なく実害が出にくい
// ため、こちらは常に表示するが安全のため上限だけ設ける)。
const PLACE_MARKERS_MIN_ZOOM = 9;
const PLACE_MARKERS_MAX_COUNT = 300;
const STATION_MARKERS_MAX_COUNT = 300;

// 現在の地図表示範囲(ビューポート)内にある駅・観光地から、地図マーカー用の
// item配列を組み立てる。駅は所持金で移動できるものすべて(Game.getMapStationCandidates
// = movement.jsのカテゴリー別クォータを経由しない全件取得)、観光地は全国
// すべて(Game.getAllPlacesForMap)を対象にし、それぞれビューポートで絞り込む
// (全国分を毎回マーカー化すると重いため)。
function buildMapItems() {
  const currentNode = Game.currentNode();
  if (!currentNode || !MapView.map) return { currentNode, items: [], placesHiddenByZoom: false };
  const bounds = MapView.map.getBounds();
  const zoom = MapView.map.getZoom();

  const stationItems = Game.getMapStationCandidates()
    .map(c => {
      const node = targetNodeOf(c);
      if (!node || !bounds.contains([node.lat, node.lng])) return null;
      const emoji = (window.TYPE_ICONS && window.TYPE_ICONS[node.type]) || '🚉';
      return { kind: 'station', candidate: c, node, emoji, tooltipHtml: candidateTooltipHtml(c), isNew: c.isNew };
    })
    .filter(Boolean)
    // 近い順に残す(件数が多い場合、現在地から遠すぎて実用性の低いものから間引く)。
    .sort((a, b) => a.candidate.distanceKm - b.candidate.distanceKm)
    .slice(0, STATION_MARKERS_MAX_COUNT);

  const placesHiddenByZoom = zoom < PLACE_MARKERS_MIN_ZOOM;
  if (placesHiddenByZoom) {
    return { currentNode, items: stationItems, placesHiddenByZoom };
  }

  const placeItems = Game.getAllPlacesForMap()
    .filter(info => bounds.contains([info.place.lat, info.place.lng]))
    // 徒歩で実際に行ける地点を優先して残し、間引かれるのは徒歩圏外(見た目の
    // 参考程度)の地点からにする。同条件内では近い順。
    .sort((a, b) => (a.walkable === b.walkable ? a.distanceKm - b.distanceKm : (a.walkable ? -1 : 1)))
    .slice(0, PLACE_MARKERS_MAX_COUNT)
    .map(info => {
      const node = info.place;
      const emoji = (window.TYPE_ICONS && window.TYPE_ICONS[node.type]) || '📍';
      const candidate = {
        targetId: node.id, targetType: 'place', targetName: node.name,
        mode: 'walk', cost: 0, distanceKm: info.distanceKm, isNew: info.isNew,
      };
      const tooltipHtml = info.walkable
        ? candidateTooltipHtml(candidate)
        : blockedPlaceTooltipHtml(node, info.distanceKm);
      return { kind: 'place', place: node, node, emoji, tooltipHtml, isNew: info.isNew, walkable: info.walkable, blocked: !info.walkable };
    });

  return { currentNode, items: [...stationItems, ...placeItems], placesHiddenByZoom };
}

// 地図マーカーのクリックを、駅(候補選択)と観光地(徒歩)とで振り分ける。
function onMapMarkerClick(item) {
  if (item.kind === 'station') {
    onChooseCandidate(item.candidate);
    return;
  }
  onWalkToPlace(item.place, item.isNew);
}

// 駅マーカー(鉄道・飛行機・フェリー・ヒッチハイク候補)をクリックした際の処理。
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
  showOfficialSitePinIfAny(node);

  if (result.arrived) {
    showResult();
    return;
  }
  renderCandidates();
}

function onWalkToPlace(place, wasNew) {
  MapView.clearCandidatePreview();
  const result = Game.walkToPlace(place.id);
  toast(result.message);
  if (result.blocked) return; // 徒歩圏外。状態は変わっていないので地図はそのまま。
  renderHud();
  if (result.gameOver) { showGameOver(); return; }
  if (!result.ok) { renderCandidates(); return; }
  MapView.markVisited(place, wasNew);
  MapView.setCurrent(place, true);
  showOfficialSitePinIfAny(place);
  if (result.arrived) { showResult(); return; }
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

function renderCandidates() {
  const list = document.getElementById('candidate-list');
  MapView.clearCandidatePreview();

  if (!isGameActive()) {
    list.innerHTML = '';
    MapView.clearCandidateMarkers();
    return;
  }

  const { currentNode, items, placesHiddenByZoom } = buildMapItems();
  const stationCount = items.filter(i => i.kind === 'station').length;
  const placeCount = items.filter(i => i.kind === 'place').length;
  const zoomHint = placesHiddenByZoom ? '観光地表示にはもう少しズームインしてください。' : `観光地${placeCount}件`;
  list.innerHTML = `<div class="map-move-hint">🗺️ マーカーにカーソルを合わせると詳細、クリックで移動します。（表示中: 駅${stationCount}件・${zoomHint}）</div>`;
  MapView.renderCandidateMarkers(items, currentNode, onMapMarkerClick);
}

// 地図をパン/ズームするたびに、表示範囲内の駅・観光地マーカーを描画し直す
// (2026-08-03、ユーザー指示。「地図で表示できる範囲が大きくなったので、
// 表示できる分は全部見せてほしい」への対応。ビューポート外は描画しないので
// 全国分を毎回マーカー化する重さは発生しない)。
function setupMapViewportRefresh() {
  MapView.map.on('moveend zoomend', () => renderCandidates());
}

function showGameOver() {
  const s = Game.state;
  document.getElementById('gameover-time').textContent = fmtTime(s.playTimeSec);
  document.getElementById('gameover-distance').textContent = fmtKm(s.totalDistanceKm);
  document.getElementById('gameover-visited').textContent = s.visitedIds.length;
  MapView.clearCandidatePreview();
  MapView.clearCandidateMarkers();
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
  MapView.clearCandidateMarkers();

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

// HUDのゲージ横ボタン(食事をとる/休憩する/温泉に入る)。2026-08-03、
// ユーザー指示によりゲージのすぐ横に常時表示する形に変更した。
function setupHudActionButtons() {
  document.getElementById('hud-btn-eat').addEventListener('click', onEat);
  document.getElementById('hud-btn-rest').addEventListener('click', onRest);
  document.getElementById('hud-btn-onsen').addEventListener('click', onOnsen);
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
  setLoading(false);

  Save.clear();
  showOverlay('overlay-title');

  setupDifficultyButtons();
  setupResetButton();
  setupPlayAgain();
  setupGameOverRetry();
  setupHudActionButtons();
  setupMapViewportRefresh();
  setupIntervals();
}

init();
