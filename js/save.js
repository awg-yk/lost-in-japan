// save.js — LocalStorage読み書き(§8)
// 地点データ自体(places.json等)は保存しない。IDと状態のみを保存する。

const SAVE_KEY = 'journeyHomeJapan_save_v1';

const Save = {
  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data.currentPlaceId === 'undefined') return null;
      return data;
    } catch (err) {
      console.warn('セーブデータの読み込みに失敗しました', err);
      return null;
    }
  },

  write(state) {
    const data = {
      currentPlaceId: state.currentNodeId,
      currentPlaceType: state.currentNodeType,
      destinationId: state.destinationId,
      money: state.money,
      visitedIds: state.visitedIds,
      discoveredIds: state.discoveredIds,
      moveHistory: state.moveHistory,
      playTimeSec: state.playTimeSec,
      hunger: state.hunger,
      thirst: state.thirst,
      totalDistanceKm: state.totalDistanceKm,
      workedIds: state.workedIds,
      startId: state.startId,
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (err) {
      console.warn('セーブに失敗しました', err);
    }
  },

  clear() {
    localStorage.removeItem(SAVE_KEY);
  },
};

window.Save = Save;
