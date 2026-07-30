// movement.js — 移動候補生成・到達可能性判定・評価式(§6)

const WALK_RADIUS_KM_DEFAULT = 8;
const WALK_RADIUS_KM_LOW_STAT = 5;
const HITCHHIKE_BASE_RATE_LAND = 0.85;
const HITCHHIKE_BASE_RATE_FERRY = 0.30;
const HITCHHIKE_LOW_STAT_PENALTY = 0.15;
const MAX_CANDIDATES = 5;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function gridKeyOf(lat, lng) {
  return `${Math.floor(lat * 10) / 10}_${Math.floor(lng * 10) / 10}`;
}

// 半径radiusKmを覆うために確認すべきグリッドキー一覧を返す。
// 経度方向のグリッド1マスの実距離は緯度によって縮むため、緯度に応じて
// 探索するマスの範囲を動的に広げる(高緯度ほど経度方向を広めに走査する)。
function getSurroundingGridKeys(lat, lng, radiusKm) {
  const latCellKm = 11.1; // 0.1度 ≈ 11.1km(緯度方向は概ね一定)
  const lngCellKm = Math.max(1, 11.1 * Math.cos((lat * Math.PI) / 180));
  const latSpan = Math.max(1, Math.ceil(radiusKm / latCellKm) + 1);
  const lngSpan = Math.max(1, Math.ceil(radiusKm / lngCellKm) + 1);

  const baseLat = Math.floor(lat * 10) / 10;
  const baseLng = Math.floor(lng * 10) / 10;
  const keys = [];
  for (let dy = -latSpan; dy <= latSpan; dy++) {
    for (let dx = -lngSpan; dx <= lngSpan; dx++) {
      const gLat = Math.round((baseLat + dy * 0.1) * 10) / 10;
      const gLng = Math.round((baseLng + dx * 0.1) * 10) / 10;
      keys.push(`${gLat}_${gLng}`);
    }
  }
  return keys;
}

// places.json / stations.json の両方を「gridKey -> [ノード]」の空間インデックスに
// 一度だけ変換する(§6.3)。ノードには type('place'|'transport')を付与する。
function buildSpatialIndex(places, stations) {
  const byGrid = new Map();
  function add(node, type) {
    const key = node.gridKey || gridKeyOf(node.lat, node.lng);
    if (!byGrid.has(key)) byGrid.set(key, []);
    byGrid.get(key).push({ ...node, _type: type });
  }
  places.forEach(p => add(p, 'place'));
  stations.forEach(s => add(s, 'transport'));
  return byGrid;
}

// 現在地点から動的半径内のノード(観光地点+交通地点)を検索する(§6.3)。
function getNearbyNodes(currentLat, currentLng, radiusKm, spatialIndex, excludeId) {
  const keys = getSurroundingGridKeys(currentLat, currentLng, radiusKm);
  const seen = new Set();
  const results = [];
  for (const key of keys) {
    const bucket = spatialIndex.get(key);
    if (!bucket) continue;
    for (const node of bucket) {
      if (node.id === excludeId || seen.has(`${node._type}_${node.id}`)) continue;
      const dist = haversineKm(currentLat, currentLng, node.lat, node.lng);
      if (dist <= radiusKm) {
        seen.add(`${node._type}_${node.id}`);
        results.push({ node, distanceKm: dist });
      }
    }
  }
  return results;
}

// --- 到達可能性判定 本実装(§3.3 / §7.4のPhase2) -------------------------
//
// §7.4では初期プロトタイプとして「直線距離の増減」による簡易判定を認めていたが、
// 分岐駅では直線距離が実際の経路と逆の増減を示すことがあり、往復振動の原因になる
// (デモ版で実際に発生: 松山↔高松方面、鹿児島↔那覇 等)。
// そのためPhase2では、目的地からの実グラフ最短距離(Dijkstra)を優先的に使い、
// 直線距離判定は「対象ノードがグラフに存在しない/接続していない」場合のみの
// 最終フォールバックに格下げする。blockReachability.json のブロック隣接は、
// 将来地点数が数万件規模に拡大しグラフ全体のDijkstraが重くなった場合の
// 中間フォールバックとして接続してある(現状の規模では出番はほぼ無い想定)。

