// tests/fixes2.test.js
//
// 2026-07-30の追加ユーザー指示7点のうち、コードロジックとして直接テストできる
// ものを検証する回帰テスト(データ変更④「観光名所を駅1つにつき1つ用意する」と
// UI変更⑥「休憩/移動のカテゴリ分け」はここでは対象外。前者はdata/、後者は
// ブラウザでの目視確認とtests/fixes.test.jsのfix1で間接的にカバーしている)。
//   ① 観光名所でもアルバイトに加えて食事・温泉ができる
//   ② 既に訪れた観光名所で、目的地への進行にも寄与しない地点は候補から外す
//   ③ 「往復振動の疑い」だけでフィルタなし全接続に切り替える古い挙動を廃止
//      (目的地方向の候補が実在するのに、遠ざかる候補が紛れ込まないこと)
//   ④ ヒッチハイクは、その区間の運賃を払えない場合にのみ候補に出る。
//      失敗時は空腹・体力をそれぞれ半分(切り捨て)にする
//   ⑤ 行動不能(所持金0・空腹0・体力0)でゲームオーバーになる
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

test('①: eating and resting are available at a sightseeing place, not just transport nodes', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;
  const placeId = [...Game.data.placesById.keys()][0];
  Game.state.currentNodeId = placeId;
  Game.state.currentNodeType = 'place';
  Game.state.money = 10000;

  assert.equal(Game.canAffordEat(), true, 'eat should be available at a sightseeing place');
  assert.equal(Game.canAffordRest(), true, 'rest should be available at a sightseeing place');
  assert.equal(Game.eat().ok, true);
  assert.equal(Game.rest().ok, true);
});

test('②: an already-visited sightseeing place that makes no progress toward the destination is excluded from candidates', () => {
  const sandbox = freshGame();
  const { Game, Movement } = sandbox;
  const currentNode = { ...Game.currentNode(), _type: 'transport' };
  const destinationNode = Game.destinationNode();

  // 現在地の近くにある観光名所を1つ探す(既発見扱いにする対象)。
  const nearby = Movement.getNearbyNodes(currentNode.lat, currentNode.lng, Movement.WALK_RADIUS_KM_DEFAULT, Game.data.spatialIndex, currentNode.id)
    .find(({ node }) => node._type === 'place');
  if (!nearby) return; // このseed/開始地点の近くに観光名所が無ければ検証対象なしでスキップ

  const place = nearby.node;
  const progress = Movement.progressScore(currentNode, place, destinationNode, Game.reachability);

  const baseCtx = {
    currentNode, destinationNode,
    money: Game.state.money, hunger: 100, stamina: 100,
    spatialIndex: Game.data.spatialIndex,
    stationsById: Game.data.stationsById, placesById: Game.data.placesById,
    recentNodeIds: [], bannedTarget: null,
    reachability: Game.reachability, hitchhikeLuckBonus: 0, hitchhikeLocked: false,
  };

  const asUndiscovered = Movement.generateCandidates({ ...baseCtx, discoveredIds: [] });
  assert.ok(asUndiscovered.some(c => c.targetType === 'place' && c.targetId === place.id),
    'an undiscovered nearby place should appear as a candidate regardless of progress');

  const asDiscovered = Movement.generateCandidates({ ...baseCtx, discoveredIds: [place.id] });
  const stillShown = asDiscovered.some(c => c.targetType === 'place' && c.targetId === place.id);
  if (progress <= 0) {
    assert.equal(stillShown, false,
      `place ${place.name} (progress=${progress}) was already visited and doesn't help reach the destination, so it should be excluded`);
  }
});

test('③: backward-progress transport candidates never appear when forward-progress ones exist', () => {
  // 以前は「直近で同じ地点に2回以上舞い戻っている」というシグナルだけで、
  // 目的地方向の正しい候補が既にあるのに、フィルタなし全接続(遠ざかる接続を
  // 含む)に丸ごと差し替えてしまっていた。forceUnfilteredTransportを渡しても
  // (今のmovement.jsはこの値を読まないため)後退方向の候補が紛れ込まないことを
  // 複数シードで確認する。
  let checkedAny = false;
  for (let seed = 1; seed <= 20; seed++) {
    const sandbox = createGameContext();
    seedGameRandom(sandbox, seed);
    const { Game, Movement } = sandbox;
    Game.newGame('normal');
    const currentNode = { ...Game.currentNode(), _type: 'transport' };
    const destinationNode = Game.destinationNode();

    const candidates = Movement.generateCandidates({
      currentNode, destinationNode,
      money: Game.state.money, hunger: 100, stamina: 100,
      spatialIndex: Game.data.spatialIndex,
      stationsById: Game.data.stationsById, placesById: Game.data.placesById,
      discoveredIds: Game.state.discoveredIds,
      recentNodeIds: [], bannedTarget: null,
      reachability: Game.reachability, hitchhikeLuckBonus: 0, hitchhikeLocked: false,
      forceUnfilteredTransport: true, // 過去の実装ならここでフィルタが丸ごと外れていた
    });

    // 徒歩候補(mode==='walk')は寄り道として意図的にフィルタ対象外(進行方向を
    // 問わず候補に出る仕様)なので、鉄道・飛行機・船・ヒッチハイクの接続のみを見る。
    const transportCandidates = candidates.filter(c => c.targetType === 'transport' && c.mode !== 'walk');
    if (transportCandidates.length === 0) continue;
    checkedAny = true;
    for (const c of transportCandidates) {
      const toNode = Game.data.stationsById.get(c.targetId);
      const progress = Movement.progressScore(currentNode, toNode, destinationNode, Game.reachability);
      assert.ok(progress > 0,
        `seed ${seed}: candidate to ${c.targetName} (mode=${c.mode}) has non-positive progress (${progress}) despite forward candidates existing`);
    }
  }
  assert.ok(checkedAny, 'test setup: expected at least one seed with transport candidates to check');
});

