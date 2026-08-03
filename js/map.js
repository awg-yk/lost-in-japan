// map.js — Leaflet地図描画、ノード/ルート表示

const TYPE_ICONS = {
  castle: '🏯', shrine: '⛩️', temple: '🛕', world_heritage: '🏛️', viewpoint: '🌄',
  park: '🌳', onsen: '♨️', museum: '🖼️', art_museum: '🖼️', michinoeki: '🅿️',
  scenic_spot: '📸', waterfall: '💦', dam: '🚧', port_town: '⚓', local_spot: '📍',
  city_hall: '🏢', famous_facility: '⭐', local_facility: '🏚️',
  station: '🚉', airport: '✈️', port: '⛴️',
};

function iconFor(type, size) {
  const emoji = TYPE_ICONS[type] || '📍';
  return L.divIcon({
    className: '', html: `<div style="font-size:${size}px;line-height:${size}px;">${emoji}</div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size],
  });
}

const MapView = {
  map: null,
  visitedLayer: null,
  currentMarker: null,
  destinationMarker: null,
  routeLayer: null,
  previewLayer: null,
  candidateLayer: null,

  init() {
    this.map = L.map('map', { zoomControl: true, attributionControl: true }).setView([36.5, 138.0], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(this.map);
    this.visitedLayer = L.layerGroup().addTo(this.map);
    this.routeLayer = L.layerGroup().addTo(this.map);
    // 候補カードにカーソルを合わせた際、現在地→候補地の直線と候補地点を
    // 一時的に強調表示するための専用レイヤー(routeLayerとは別に管理し、
    // 到着後のルート表示と競合しないようにする)。
    this.previewLayer = L.layerGroup().addTo(this.map);
    // 移動候補そのものを地図上のマーカーとして表示するレイヤー
    // (2026-08-03、ユーザー指示。下部の候補カード一覧から、地図をクリックして
    // 移動する方式に変更した際に追加)。
    this.candidateLayer = L.layerGroup().addTo(this.map);
  },

  // 現在地→候補地の直線だけを描く軽量版(candidateマーカー自体は既に
  // candidateLayerに出ているため、showCandidatePreviewと違って先端の
  // パルスマーカーは重ねて描かない)。
  previewLine(fromNode, toNode) {
    this.previewLayer.clearLayers();
    L.polyline([[fromNode.lat, fromNode.lng], [toNode.lat, toNode.lng]], {
      color: '#1E90FF', weight: 4, opacity: 0.9, dashArray: '2, 10', lineCap: 'round',
      interactive: false,
    }).addTo(this.previewLayer);
  },

  // 移動候補を地図上のクリック可能なマーカーとして描画する。
  // items: [{ candidate, node, emoji, tooltipHtml }]
  // ホバー(mouseover)で現在地からの直線とツールチップを表示し、
  // クリックでonClick(candidate)を呼ぶ(2026-08-03、ユーザー指示: 下部の
  // 候補カード一覧をやめ、観光地・駅を地図上に表示してクリックで移動する形式にした)。
  renderCandidateMarkers(items, currentNode, onClick) {
    this.candidateLayer.clearLayers();

    // 候補全体(+現在地)が画面内に収まるようにパン/ズームする。上部のHUD
    // (position:absolute、地図の上に被さる)や下部の候補パネルにマーカーが
    // 隠れてクリックできなくなるのを防ぐため、それらの高さ分だけ余白を
    // 大きく取る(showCandidatePreviewと同じ考え方)。
    if (items.length > 0) {
      const points = [[currentNode.lat, currentNode.lng], ...items.map(({ node }) => [node.lat, node.lng])];
      const bounds = L.latLngBounds(points);
      const mapSize = this.map.getSize();
      this.map.flyToBounds(bounds, {
        paddingTopLeft: [24, 90],
        paddingBottomRight: [24, Math.round(mapSize.y * 0.42)],
        maxZoom: 13,
        duration: 0.35,
      });
    }

    for (const { candidate, node, emoji, tooltipHtml } of items) {
      const size = candidate.isNew ? 30 : 24;
      const marker = L.marker([node.lat, node.lng], {
        icon: L.divIcon({
          className: 'candidate-map-marker' + (candidate.isNew ? ' candidate-map-marker--new' : ''),
          html: `<div style="font-size:${size}px;line-height:${size}px;">${emoji}</div>`,
          iconSize: [size, size], iconAnchor: [size / 2, size / 2],
        }),
      });
      marker.bindTooltip(tooltipHtml, { direction: 'top', offset: [0, -size / 2], opacity: 0.97 });
      marker.on('mouseover', () => this.previewLine(currentNode, node));
      marker.on('mouseout', () => this.previewLayer.clearLayers());
      marker.on('click', () => onClick(candidate));
      marker.addTo(this.candidateLayer);
    }
  },

  clearCandidateMarkers() {
    if (this.candidateLayer) this.candidateLayer.clearLayers();
    if (this.previewLayer) this.previewLayer.clearLayers();
  },

  // 現在地から候補地までの直線と、候補地点そのものを目立つ見た目で表示する。
  // ホバーのたびに呼ばれる想定なので、まず前回分をクリアしてから描画する。
  // 鉄道・飛行機等の候補は現在の表示範囲から大きく外れていることが多いため、
  // 両地点が収まるように地図を軽くパン/ズームする(候補パネルに隠れないよう
  // 下側に余白を多めに取る)。
  showCandidatePreview(fromNode, toNode) {
    this.previewLayer.clearLayers();
    L.polyline([[fromNode.lat, fromNode.lng], [toNode.lat, toNode.lng]], {
      color: '#1E90FF', weight: 5, opacity: 0.95, dashArray: '2, 10', lineCap: 'round',
    }).addTo(this.previewLayer);
    L.marker([toNode.lat, toNode.lng], {
      icon: L.divIcon({ className: 'candidate-preview-marker', html: '<div class="candidate-preview-pulse"></div>', iconSize: [34, 34], iconAnchor: [17, 17] }),
      interactive: false,
    }).addTo(this.previewLayer);

    const bounds = L.latLngBounds([[fromNode.lat, fromNode.lng], [toNode.lat, toNode.lng]]);
    const mapSize = this.map.getSize();
    this.map.flyToBounds(bounds, {
      paddingTopLeft: [24, 90],
      paddingBottomRight: [24, Math.round(mapSize.y * 0.42)],
      maxZoom: 13,
      duration: 0.35,
    });
  },

  clearCandidatePreview() {
    if (this.previewLayer) this.previewLayer.clearLayers();
  },

  setDestination(node) {
    if (this.destinationMarker) this.map.removeLayer(this.destinationMarker);
    this.destinationMarker = L.marker([node.lat, node.lng], { icon: iconFor(node.type, 26) })
      .bindTooltip(`🏁 目的地: ${node.name}`, { permanent: false })
      .addTo(this.map);
  },

  setCurrent(node, focus) {
    if (this.currentMarker) this.map.removeLayer(this.currentMarker);
    this.currentMarker = L.marker([node.lat, node.lng], {
      icon: L.divIcon({ className: '', html: '<div style="font-size:28px;line-height:28px;">🚶</div>', iconSize: [28, 28], iconAnchor: [14, 28] }),
    }).bindTooltip(node.name, { permanent: false }).addTo(this.map);
    if (focus) this.map.setView([node.lat, node.lng], Math.max(this.map.getZoom(), 6));
  },

  // 観光名所到着時、そのピン(現在地マーカー)に公式ホームページへのリンクを
  // ポップアップとして表示する(2026-08-02、ユーザー指示。「その地点にピンを
  // 打って、そこに公式URLを表示」)。onLinkClickはポップアップのDOMが実際に
  // 挿入された後(Leafletのpopupopenイベント)でなければ要素が見つからないため、
  // イベント経由で毎回バインドし直す。
  bindCurrentPopup(html, onLinkClick) {
    if (!this.currentMarker) return;
    this.currentMarker.unbindPopup();
    this.currentMarker.bindPopup(html, { maxWidth: 240, autoClose: false, closeOnClick: false });
    this.currentMarker.on('popupopen', () => {
      const link = document.getElementById('map-official-site-link');
      if (link && onLinkClick) link.addEventListener('click', onLinkClick, { once: true });
    });
    this.currentMarker.openPopup();
  },

  markVisited(node, isNew) {
    const marker = L.marker([node.lat, node.lng], { icon: iconFor(node.type, isNew ? 20 : 16), opacity: isNew ? 1 : 0.6 })
      .bindTooltip(node.name, { permanent: false })
      .addTo(this.visitedLayer);
    return marker;
  },

  clearRoute() {
    this.routeLayer.clearLayers();
  },

  drawRoute(coords) {
    this.clearRoute();
    if (coords.length < 2) return;
    L.polyline(coords, { color: '#E8A33D', weight: 3, opacity: 0.8 }).addTo(this.routeLayer);
    this.map.fitBounds(L.latLngBounds(coords), { padding: [40, 40] });
  },
};

window.MapView = MapView;
window.iconFor = iconFor;
window.TYPE_ICONS = TYPE_ICONS;