// 目的地(destinationId)を始点に、交通ノードグラフ全体への最短距離(km)を
// Dijkstra法で一括計算する。ゲーム開始時・目的地確定時に一度だけ呼び出す想定
// (§3.3「実行時の経路探索を軽量化するためのキャッシュ」の本実装)。
function buildGraphDistances(destinationId, stationsById) {
  const dist = new Map([[destinationId, 0]]);
  const visited = new Set();
  const frontier = new Set([destinationId]);

  while (frontier.size > 0) {
    let currentId = null;
    let currentDist = Infinity;
    for (const id of frontier) {
      const d = dist.get(id);
      if (d < currentDist) { currentDist = d; currentId = id; }
    }
    frontier.delete(currentId);
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const node = stationsById.get(currentId);
    if (!node) continue;
    for (const conn of node.connections || []) {
      if (visited.has(conn.toId)) continue;
      const neighbor = stationsById.get(conn.toId);
      if (!neighbor) continue;
      const edgeDist = haversineKm(node.lat, node.lng, neighbor.lat, neighbor.lng);
      const candidateDist = currentDist + edgeDist;
      if (candidateDist < (dist.has(conn.toId) ? dist.get(conn.toId) : Infinity)) {
        dist.set(conn.toId, candidateDist);
        frontier.add(conn.toId);
      }
    }
  }
  return dist;
}

// blockReachability.json は0.5度グリッドでブロック分割されている(§3.3)。
// §6.3の空間インデックス用gridKey(0.1度)とは別物なので関数を分けておく。
function blockKeyOf(lat, lng, blockSizeDeg = 0.5) {
  const bx = Math.floor((lat + 1e-9) / blockSizeDeg) * blockSizeDeg;
  const by = Math.floor((lng + 1e-9) / blockSizeDeg) * blockSizeDeg;
  return `${bx.toFixed(1)}_${by.toFixed(1)}`;
}

