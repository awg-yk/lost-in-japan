// game.js — ゲーム状態管理(所持金・空腹・体力・発見済み等)(§4,§7,§8)

// 難易度プリセット。所持金と「ラッキー度」(ヒッチハイク成功率・ランダムイベント
// 発生頻度への補正)が変わる。難易度はゲーム開始時に選び、以後の全ての判定で使う。
const DIFFICULTY_PRESETS = {
  easy: { label: 'EASY', initialMoney: 8000, hitchhikeLuckBonus: 0.15, eventChanceMultiplier: 1.3 },
  normal: { label: 'NORMAL', initialMoney: 5000, hitchhikeLuckBonus: 0, eventChanceMultiplier: 1.0 },
  // 2026-07-30セッションでのバランス再調整: アルバイトの同一ノード3回上限
  // (WORK_MAX_PER_NODE)導入後、HARDの初期¥3000は-15%ヒッチハイク運補正と
  // 合わさって、遠方かつ運賃の高い目的地(特にflight-onlyの離島区間)で
  // 資金繰りが厳しくなりがちなことがtests/regression.test.jsのシミュレーションで
  // 判明した。¥4000への引き上げ(2000シードでの検証: 平均到着手数36.2→32.2、
  // p99=223→185)によりEASY/NORMALとの明確な差は保ちつつ、極端な長期化の
  // 頻度を抑えている。
  hard: { label: 'HARD', initialMoney: 4000, hitchhikeLuckBonus: -0.15, eventChanceMultiplier: 0.7 },
};

// 空腹は移動時間の目安として全ての移動手段で減少する。
// 体力は「歩いた」ことによる身体的消耗のみで減少する(電車や飛行機に乗っている間は消耗しない)。
const HUNGER_DECAY_PER_KM = 0.06;
const STAMINA_DECAY_PER_KM_WALK = 1.1;
// ヒッチハイク失敗時は固定値ではなく、空腹・体力をその場で半分にする
// (2026-07-30変更。js/game.js の chooseCandidate 内で `/= 2` として実装)。

const EAT_COST = 300;
const EAT_HUNGER_GAIN = 45;
const REST_COST = 150;
const REST_STAMINA_GAIN = 45;

// アルバイト: 観光名所(地点データ)でのみ働ける(2026-07-30変更。旧仕様では
// 駅・空港・港でも働けたが、それだと寄り道せず稼げてしまい「旅先の発見」という
// 目的に反するため、観光名所限定にした)。同一ノードでの繰り返し労働を防ぐため
// WORK_MAX_PER_NODEで上限を設けている(観光名所の総数が増えたため、旧仕様の
// 3回から1回に引き下げ、稼ぐには別の観光名所に移動する必要があるようにした)。
// また、空腹・体力のどちらかが0の状態では働けない(力尽きた状態での労働を禁止)。
const WORK_WAGE = 1000;
const WORK_HUNGER_COST = 8;
const WORK_STAMINA_COST = 15;
const WORK_MAX_PER_NODE = 1;

