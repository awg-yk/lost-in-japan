// tools/balance_harness.js
//
// Phase3(バランス調整)向けの分析ツール。tests/support/(Game/Movementを
// Node上でヘッドレス実行する仕組み)を再利用し、多数のシード×難易度×方策で
// プレイをシミュレーションして、到着までの手数の分布(平均・中央値・p90・p99)
// を集計する。tests/*.test.js が「壊れていないか(詰み・不変条件)」を見るのに
// 対し、こちらは「体感として妥当な速さで進むか」という設計判断のための
// 定量データを出すためのもの(pass/failを判定するテストではない)。
//
// 使い方:
//   node tools/balance_harness.js                 # 既定(2000シード, 全難易度, greedy方策)
//   node tools/balance_harness.js --seeds 500 --difficulty hard --policy discovery
'use strict';

const path = require('path');
const { createGameContext } = require('../tests/support/gameHarness');
const { simulateGame } = require('../tests/support/simulate');
const { POLICIES } = require('../tests/support/policies');

function parseArgs(argv) {
  const args = { seeds: 2000, maxSteps: 800, difficulties: ['easy', 'normal', 'hard'], policies: ['greedy'] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seeds') args.seeds = Number(argv[++i]);
    else if (argv[i] === '--max-steps') args.maxSteps = Number(argv[++i]);
    else if (argv[i] === '--difficulty') args.difficulties = [argv[++i]];
    else if (argv[i] === '--policy') args.policies = [argv[++i]];
  }
  return args;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  return sortedArr[Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p))];
}

function runSweep(policyName, difficulty, seedCount, maxSteps) {
  const stepsArr = [];
  let gameOverCount = 0;
  let unresolved = 0; // 手数上限に達しても到着もゲームオーバーもしなかった(要調査)
  let stuck = 0;
  let violationGames = 0;

  for (let seed = 1; seed <= seedCount; seed++) {
    const sandbox = createGameContext();
    const result = simulateGame({
      sandbox,
      difficulty,
      movementPolicy: POLICIES[policyName],
      seed,
      maxSteps,
      workHeavyOverride: policyName === 'workHeavy',
    });
    if (result.violations.length > 0) violationGames++;
    if (result.stuck) { stuck++; continue; }
    // 2026-07-30: 行動不能によるゲームオーバーは意図された正規の終了状態
    // (到着と同じく「解決済み」)なので、到着とは別集計にしつつ手数分布には含めない
    // (ゲームオーバーは「進み続けた結果の手数」ではなく、経済的に詰んだ結果のため
    // 意味合いが異なる)。
    if (result.gameOver) { gameOverCount++; continue; }
    if (!result.arrived) { unresolved++; continue; }
    stepsArr.push(result.steps);
  }

  stepsArr.sort((a, b) => a - b);
  const avg = stepsArr.length ? stepsArr.reduce((a, b) => a + b, 0) / stepsArr.length : null;

  return {
    policyName, difficulty, seedCount,
    arrived: stepsArr.length,
    gameOverCount, unresolved, stuck, violationGames,
    avg, median: percentile(stepsArr, 0.5), p90: percentile(stepsArr, 0.9), p99: percentile(stepsArr, 0.99),
    max: stepsArr.length ? stepsArr[stepsArr.length - 1] : null,
  };
}

function fmt(n) { return n === null || n === undefined ? '-' : (typeof n === 'number' ? n.toFixed(1) : n); }

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`balance_harness: seeds=${args.seeds} maxSteps=${args.maxSteps}`);
  console.log('policy'.padEnd(10), 'difficulty'.padEnd(8), 'arrived'.padEnd(8), 'gameOver'.padEnd(9), 'unresolved'.padEnd(11), 'stuck'.padEnd(6), 'viol'.padEnd(6), 'avg'.padEnd(7), 'median'.padEnd(7), 'p90'.padEnd(6), 'p99'.padEnd(6), 'max');
  for (const policyName of args.policies) {
    for (const difficulty of args.difficulties) {
      const r = runSweep(policyName, difficulty, args.seeds, args.maxSteps);
      console.log(
        r.policyName.padEnd(10), r.difficulty.padEnd(8),
        `${r.arrived}/${r.seedCount}`.padEnd(8), String(r.gameOverCount).padEnd(9), String(r.unresolved).padEnd(11),
        String(r.stuck).padEnd(6), String(r.violationGames).padEnd(6),
        fmt(r.avg).padEnd(7), fmt(r.median).padEnd(7), fmt(r.p90).padEnd(6), fmt(r.p99).padEnd(6), fmt(r.max)
      );
    }
  }
}

if (require.main === module) main();

module.exports = { runSweep };
