// movement.js — 移動候補生成・到達可能性判定・評価式(§6)

const WALK_RADIUS_KM_DEFAULT = 8;
const WALK_RADIUS_KM_LOW_STAT = 5;
// Phase3バランス調整: 当初0.85だったが、シミュレーションで有料交通機関がほぼ
// 選ばれなくなる(ヒッチハイクが常に支配的候補になる)ことが判明したため引き下げた。
// §7.1.1で基礎成功率が明示されているferryの30%はそのまま維持する。
const HITCHHIKE_BASE_RATE_LAND = 0.55;
const HITCHHIKE_BASE_RATE_FERRY = 0.30;
const HITCHHIKE_LOW_STAT_PENALTY = 0.15;
const HITCHHIKE_SCORE_PENALTY = 0.04;
const MAX_CANDIDATES = 6;

// 2026-07-31: ユーザー指示により、候補地をカテゴリー別(歴史・自然・温泉・
// 道の駅・その他の観光目的と、ゴールに近づく駅・港等の「移動」)に整理して
// 表示できるようにする。observedデータのtype値からカテゴリーを機械的に
// 割り当てる(未知のtypeは「その他」に落とす)。
const PLACE_CATEGORY_MAP = {
  shrine: '歴史', temple: '歴史', castle: '歴史', historic: '歴史',
  famous_facility: '歴史', world_heritage: '歴史', city_hall: '歴史',
  museum: '歴史', art_museum: '歴史',
  scenic_spot: '自然', nature: '自然', park: '自然', viewpoint: '自然',
  waterfall: '自然', mountain: '自然',
  onsen: '温泉',
  michinoeki: '道の駅',
};
const CATEGORY_ORDER = ['移動', '歴史', '自然', '温泉', '道の駅', 'その他'];
// カテゴリーごとの最大表示件数(移動は経路継続に重要なため多めに確保)。
const CATEGORY_QUOTA = { 移動: 8, 歴史: 5, 自然: 5, 温泉: 3, 道の駅: 3, その他: 4 };

function categoryOf(targetType, node) {
  if (targetType === 'transport') return '移動';
  return PLACE_CATEGORY_MAP[node && node.type] || 'その他';
}

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
// 2026-07-31: 全国駅データ拡張後、進行スコアの差がほぼ横並びになるローカルな
// 駅クラスタ(例: 支線沿いの数駅)を8〜10手周期で巡り続けて詰むケースが
// シミュレーションで見つかった。直近5手分しか見ていなかったため、それより
// 長い周期のループを検知できなかった。より長い窓(20手)まで見て、離れた
// 訪問ほど弱いペナルティを掛けるようにし、周期の長いループでも「そこへ戻る」
// 候補群のスコアが少しずつ下がって、いずれ他の(僅かでも前進する)候補が
// 上回るようにする。
const RECENT_NODE_PENALTY = [
  0.35, 0.28, 0.20, 0.12, 0.06,
  0.05, 0.05, 0.04, 0.04, 0.04,
  0.03, 0.03, 0.03, 0.02, 0.02,
  0.02, 0.02, 0.02, 0.02, 0.02,
  0.02, 0.02, 0.02, 0.02, 0.02,
  0.02, 0.02, 0.02, 0.02, 0.02,
  0.02, 0.02, 0.02, 0.02, 0.02,
  0.02, 0.02, 0.02, 0.02, 0.02,
];
function recentPenalty(targetId, targetType, recentNodeIds) {
  if (!recentNodeIds) return 0;
  for (let i = 0; i < recentNodeIds.length && i < RECENT_NODE_PENALTY.length; i++) {
    const recent = recentNodeIds[i];
    if (recent && recent.id === targetId && recent.type === targetType) return RECENT_NODE_PENALTY[i];
  }
  return 0;
}