const RANDOM_EVENT_CHANCE = 0.25;
// Phase3: §7.3の例(お金を拾う/地域グルメ/珍しい発見/地元イベント/ヒッチハイク成功)
// を踏まえ、4種類から8種類に拡充した。全て正の効果か中立の演出のみとし、
// 「発見の旅」の気分を損なわないようにしている(ネガティブなペナルティ演出は含めない)。
const RANDOM_EVENTS = [
  { weight: 3, apply: () => { const amount = 200 + Math.floor(Math.random() * 600); Game.state.money += amount; return `道端で ¥${amount} を拾った！`; } },
  { weight: 3, apply: () => { Game.state.hunger = Math.min(100, Game.state.hunger + 20); return '地元のグルメを味見して、少しお腹が満たされた。'; } },
  { weight: 2, apply: () => { const bonus = 50 + Math.floor(Math.random() * 100); Game.state.money += bonus; return `珍しいものを見つけてちょっとした収入(¥${bonus})になった。`; } },
  { weight: 2, apply: () => '地元のイベントに遭遇した。旅の思い出が一つ増えた。' },
  { weight: 3, apply: () => { Game.state.stamina = Math.min(100, Game.state.stamina + 15); return 'ベンチで少し休ませてもらい、体力が少し回復した。'; } },
  { weight: 2, apply: () => { Game.state.hunger = Math.min(100, Game.state.hunger + 10); Game.state.stamina = Math.min(100, Game.state.stamina + 10); return '地元の人に手土産をもらった。'; } },
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

  difficultyPreset() {
    return DIFFICULTY_PRESETS[this.state && this.state.difficulty] || DIFFICULTY_PRESETS.normal;
  },

  newGame(difficulty) {
    const preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.normal;
    const stationIds = [...this.data.stationsById.keys()];
    const startId = stationIds[Math.floor(Math.random() * stationIds.length)];
    let destinationId = startId;
    while (destinationId === startId) {
      destinationId = stationIds[Math.floor(Math.random() * stationIds.length)];
    }

    this.state = {
      difficulty: DIFFICULTY_PRESETS[difficulty] ? difficulty : 'normal',
      currentNodeId: startId,
      currentNodeType: 'transport',
      startId,
      destinationId,
      money: preset.initialMoney,
      hunger: 100,
      stamina: 100,
      visitedIds: [],
      discoveredIds: [],
      moveHistory: [],
      playTimeSec: 0,
      totalDistanceKm: 0,
      workedIds: [],
      hitchhikeLocked: false,
      arrived: false,
    };
    this.buildReachability(destinationId);
    this.onArrive(startId, 'transport');
    Save.write(this.state);
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
    // 同じ場所に3回以上舞い戻っているなら、直前地点への逆戻りを今回だけ禁止し、
    // 強制的に別の選択肢を取らせて往復ループを断ち切る。
    // (以前はrevisitCount>=2で交通機関の方向性フィルタ自体を丸ごと外す
    // forceUnfilteredTransportもあったが、目的地方向の正しい候補が既にあるのに
    // 遠ざかる候補まで紛れ込む不具合の原因だったため2026-07-30に削除した。
    // movement.js側は「フィルタ後0件のときのみ」フィルタなしにフォールバックする)。
    const RECENT_WINDOW = 8;
    const recentVisits = history.slice(-RECENT_WINDOW);
    const revisitCount = recentVisits.filter(m => m.toId === this.state.currentNodeId && m.toType === this.state.currentNodeType).length;
    const bannedTarget = revisitCount >= 3 && recentNodeIds[0] ? recentNodeIds[0] : null;

    const baseCtx = {
      currentNode: { ...this.currentNode(), _type: this.state.currentNodeType },
      destinationNode: this.destinationNode(),
      money: this.state.money,
      hunger: this.state.hunger,
      stamina: this.state.stamina,
      spatialIndex: this.data.spatialIndex,
      stationsById: this.data.stationsById,
      placesById: this.data.placesById,
      discoveredIds: this.state.discoveredIds,
      recentNodeIds,
      bannedTarget,
      reachability: this.reachability,
      hitchhikeLuckBonus: this.difficultyPreset().hitchhikeLuckBonus,
    };

    const candidates = Movement.generateCandidates({ ...baseCtx, hitchhikeLocked: this.state.hitchhikeLocked });

    // 詰み回避の最終手段: ヒッチハイクがロックされていて、かつ他に取れる行動が
    // 本当に何も無い(移動候補0件・アルバイトも食事も温泉も不可)場合のみ、ロックを
    // 一時的に無視してヒッチハイクを候補に戻す。「アルバイトする/食事/温泉」という
    // movement.js側が知らない選択肢の有無を踏まえた判断のため、ここ(game.js)で行う。
    //
    // 注意: canWork()は現在、空腹・体力が0の場合や同一ノードでの労働回数上限
    // (WORK_MAX_PER_NODE)に達した場合にもfalseを返す。そのため「!canWork()」だけを
    // 条件にすると、実際には所持金があって食事・温泉で回復できる状況でも
    // 不必要にヒッチハイクへ強制的に賭けさせてしまう。食事・温泉の可否も
    // 併せて確認し、本当に他に取れる手段が無い場合に限定する。
    if (candidates.length === 0 && this.state.hitchhikeLocked &&
        !this.canWork() && !this.canAffordEat() && !this.canAffordRest()) {
      return Movement.generateCandidates({ ...baseCtx, hitchhikeLocked: false });
    }

    return candidates;
  },

  // 移動候補を確定させる。戻り値: { ok, message, arrived }
  chooseCandidate(candidate) {
    const s = this.state;
    const fromId = s.currentNodeId;
    const fromType = s.currentNodeType;

    if (candidate.mode === 'hitchhike') {
      const success = Math.random() < candidate.successRate;
      if (!success) {
        // 2026-07-30変更: ヒッチハイクは「運賃を払えないとき」の最終手段に
        // 位置づけたため、失敗時のペナルティを固定値(-3/-4)から空腹・体力を
        // それぞれ半分にする方式へ強化した(ユーザー指示。お金が無い状態での
        // 失敗が実際に痛手になるようにするため)。Math.floorで整数に丸めることで、
        // 単純な division だけだと理論上ゼロに漸近するだけで正確な0に到達しない
        // (浮動小数点の性質上、行動不能判定`<=0`がほぼ永久に成立しない)問題を防ぐ。
        s.hunger = Math.floor(s.hunger / 2);
        s.stamina = Math.floor(s.stamina / 2);
        // §実装時の裁量: ヒッチハイクが強すぎるとのフィードバックを受け、
        // 失敗した場合は別の選択肢を選ぶまでヒッチハイクを候補から除外する。
        s.hitchhikeLocked = true;
        Save.write(s);
        return { ok: false, message: 'ヒッチハイクは失敗した…足止めをくらい、空腹と体力が半分になった。(他の方法を試すまでヒッチハイクはできない)', arrived: false, gameOver: this.checkGameOver() };
      }
    } else if (candidate.cost > 0) {
      if (s.money < candidate.cost) return { ok: false, message: '所持金が足りません。', arrived: false };
      s.money -= candidate.cost;
    }

    // ヒッチハイク以外の選択肢(徒歩・有料交通機関・成功したヒッチハイク)を
    // 選んだので、失敗によるロックを解除する。
    s.hitchhikeLocked = false;

    // 空腹は移動手段によらず(移動時間の目安として)減少するが、
    // 体力は徒歩による身体的消耗としてのみ減少する。
    s.hunger = Math.max(0, s.hunger - candidate.distanceKm * HUNGER_DECAY_PER_KM);
    if (candidate.mode === 'walk') {
      s.stamina = Math.max(0, s.stamina - candidate.distanceKm * STAMINA_DECAY_PER_KM_WALK);
    }
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
    if (Math.random() < RANDOM_EVENT_CHANCE * this.difficultyPreset().eventChanceMultiplier) {
      eventMessage = this.triggerRandomEvent();
    }

    const arrived = candidate.targetType === 'transport' && candidate.targetId === s.destinationId;
    s.arrived = arrived;
    Save.write(s);

    const baseMessage = candidate.cost > 0
      ? `${candidate.targetName} に到着した(運賃 ¥${candidate.cost.toLocaleString()})。`
      : `${candidate.targetName} に到着した。`;
    return { ok: true, message: eventMessage ? `${baseMessage}\n${eventMessage}` : baseMessage, arrived, gameOver: this.checkGameOver() };
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

  atTransportNode() {
    return this.state.currentNodeType === 'transport';
  },

  // アルバイトができるのは観光名所(地点データ、`currentNodeType === 'place'`)のみ。
  // 駅・空港でも働けてしまうと寄り道せずに稼げてしまい、「旅先の発見」という
  // ゲームの目的に反するため(2026-07-30、ユーザー指示による変更)。
  atSightseeingPlace() {
    return this.state.currentNodeType === 'place';
  },

  // 食事・温泉は、交通ノード(駅・空港・港)・観光名所のどちらでも利用できる
  // (2026-07-30変更: 観光名所でもアルバイトに加えて食事・温泉ができるように
  // した。§実装時の裁量: 本来は地点ごとの実際の飲食店・温泉データに応じる
  // べきだが、実データ整備前の暫定として一律に利用できることにしている)。
  atRecoverableNode() {
    return this.atTransportNode() || this.atSightseeingPlace();
  },

  canAffordEat() {
    return this.atRecoverableNode() && this.state.money >= EAT_COST;
  },

  canAffordRest() {
    return this.atRecoverableNode() && this.state.money >= REST_COST;
  },

  eat() {
    if (!this.canAffordEat()) {
      return { ok: false, message: this.atRecoverableNode() ? '所持金が足りません。' : 'ここでは食事できません。' };
    }
    this.state.money -= EAT_COST;
    this.state.hunger = Math.min(100, this.state.hunger + EAT_HUNGER_GAIN);
    this.state.hitchhikeLocked = false;
    Save.write(this.state);
    return { ok: true, message: `食事をとった(¥${EAT_COST})。`, gameOver: this.checkGameOver() };
  },

  rest() {
    if (!this.canAffordRest()) {
      return { ok: false, message: this.atRecoverableNode() ? '所持金が足りません。' : 'ここでは温泉に入れません。' };
    }
    this.state.money -= REST_COST;
    this.state.stamina = Math.min(100, this.state.stamina + REST_STAMINA_GAIN);
    this.state.hitchhikeLocked = false;
    Save.write(this.state);
    return { ok: true, message: `温泉に入って体力を回復した(¥${REST_COST})。`, gameOver: this.checkGameOver() };
  },

  // アルバイト: 観光名所(地点データ)であれば働けるが、以下の条件で制限する。
  //   - 駅・空港・港(交通ノード)では働けない(寄り道して観光名所を
  //     訪れる動機付けのため。2026-07-30変更、旧仕様では交通ノードで働けた)。
  //   - 空腹・体力のどちらかが0のときは働けない(力尽きた状態での労働を禁止)。
  //   - 同一ノードでの労働回数はWORK_MAX_PER_NODE(観光名所の総数が増えたため1回)まで。
  canWork() {
    if (!this.atSightseeingPlace()) return false;
    if (this.state.hunger <= 0 || this.state.stamina <= 0) return false;
    return this.workCountAtCurrentNode() < WORK_MAX_PER_NODE;
  },

  // 現在地(観光名所)で、これまでに何回アルバイトしたか。
  workCountAtCurrentNode() {
    const id = this.state.currentNodeId;
    return this.state.workedIds.filter(workedId => workedId === id).length;
  },

  // 候補リストに「アルバイトする」を出す際、選ぶ前に稼げる金額・消耗・残り回数を見せるためのプレビュー。
  workPreview() {
    return {
      wage: WORK_WAGE,
      hungerCost: WORK_HUNGER_COST,
      staminaCost: WORK_STAMINA_COST,
      remaining: WORK_MAX_PER_NODE - this.workCountAtCurrentNode(),
      max: WORK_MAX_PER_NODE,
    };
  },

  work() {
    if (!this.canWork()) return { ok: false, message: 'ここでは働けません。' };
    const node = this.currentNode();
    this.state.money += WORK_WAGE;
    this.state.workedIds.push(this.state.currentNodeId);
    this.state.hunger = Math.max(0, this.state.hunger - WORK_HUNGER_COST);
    this.state.stamina = Math.max(0, this.state.stamina - WORK_STAMINA_COST);
    // アルバイトも「別の選択肢」の一つなので、ヒッチハイク失敗ロックを解除する。
    this.state.hitchhikeLocked = false;
    Save.write(this.state);
    return { ok: true, message: `${node.name}でアルバイトして ¥${WORK_WAGE.toLocaleString()} 稼いだ(体力 -${WORK_STAMINA_COST} ・ 空腹 -${WORK_HUNGER_COST})。`, gameOver: this.checkGameOver() };
  },

  // 行動不能判定(2026-07-30、ユーザー指示による新規追加): 所持金が無く(0以下)、
  // かつ空腹・体力の両方が0の場合、これ以上取れる行動が実質無い
  // (食事・温泉はお金が要り、アルバイトは空腹/体力0で不可)とみなしてゲームオーバーにする。
  // ヒッチハイクは所持金が無いときの最終手段として使えるが、それでもこの状態を
  // 「詰み」ではなく「現実的な失敗」として扱う、というユーザーの意図を反映している。
  isIncapacitated() {
    const s = this.state;
    return s.money <= 0 && s.hunger <= 0 && s.stamina <= 0;
  },

  checkGameOver() {
    const over = this.isIncapacitated();
    this.state.gameOver = over;
    return over;
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
window.EAT_HUNGER_GAIN = EAT_HUNGER_GAIN;
window.REST_COST = REST_COST;
window.REST_STAMINA_GAIN = REST_STAMINA_GAIN;
window.HUNGER_DECAY_PER_KM = HUNGER_DECAY_PER_KM;
window.STAMINA_DECAY_PER_KM_WALK = STAMINA_DECAY_PER_KM_WALK;
