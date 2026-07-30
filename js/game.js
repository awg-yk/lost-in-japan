// game.js — ゲーム状態管理(所持金・空腹・喉の渇き・発見済み等)(§4,§7,§8)

const INITIAL_MONEY = 5000;
const HUNGER_DECAY_PER_KM = 0.06;
const THIRST_DECAY_PER_KM = 0.08;
const HITCHHIKE_FAIL_HUNGER_COST = 3;
const HITCHHIKE_FAIL_THIRST_COST = 4;

const EAT_COST = 300;
const EAT_HUNGER_GAIN = 45;
const DRINK_COST = 150;
const DRINK_THIRST_GAIN = 45;

const RANDOM_EVENT_CHANCE = 0.25;
// Phase3: §7.3の例(お金を拾う/地域グルメ/珍しい発見/地元イベント/ヒッチハイク成功)
// を踏まえ、4種類から8種類に拡充した。全て正の効果か中立の演出のみとし、
// 「発見の旅」の気分を損なわないようにしている(ネガティブなペナルティ演出は含めない)。
const RANDOM_EVENTS = [
  { weight: 3, apply: () => { const amount = 200 + Math.floor(Math.random() * 600); Game.state.money += amount; return `道端で ¥${amount} を拾った！`; } },
  { weight: 3, apply: () => { Game.state.hunger = Math.min(100, Game.state.hunger + 20); return '地元のグルメを味見して、少しお腹が満たされた。'; } },
  { weight: 2, apply: () => { const bonus = 50 + Math.floor(Math.random() * 100); Game.state.money += bonus; return `珍しいものを見つけてちょっとした収入(¥${bonus})になった。`; } },
  { weight: 2, apply: () => '地元のイベントに遭遇した。旅の思い出が一つ増えた。' },
  { weight: 3, apply: () => { Game.state.thirst = Math.min(100, Game.state.thirst + 15); return '自販機でおまけの一本が出てきた。少し喉が潤った。'; } },
  { weight: 2, apply: () => { Game.state.hunger = Math.min(100, Game.state.hunger + 10); Game.state.thirst = Math.min(100, Game.state.thirst + 10); return '地元の人に手土産をもらった。'; } },
  { weight: 2, apply: () => { const discount = 100 + Math.floor(Math.random() * 200); Game.state.money += discount; return `お得な情報を教えてもらい、¥${discount}分お得になった。`; } },
  { weight: 1, apply: () => '道端で野生の生き物に遭遇した。旅の良い思い出になった。' },
];

