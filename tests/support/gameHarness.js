// tests/support/gameHarness.js
//
// js/*.js はブラウザ向けスクリプト(<script>タグで読み込まれ、末尾で
// `window.X = X` の形でグローバルに公開する作り)であり、CommonJSモジュールでは
// ない。ビルドツールなしという方針(docs/HANDOFF.md参照)を維持したまま、
// 本番と全く同じコードをNode上でテストするため、vmでサンドボックス実行し、
// window === global にすることでブラウザと同じグローバル公開のされ方を再現する。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

const GAME_SCRIPTS = ['js/data-utils.js', 'js/movement.js', 'js/game.js', 'js/save.js'];

function createLocalStorageStub() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

// data/*.json を読み込み、main.jsのloadData()と同じ後処理(相互接続の補完・
// 空間インデックス構築)を行う。main.js自体はfetch/DOMに依存するため直接は
// 使えず、この部分だけは複製する必要があるが、相互接続の補完ロジック自体は
// js/data-utils.js を共用しているため本番と食い違うことはない。
function loadGameData(sandbox) {
  const places = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/places.json'), 'utf8')).places;
  const stations = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stations.json'), 'utf8')).nodes;
  const blockReachability = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/blockReachability.json'), 'utf8'));

  sandbox.DataUtils.ensureReciprocalConnections(stations);

  return {
    places,
    stations,
    placesById: new Map(places.map(p => [p.id, p])),
    stationsById: new Map(stations.map(s => [s.id, s])),
    spatialIndex: sandbox.Movement.buildSpatialIndex(places, stations),
    blockReachability,
  };
}

// ゲームロジック一式(Game/Movement/Save)とデータを読み込んだサンドボックスを
// 1つ作る。同じサンドボックスを使い回し、seedGameRandom()でMath.randomだけを
// 差し替えることで、複数シードのシミュレーションを高速に実行できる。
function createGameContext() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.localStorage = createLocalStorageStub();
  const ctx = vm.createContext(sandbox);

  for (const file of GAME_SCRIPTS) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, ctx, { filename: file });
  }

  // vm.createContext()でcontextify化されたオブジェクトは、実行中のコード内から見える
  // `Math`等の組み込みオブジェクトを、Node側のsandbox参照からは(同じプロパティとしては)
  // 参照できないという既知の挙動がある。そのため、コンテキスト内部から見た実体の
  // Mathオブジェクトを別途取得し、_contextMathとして保持しておく
  // (seedGameRandom()がMath.randomを差し替える際に使う)。
  sandbox._contextMath = vm.runInContext('Math', ctx);

  sandbox.Game.init(loadGameData(sandbox));
  return sandbox;
}

// mulberry32: 依存追加なしで使える小さな決定論的PRNG。
// テストの再現性のため、ゲームロジック内のMath.random()呼び出しをこれに差し替える。
function mulberry32(seed) {
  let s = seed >>> 0;
  return function random() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedGameRandom(sandbox, seed) {
  sandbox._contextMath.random = mulberry32(seed);
}

module.exports = { createGameContext, seedGameRandom, mulberry32 };
