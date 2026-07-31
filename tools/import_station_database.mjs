#!/usr/bin/env node
/**
 * tools/import_station_database.mjs
 *
 * Seo-4d696b75/station_database (CC BY 4.0, 駅メモ!データ準拠) を取り込んで
 * data/stations.json / data/voronoiData.json / data/connections.json /
 * data/blockReachability.json / data/places.json (nearestStationIdのみ更新) を
 * 生成するワンショットスクリプト。再実行可能。
 *
 * データ取得はネットワーク制約により raw.githubusercontent.com 経由のみで行う
 * (overpass-api.de 等は本サンドボックスから403でブロックされる)。
 *
 * 事前検証(このコメントに事実として記録):
 *   register.csv の station_code 列は station.json の `id` ではなく `code` フィールドと
 *   対応する。例: register.csv の "100201,1002,1,NULL" は 東海道新幹線(line code=1002)の
 *   1番目の駅で、station.json 中 code=100201 のレコード(name="東京")と一致した。
 *   station_code=100202→品川, 100203→新横浜, 100204→小田原 も同様に一致したため、
 *   station_code ↔ station.json.code の対応関係を採用する。
 *
 * 使い方:
 *   node tools/import_station_database.mjs
 *   (キャッシュディレクトリ: tools/.cache/station_database/ に生データを保存し、再実行時はキャッシュを使う)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const CACHE_DIR = path.join(__dirname, '.cache', 'station_database');

const BASE_URL = 'https://raw.githubusercontent.com/Seo-4d696b75/station_database/master/out/main';
const SEED = 42;

// --- 標準的な47都道府県コード表(JISコード順、station_database の prefecture 数値と一致) ---
const PREFECTURES = [
  '', '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県',
  '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県',
  '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県',
  '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

// --- 簡易疑似乱数(Mulberry32) — Python random.Random(42) とは値は異なるが、
//     シードから再現可能という要件(§設計判断)を満たすためNode標準機能のみで実装する ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const r = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dlat = ((lat2 - lat1) * Math.PI) / 180;
  const dlng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function gridKey(lat, lng) {
  return `${Math.floor(lat * 10) / 10}_${Math.floor(lng * 10) / 10}`;
}

function roundTo(value, digits) {
  // Python の round(x, -2) 相当(100円単位に丸め)
  const factor = 10 ** digits;
  return Math.round(value / factor) * factor;
}

function computeCost(distKm) {
  return Math.max(200, roundTo(distKm * 12, 2));
}

// §4.2 カテゴリ基礎値(tools/data_generator.py と同一)
const CATEGORY_BASE = { station_major: 30, station_local: 40 };

function nearestMajorCityKm(lat, lng) {
  const cities = [
    [43.0621, 141.3544], [38.2682, 140.8694], [35.6812, 139.7671], [35.4437, 139.638],
    [35.1815, 136.9066], [36.5613, 136.6562], [34.6937, 135.5023], [35.0116, 135.7681],
    [34.6901, 135.1955], [34.3853, 132.4553], [34.3401, 134.0434], [33.8392, 132.7657],
    [33.5904, 130.4017], [32.7898, 130.7417], [26.2124, 127.6809],
  ];
  let best = Infinity;
  for (const [clat, clng] of cities) {
    const d = haversineKm(lat, lng, clat, clng);
    if (d < best) best = d;
  }
  return best;
}

function computeDiscoveryScore(categoryKey, lat, lng, rng) {
  const base = CATEGORY_BASE[categoryKey] ?? 50;
  // has_wikipedia=True, wikipedia_length=5000 固定(tools/data_generator.pyの駅生成部と同一)
  const fameAdjustment = -Math.min(30, 5000 / 500);
  const geoAdjustment = Math.min(25, nearestMajorCityKm(lat, lng) / 10);
  // osm_tag_count=6, has_image_tag=False 固定 → osm_secondary = 0
  const osmSecondary = 0;
  const randomAdjustment = rng() * 6 - 3; // uniform(-3, 3)
  const score = base + fameAdjustment + geoAdjustment + osmSecondary + randomAdjustment;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function computeReward(discoveryScore) {
  return Math.round(50 + discoveryScore * 1.5);
}

// --- Union-Find (孤立防止・連結性検証用) ---
class UnionFind {
  constructor(ids) {
    this.parent = new Map();
    for (const id of ids) this.parent.set(id, id);
  }
  find(x) {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(x) !== root) {
      const next = this.parent.get(x);
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  components() {
    const groups = new Map();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(id);
    }
    return [...groups.values()];
  }
}

async function fetchCached(name, url, isText) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, name);
  if (fs.existsSync(cachePath)) {
    console.log(`[cache] ${name}`);
    return isText ? fs.readFileSync(cachePath, 'utf-8') : JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }
  console.log(`[fetch] ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${url} -> ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(cachePath, text, 'utf-8');
  return isText ? text : JSON.parse(text);
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const row = {};
    header.forEach((h, idx) => { row[h] = cols[idx]; });
    rows.push(row);
  }
  return rows;
}

async function main() {
  const rng = mulberry32(SEED);

  const [stationsRaw, linesRaw, registerCsv] = await Promise.all([
    fetchCached('station.json', `${BASE_URL}/station.json`, false),
    fetchCached('line.json', `${BASE_URL}/line.json`, false),
    fetchCached('register.csv', `${BASE_URL}/register.csv`, true),
  ]);

  console.log(`station.json: ${stationsRaw.length}件, line.json: ${linesRaw.length}件`);

  // 廃駅を除外
  const openStations = stationsRaw.filter((s) => !s.closed);
  console.log(`廃駅除外: ${stationsRaw.length} -> ${openStations.length}`);

  const lineNameByCode = new Map(linesRaw.map((l) => [l.code, l.name]));
  const stationByCode = new Map(openStations.map((s) => [s.code, s]));
  const stationById = new Map(openStations.map((s) => [s.id, s]));

  // register.csv から路線ごとの駅並び順を復元し、隣接駅ペア(=鉄道接続)を作る
  const registerRows = parseCsv(registerCsv);
  const byLine = new Map();
  for (const row of registerRows) {
    const stationCode = Number(row.station_code);
    const lineCode = Number(row.line_code);
    const index = Number(row.index);
    const st = stationByCode.get(stationCode);
    if (!st) continue; // 廃駅など、開業中データに存在しない駅はスキップ
    if (!byLine.has(lineCode)) byLine.set(lineCode, []);
    byLine.get(lineCode).push({ index, id: st.id });
  }

  const edgeKeySet = new Set();
  const edgePairs = []; // [aId, bId, distKm]
  for (const [, entries] of byLine) {
    entries.sort((a, b) => a.index - b.index);
    for (let i = 0; i < entries.length - 1; i++) {
      const a = entries[i].id;
      const b = entries[i + 1].id;
      if (a === b) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (edgeKeySet.has(key)) continue;
      edgeKeySet.add(key);
      const sa = stationById.get(a);
      const sb = stationById.get(b);
      const dist = haversineKm(sa.lat, sa.lng, sb.lat, sb.lng);
      edgePairs.push([a, b, dist]);
    }
  }
  console.log(`register.csvから復元した隣接ペア: ${edgePairs.length}本`);

  // 孤立防止: 連結成分が複数ある場合、最近傍の駅同士を橋渡し接続する
  const allIds = openStations.map((s) => s.id);
  const uf = new UnionFind(allIds);
  for (const [a, b] of edgePairs) uf.union(a, b);

  let components = uf.components();
  console.log(`register.csv接続後の連結成分数: ${components.length}`);

  let bridgeCount = 0;
  while (components.length > 1) {
    // 最大成分に、残りの各成分から最も近いペアで1本ずつ接続する(O(n^2)回避のため
    // 各非最大成分について、代表点付近の駅のみでなく全駅と比較する必要はあるが、
    // 成分数は少ないと想定されるため許容する)
    components.sort((a, b) => b.length - a.length);
    const main = components[0];
    const other = components[1];
    let best = null;
    // 成分が大きい場合の計算量対策: gridKeyで粗く絞り込んでから最近傍探索
    for (const b of other) {
      const sb = stationById.get(b);
      for (const a of main) {
        const sa = stationById.get(a);
        const d = haversineKm(sa.lat, sa.lng, sb.lat, sb.lng);
        if (!best || d < best[2]) best = [a, b, d];
      }
    }
    const [a, b, d] = best;
    edgePairs.push([a, b, d]);
    uf.union(a, b);
    bridgeCount++;
    components = uf.components();
  }
  if (bridgeCount > 0) console.log(`連結性確保のため ${bridgeCount} 本の橋渡し接続を追加しました。`);

  // 最終検証: 単一連結成分であることを確認
  const finalComponents = uf.components();
  if (finalComponents.length !== 1) {
    throw new Error(`検証失敗: 連結成分が ${finalComponents.length} 個残っています`);
  }
  console.log(`到達可能性検証: 全 ${allIds.length} 駅が単一連結成分に属することを確認しました。`);

  // stations.json ノード生成
  const nodes = [];
  for (const s of openStations) {
    const lineNames = (s.lines || []).map((code) => lineNameByCode.get(code)).filter(Boolean);
    const category = lineNames.length >= 3 ? 'station_major' : 'station_local';
    const score = computeDiscoveryScore(category, s.lat, s.lng, rng);
    nodes.push({
      id: s.id,
      name: `${s.name}駅`,
      type: 'station',
      lat: s.lat,
      lng: s.lng,
      prefecture: PREFECTURES[s.prefecture] || '',
      lines: lineNames,
      discoveryScore: score,
      reward: computeReward(score),
      gridKey: gridKey(s.lat, s.lng),
      connections: [],
    });
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // edges (双方向) を構築
  const edges = [];
  for (const [a, b, dist] of edgePairs) {
    const cost = computeCost(dist);
    edges.push({ fromId: a, toId: b, mode: 'rail', requiresTransport: [], cost });
  }

  for (const e of edges) {
    nodeById.get(e.fromId).connections.push({ toId: e.toId, mode: e.mode, requiresTransport: e.requiresTransport, cost: e.cost });
    nodeById.get(e.toId).connections.push({ toId: e.fromId, mode: e.mode, requiresTransport: e.requiresTransport, cost: e.cost });
  }

  console.log(`最終ノード数: ${nodes.length}, 最終接続本数(片方向合計): ${edges.length * 2}`);

  // --- data/stations.json 書き出し ---
  fs.writeFileSync(path.join(DATA_DIR, 'stations.json'), JSON.stringify({ nodes }, null, 2), 'utf-8');

  // --- data/connections.json 書き出し(生成物。stations.json埋め込み済みが正) ---
  fs.writeFileSync(
    path.join(DATA_DIR, 'connections.json'),
    JSON.stringify({
      comment: '生成物。stations.json埋め込み済みconnectionsが正。tools/import_station_database.mjsで生成(station_database由来)。',
      edges,
    }, null, 2),
    'utf-8',
  );

  // --- data/voronoiData.json 書き出し(駅サガース風ボロノイ表示用) ---
  // 9800件超のため、座標を小数点以下5桁(約1m精度)に丸めて軽量化する
  const round5 = (n) => Math.round(n * 1e5) / 1e5;
  const voronoi = {};
  let skippedGeom = 0;
  for (const s of openStations) {
    if (!s.voronoi || !s.voronoi.geometry) continue;
    const geomType = s.voronoi.geometry.type;
    // 大半は Polygon(閉じたボロノイ領域)だが、地図の端に位置する駅など一部は
    // LineString(開いた境界線)になっている。ここではPolygonのみ採用し、
    // LineStringは正しいポリゴン表示にならないため描画対象から除外する。
    if (geomType !== 'Polygon') { skippedGeom++; continue; }
    const coords = s.voronoi.geometry.coordinates.map((ring) => ring.map(([lng, lat]) => [round5(lng), round5(lat)]));
    voronoi[s.id] = { type: geomType, coordinates: coords };
  }
  if (skippedGeom > 0) console.log(`ボロノイ: Polygon以外(LineString等)の ${skippedGeom} 件は描画対象から除外しました。`);
  fs.writeFileSync(path.join(DATA_DIR, 'voronoiData.json'), JSON.stringify(voronoi), 'utf-8');
  console.log(`voronoiData.json: ${Object.keys(voronoi).length}件のポリゴンを書き出しました。`);

  // --- data/places.json: nearestStationId のみ再計算して更新 ---
  const placesPath = path.join(DATA_DIR, 'places.json');
  const placesDoc = JSON.parse(fs.readFileSync(placesPath, 'utf-8'));
  // gridKeyベースの粗い空間インデックスで最近傍探索を高速化
  const stationGrid = new Map();
  for (const n of nodes) {
    if (!stationGrid.has(n.gridKey)) stationGrid.set(n.gridKey, []);
    stationGrid.get(n.gridKey).push(n);
  }
  function nearestStation(lat, lng) {
    const gk = gridKey(lat, lng);
    const [gx, gy] = gk.split('_').map(Number);
    let candidates = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const key = `${Math.round((gx + dx * 0.1) * 10) / 10}_${Math.round((gy + dy * 0.1) * 10) / 10}`;
        if (stationGrid.has(key)) candidates.push(...stationGrid.get(key));
      }
    }
    if (candidates.length === 0) candidates = nodes; // フォールバック(まず起きない)
    let best = null;
    let bestDist = Infinity;
    for (const c of candidates) {
      const d = haversineKm(lat, lng, c.lat, c.lng);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }
  for (const p of placesDoc.places) {
    const nearest = nearestStation(p.lat, p.lng);
    p.nearestStationId = nearest ? nearest.id : null;
  }
  fs.writeFileSync(placesPath, JSON.stringify(placesDoc, null, 2), 'utf-8');
  console.log(`places.json: ${placesDoc.places.length}件のnearestStationIdを再計算しました。`);

  // --- data/blockReachability.json 再生成(tools/data_generator.pyのgenerate_block_reachabilityと同ロジック) ---
  const blockSizeDeg = 0.5;
  const allLatLngs = [...placesDoc.places.map((p) => [p.lat, p.lng]), ...nodes.map((n) => [n.lat, n.lng])];
  const blocks = new Map();
  for (const [lat, lng] of allLatLngs) {
    const bx = Math.floor(lat / blockSizeDeg) * blockSizeDeg;
    const by = Math.floor(lng / blockSizeDeg) * blockSizeDeg;
    blocks.set(`${bx}_${by}`, blocks.get(`${bx}_${by}`) || new Set());
  }
  for (const key of blocks.keys()) {
    const [bx, by] = key.split('_').map(Number);
    for (const dx of [-blockSizeDeg, 0, blockSizeDeg]) {
      for (const dy of [-blockSizeDeg, 0, blockSizeDeg]) {
        if (dx === 0 && dy === 0) continue;
        const nk = `${bx + dx}_${by + dy}`;
        if (blocks.has(nk)) blocks.get(key).add(nk);
      }
    }
  }
  const blockReach = { blocks: {} };
  for (const [k, v] of [...blocks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    blockReach.blocks[k] = { neighbors: [...v].sort() };
  }
  fs.writeFileSync(path.join(DATA_DIR, 'blockReachability.json'), JSON.stringify(blockReach, null, 2), 'utf-8');
  console.log(`blockReachability.json: ${Object.keys(blockReach.blocks).length}ブロックを再生成しました。`);

  console.log('完了。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
