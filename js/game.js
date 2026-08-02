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
// 2026-07-31: 全国駅・観光地データの拡張により、短距離の徒歩・乗り換えだけを
// 繰り返す「足踏み」でも距離ベースの消耗がほとんど発生せず、資金さえあれば
// 実質無期限に旅を続けられてしまうことが分かった(ユーザー指摘: 実際のプレイ
// では数十〜数百ターンが現実的な範囲であるべき)。距離によらず「1手=一定の
// 時間経過」による最低限の消耗を加え、進展の無い足踏みでも空腹・体力が
// 着実に減っていくようにする。
const HUNGER_DECAY_PER_MOVE_FLAT = 0.25;
const STAMINA_DECAY_PER_MOVE_FLAT = 0.15;
// ヒッチハイク失敗時は固定値ではなく、空腹・体力をその場で半分にする
// (2026-07-30変更。js/game.js の chooseCandidate 内で `/= 2` として実装)。

// 2026-07-31: ユーザー指示により食事・温泉(入浴)を値上げし、「休憩する」
// (どこでも使える控えめな体力回復)と「温泉に入る」(温泉施設限定・全回復)を
// 分離した。
const EAT_COST = 500;
const EAT_HUNGER_GAIN = 45;
const REST_COST = 150;
const REST_STAMINA_GAIN = 45;
// 2026-07-31: 「休憩する」は150円払っている=飲み物を買いながらベンチで休む、
// という意味合いを持たせるため、体力に加えて空腹も少し回復するようにした
// (ユーザー指示)。
const REST_HUNGER_GAIN = 10;
const ONSEN_COST = 500;

// 観光名所到着時に公式ホームページを見ると対価がもらえる(2026-08-02、
// ユーザー指示)。他の収入源(発見報酬・ランダムイベント)と同じ理由で、
// 1プレイ全体を通した合計に上限を設ける(公式URLを持つ地点だけを巡る
// プレイで無制限の収入源にならないようにするため)。
const OFFICIAL_SITE_VIEW_REWARD = 1000;
const OFFICIAL_SITE_VIEW_REWARD_TOTAL_CAP = 10000;

// 2026-08-02、ユーザー指示により「アルバイトする」を廃止した(旧WORK_WAGE等の
// 定数・canWork()/work()等のメソッドは削除済み)。代わりに、観光名所
// (地点データ)へ到着すると自動的にボーナスがもらえる(PLACE_ARRIVAL_BONUS)。
const PLACE_ARRIVAL_BONUS = 1000;
// 2026-08-02、ユーザー報告により修正: PLACE_ARRIVAL_BONUSを導入した当初、
// 駅・観光名所どちらの発見報酬も同じdiscoveryRewardEarned/DISCOVERY_REWARD_
// TOTAL_CAP(8000円、旧: 駅・観光名所合わせて50〜200円程度の可変報酬を
// 前提に設定した値)を共有していたため、固定1000円の観光名所ボーナスだと
// わずか8回訪問しただけで上限に達し、「途中から観光地に行っても千円が
// もらえない」状態になっていた。観光名所のボーナスは駅の発見報酬とは
// 別の専用の合計上限(placeArrivalBonusEarned/PLACE_ARRIVAL_BONUS_TOTAL_CAP)
// で管理し、互いに影響しないようにする。
const PLACE_ARRIVAL_BONUS_TOTAL_CAP = 15000;
// 2026-07-31: 「新規発見した地点(駅・空港・港)ごとにdiscoveryScoreベースの
// 報酬(50〜200円程度)を毎回無条件に受け取れる」onArrive()の仕様が、全国の
// 駅データが1万件超に拡張された結果、これ単体で青天井収入源になり得た。
// 探索へのご褒美という趣旨自体は残しつつ、ゲーム全体で受け取れる発見報酬の
// 合計に上限を設ける(上限到達後もdiscoveredIds自体には引き続き加算され、
// 既訪問扱い・既訪問地点の除外ロジックには影響しない。お金だけがそれ以上
// 増えなくなる)。
const DISCOVERY_REWARD_TOTAL_CAP = 8000;

