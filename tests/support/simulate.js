// tests/support/simulate.js
//
// 実際のGame/Movementロジック(tests/support/gameHarness.js経由でNode上にロード)を
// 使い、ヘッドレスに1プレイを最後まで(または詰み/上限手数まで)実行する。
// docs/PHASE_PLAN.md Phase5の「候補が0件にならない」「往復ループで詰まらない」を
// 継続的に検証するための土台。
//
// 注意: Movement.generateCandidates()のスコア計算にはMath.random()が含まれる
// (candidateScore()の 0.05*Math.random() 項)ため、Game.getCandidates()の呼び出しは
// 副作用がある(乱数を1つ以上消費する)。実際のUI(main.jsのrenderCandidates())は
// 1ステップにつき1回しか呼ばないため、このシミュレーターも必ず1ステップ1回に揃える。
// そうしないと、同じseedを与えても検証コードの呼び出し回数によって乱数列がずれ、
// シード固定の意味が無くなる(実際、invariantチェック用に余分に呼んでいたところ、
// 実在しない「詰み」を誤検出したことがある)。
'use strict';

const EAT_THRESHOLD = 30;
const REST_THRESHOLD = 30;
// 所持金が少なく、かつ移動方策が選んだ候補がスコア0以下(=進行度がほぼ無い・
// マイナスの弱い手)の場合に限り、移動よりアルバイトを優先する。
// (フェリー・空港ルートには運賃が数千円かかるものがあり、無計画に歩き回るだけの
// 単純な方策だと、稼ぐという選択肢を一切使わず所持金不足で足止めされるケースが
// あった。逆に「候補のスコアを見ずに所持金だけで無条件にアルバイトを優先する」
// 実装にすると、今度は運賃を払えば取れる好スコアな候補があるのに、あえて
// アルバイトを選んで足止めしてしまうケースが新たに生じた。そのため
// 「今回選ぼうとした手が弱い(スコア<=0)ときだけ」働くことを優先する)。
const MONEY_LOW_THRESHOLD = 3000;
const WEAK_CANDIDATE_SCORE = 0;

function canAffordEat(sandbox) {
  return sandbox.Game.canAffordEat();
}

function canAffordRest(sandbox) {
  return sandbox.Game.canAffordRest();
}

// 次に取るアクションを1つ決める。candidatesは呼び出し側が(1ステップにつき1回)
// Game.getCandidates()した結果を渡す(このモジュール内で再取得しない)。
// 戻り値: { type: 'eat'|'rest'|'work'|'move', candidate? } または、
// 本当に取れる行動が何も無い場合は null(詰み)。
function decideAction(sandbox, candidates, movementPolicy, { workHeavyOverride = false } = {}) {
  const { Game } = sandbox;
  const s = Game.state;
  const canWork = Game.canWork();

  if (s.hunger <= EAT_THRESHOLD && canAffordEat(sandbox)) return { type: 'eat' };
  if (s.stamina <= REST_THRESHOLD && canAffordRest(sandbox)) return { type: 'rest' };

  if (workHeavyOverride && canWork) return { type: 'work' };

  if (candidates.length > 0) {
    const chosen = movementPolicy(candidates);
    if (chosen) {
      const chosenIsWeak = chosen.score <= WEAK_CANDIDATE_SCORE;
      if (chosenIsWeak && canWork && s.money < MONEY_LOW_THRESHOLD) return { type: 'work' };
      return { type: 'move', candidate: chosen };
    }
  }

  // 移動候補が無い場合の最終手段: 稼ぐ・食べる・休む の順に試す
  // (main.jsのrenderCandidatesが「候補ゼロ・work/eat/rest全て不可」の場合のみ
  // 「移動できる場所が見つかりません」と表示するのと同じ考え方)。
  if (canWork) return { type: 'work' };
  if (canAffordEat(sandbox)) return { type: 'eat' };
  if (canAffordRest(sandbox)) return { type: 'rest' };

  return null;
}

// 1プレイをシミュレーションする。
// 戻り値: { arrived, stuck, steps, violations, state }
//   - arrived: 目的地に到着したか
//   - stuck: 詰み(候補もwork/eat/restも無い)が発生したか
//   - violations: 各ステップ後に検査した不変条件違反の一覧(空なら問題なし)
function simulateGame({ sandbox, difficulty = 'normal', movementPolicy, seed, maxSteps = 400, workHeavyOverride = false }) {
  const { seedGameRandom } = require('./gameHarness');
  seedGameRandom(sandbox, seed);

  const { Game } = sandbox;
  Game.newGame(difficulty);

  const violations = [];
  const actionLog = [];

  for (let step = 1; step <= maxSteps; step++) {
    if (Game.state.arrived) break;

    // Game.getCandidates()は1ステップにつきちょうど1回だけ呼ぶ(乱数消費を実プレイと揃えるため)。
    const candidates = Game.getCandidates();
    const canWork = Game.canWork();
    const canEat = canAffordEat(sandbox);
    const canRest = canAffordRest(sandbox);

    const totalActions = candidates.length + [canWork, canEat, canRest].filter(Boolean).length;
    if (totalActions > 9) {
      violations.push(`step ${step}: total selectable actions (${totalActions}) exceed the 3x3=9 grid capacity`);
    }

    const action = decideAction(sandbox, candidates, movementPolicy, { workHeavyOverride });
    if (!action) {
      return { arrived: false, stuck: true, steps: step - 1, violations, actionLog, state: { ...Game.state } };
    }

    let result;
    if (action.type === 'work') result = Game.work();
    else if (action.type === 'eat') result = Game.eat();
    else if (action.type === 'rest') result = Game.rest();
    else result = Game.chooseCandidate(action.candidate);

    actionLog.push({ type: action.type, ok: result.ok });

    const s = Game.state;
    if (s.money < 0) violations.push(`step ${step}: money went negative (${s.money})`);
    if (s.hunger < 0 || s.hunger > 100) violations.push(`step ${step}: hunger out of range (${s.hunger})`);
    if (s.stamina < 0 || s.stamina > 100) violations.push(`step ${step}: stamina out of range (${s.stamina})`);
    if ((s.hunger <= 0 || s.stamina <= 0) && Game.canWork()) {
      violations.push(`step ${step}: canWork() true despite hunger=${s.hunger} stamina=${s.stamina}`);
    }
    if (Game.workCountAtCurrentNode() > 3) {
      violations.push(`step ${step}: worked more than 3 times at node ${s.currentNodeId} (${Game.workCountAtCurrentNode()})`);
    }
  }

  return {
    arrived: !!Game.state.arrived,
    stuck: false,
    steps: actionLog.length,
    violations,
    actionLog,
    state: { ...Game.state },
  };
}

module.exports = { simulateGame, decideAction, canAffordEat, canAffordRest };
