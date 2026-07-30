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
  // 2026-07-30修正: 当初は「非徒歩候補が1つでもあれば絶対にそれを選ぶ」という
  // 絶対的フィルタだったが、これだと非徒歩の選択肢(特にヒッチハイク)だけで
  // 2地点を無限に往復してしまい抜け出せなくなるケースが実際にテストで見つかった
  // (徒歩で観光名所へ寄り道して稼ぐ、という選択肢を仕組み上絶対に選べないため)。
  // 絶対禁止ではなく大きめのスコア加算による「強い好み」に変更し、非徒歩options
  // が本当に悪い場合は徒歩(観光名所での資金稼ぎ等)にも逃げられるようにした。
  rush(candidates) {
    const NON_WALK_BONUS = 0.2;
    const withBonus = candidates.map(c => ({ c, adjusted: c.score + (c.mode !== 'walk' ? NON_WALK_BONUS : 0) }));
    withBonus.sort((a, b) => b.adjusted - a.adjusted);
    return withBonus.length > 0 ? withBonus[0].c : null;
  },

  // 移動選択自体はgreedyと同じ。simulate.js側のworkHeavyOverride と組み合わせて、
  // 「同一ノードで働けるだけ働く」ケースを作るために使う。
  workHeavy(candidates) {
    return candidates[0] || null;
  },
};

module.exports = { POLICIES };