const RANDOM_EVENT_CHANCE = 0.25;
// 2026-07-31: WORK_MAX_TOTAL_PER_GAME/DISCOVERY_REWARD_TOTAL_CAPと同じ理由
// (全国データ拡張で手数が伸びるほど無制限に積み上がる収入源になっていた)で、
// ランダムイベントによる収入合計にも上限を設ける。
const RANDOM_EVENT_MONEY_TOTAL_CAP = 5000;
function grantEventMoney(amount) {
  const earned = Game.state.randomEventMoneyEarned || 0;
  const grantable = Math.max(0, Math.min(amount, RANDOM_EVENT_MONEY_TOTAL_CAP - earned));
  Game.state.money += grantable;
  Game.state.randomEventMoneyEarned = earned + grantable;
  return grantable;
}
// Phase3: §7.3の例(お金を拾う/地域グルメ/珍しい発見/地元イベント/ヒッチハイク成功)
// を踏まえ、4種類から8種類に拡充した。全て正の効果か中立の演出のみとし、
// 「発見の旅」の気分を損なわないようにしている(ネガティブなペナルティ演出は含めない)。
const RANDOM_EVENTS = [
  { weight: 3, apply: () => { const amount = grantEventMoney(200 + Math.floor(Math.random() * 600)); return amount > 0 ? `道端で ¥${amount} を拾った！` : '道端に落し物を見つけたが、既に十分な収入があったので届け出た。'; } },
  { weight: 3, apply: () => { Game.state.hunger = Math.min(100, Game.state.hunger + 20); return '地元のグルメを味見して、少しお腹が満たされた。'; } },
  { weight: 2, apply: () => { const bonus = grantEventMoney(50 + Math.floor(Math.random() * 100)); return bonus > 0 ? `珍しいものを見つけてちょっとした収入(¥${bonus})になった。` : '珍しいものを見つけた。旅の思い出が一つ増えた。'; } },
  { weight: 2, apply: () => '地元のイベントに遭遇した。旅の思い出が一つ増えた。' },
  { weight: 3, apply: () => { Game.state.stamina = Math.min(100, Game.state.stamina + 15); return 'ベンチで少し休ませてもらい、体力が少し回復した。'; } },
  { weight: 2, apply: () => { Game.state.hunger = Math.min(100, Game.state.hunger + 10); Game.state.stamina = Math.min(100, Game.state.stamina + 10); return '地元の人に手土産をもらった。'; } },
  { weight: 2, apply: () => { const discount = grantEventMoney(100 + Math.floor(Math.random() * 200)); return discount > 0 ? `お得な情報を教えてもらい、¥${discount}分お得になった。` : 'お得な情報を教えてもらったが、もう十分な余裕があった。'; } },
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
      discoveryRewardEarned: 0,
      placeArrivalBonusEarned: 0,
      randomEventMoneyEarned: 0,
      officialSiteViewedIds: [],
      officialSiteRewardEarned: 0,
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
      if (nodeType === 'place') {
        // 観光名所は固定のPLACE_ARRIVAL_BONUS(2026-08-02、アルバイト廃止に伴う
        // 置き換え)。駅の発見報酬(DISCOVERY_REWARD_TOTAL_CAP)とは別の専用の
        // 合計上限で管理する(理由は同定数のコメント参照)。
        const earned = this.state.placeArrivalBonusEarned || 0;
        const grantable = Math.max(0, Math.min(PLACE_ARRIVAL_BONUS, PLACE_ARRIVAL_BONUS_TOTAL_CAP - earned));
        this.state.money += grantable;
        this.state.placeArrivalBonusEarned = earned + grantable;
      } else {
        const node = this.data.stationsById.get(nodeId);
        const reward = (node && node.reward) || 0;
        const earned = this.state.discoveryRewardEarned || 0;
        const grantable = Math.max(0, Math.min(reward, DISCOVERY_REWARD_TOTAL_CAP - earned));
        this.state.money += grantable;
        this.state.discoveryRewardEarned = earned + grantable;
      }
    }
  },

  getCandidates() {
    const history = this.state.moveHistory;
    // movement.jsのRECENT_NODE_PENALTYが20手分の窓を見るため、それに合わせて集める
    // (2026-07-31、長周期ループ対策。詳細はmovement.js側のコメント参照)。
    const recentNodeIds = [];
    for (let i = history.length - 1; i >= 0 && recentNodeIds.length < 40; i--) {
      recentNodeIds.push({ id: history[i].fromId, type: history[i].fromType });
    }

    // 直近数手のうちに現在地へ何度も舞い戻っている(=往復振動している)場合、
    // 同じ場所に3回以上舞い戻っているなら、直前地点への逆戻りを今回だけ禁止し、
    // 強制的に別の選択肢を取らせて往復ループを断ち切る。
    // (以前はrevisitCount>=2で交通機関の方向性フィルタ自体を丸ごと外す
    // forceUnfilteredTransportもあったが、目的地方向の正しい候補が既にあるのに
    // 遠ざかる候補まで紛れ込む不具合の原因だったため2026-07-30に削除した。
    // movement.js側は「フィルタ後0件のときのみ」フィルタなしにフォールバックする)。
    // 2026-07-31: 全国駅データ拡張(131→10,603ノード)で、短い2地点往復だけでなく
    // 進行スコアがほぼ横並びのローカルな駅クラスタを巡る、より長い周回(8手を
    // 超えるループ)が実際に発生することが分かった(例: 群馬県内の駅を約9手周期で
    // 巡り続けて詰む実例をシミュレーションで検出)。8手の窓では周期がそれより
    // 長いループを検知できないため、窓を広げた。
    const RECENT_WINDOW = 40;
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
    // 本当に何も無い(移動候補0件・食事も温泉も不可)場合のみ、ロックを
    // 一時的に無視してヒッチハイクを候補に戻す。「食事/温泉」という
    // movement.js側が知らない選択肢の有無を踏まえた判断のため、ここ(game.js)で行う。
    if (candidates.length === 0 && this.state.hitchhikeLocked &&
        !this.canAffordEat() && !this.canAffordRest() && !this.canAffordOnsen()) {
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
    // 距離に応じた消耗に加え、1手ごとの固定消耗(HUNGER/STAMINA_DECAY_PER_MOVE_FLAT)
    // も加える(§上記コメント参照。短距離移動の繰り返しでも時間経過分は消耗させるため)。
    s.hunger = Math.max(0, s.hunger - candidate.distanceKm * HUNGER_DECAY_PER_KM - HUNGER_DECAY_PER_MOVE_FLAT);
    s.stamina = Math.max(0, s.stamina - STAMINA_DECAY_PER_MOVE_FLAT
      - (candidate.mode === 'walk' ? candidate.distanceKm * STAMINA_DECAY_PER_KM_WALK : 0));
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

  // 温泉施設(観光名所のtype==='onsen')かどうか。「温泉に入る」はここでのみ選べる
  // (2026-07-31、ユーザー指示)。
  atOnsen() {
    if (this.state.currentNodeType !== 'place') return false;
    const node = this.currentNode();
    return !!(node && node.type === 'onsen');
  },

  // ⑤ 空腹・体力が既に100%のときは、食事/休憩/温泉を選べないようにする
  // (回復する意味が無いため。2026-07-31、ユーザー指示)。
  canAffordEat() {
    return this.atRecoverableNode() && this.state.money >= EAT_COST && this.state.hunger < 100;
  },

  // 休憩は体力に加えて空腹も少し回復するため、どちらかが100%未満なら選べる。
  canAffordRest() {
    return this.atRecoverableNode() && this.state.money >= REST_COST && (this.state.stamina < 100 || this.state.hunger < 100);
  },

  canAffordOnsen() {
    return this.atOnsen() && this.state.money >= ONSEN_COST && this.state.stamina < 100;
  },

  eat() {
    if (!this.canAffordEat()) {
      return { ok: false, message: this.atRecoverableNode() ? '所持金が足りない、または既に満腹です。' : 'ここでは食事できません。' };
    }
    this.state.money -= EAT_COST;
    this.state.hunger = Math.min(100, this.state.hunger + EAT_HUNGER_GAIN);
    this.state.hitchhikeLocked = false;
    Save.write(this.state);
    return { ok: true, message: `食事をとった(¥${EAT_COST})。`, gameOver: this.checkGameOver() };
  },

  // 「休憩する」: どこでも使える控えめな体力回復(2026-07-31、ユーザー指示で
  // デフォルトの体力回復手段とした。旧「温泉に入る」相当だが全回復ではない)。
  rest() {
    if (!this.canAffordRest()) {
      return { ok: false, message: this.atRecoverableNode() ? '所持金が足りない、または既に空腹・体力ともに満タンです。' : 'ここでは休憩できません。' };
    }
    this.state.money -= REST_COST;
    this.state.stamina = Math.min(100, this.state.stamina + REST_STAMINA_GAIN);
    // 飲み物を買いながらベンチで休む、という意味合いで空腹も少し回復する(2026-07-31)。
    this.state.hunger = Math.min(100, this.state.hunger + REST_HUNGER_GAIN);
    this.state.hitchhikeLocked = false;
    Save.write(this.state);
    return { ok: true, message: `少し休憩して体力(+${REST_STAMINA_GAIN})と空腹(+${REST_HUNGER_GAIN})を回復した(¥${REST_COST})。`, gameOver: this.checkGameOver() };
  },

  // 「温泉に入る」: 温泉施設(type==='onsen')限定。体力を100%まで全回復する
  // (2026-07-31、ユーザー指示)。
  onsen() {
    if (!this.canAffordOnsen()) {
      return { ok: false, message: this.atOnsen() ? '所持金が足りない、または既に体力満タンです。' : 'ここには温泉がありません。' };
    }
    this.state.money -= ONSEN_COST;
    this.state.stamina = 100;
    this.state.hitchhikeLocked = false;
    Save.write(this.state);
    return { ok: true, message: `温泉に入って体力が全回復した(¥${ONSEN_COST})。`, gameOver: this.checkGameOver() };
  },

  canViewOfficialSite() {
    if (this.state.currentNodeType !== 'place') return false;
    const node = this.currentNode();
    return !!(node && node.officialUrl && !this.state.officialSiteViewedIds.includes(node.id));
  },

  // 観光名所到着時、公式ホームページを見た対価として一定額もらえる
  // (2026-08-02、ユーザー指示)。同じ地点で二重に受け取れないよう
  // officialSiteViewedIdsで管理し、ゲーム全体の合計にも上限を設ける。
  viewOfficialSite() {
    if (!this.canViewOfficialSite()) {
      return { ok: false, message: 'ここでは公式ホームページの対価をもらえません。' };
    }
    const node = this.currentNode();
    this.state.officialSiteViewedIds.push(node.id);
    const earned = this.state.officialSiteRewardEarned || 0;
    const grantable = Math.max(0, Math.min(OFFICIAL_SITE_VIEW_REWARD, OFFICIAL_SITE_VIEW_REWARD_TOTAL_CAP - earned));
    this.state.money += grantable;
    this.state.officialSiteRewardEarned = earned + grantable;
    Save.write(this.state);
    return {
      ok: true,
      message: grantable > 0
        ? `公式ホームページを見て¥${grantable}もらった。`
        : '公式ホームページを見た。',
      url: node.officialUrl,
      gameOver: this.checkGameOver(),
    };
  },

  // 2026-08-02、ユーザー指示により「アルバイトする」(canWork/workPreview/work)
  // を廃止した。観光名所到着時のPLACE_ARRIVAL_BONUS自動付与(onArrive参照)に
  // 置き換えている。

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
window.REST_HUNGER_GAIN = REST_HUNGER_GAIN;
window.ONSEN_COST = ONSEN_COST;
window.OFFICIAL_SITE_VIEW_REWARD = OFFICIAL_SITE_VIEW_REWARD;
window.HUNGER_DECAY_PER_KM = HUNGER_DECAY_PER_KM;
window.STAMINA_DECAY_PER_KM_WALK = STAMINA_DECAY_PER_KM_WALK;
