#!/usr/bin/env python3
"""data/*.json のスキーマ・孤立防止ルール検証(ネットワーク不要)。

以下を検証する:
  1. 必須フィールドの有無・型・discoveryScoreの範囲(0-100)
  2. 各観光地点(place)のnearestStationIdが実在の駅/空港/港を指しているか
  3. 交通ノード(station)のグラフが単一の連結成分になっているか(§5.1 孤立防止)
     (stations.jsonのconnectionsは片方向定義のため、main.jsと同じロジックで
      逆方向接続を補ってから判定する)
  4. requiresTransport=['flight'] のみで隔てられた区間(単一障害点)に、
     isBudget:trueの接続が最低1本存在するか(§7.1.1 詰み防止)

使い方:
    python3 tools/validate_data.py --data data
"""

import argparse
import json
import sys
from pathlib import Path

from data_generator import UnionFind, is_bridge_edge, REQUIRED_PLACE_FIELDS, REQUIRED_STATION_FIELDS


def load_data(data_dir):
    data_dir = Path(data_dir)
    places = json.loads((data_dir / 'places.json').read_text(encoding='utf-8'))['places']
    stations = json.loads((data_dir / 'stations.json').read_text(encoding='utf-8'))['nodes']
    return places, stations


def ensure_reciprocal_connections(stations):
    """main.js の ensureReciprocalConnections と同一ロジック(Python版)。"""
    by_id = {s['id']: s for s in stations}
    original_edges = [{'from': s['id'], **c} for s in stations for c in s['connections']]
    for edge in original_edges:
        target = by_id.get(edge['toId'])
        if target is None:
            continue
        has_reverse = any(
            c['toId'] == edge['from'] and c['mode'] == edge['mode'] and c['cost'] == edge['cost']
            for c in target['connections']
        )
        if not has_reverse:
            target['connections'].append({
                'toId': edge['from'], 'mode': edge['mode'], 'requiresTransport': edge['requiresTransport'],
                'cost': edge['cost'], **({'isBudget': True} if edge.get('isBudget') else {}),
            })


def check_schema(places, stations):
    errors = []
    for p in places:
        missing = REQUIRED_PLACE_FIELDS - p.keys()
        if missing:
            errors.append(f"place {p.get('id')} ({p.get('name')}): missing fields {missing}")
        score = p.get('discoveryScore')
        if not isinstance(score, (int, float)) or not (0 <= score <= 100):
            errors.append(f"place {p.get('id')} ({p.get('name')}): discoveryScore out of range: {score}")
    for s in stations:
        missing = REQUIRED_STATION_FIELDS - s.keys()
        if missing:
            errors.append(f"station {s.get('id')} ({s.get('name')}): missing fields {missing}")
        score = s.get('discoveryScore')
        if not isinstance(score, (int, float)) or not (0 <= score <= 100):
            errors.append(f"station {s.get('id')} ({s.get('name')}): discoveryScore out of range: {score}")
    return errors


def check_nearest_station_coverage(places, stations):
    station_ids = {s['id'] for s in stations}
    errors = []
    for p in places:
        if p.get('nearestStationId') not in station_ids:
            errors.append(f"place {p['id']} ({p['name']}): nearestStationId {p.get('nearestStationId')} が stations に存在しません")
    return errors


def check_connectivity(stations):
    station_ids = [s['id'] for s in stations]
    uf = UnionFind(station_ids)
    for s in stations:
        for c in s['connections']:
            if c['toId'] in uf.parent:
                uf.union(s['id'], c['toId'])
    components = uf.components()
    if len(components) <= 1:
        return [], components
    by_id = {s['id']: s for s in stations}
    errors = [f'交通ネットワークが {len(components)} 個の連結成分に分断されています:']
    for comp in components:
        names = ', '.join(by_id[i]['name'] for i in comp[:5])
        suffix = ' ...' if len(comp) > 5 else ''
        errors.append(f'  - ({len(comp)}件) {names}{suffix}')
    return errors, components


def check_budget_flight_coverage(stations):
    station_ids = [s['id'] for s in stations]
    edges = []
    for s in stations:
        for c in s['connections']:
            edges.append({'fromId': s['id'], 'toId': c['toId'], 'mode': c['mode'],
                          'requiresTransport': c['requiresTransport'], 'cost': c['cost'], 'isBudget': c.get('isBudget', False)})

    errors = []
    flight_only_edges = [e for e in edges if e['mode'] == 'flight' and e['requiresTransport'] == ['flight'] and not e['isBudget']]
    by_id = {s['id']: s for s in stations}
    checked_pairs = set()
    for e in flight_only_edges:
        pair = frozenset({e['fromId'], e['toId']})
        if pair in checked_pairs:
            continue
        checked_pairs.add(pair)
        has_budget = any(o['isBudget'] and {o['fromId'], o['toId']} == {e['fromId'], e['toId']} for o in edges)
        if has_budget:
            continue  # 既に格安便があるので、この対の単一障害点性は問題にならない
        if not is_bridge_edge(edges, station_ids, e):
            continue  # 単一障害点でなければ(=他の経路がある)、格安便必須ルールの対象外
        a, b = by_id[e['fromId']]['name'], by_id[e['toId']]['name']
        errors.append(f'§7.1.1違反: {a} <-> {b} はflightのみで隔てられた単一障害点だが、isBudget便が存在しません')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--data', default='data', help='data/*.json のあるディレクトリ')
    args = parser.parse_args()

    places, stations = load_data(args.data)
    ensure_reciprocal_connections(stations)

    all_errors = []
    all_errors += check_schema(places, stations)
    all_errors += check_nearest_station_coverage(places, stations)

    connectivity_errors, _ = check_connectivity(stations)
    all_errors += connectivity_errors

    all_errors += check_budget_flight_coverage(stations)

    if all_errors:
        print(f'FAIL: {len(all_errors)} 件の問題が見つかりました\n')
        for e in all_errors:
            print(f'  - {e}')
        sys.exit(1)

    print(f'PASS: places={len(places)}件, stations={len(stations)}件 — スキーマ・孤立防止ルールともに問題なし')


if __name__ == '__main__':
    main()