// 目的地ブロックを始点に、blockReachability.json上の隣接ブロックをBFSして
// 各ブロックへの最短ホップ数を求める(グラフのDijkstraが使えない場合の中間フォールバック)。
function buildBlockDistances(destinationBlockKey, blockReachability) {
  const blocks = (blockReachability && blockReachability.blocks) || {};
  const dist = new Map([[destinationBlockKey, 0]]);
  const queue = [destinationBlockKey];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    const currentDist = dist.get(current);
    const neighbors = (blocks[current] && blocks[current].neighbors) || [];
    for (const n of neighbors) {
      if (!dist.has(n)) {
        dist.set(n, currentDist + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}

function graphProgress(fromId, toId, graphDistances) {
  if (!graphDistances) return null;
  const before = graphDistances.get(fromId);
  const after = graphDistances.get(toId);
  if (before === undefined || after === undefined || before === 0) return null;
  return (before - after) / before;
}

function blockProgress(fromNode, toNode, blockDistances) {
  if (!blockDistances) return null;
  const before = blockDistances.get(blockKeyOf(fromNode.lat, fromNode.lng));
  const after = blockDistances.get(blockKeyOf(toNode.lat, toNode.lng));
  if (before === undefined || after === undefined || before === 0) return null;
  return (before - after) / before;
}

function straightLineProgress(fromNode, toNode, destinationNode) {
  const before = haversineKm(fromNode.lat, fromNode.lng, destinationNode.lat, destinationNode.lng);
  if (before === 0) return 0;
  const after = haversineKm(toNode.lat, toNode.lng, destinationNode.lat, destinationNode.lng);
  return (before - after) / before;
}

// 進行方向スコアの本体。reachability = { graphDistances, blockDistances } を
// game.js からゲーム開始時に一度だけ渡す想定(§3.3参照)。
function progressScore(fromNode, toNode, destinationNode, reachability) {
  const g = reachability && graphProgress(fromNode.id, toNode.id, reachability.graphDistances);
  if (g !== null && g !== undefined) return g;
  const b = reachability && blockProgress(fromNode, toNode, reachability.blockDistances);
  if (b !== null && b !== undefined) return b;
  return straightLineProgress(fromNode, toNode, destinationNode);
}

// 到達可能性判定(§3.3 / §7.4)。上記progressScoreの符号で判定する
// (プラス=目的地に近づく)。関数インターフェースは仕様書指定のまま維持している。
function isReachableToward(fromNode, toNode, destinationNode, reachability) {
  return progressScore(fromNode, toNode, destinationNode, reachability) > 0;
}

function transportScoreOf(targetNode, stationsById) {
  let count = 0;
  if (targetNode._type === 'transport' || targetNode.type === 'station' || targetNode.type === 'airport' || targetNode.type === 'port') {
    count = (targetNode.connections || []).length;
  } else if (targetNode.nearestStationId && stationsById.has(targetNode.nearestStationId)) {
    count = (stationsById.get(targetNode.nearestStationId).connections || []).length;
  }
  return Math.min(1, count / 5);
}

function candidateScore({ progress, discoveryScore, transportScore }) {
  return 0.4 * progress + 0.4 * (discoveryScore / 100) + 0.15 * transportScore + 0.05 * Math.random();
}

// 直近訪れた地点への「往復振動」を防ぐためのペナルティ(§実装時の裁量)。
// 直前地点への逆戻りほど重いペナルティを掛けるが、候補自体は消さない
// (他に選択肢がない場合でも詰まないようにするため)。
const RECENT_NODE_PENALTY = [0.35, 0.28, 0.20, 0.12, 0.06];
function recentPenalty(targetId, targetType, recentNodeIds) {
  if (!recentNodeIds) return 0;
  for (let i = 0; i < recentNodeIds.length && i < RECENT_NODE_PENALTY.length; i++) {
    const recent = recentNodeIds[i];
    if (recent && recent.id === targetId && recent.type === targetType) return RECENT_NODE_PENALTY[i];
  }
  return 0;
}

// 現在地点・所持金・空腹/喉の状態から移動候補を生成し、上位のみ返す(§6.2,§6.3,§6.4)。
function generateCandidates(ctx) {
  const {
    currentNode, destinationNode, money, hunger, thirst,
    spatialIndex, stationsById, placesById, discoveredIds, recentNodeIds,
  } = ctx;

  const lowStat = hunger <= 0 || thirst <= 0;
  const walkRadius = lowStat ? WALK_RADIUS_KM_LOW_STAT : WALK_RADIUS_KM_DEFAULT;
  const discoveredSet = new Set(discoveredIds);
  const candidates = [];

  function effectiveDiscovery(node) {
    return discoveredSet.has(node.id) ? 0 : (node.discoveryScore || 0);
  }

  // --- 徒歩候補(寄り道も許可) ---
  const nearby = getNearbyNodes(currentNode.lat, currentNode.lng, walkRadius, spatialIndex, currentNode.id);
  for (const { node, distanceKm } of nearby) {
    candidates.push({
      key: `walk_${node._type}_${node.id}`,
      targetId: node.id,
      targetType: node._type,
      targetName: node.name,
      mode: 'walk',
      cost: 0,
      distanceKm,
      isBudget: false,
      discoveryScore: node.discoveryScore || 0,
      isNew: !discoveredSet.has(node.id),
      score: candidateScore({
        progress: progressScore(currentNode, node, destinationNode),
        discoveryScore: effectiveDiscovery(node),
        transportScore: transportScoreOf(node, stationsById),
      }),
    });
  }

  // 孤立防止: 現在地が観光地点の場合、最寄り駅は半径外でも必ず候補に加える(§5.1)。
  if (currentNode._type === 'place' && currentNode.nearestStationId && stationsById.has(currentNode.nearestStationId)) {
    const station = stationsById.get(currentNode.nearestStationId);
    const already = candidates.some(c => c.mode === 'walk' && c.targetType === 'transport' && c.targetId === station.id);
    if (!already) {
      const distanceKm = haversineKm(currentNode.lat, currentNode.lng, station.lat, station.lng);
      candidates.push({
        key: `walk_transport_${station.id}`,
        targetId: station.id,
        targetType: 'transport',
        targetName: station.name,
        mode: 'walk',
        cost: 0,
        distanceKm,
        isBudget: false,
        discoveryScore: station.discoveryScore || 0,
        isNew: !discoveredSet.has(station.id),
        score: candidateScore({
          progress: progressScore(currentNode, station, destinationNode),
          discoveryScore: effectiveDiscovery(station),
          transportScore: transportScoreOf({ _type: 'transport', connections: station.connections }, stationsById),
        }),
      });
    }
  }

  // --- 交通機関候補(鉄道・飛行機・船・ヒッチハイク) ---
  // 通常は目的地への方向性を維持する接続のみを候補にする(§6.1)。
  // Phase2: 到達可能性判定はctx.reachability(グラフ最短距離/ブロック隣接)を
  // 優先して使う(上記のprogressScore参照)。データが不整合等でreachabilityが
  // 全く使えない場合の直線距離フォールバックに備え、なお救済策も残しておく。
  function buildTransportCandidates(enforceProgressFilter) {
    const result = [];
    if (currentNode._type !== 'transport') return result;
    const connections = currentNode.connections || [];
    for (const conn of connections) {
      const toNode = stationsById.get(conn.toId);
      if (!toNode) continue;
      if (enforceProgressFilter && !isReachableToward(currentNode, toNode, destinationNode, ctx.reachability)) continue;

      const progress = progressScore(currentNode, toNode, destinationNode, ctx.reachability);
      const transportScoreVal = transportScoreOf({ _type: 'transport', connections: toNode.connections }, stationsById);
      const discovery = effectiveDiscovery(toNode);
      const distanceKm = haversineKm(currentNode.lat, currentNode.lng, toNode.lat, toNode.lng);
      const flightOnly = conn.requiresTransport.length === 1 && conn.requiresTransport[0] === 'flight';

      // 有料の交通機関候補(所持金が足りる場合のみ。§7.1)
      if (money >= conn.cost) {
        result.push({
          key: `${conn.mode}_${currentNode.id}_${toNode.id}_${conn.cost}`,
          targetId: toNode.id,
          targetType: 'transport',
          targetName: toNode.name,
          mode: conn.mode,
          cost: conn.cost,
          distanceKm,
          isBudget: !!conn.isBudget,
          discoveryScore: toNode.discoveryScore || 0,
          isNew: !discoveredSet.has(toNode.id),
          score: candidateScore({ progress, discoveryScore: discovery, transportScore: transportScoreVal }),
        });
      }

      // ヒッチハイク候補(flightのみで隔てられた区間では不可。§7.1.1)
      if (!flightOnly) {
        const isFerry = conn.requiresTransport.includes('ferry');
        const baseRate = isFerry ? HITCHHIKE_BASE_RATE_FERRY : HITCHHIKE_BASE_RATE_LAND;
        const successRate = Math.max(0.05, baseRate - (lowStat ? HITCHHIKE_LOW_STAT_PENALTY : 0));
        result.push({
          key: `hitchhike_${currentNode.id}_${toNode.id}`,
          targetId: toNode.id,
          targetType: 'transport',
          targetName: toNode.name,
          mode: 'hitchhike',
          cost: 0,
          distanceKm,
          isBudget: false,
          successRate,
          discoveryScore: toNode.discoveryScore || 0,
          isNew: !discoveredSet.has(toNode.id),
          score: candidateScore({ progress, discoveryScore: discovery, transportScore: transportScoreVal }) - 0.02,
        });
      }
    }
    return result;
  }

  // 通常は目的地方向のみフィルタする。ただし直線距離ヒューリスティックが分岐点で
  // 「進行方向を保つ接続が無い」と誤判定し、同じ地点を往復し続けてしまう場合の
  // 救済として、その状況を検知した呼び出し元(game.js)からの合図で
  // フィルタなしの全接続を候補にする(§7.1.1の詰み防止の趣旨に沿った措置)。
  let transportCandidates = buildTransportCandidates(true);
  if (transportCandidates.length === 0 || ctx.forceUnfilteredTransport) {
    transportCandidates = buildTransportCandidates(false);
  }
  candidates.push(...transportCandidates);

  for (const c of candidates) {
    c.score -= recentPenalty(c.targetId, c.targetType, recentNodeIds);
  }

  // 同じ2地点(またはごく少数の地点)を延々往復してしまう場合の最終手段。
  // 直前地点への移動を今回に限り候補から除外し、強制的に別の選択を取らせる
  // (banTarget自体しか選択肢が無い場合は除外しない=詰み回避を優先)。
  let finalCandidates = candidates;
  if (ctx.bannedTarget) {
    const filtered = candidates.filter(c => !(c.targetId === ctx.bannedTarget.id && c.targetType === ctx.bannedTarget.type));
    if (filtered.length > 0) finalCandidates = filtered;
  }

  finalCandidates.sort((a, b) => b.score - a.score);
  return finalCandidates.slice(0, MAX_CANDIDATES);
}

window.Movement = {
  haversineKm,
  gridKeyOf,
  getSurroundingGridKeys,
  buildSpatialIndex,
  getNearbyNodes,
  isReachableToward,
  progressScore,
  candidateScore,
  generateCandidates,
  buildGraphDistances,
  blockKeyOf,
  buildBlockDistances,
  WALK_RADIUS_KM_DEFAULT,
  WALK_RADIUS_KM_LOW_STAT,
};
