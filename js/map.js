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

  init() {
    this.map = L.map('map', { zoomControl: true, attributionControl: true }).setView([36.5, 138.0], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(this.map);
    this.visitedLayer = L.layerGroup().addTo(this.map);
    this.routeLayer = L.layerGroup().addTo(this.map);
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
