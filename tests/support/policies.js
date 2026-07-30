// tests/support/policies.js
//
// docs/PHASE_PLAN.md のPhase3で使われた3種の疑似プレイヤー方策(greedy/discovery/rush)
// を再現し、Phase5(回帰テスト)向けに追加でworkHeavy方策(アルバイト上限回数=3の
// 検証用に、可能な限りアルバイトを優先して同一ノードで働き続けようとする)を用意する。
// いずれも「移動候補の中から何を選ぶか」だけを決め、空腹/体力の生存行動(eat/rest)は
// simulate.js側で共通の優先ロジックとして扱う。
'use strict';

const POLICIES = {
  // 候補リストの先頭(Movement.generateCandidatesがスコア順にソート済み)をそのまま選ぶ。
  greedy(candidates) {
    return candidates[0] || null;
  },

  // 未発見地点(isNew)を優先し、その中で最もスコアの高いものを選ぶ。
  discovery(candidates) {
    const undiscovered = candidates.filter(c => c.isNew);
    if (undiscovered.length > 0) return undiscovered[0];
    return candidates[0] || null;
  },

  // 徒歩以外(鉄道・飛行機・船・ヒッチハイク)を優先する最短ルート型。
  rush(candidates) {
    const nonWalk = candidates.filter(c => c.mode !== 'walk');
    if (nonWalk.length > 0) return nonWalk[0];
    return candidates[0] || null;
  },

  // 移動選択自体はgreedyと同じ。simulate.js側のworkHeavyOverride と組み合わせて、
  // 「同一ノードで働けるだけ働く」ケースを作るために使う。
  workHeavy(candidates) {
    return candidates[0] || null;
  },
};

module.exports = { POLICIES };
