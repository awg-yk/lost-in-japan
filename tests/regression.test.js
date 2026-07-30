// tests/regression.test.js
//
// docs/PHASE_PLAN.md Phase5「詰み・往復振動が起きないことを、複数シード・複数
// 方策でリグレッション化する」の実装。docs/HANDOFF.mdに記録されている過去の
// 実バグ(松山↔高松の往復振動、鹿児島↔那覇のフェリーヒッチハイク往復、
// ヒッチハイクロックまわりの詰みなど)を、コード変更のたびに機械的に再検出できる
// ようにする。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGameContext } = require('./support/gameHarness');
const { simulateGame } = require('./support/simulate');
const { POLICIES } = require('./support/policies');

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const DIFFICULTIES = ['easy', 'normal', 'hard'];
const MAX_STEPS = 400; // docs/PHASE_PLAN.mdの実測(15〜39手)に対し十分な余裕を持たせた上限

function runAndReport(policyName, difficulty, seed) {
  const sandbox = createGameContext();
  const movementPolicy = POLICIES[policyName];
  const result = simulateGame({
    sandbox,
    difficulty,
    movementPolicy,
    seed,
    maxSteps: MAX_STEPS,
    workHeavyOverride: policyName === 'workHeavy',
  });
  return result;
}

for (const policyName of Object.keys(POLICIES)) {
  test(`regression: ${policyName} policy never gets stuck or breaks invariants (all difficulties, ${SEEDS.length} seeds)`, () => {
    for (const difficulty of DIFFICULTIES) {
      for (const seed of SEEDS) {
        const result = runAndReport(policyName, difficulty, seed);
        const ctx = `${policyName}/${difficulty}/seed=${seed}`;

        assert.equal(result.stuck, false,
          `${ctx}: got stuck with no movement/work/eat/rest option (steps=${result.steps})`);
        assert.deepEqual(result.violations, [],
          `${ctx}: invariant violations: ${result.violations.join('; ')}`);
        assert.equal(result.arrived, true,
          `${ctx}: did not arrive within ${MAX_STEPS} steps (possible infinite oscillation)`);
      }
    }
  });
}

test('regression: discovery policy visits at least as many places as a naive greedy policy on average', () => {
  // docs/PHASE_PLAN.md Phase3で確認された「discovery方策はgreedyより訪問数が多い」
  // という設計意図(寄り道が有利)が壊れていないことをゆるく確認する
  // (統計的性質のチェックであり、個別seedの厳密比較ではない)。
  let greedyVisited = 0;
  let discoveryVisited = 0;
  for (const seed of SEEDS) {
    const greedy = runAndReport('greedy', 'normal', seed);
    const discovery = runAndReport('discovery', 'normal', seed);
    greedyVisited += greedy.state.visitedIds.length;
    discoveryVisited += discovery.state.visitedIds.length;
  }
  assert.ok(discoveryVisited >= greedyVisited,
    `discovery policy visited fewer places on average (${discoveryVisited} vs ${greedyVisited} total over ${SEEDS.length} seeds)`);
});
