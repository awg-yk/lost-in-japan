// tests/fixes.test.js
//
// ユーザーからの指示それぞれについて、直接・決定論的に検証する回帰テスト。
//   ① 選択肢は3x3=9マス以内に収まる(UIが地図を覆い隠さない前提の担保)
//   ② 空腹・体力のどちらかが0のときはアルバイト不可
//   ③ アルバイトは同一ノードにつき最大3回まで
//   ④ アルバイトができるのは観光名所(地点データ)のみ。駅・空港・港では働けない
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

// ゲーム開始直後は必ず交通ノードにいる(newGame()参照)。アルバイト関連のテストは
// 観光名所でなければ意味が無いため、実際のグラフ接続を辿るのではなく、テストの
// 意図がぶれないよう地点データへ直接テレポートさせる。
function teleportToPlace(sandbox, placeId) {
  const { Game } = sandbox;
  const id = placeId !== undefined ? placeId : [...Game.data.placesById.keys()][0];
  Game.state.currentNodeId = id;
  Game.state.currentNodeType = 'place';
  return id;
}

test('fix4: work is not available at a transport node, even at full gauges', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;
  assert.equal(Game.atTransportNode(), true, 'newGame starts at a transport node');
  assert.equal(Game.canWork(), false, 'work must be unavailable at a transport node');
  const result = Game.work();
  assert.equal(result.ok, false, 'work() must refuse to run at a transport node');
});

test('fix4: work becomes available once at a sightseeing place (with full gauges)', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;
  teleportToPlace(sandbox);
  assert.equal(Game.canWork(), true, 'work should be available at a sightseeing place with full gauges');
  assert.equal(Game.work().ok, true);
});

test('fix2: work is disabled once hunger hits 0, even at a sightseeing place', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;
  teleportToPlace(sandbox);
  assert.equal(Game.canWork(), true, 'work should be available at full gauges');

  Game.state.hunger = 0;
  assert.equal(Game.canWork(), false, 'canWork() must be false once hunger is 0');
  const result = Game.work();
  assert.equal(result.ok, false, 'work() must refuse to run once hunger is 0');
});

test('fix2: work is disabled once stamina hits 0, even at a sightseeing place', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;
  teleportToPlace(sandbox);
  Game.state.stamina = 0;
  assert.equal(Game.canWork(), false, 'canWork() must be false once stamina is 0');
  const result = Game.work();
  assert.equal(result.ok, false, 'work() must refuse to run once stamina is 0');
});

test('fix2: eating and resting stay available at 0 gauges (only work is blocked)', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;
  // 食事・温泉は引き続き交通ノード側の設備という想定なので、テレポートしない。
  Game.state.hunger = 0;
  Game.state.stamina = 0;
  Game.state.money = 10000;
  assert.equal(Game.eat().ok, true, 'eat() should still work so the player can recover');
  assert.equal(Game.rest().ok, true, 'rest() should still work so the player can recover');
});

test('fix3: work is capped at 3 times at the same sightseeing place', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;
  teleportToPlace(sandbox);
  Game.state.hunger = 100;
  Game.state.stamina = 100;

  const results = [];
  for (let i = 0; i < 5; i++) results.push(Game.work());

  assert.deepEqual(results.map(r => r.ok), [true, true, true, false, false],
    'only the first 3 work attempts at the same place should succeed');
  assert.equal(Game.canWork(), false, 'canWork() must be false after 3 successful work attempts');
});

test('fix3: work count resets for a different place (limit is per-node, not global)', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;
  const placeIds = [...Game.data.placesById.keys()];
  teleportToPlace(sandbox, placeIds[0]);
  Game.state.hunger = 100;
  Game.state.stamina = 100;
  Game.work(); Game.work(); Game.work();
  assert.equal(Game.canWork(), false, 'maxed out at the starting place');

  // 「同一ノードにつき3回」であって「合計3回」ではないことをピンポイントで確認する。
  teleportToPlace(sandbox, placeIds[1]);
  assert.equal(Game.canWork(), true, 'a fresh place should allow working again');
  assert.equal(Game.work().ok, true);
});

test('fix1: total selectable actions (movement candidates + work/eat/rest) never exceed the 3x3=9 grid', () => {
  // 複数シード・複数地点で移動を進めながら、毎ステップの選択肢総数が9を超えないことを確認する。
  for (let seed = 1; seed <= 20; seed++) {
    const sandbox = createGameContext();
    seedGameRandom(sandbox, seed);
    const { Game } = sandbox;
    Game.newGame('normal');

    for (let step = 0; step < 30 && !Game.state.arrived; step++) {
      const candidates = Game.getCandidates();
      const canWork = Game.canWork();
      const canEat = Game.canAffordEat();
      const canRest = Game.canAffordRest();
      const total = candidates.length + [canWork, canEat, canRest].filter(Boolean).length;
      assert.ok(total <= 9, `seed ${seed} step ${step}: ${total} selectable actions exceed the 9-cell grid`);

      const pick = candidates[0];
      if (pick) Game.chooseCandidate(pick);
      else if (canWork) Game.work();
      else if (canEat) Game.eat();
      else if (canRest) Game.rest();
      else break;
    }
  }
});