// 現在地点・所持金・空腹/体力の状態から移動候補を生成し、上位のみ返す(§6.2,§6.3,§6.4)。
function generateCandidates(ctx) {
  const {
    currentNode, destinationNode, money, hunger, stamina,
    spatialIndex, stationsById, placesById, discoveredIds, recentNodeIds,
  } = ctx;

  const lowStat = hunger <= 0 || stamina <= 0;
  const walkRadius = lowStat ? WALK_RADIUS_KM_LOW_STAT : WALK_RADIUS_KM_DEFAULT;
  const discoveredSet = new Set(discoveredIds);
  const candidates = [];

  function effectiveDiscovery(node) {
    return discoveredSet.has(node.id) ? 0 : (node.discoveryScore || 0);
  }

  // --- 徒歩候補(観光名所への寄り道のみ。2026-07-31、ユーザー指示) ---
  // 以前は徒歩圏内の駅・港(交通ノード)にも直接歩いて移動できたが、駅間を
  // 徒歩で移動できてしまうと(徒歩半径8km・低ゲージ時でも5km)非現実的な
  // 距離を歩くケースが目立つとの指摘を受けた。駅から駅への移動は必ず鉄道
  // (connections由来の`mode: 'rail'`等)を使うようにし、徒歩は観光名所
  // (`node._type === 'place'`)への寄り道専用にする。現在地が観光名所の場合の
  // 「最寄り駅への帰路」だけは、駅ネットワークへ戻るために必要な例外として
  // 別途下で保証している。
  const nearby = getNearbyNodes(currentNode.lat, currentNode.lng, walkRadius, spatialIndex, currentNode.id)
    .filter(({ node }) => node._type === 'place');
  for (const { node, distanceKm } of nearby) {
    // progressScoreにはctx.reachability(グラフ最短距離)を渡す(以前は未指定で
    // 常に直線距離フォールバックになっていた。Phase2の趣旨に沿って修正)。
    const progress = progressScore(currentNode, node, destinationNode, ctx.reachability);

    // 既に訪れた観光名所(地点データ)で、かつ目的地への進行にも寄与しない
    // (progress<=0の)場合は候補から外したい(§実装時の裁量。ユーザー指示。
    // 発見報酬も無く、目的地に近づきもしない寄り道を候補に出し続けるのは
    // 選択の邪魔になるだけのため)。交通ノードは経路継続に必要なので対象外。
    //
    // ただし孤立した交通ノード(例: 目的地行きの高額なflight-only接続1本しか
    // 無い離島の空港)では、その観光名所への徒歩が唯一の行動(=そこでしか
    // アルバイトができない)であることがあり、無条件に除外すると本当に候補が
    // 0件になって詰んでしまう(2026-07-30、実際にシミュレーションで発見)。
    // そのため即座に除外せず`prunable`としてマークし、他に候補が残る場合に
    // 限って末尾でまとめて除外する(bannedTargetと同じ「最後の1つは残す」方針)。
    const prunable = node._type === 'place' && discoveredSet.has(node.id) && progress <= 0;

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
      category: categoryOf(node._type, node),
      prunable,
      score: candidateScore({
        progress,
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
        category: '移動',
        // 密集した観光地データの中でも、この「最寄り駅への帰路」だけは枠の
        // 奪い合い(下記の交通機関/徒歩クォータ選定)から除外して必ず残す
        // (2026-07-31。孤立防止のためにcandidatesへ追加しても、最終的な
        // 上位N件への絞り込みで漏れてしまっては孤立防止の意味が無いため)。
        guaranteed: true,
        score: candidateScore({
          progress: progressScore(currentNode, station, destinationNode, ctx.reachability),
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
  function buildTransportCandidates(enforceProgressFilter, allowHitchhike) {
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
          category: '移動',
          score: candidateScore({ progress, discoveryScore: discovery, transportScore: transportScoreVal }),
        });
      }

      // ヒッチハイク候補(flightのみで隔てられた区間では不可。§7.1.1)
      // 2026-07-30変更(ユーザー指示): ヒッチハイクは「この区間の運賃を
      // 払えない場合」にのみ候補に出す(money < conn.cost)。所持金があるのに
      // 無料のヒッチハイクが有料交通機関を押しのけて選ばれ続けるのを防ぎ、
      // 「お金が無いときの最終手段」という位置づけをはっきりさせるため。
      // また、直前にヒッチハイクが失敗した場合は allowHitchhike=false になり、
      // 別の選択肢を選ぶまで候補からヒッチハイクを一切外す(強すぎる、との要望)。
      if (!flightOnly && allowHitchhike && money < conn.cost) {
        const isFerry = conn.requiresTransport.includes('ferry');
        const baseRate = isFerry ? HITCHHIKE_BASE_RATE_FERRY : HITCHHIKE_BASE_RATE_LAND;
        // 難易度の「ラッキー度」補正(EASYはプラス、HARDはマイナス)。§実装時の裁量。
        const luckBonus = ctx.hitchhikeLuckBonus || 0;
        const successRate = Math.min(0.95, Math.max(0.05, baseRate + luckBonus - (lowStat ? HITCHHIKE_LOW_STAT_PENALTY : 0)));
        const expectedProgress = progress * successRate;
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
          category: '移動',
          score: candidateScore({ progress: expectedProgress, discoveryScore: discovery, transportScore: transportScoreVal }) - HITCHHIKE_SCORE_PENALTY,
        });
      }
    }
    return result;
  }

  // 通常は目的地方向のみフィルタする。目的地から遠ざかる接続(フィルタ後
  // 0件になった場合の最終フォールバック)だけ、詰み防止のためフィルタなしで
  // 候補に加える(§7.1.1の詰み防止の趣旨に沿った措置)。
  // 2026-07-30修正: 以前は「直近で同じ地点に2回以上舞い戻っている
  // (ctx.forceUnfilteredTransport)」だけでもフィルタなし全接続に総入れ替え
  // していたため、目的地方向の正しい候補が既にあるのに、わざわざ遠ざかる
  // ヒッチハイク等が候補に紛れ込む(ユーザー指摘の「なぜか遠ざかる候補が出る」
  // 不具合の原因)。フィルタ後の候補が実際に0件のときだけフォールバックするよう修正。
  const allowHitchhike = !ctx.hitchhikeLocked;
  let transportCandidates = buildTransportCandidates(true, allowHitchhike);
  if (transportCandidates.length === 0) {
    transportCandidates = buildTransportCandidates(false, allowHitchhike);
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
    const filtered = finalCandidates.filter(c => !(c.targetId === ctx.bannedTarget.id && c.targetType === ctx.bannedTarget.type));
    if (filtered.length > 0) finalCandidates = filtered;
  }

  // 既に訪れた・進行にも寄与しない観光名所(prunable、上記コメント参照)を、
  // 他に候補が残る場合に限って除外する。ここで初めて除外することで、
  // 「そこへの徒歩だけが唯一の行動」という孤立した交通ノードでの詰みを防ぐ。
  const pruned = finalCandidates.filter(c => !c.prunable);
  if (pruned.length > 0) finalCandidates = pruned;
  finalCandidates.forEach(c => { delete c.prunable; });

  // ヒッチハイクロックにより候補が0件になり得る場合の詰み回避は、ここでは行わない。
  // movement.jsは「アルバイトする」等の非移動アクションの存在を知らないため、
  // 本当に他に取れる行動が無いかどうかの判断はgame.js側(Game.getCandidates)に委ねる。

  // 全国観光地データの拡張(2万件超)により、駅周辺の徒歩候補(観光名所)だけで
  // 上位枠が埋まり、鉄道・ヒッチハイク等の交通機関候補や他の未発見スポットが
  // 押し出されて選べなくなる密集地問題への対処(2026-07-31、実際にnpm testの
  // 「詰み(往復振動)」で顕在化)。当初はスコア純粋な全体top-Nから交通機関枠/
  // 徒歩枠のクォータ方式に変更したが、さらにユーザー指示(カテゴリー別表示)を
  // 受けて、カテゴリー(移動・歴史・自然・温泉・道の駅・その他)ごとに上位を
  // 確保する方式に発展させた。各カテゴリー内では未発見(isNew)の地点を
  // 既発見より優先し、密集による埋没を防ぐ。
  const guaranteed = finalCandidates.filter(c => c.guaranteed);
  const contested = finalCandidates.filter(c => !c.guaranteed);

  const chosen = [...guaranteed];
  const chosenKeys = new Set(guaranteed.map(c => c.key));
  for (const cat of CATEGORY_ORDER) {
    const quota = CATEGORY_QUOTA[cat] || 3;
    const already = chosen.filter(c => c.category === cat).length;
    const pool = contested
      .filter(c => c.category === cat && !chosenKeys.has(c.key))
      .sort((a, b) => {
        // 「移動」カテゴリーでは、実際の交通機関(鉄道・飛行機・船・ヒッチハイク)
        // を、単なる近隣駅への徒歩候補より優先する(2026-07-31。そうしないと
        // 徒歩で行ける駅が多いエリアで、肝心の運賃・ヒッチハイク候補が
        // クォータから押し出されてしまう=以前修正した密集地問題の再発)。
        if (cat === '移動' && (a.mode !== 'walk') !== (b.mode !== 'walk')) {
          return a.mode !== 'walk' ? -1 : 1;
        }
        if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
        return b.score - a.score;
      });
    const picked = pool.slice(0, Math.max(0, quota - already));
    for (const c of picked) { chosen.push(c); chosenKeys.add(c.key); }

    // 2026-07-31(ユーザー指示): 「移動」カテゴリーでは、所持金で払える実際の
    // 交通機関候補の中でも、最寄りの「主要駅」(接続数が多いハブ駅)が枠から
    // 漏れないようにする。密集地では最寄り駅より遠い駅の方がスコアが高く
    // 選ばれることがあるため、クォータが埋まっている場合はスコア最下位の
    // 1件を削って主要駅を代わりに入れる。
    if (cat === '移動') {
      const MAJOR_STATION_MIN_CONNECTIONS = 3;
      const majorPool = contested
        .filter(c => c.category === '移動' && c.mode !== 'walk' && !chosenKeys.has(c.key))
        .filter(c => {
          const target = stationsById.get(c.targetId);
          return target && (target.connections || []).length >= MAJOR_STATION_MIN_CONNECTIONS;
        })
        .sort((a, b) => a.distanceKm - b.distanceKm);
      const nearestMajor = majorPool[0];
      if (nearestMajor) {
        // guaranteed(最寄り駅への孤立防止用帰路)は絶対に追い出さない対象。
        const catItems = chosen.filter(c => c.category === '移動' && !c.guaranteed);
        if (catItems.length >= quota) {
          const worst = [...catItems].sort((a, b) => a.score - b.score)[0];
          const idx = chosen.indexOf(worst);
          if (idx !== -1) { chosen.splice(idx, 1); chosenKeys.delete(worst.key); }
        }
        chosen.push(nearestMajor);
        chosenKeys.add(nearestMajor.key);
      }
    }
  }

  chosen.forEach(c => { delete c.guaranteed; });
  // カテゴリー順→スコア順に並べる(UI側でのカテゴリー別グルーピング表示を想定)。
  chosen.sort((a, b) => {
    const catDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (catDiff !== 0) return catDiff;
    return b.score - a.score;
  });
  return chosen;
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
  MAX_CANDIDATES,
  CATEGORY_ORDER,
  CATEGORY_QUOTA,
  categoryOf,
};
