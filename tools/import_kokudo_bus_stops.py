#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""国土数値情報 高速バス停留所データ(P36-23、全国47都道府県)を data/busStops.json に
書き出す。

重要: このデータは data/places.json / data/stations.json のいずれにも統合しない。
ユーザーの明示的な指示により、バスという移動手段は js/game.js / js/movement.js の
移動ロジックに一切組み込まない(将来のバス移動手段追加に備えたデータとして
独立ファイルに保存するのみ)。data/busStops.json は現状ゲームのどこからも
読み込まれない。

出典: 高速バス停留所(P36) https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P36.html

フィールド:
  P36_001 = 停留所名
  P36_002 = 事業者名(カンマ・読点区切りで複数を含む場合あり)
  P36_003_01〜_17 = 経由路線名(空文字多数、複数路線が停車する場合に複数列)
  座標 = shapeのポイント座標

出力フォーマット:
    {"stops": [{"id":..., "name":..., "lat":..., "lng":..., "prefecture":...,
                 "operators": [...], "routes": [...]}]}

使い方:
    python3 tools/import_kokudo_bus_stops.py [--p36-zip PATH] [--out data/busStops.json]
"""

import argparse
import json
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRATCH = Path('/tmp/claude-0/-home-user-journey-home-japan/f5e3deee-8675-5cd8-9420-638b9be032f9/scratchpad')
DEFAULT_P36_ZIP = Path('/root/.claude/uploads/f5e3deee-8675-5cd8-9420-638b9be032f9/c1264099-P3623_SHP.zip')
DEFAULT_P36_PREPARED = SCRATCH / 'p3623' / 'P36-23_SHP'
DEFAULT_CACHE_DIR = REPO_ROOT / 'tools' / '.cache' / 'kokudo_bus_stops'

PREF_NAMES = {
    '01': '北海道', '02': '青森県', '03': '岩手県', '04': '宮城県', '05': '秋田県',
    '06': '山形県', '07': '福島県', '08': '茨城県', '09': '栃木県', '10': '群馬県',
    '11': '埼玉県', '12': '千葉県', '13': '東京都', '14': '神奈川県', '15': '新潟県',
    '16': '富山県', '17': '石川県', '18': '福井県', '19': '山梨県', '20': '長野県',
    '21': '岐阜県', '22': '静岡県', '23': '愛知県', '24': '三重県', '25': '滋賀県',
    '26': '京都府', '27': '大阪府', '28': '兵庫県', '29': '奈良県', '30': '和歌山県',
    '31': '鳥取県', '32': '島根県', '33': '岡山県', '34': '広島県', '35': '山口県',
    '36': '徳島県', '37': '香川県', '38': '愛媛県', '39': '高知県', '40': '福岡県',
    '41': '佐賀県', '42': '長崎県', '43': '熊本県', '44': '大分県', '45': '宮崎県',
    '46': '鹿児島県', '47': '沖縄県',
}


def ensure_extracted(zip_path, cache_dir):
    marker = cache_dir / '.done'
    if marker.exists():
        return cache_dir
    if not zip_path or not zip_path.exists():
        raise SystemExit(f'展開済みキャッシュが無く、ZIPも見つかりません: {zip_path}')
    cache_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(cache_dir)
    marker.write_text('ok', encoding='utf-8')
    return cache_dir


def find_dir(prepared_dir, zip_path, cache_dir):
    if prepared_dir and Path(prepared_dir).exists():
        return Path(prepared_dir)
    return ensure_extracted(zip_path, cache_dir)


def load_pref_stops(shp_path, pref_name):
    import shapefile
    r = shapefile.Reader(str(shp_path).rsplit('.', 1)[0], encoding='cp932')
    stops = []
    route_cols = [f'P36_003_{i:02d}' for i in range(1, 18)]
    op_col = 'P36_002'
    for sr in r.shapeRecords():
        rec = sr.record.as_dict()
        name = (rec.get('P36_001') or '').strip()
        if not name or not sr.shape.points:
            continue
        lng, lat = sr.shape.points[0][0], sr.shape.points[0][1]
        operators_raw = (rec.get(op_col) or '').strip()
        operators = [o.strip() for o in operators_raw.replace('、', ',').split(',') if o.strip()]
        routes = []
        for col in route_cols:
            val = (rec.get(col) or '').strip()
            if not val:
                continue
            # 同一セルにカンマ区切りで複数路線名が入っている場合があるため分割する
            for r_name in val.split(','):
                r_name = r_name.strip()
                if r_name and r_name not in routes:
                    routes.append(r_name)
        stops.append({
            'name': name, 'lat': lat, 'lng': lng, 'prefecture': pref_name,
            'operators': operators, 'routes': routes,
        })
    return stops


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--p36-zip', type=Path, default=DEFAULT_P36_ZIP)
    parser.add_argument('--p36-prepared', type=Path, default=DEFAULT_P36_PREPARED)
    parser.add_argument('--cache-dir', type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument('--out', default='data/busStops.json')
    args = parser.parse_args()

    p36_dir = find_dir(args.p36_prepared, args.p36_zip, args.cache_dir)

    all_stops = []
    next_id = 1
    for pref_code, pref_name in sorted(PREF_NAMES.items()):
        candidates = list(p36_dir.rglob(f'P36-23_{pref_code}.shp'))
        if not candidates:
            print(f'[警告] P36-23_{pref_code}.shp が見つかりません({pref_name})', file=sys.stderr)
            continue
        stops = load_pref_stops(candidates[0], pref_name)
        for s in stops:
            all_stops.append({
                'id': next_id,
                'name': s['name'],
                'lat': round(s['lat'], 6),
                'lng': round(s['lng'], 6),
                'prefecture': s['prefecture'],
                'operators': s['operators'],
                'routes': s['routes'],
            })
            next_id += 1
        print(f'[{pref_name}] {len(stops)}件')

    print(f'合計: {len(all_stops)}件')

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({
            'comment': (
                '国土数値情報 高速バス停留所データ(P36-23)。ゲームロジックには未統合'
                '(バス移動手段は未実装)。将来のバス移動手段追加に備えたデータ。'
                'docs/HANDOFF.md 参照。'
            ),
            'stops': all_stops,
        }, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    print(f'書き出し完了: {out_path} ({len(all_stops)}件)')


if __name__ == '__main__':
    main()