const Game = {
  data: null, // { places, stations, placesById, stationsById, spatialIndex, blockReachability }
  state: null,
  reachability: null, // { graphDistances, blockDistances } — 目的地確定時に一度だけ計算(Phase2)

  init(data) {
    this.data = data;
  },

  currentNode() {
    const { currentNodeId, currentNodeType } = this.state;
    return currentNodeType === 'place' ? this.data.placesById.get(currentNodeId) : this.data.stationsById.get(currentNodeId);
  },

  destinationNode() {
    return this.data.stationsById.get(this.state.destinationId);
  },

  // 目的地からの実グラフ最短距離(Dijkstra)とブロック隣接BFSを一度だけ計算し、
  // 以後の候補生成(移動のたび)で使い回す(§3.3のキャッシュ思想を実装)。
  buildReachability(destinationId) {
    const destNode = this.data.stationsById.get(destinationId);
    const graphDistances = Movement.buildGraphDistances(destinationId, this.data.stationsById);
    const blockDistances = destNode
      ? Movement.buildBlockDistances(Movement.blockKeyOf(destNode.lat, destNode.lng), this.data.blockReachability)
      : null;
    this.reachability = { graphDistances, blockDistances };
  },

  newGame() {
    const stationIds = [...this.data.stationsById.keys()];
    const startId = stationIds[Math.floor(Math.random() * stationIds.length)];
    let destinationId = startId;
    while (destinationId === startId) {
      destinationId = stationIds[Math.floor(Math.random() * stationIds.length)];
    }

    this.state = {
      currentNodeId: startId,
      currentNodeType: 'transport',
      startId,
      destinationId,
      money: INITIAL_MONEY,
      hunger: 100,
      thirst: 100,
      visitedIds: [],
      discoveredIds: [],
      moveHistory: [],
      playTimeSec: 0,
      totalDistanceKm: 0,
      workedIds: [],
      arrived: false,
    };
    this.buildReachability(destinationId);
    this.onArrive(startId, 'transport');
    Save.write(this.state);
    return this.state;
  },

  loadFromSave(saved) {
    this.state = {
      currentNodeId: saved.currentPlaceId,
      currentNodeType: saved.currentPlaceType,
      startId: saved.startId,
      destinationId: saved.destinationId,
      money: saved.money,
      hunger: saved.hunger,
      thirst: saved.thirst,
      visitedIds: saved.visitedIds || [],
      discoveredIds: saved.discoveredIds || [],
      moveHistory: saved.moveHistory || [],
      playTimeSec: saved.playTimeSec || 0,
      totalDistanceKm: saved.totalDistanceKm || 0,
      workedIds: saved.workedIds || [],
      arrived: false,
    };
    this.buildReachability(saved.destinationId);
    return this.state;
  },

  onArrive(nodeId, nodeType) {
    if (!this.state.visitedIds.includes(nodeId)) this.state.visitedIds.push(nodeId);
    if (!this.state.discoveredIds.includes(nodeId)) {
      this.state.discoveredIds.push(nodeId);
      const node = nodeType === 'place' ? this.data.placesById.get(nodeId) : this.data.stationsById.get(nodeId);
      this.state.money += (node && node.reward) || 0;
    }
  },

  getCandidates() {
    const history = this.state.moveHistory;
    const recentNodeIds = [];
    for (let i = history.length - 1; i >= 0 && recentNodeIds.length < 5; i--) {
      recentNodeIds.push({ id: history[i].fromId, type: history[i].fromType });
    }

    // 直近数手のうちに現在地へ何度も舞い戻っている(=往復振動している)場合、
    // 直線距離ヒューリスティックの誤判定で足止めされている可能性が高いとみなし、
    // movement.js側で交通機関の方向性フィルタを一時的に外させる。
    const RECENT_WINDOW = 8;
    const recentVisits = history.slice(-RECENT_WINDOW);
    const revisitCount = recentVisits.filter(m => m.toId === this.state.currentNodeId && m.toType === this.state.currentNodeType).length;
    const forceUnfilteredTransport = revisitCount >= 2;
    // 同じ場所に3回以上舞い戻っている場合は、直前地点への逆戻りを今回だけ禁止し、
    // 強制的に別の選択肢を取らせて往復ループを断ち切る。
    const bannedTarget = revisitCount >= 3 && recentNodeIds[0] ? recentNodeIds[0] : null;

    return Movement.generateCandidates({
      currentNode: { ...this.currentNode(), _type: this.state.currentNodeType },
      destinationNode: this.destinationNode(),
      money: this.state.money,
      hunger: this.state.hunger,
      thirst: this.state.thirst,
      spatialIndex: this.data.spatialIndex,
      stationsById: this.data.stationsById,
      placesById: this.data.placesById,
      discoveredIds: this.state.discoveredIds,
      recentNodeIds,
      forceUnfilteredTransport,
      bannedTarget,
      reachability: this.reachability,
    });
  },

  // 移動候補を確定させる。戻り値: { ok, message, arrived }
  chooseCandidate(candidate) {
    const s = this.state;
    const fromId = s.currentNodeId;
    const fromType = s.currentNodeType;

    if (candidate.mode === 'hitchhike') {
      const success = Math.random() < candidate.successRate;
      if (!success) {
        s.hunger = Math.max(0, s.hunger - HITCHHIKE_FAIL_HUNGER_COST);
        s.thirst = Math.max(0, s.thirst - HITCHHIKE_FAIL_THIRST_COST);
        Save.write(s);
        return { ok: false, message: 'ヒッチハイクは失敗した…足止めをくらった。', arrived: false };
      }
    } else if (candidate.cost > 0) {
      if (s.money < candidate.cost) return { ok: false, message: '所持金が足りません。', arrived: false };
      s.money -= candidate.cost;
    }

    s.hunger = Math.max(0, s.hunger - candidate.distanceKm * HUNGER_DECAY_PER_KM);
    s.thirst = Math.max(0, s.thirst - candidate.distanceKm * THIRST_DECAY_PER_KM);
    s.totalDistanceKm += candidate.distanceKm;

    s.currentNodeId = candidate.targetId;
    s.currentNodeType = candidate.targetType;
    s.moveHistory.push({
      fromId, fromType, toId: candidate.targetId, toType: candidate.targetType,
      mode: candidate.mode, cost: candidate.cost, distanceKm: candidate.distanceKm,
      timestamp: Date.now(),
    });

    this.onArrive(candidate.targetId, candidate.targetType);

    let eventMessage = null;
    if (Math.random() < RANDOM_EVENT_CHANCE) {
      eventMessage = this.triggerRandomEvent();
    }

    const arrived = candidate.targetType === 'transport' && candidate.targetId === s.destinationId;
    s.arrived = arrived;
    Save.write(s);

    const baseMessage = `${candidate.targetName} に到着した。`;
    return { ok: true, message: eventMessage ? `${baseMessage}\n${eventMessage}` : baseMessage, arrived };
  },

  triggerRandomEvent() {
    const totalWeight = RANDOM_EVENTS.reduce((sum, e) => sum + e.weight, 0);
    let r = Math.random() * totalWeight;
    for (const event of RANDOM_EVENTS) {
      if (r < event.weight) return event.apply();
      r -= event.weight;
    }
    return null;
  },

  eat() {
    if (this.state.money < EAT_COST) return { ok: false, message: '所持金が足りません。' };
    this.state.money -= EAT_COST;
    this.state.hunger = Math.min(100, this.state.hunger + EAT_HUNGER_GAIN);
    Save.write(this.state);
    return { ok: true, message: `食事をとった(¥${EAT_COST})。` };
  },

  drink() {
    if (this.state.money < DRINK_COST) return { ok: false, message: '所持金が足りません。' };
    this.state.money -= DRINK_COST;
    this.state.thirst = Math.min(100, this.state.thirst + DRINK_THIRST_GAIN);
    Save.write(this.state);
    return { ok: true, message: `水分補給をした(¥${DRINK_COST})。` };
  },

  tickPlayTime() {
    this.state.playTimeSec += 1;
  },

  transportBreakdown() {
    const counts = {};
    for (const move of this.state.moveHistory) {
      counts[move.mode] = (counts[move.mode] || 0) + 1;
    }
    return counts;
  },

  prefectureCount() {
    const prefs = new Set();
    for (const id of this.state.visitedIds) {
      const node = this.data.placesById.get(id) || this.data.stationsById.get(id);
      if (node && node.prefecture) prefs.add(node.prefecture);
    }
    return prefs.size;
  },
};

window.Game = Game;
window.EAT_COST = EAT_COST;
window.DRINK_COST = DRINK_COST;
