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

function canAffordEat(sandbox) {
  return sandbox.Game.canAffordEat();
}

function canAffordRest(sandbox) {
  return sandbox.Game.canAffordRest();
}

// 次に取るアクションを1つ決める。candidatesは呼び出し側が(1ステップにつき1回)
// Game.getCandidates()した結果を渡す(このモジュール内で再取得しない)。
// 戻り値: { type: 'eat'|'rest'|'move', candidate? } または、
// 本当に取れる行動が何も無い場合は null(詰み)。
// 2026-08-02: 「アルバイトする」廃止(観光名所到着時の自動ボーナスに置き換え)
// に伴い、work関連の分岐を削除した。
function decideAction(sandbox, candidates, movementPolicy) {
  const s = sandbox.Game.state;

  if (s.hunger <= EAT_THRESHOLD && canAffordEat(sandbox)) return { type: 'eat' };
  if (s.stamina <= REST_THRESHOLD && canAffordRest(sandbox)) return { type: 'rest' };

  if (candidates.length > 0) {
    const chosen = movementPolicy(candidates);
    if (chosen) return { type: 'move', candidate: chosen };
  }

  // 移動候補が無い場合の最終手段: 食べる・休む の順に試す
  // (main.jsのrenderCandidatesが「候補ゼロ・eat/rest全て不可」の場合のみ
  // 「移動できる場所が見つかりません」と表示するのと同じ考え方)。
  if (canAffordEat(sandbox)) return { type: 'eat' };
  if (canAffordRest(sandbox)) return { type: 'rest' };

  return null;
}

// 1プレイをシミュレーションする。
// 戻り値: { arrived, stuck, steps, violations, state }
//   - arrived: 目的地に到着したか
//   - stuck: 詰み(候補もeat/restも無い)が発生したか
//   - violations: 各ステップ後に検査した不変条件違反の一覧(空なら問題なし)
function simulateGame({ sandbox, difficulty = 'normal', movementPolicy, seed, maxSteps = 400 }) {
  const { seedGameRandom } = require('./gameHarness');
  seedGameRandom(sandbox, seed);

  const { Game, Movement } = sandbox;
  Game.newGame(difficulty);

  const violations = [];
  const actionLog = [];

  for (let step = 1; step <= maxSteps; step++) {
    if (Game.state.arrived || Game.state.gameOver) break;

    // Game.getCandidates()は1ステップにつきちょうど1回だけ呼ぶ(乱数消費を実プレイと揃えるため)。
    const candidates = Game.getCandidates();

    // 2026-07-31: 候補地をカテゴリー別(移動・歴史・自然・温泉・道の駅・その他)に
    // 整理して表示する方式に変更したため、固定3x3=9マスグリッドの制約は撤廃した
    // (docs/HANDOFF.md §17参照)。代わりに、候補数がカテゴリー別クォータの合計を
    // 超えないという健全性だけを確認する(無制限に膨れ上がらないことの担保)。
    const quotaSum = Object.values(Movement.CATEGORY_QUOTA).reduce((a, b) => a + b, 0);
    if (candidates.length > quotaSum) {
      violations.push(`step ${step}: candidate count (${candidates.length}) exceeds the category quota total (${quotaSum})`);
    }

    const action = decideAction(sandbox, candidates, movementPolicy);
    if (!action) {
      return { arrived: false, gameOver: false, stuck: true, steps: step - 1, violations, actionLog, state: { ...Game.state } };
    }

    let result;
    if (action.type === 'eat') result = Game.eat();
    else if (action.type === 'rest') result = Game.rest();
    else result = Game.chooseCandidate(action.candidate);

    actionLog.push({ type: action.type, ok: result.ok });

    const s = Game.state;
    if (s.money < 0) violations.push(`step ${step}: money went negative (${s.money})`);
    if (s.hunger < 0 || s.hunger > 100) violations.push(`step ${step}: hunger out of range (${s.hunger})`);
    if (s.stamina < 0 || s.stamina > 100) violations.push(`step ${step}: stamina out of range (${s.stamina})`);

    // 実際のUI(main.js)はGame Over時にそれ以上の入力を受け付けない
    // (result.gameOverを見てオーバーレイを出し、renderCandidates()を呼ばない)ため、
    // シミュレーターもここで打ち切る(そうしないと0/0ゲージのまま無為に手数だけ
    // 積み上げてしまい、詰みでも到着でもない偽の「未到着」を報告してしまう)。
    if (result.gameOver) break;
  }

  return {
    arrived: !!Game.state.arrived,
    gameOver: !!Game.state.gameOver,
    stuck: false,
    steps: actionLog.length,
    violations,
    actionLog,
    state: { ...Game.state },
  };
}

module.exports = { simulateGame, decideAction, canAffordEat, canAffordRest };