test('④: hitchhike only appears for a connection whose fare the player cannot afford', () => {
  const sandbox = freshGame();
  const { Game, Movement } = sandbox;
  const currentNode = { ...Game.currentNode(), _type: 'transport' };
  const conn = (currentNode.connections || []).find(c => c.cost > 0 && !(c.requiresTransport.length === 1 && c.requiresTransport[0] === 'flight'));
  assert.ok(conn, 'test setup: expected a payable, non-flight-only connection from the starting station');

  // このconnへの進行度を必ず正にする、テスト用の最小限の到達可能性データ。
  const reachability = { graphDistances: new Map([[currentNode.id, 100], [conn.toId, 50]]), blockDistances: null };

  function hitchhikeOffered(money) {
    const candidates = Movement.generateCandidates({
      currentNode, destinationNode: Game.destinationNode(),
      money, hunger: 100, stamina: 100,
      spatialIndex: Game.data.spatialIndex,
      stationsById: Game.data.stationsById, placesById: Game.data.placesById,
      discoveredIds: Game.state.discoveredIds,
      recentNodeIds: [], bannedTarget: null,
      reachability, hitchhikeLuckBonus: 0, hitchhikeLocked: false,
    });
    return candidates.some(c => c.mode === 'hitchhike' && c.targetId === conn.toId);
  }

  assert.equal(hitchhikeOffered(0), true, 'hitchhike should be offered when the fare is unaffordable');
  assert.equal(hitchhikeOffered(conn.cost + 100000), false, 'hitchhike should not be offered once the fare is affordable');
});

test('④: a failed hitchhike halves (and floors) hunger and stamina', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;
  sandbox._contextMath.random = () => 0.999; // successRateは最大0.95なので必ず失敗させる
  Game.state.money = 0; // money=0にして、非flight-onlyの接続を全てヒッチハイク対象にする
  Game.state.hunger = 41;
  Game.state.stamina = 7;

  const candidates = Game.getCandidates();
  const hitchhike = candidates.find(c => c.mode === 'hitchhike');
  assert.ok(hitchhike, 'test setup: expected a hitchhike candidate when money is 0');

  const result = Game.chooseCandidate(hitchhike);
  assert.equal(result.ok, false, 'the forced failure should be reported as not ok');
  assert.equal(Game.state.hunger, Math.floor(41 / 2), 'hunger should be halved and floored');
  assert.equal(Game.state.stamina, Math.floor(7 / 2), 'stamina should be halved and floored');
});

test('⑤: game over triggers exactly when money<=0 and hunger<=0 and stamina<=0', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;

  Game.state.money = 100; Game.state.hunger = 0; Game.state.stamina = 0;
  assert.equal(Game.isIncapacitated(), false, 'still has money, so not incapacitated yet');

  Game.state.money = 0;
  assert.equal(Game.isIncapacitated(), true, 'no money and both gauges at 0 should be incapacitated');

  Game.state.hunger = 5;
  assert.equal(Game.isIncapacitated(), false, 'hunger above 0 means not (yet) incapacitated');
});

test('⑤: chooseCandidate reports gameOver once a hitchhike failure pushes gauges to exactly 0 with no money', () => {
  const sandbox = freshGame();
  const { Game } = sandbox;
  sandbox._contextMath.random = () => 0.999; // 必ず失敗させる
  Game.state.money = 0;
  Game.state.hunger = 1;
  Game.state.stamina = 1;

  const hitchhike = Game.getCandidates().find(c => c.mode === 'hitchhike');
  assert.ok(hitchhike, 'test setup: expected a hitchhike candidate when money is 0');

  const result = Game.chooseCandidate(hitchhike);
  assert.equal(Game.state.hunger, 0);
  assert.equal(Game.state.stamina, 0);
  assert.equal(result.gameOver, true, 'money<=0 and both gauges at 0 after the failed hitchhike should trigger game over');
  assert.equal(Game.state.gameOver, true);
});
