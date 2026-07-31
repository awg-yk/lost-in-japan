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

  // --- 駅サガース風「最寄り駅ボロノイ」表示(§追加要件) ---
  // data/voronoiData.json は全国8971駅分(約1.7MB)のポリゴンを含むため、
  // 常時全件描画するとLeafletの描画が非常に重くなる。そのため:
  //   1. データ本体はトグルON時に一度だけ遅延fetchする(初期ロードを圧迫しない)。
  //   2. 描画はLeafletのcanvasレンダラーを使い、DOM要素を増やさない。
  //   3. 現在の地図表示範囲(bounds)に交差するポリゴンのみを都度描画し、
  //      さらにズームレベルが低い(=広域表示で1画面に大量の駅が入る)場合は
  //      「ボロノイは閉じるまで待つ」ことで無駄な大量描画を避ける。
  voronoiData: null,
  voronoiLoading: null,
  voronoiEnabled: false,
  voronoiLayer: null,
  voronoiRenderer: null,
  voronoiMoveHandler: null,
  stationsById: null,
  MIN_VORONOI_ZOOM: 9,
  MAX_VORONOI_POLYGONS: 600,

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
    this.voronoiRenderer = L.canvas({ padding: 0.2 });
  },

  // ゲームデータ側の駅リストを渡しておく(voronoiData.jsonにはid->座標配列しか
  // 無いため、境界矩形での粗いカリングにstations.jsonの緯度経度を併用する)。
  setStations(stationsById) {
    this.stationsById = stationsById;
  },

  async loadVoronoiData() {
    if (this.voronoiData) return this.voronoiData;
    if (!this.voronoiLoading) {
      this.voronoiLoading = fetch('data/voronoiData.json')
        .then((res) => res.json())
        .then((json) => { this.voronoiData = json; return json; })
        .catch((err) => { this.voronoiLoading = null; throw err; });
    }
    return this.voronoiLoading;
  },

  async toggleVoronoi() {
    this.voronoiEnabled = !this.voronoiEnabled;
    const btn = document.getElementById('fab-voronoi');
    if (this.voronoiEnabled) {
      if (btn) btn.classList.add('active');
      await this.loadVoronoiData();
      if (!this.voronoiLayer) this.voronoiLayer = L.layerGroup().addTo(this.map);
      this.renderVisibleVoronoi();
      if (!this.voronoiMoveHandler) {
        this.voronoiMoveHandler = () => this.renderVisibleVoronoi();
        this.map.on('moveend zoomend', this.voronoiMoveHandler);
      }
    } else {
      if (btn) btn.classList.remove('active');
      if (this.voronoiLayer) this.voronoiLayer.clearLayers();
    }
  },

  // 現在の表示範囲に入っている駅のボロノイ領域だけを描く。
  // ズームが低すぎる(広域)場合や該当駅が多すぎる場合は、視認性・性能のため
  // 描画をスキップしてトーストではなくボタン状態のみで静かに知らせる。
  renderVisibleVoronoi() {
    if (!this.voronoiEnabled || !this.voronoiLayer || !this.voronoiData) return;
    this.voronoiLayer.clearLayers();
    if (this.map.getZoom() < this.MIN_VORONOI_ZOOM) return;

    const bounds = this.map.getBounds().pad(0.15);
    let ids;
    if (this.stationsById) {
      ids = [];
      for (const [id, node] of this.stationsById) {
        if (node.type !== 'station') continue;
        if (bounds.contains([node.lat, node.lng])) ids.push(id);
        if (ids.length > this.MAX_VORONOI_POLYGONS) break;
      }
    } else {
      ids = Object.keys(this.voronoiData).map(Number);
    }

    let count = 0;
    for (const id of ids) {
      if (count >= this.MAX_VORONOI_POLYGONS) break;
      const geom = this.voronoiData[id];
      if (!geom) continue;
      const latlngs = geom.coordinates.map((ring) => ring.map(([lng, lat]) => [lat, lng]));
      L.polygon(latlngs, {
        renderer: this.voronoiRenderer,
        color: '#1E90FF', weight: 1, opacity: 0.55,
        fillColor: '#1E90FF', fillOpacity: 0.06,
        interactive: false,
      }).addTo(this.voronoiLayer);
      count++;
    }
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
