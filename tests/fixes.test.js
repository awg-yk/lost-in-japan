// tests/fixes.test.js
//
// ユーザーからの指示それぞれについて、直接・決定論的に検証する回帰テスト。
//   ① 選択肢は3x3=9マス以内に収まる(UIが地図を覆い隠さない前提の担保)
//
// 2026-08-02: 「アルバイトする」を廃止し、観光名所到着時の自動ボーナスに
// 置き換えたため、旧②③④(アルバイトの利用条件・同一ノード回数上限)の
// テストは前提が失われて削除した。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGameContext, seedGameRandom } = require('./support/gameHarness');

function freshGame(seed = 1) {
  const sandbox = createGameContext();
  seedGameRandom(sandbox, seed);
  sandbox.Game.newGame('normal');
  return sandbox;
}

test('fix2: eating and resting stay available at 0 gauges', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;
  Game.state.hunger = 0;
  Game.state.stamina = 0;
  Game.state.money = 10000;
  assert.equal(Game.eat().ok, true, 'eat() should still work so the player can recover');
  assert.equal(Game.rest().ok, true, 'rest() should still work so the player can recover');
});

// 2026-07-31: ユーザー指示により候補地をカテゴリー別(移動・歴史・自然・温泉・
// 道の駅・その他)表示に変更し、「候補地をたくさん表示できる」ことを狙って
// 固定3x3=9マスグリッドの制約を撤廃した(js/movement.jsのCATEGORY_QUOTA参照)。
// そのため旧fix1(9マス以内)は前提が崩れており、代わりに「候補総数が
// カテゴリー別クォータの合計を超えない」という新しい上限だけを確認する
// (無制限に膨れ上がらないことの健全性チェック)。
test('fix1(改定): 候補総数はカテゴリー別クォータの合計を超えない', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const sandbox = createGameContext();
    seedGameRandom(sandbox, seed);
    const { Game, Movement } = sandbox;
    Game.newGame('normal');
    const quotaSum = Object.values(Movement.CATEGORY_QUOTA).reduce((a, b) => a + b, 0);

    for (let step = 0; step < 30 && !Game.state.arrived; step++) {
      const candidates = Game.getCandidates();
      const canEat = Game.canAffordEat();
      const canRest = Game.canAffordRest();
      assert.ok(candidates.length <= quotaSum,
        `seed ${seed} step ${step}: ${candidates.length} candidates exceed the category quota total (${quotaSum})`);

      const pick = candidates[0];
      if (pick) Game.chooseCandidate(pick);
      else if (canEat) Game.eat();
      else if (canRest) Game.rest();
      else break;
    }
  }
});
