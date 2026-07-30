// data-utils.js — データ読み込み後の後処理(DOM/fetchに依存しない純粋ロジック)。
// main.js(ブラウザ)とtests/(Node)の両方から同じ実装を使うために分離してある。

// stations.jsonのconnectionsは片方向のみ定義されているため、
// 起動時に一度だけ逆方向の接続を補完する(通常は双方向に移動できるため)。
function ensureReciprocalConnections(stations) {
  const byId = new Map(stations.map(s => [s.id, s]));
  const originalEdges = [];
  stations.forEach(s => s.connections.forEach(c => originalEdges.push({ from: s.id, ...c })));
  originalEdges.forEach(edge => {
    const target = byId.get(edge.toId);
    if (!target) return;
    const hasReverse = target.connections.some(c => c.toId === edge.from && c.mode === edge.mode && c.cost === edge.cost);
    if (!hasReverse) {
      target.connections.push({ toId: edge.from, mode: edge.mode, requiresTransport: edge.requiresTransport, cost: edge.cost, isBudget: !!edge.isBudget });
    }
  });
}

window.DataUtils = { ensureReciprocalConnections };
