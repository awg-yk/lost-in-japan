#!/usr/bin/env python3
"""data_generator.py の純粋ロジック関数に対するユニットテスト(ネットワーク不要)。

実行方法:
    python3 -m unittest tools.test_data_generator -v
    (リポジトリルートから実行する場合)
    または
    cd tools && python3 -m unittest test_data_generator -v
"""

import random
import unittest

from data_generator import (
    UnionFind,
    bridge_disconnected_components,
    compute_discovery_score,
    ensure_budget_flight_edges,
    ensure_place_station_coverage,
    grid_key,
    is_bridge_edge,
    merge_new_places,
)


class FixedRng:
    """discoveryScoreのランダム補正を固定値にして再現性を確保するテスト用スタブ。"""
    def uniform(self, a, b):
        return 0.0


class GridKeyTests(unittest.TestCase):
    def test_rounds_down_to_one_decimal(self):
        self.assertEqual(grid_key(32.806, 130.706), '32.8_130.7')

    def test_handles_exact_tenths(self):
        self.assertEqual(grid_key(35.5, 139.7), '35.5_139.7')


class DiscoveryScoreTests(unittest.TestCase):
    def test_no_wikipedia_gets_max_fame_bonus(self):
        # 東京(主要都市)そばで、Wikipedia記事なし
        score = compute_discovery_score('local_spot', has_wikipedia=False, wikipedia_length=0,
                                         lat=35.68, lng=139.77, osm_tag_count=3, has_image_tag=False, rng=FixedRng())
        # base(70) + fame(+30) + geo(~0) = 100 → クランプ
        self.assertEqual(score, 100)

    def test_famous_wikipedia_article_reduces_score(self):
        score = compute_discovery_score('castle', has_wikipedia=True, wikipedia_length=20000,
                                         lat=35.68, lng=139.77, osm_tag_count=3, has_image_tag=False, rng=FixedRng())
        # base(15) + fame(-30 clamp) + geo(~0) = 0以下 → クランプ
        self.assertEqual(score, 0)

    def test_score_is_clamped_to_0_100(self):
        score = compute_discovery_score('local_facility', has_wikipedia=False, wikipedia_length=0,
                                         lat=45.5, lng=141.9, osm_tag_count=0, has_image_tag=False, rng=FixedRng())
        self.assertGreaterEqual(score, 0)
        self.assertLessEqual(score, 100)

    def test_remote_location_scores_higher_than_near_major_city(self):
        near = compute_discovery_score('park', True, 5000, lat=35.68, lng=139.77, osm_tag_count=3, has_image_tag=False, rng=FixedRng())
        far = compute_discovery_score('park', True, 5000, lat=45.5, lng=141.9, osm_tag_count=3, has_image_tag=False, rng=FixedRng())
        self.assertGreater(far, near)


class UnionFindTests(unittest.TestCase):
    def test_starts_fully_disconnected(self):
        uf = UnionFind([1, 2, 3])
        self.assertEqual(len(uf.components()), 3)

    def test_union_merges_components(self):
        uf = UnionFind([1, 2, 3])
        uf.union(1, 2)
        components = uf.components()
        self.assertEqual(len(components), 2)
        self.assertTrue(any(set(c) == {1, 2} for c in components))


class BridgeDisconnectedComponentsTests(unittest.TestCase):
    def test_bridges_two_isolated_clusters(self):
        stations = {
            1: {'lat': 35.0, 'lng': 135.0}, 2: {'lat': 35.01, 'lng': 135.01},
            3: {'lat': 40.0, 'lng': 140.0}, 4: {'lat': 40.01, 'lng': 140.01},
        }
        edges = [
            {'fromId': 1, 'toId': 2, 'mode': 'rail', 'requiresTransport': [], 'cost': 500},
            {'fromId': 3, 'toId': 4, 'mode': 'rail', 'requiresTransport': [], 'cost': 500},
        ]
        added = bridge_disconnected_components(stations, edges)
        self.assertEqual(len(added), 1)

        uf = UnionFind(list(stations.keys()))
        for e in edges:
            uf.union(e['fromId'], e['toId'])
        self.assertEqual(len(uf.components()), 1)

    def test_no_bridge_needed_if_already_connected(self):
        stations = {1: {'lat': 35.0, 'lng': 135.0}, 2: {'lat': 35.01, 'lng': 135.01}}
        edges = [{'fromId': 1, 'toId': 2, 'mode': 'rail', 'requiresTransport': [], 'cost': 500}]
        added = bridge_disconnected_components(stations, edges)
        self.assertEqual(added, [])


class IsBridgeEdgeTests(unittest.TestCase):
    def test_sole_connector_is_a_bridge(self):
        # 1 - 2 - 3 という一本道: 2-3間のedgeを除くと3が孤立する
        edges = [
            {'fromId': 1, 'toId': 2, 'mode': 'rail', 'requiresTransport': []},
            {'fromId': 2, 'toId': 3, 'mode': 'flight', 'requiresTransport': ['flight']},
        ]
        self.assertTrue(is_bridge_edge(edges, [1, 2, 3], edges[1]))

    def test_redundant_path_is_not_a_bridge(self):
        # 1-2, 2-3, 1-3 の三角形: どの辺を除いても連結性は保たれる
        edges = [
            {'fromId': 1, 'toId': 2, 'mode': 'rail', 'requiresTransport': []},
            {'fromId': 2, 'toId': 3, 'mode': 'flight', 'requiresTransport': ['flight']},
            {'fromId': 1, 'toId': 3, 'mode': 'ferry', 'requiresTransport': ['ferry']},
        ]
        self.assertFalse(is_bridge_edge(edges, [1, 2, 3], edges[1]))

    def test_bidirectional_duplicate_edges_do_not_mask_a_bridge(self):
        # 生成パイプラインは双方向接続を2本の有向edgeとして保持するため、
        # 逆方向の複製edgeが残っていても正しくbridgeと判定できるべき(実際に見つけたバグの回帰テスト)。
        edges = [
            {'fromId': 1, 'toId': 2, 'mode': 'flight', 'requiresTransport': ['flight']},
            {'fromId': 2, 'toId': 1, 'mode': 'flight', 'requiresTransport': ['flight']},
        ]
        self.assertTrue(is_bridge_edge(edges, [1, 2], edges[0]))


class EnsureBudgetFlightEdgesTests(unittest.TestCase):
    def test_adds_budget_flight_for_flight_only_bridge(self):
        stations = {1: {'lat': 35.0, 'lng': 135.0}, 2: {'lat': 26.0, 'lng': 127.0}}
        edges = [{'fromId': 1, 'toId': 2, 'mode': 'flight', 'requiresTransport': ['flight'], 'cost': 20000}]
        added = ensure_budget_flight_edges(stations, edges)
        self.assertEqual(len(added), 1)
        self.assertTrue(added[0]['isBudget'])

    def test_does_not_duplicate_existing_budget_flight(self):
        stations = {1: {'lat': 35.0, 'lng': 135.0}, 2: {'lat': 26.0, 'lng': 127.0}}
        edges = [
            {'fromId': 1, 'toId': 2, 'mode': 'flight', 'requiresTransport': ['flight'], 'cost': 20000},
            {'fromId': 1, 'toId': 2, 'mode': 'flight', 'requiresTransport': ['flight'], 'cost': 6000, 'isBudget': True},
        ]
        added = ensure_budget_flight_edges(stations, edges)
        self.assertEqual(added, [])

    def test_no_budget_flight_needed_when_ferry_alternative_exists(self):
        stations = {1: {'lat': 35.0, 'lng': 135.0}, 2: {'lat': 26.0, 'lng': 127.0}}
        edges = [
            {'fromId': 1, 'toId': 2, 'mode': 'flight', 'requiresTransport': ['flight'], 'cost': 20000},
            {'fromId': 1, 'toId': 2, 'mode': 'ferry', 'requiresTransport': ['ferry'], 'cost': 9000},
        ]
        added = ensure_budget_flight_edges(stations, edges)
        self.assertEqual(added, [])


class EnsurePlaceStationCoverageTests(unittest.TestCase):
    def test_assigns_nearest_station(self):
        places = [{'name': 'テスト地点', 'lat': 35.001, 'lng': 135.001}]
        stations = {1: {'lat': 35.0, 'lng': 135.0}, 2: {'lat': 40.0, 'lng': 140.0}}
        warnings = ensure_place_station_coverage(places, stations)
        self.assertEqual(places[0]['nearestStationId'], 1)
        self.assertEqual(warnings, [])

    def test_warns_when_nearest_station_is_far(self):
        places = [{'name': '離島の地点', 'lat': 24.0, 'lng': 123.0}]
        stations = {1: {'name': 'テスト駅', 'lat': 35.0, 'lng': 135.0}}
        warnings = ensure_place_station_coverage(places, stations, max_distance_km=60)
        self.assertEqual(len(warnings), 1)


class MergeNewPlacesTests(unittest.TestCase):
    """2026-07-30追加: --places-only モード(観光名所だけを既存データにマージする)の
    重複除外ロジックを検証する。"""

    def test_new_place_is_added(self):
        existing = [{'id': 101, 'name': '既存地点', 'lat': 35.0, 'lng': 135.0}]
        new = [{'id': 999001, 'name': '新規地点', 'lat': 40.0, 'lng': 140.0}]
        merged, added, skipped = merge_new_places(new, existing)
        self.assertEqual(added, 1)
        self.assertEqual(skipped, 0)
        self.assertEqual(len(merged), 2)

    def test_same_name_is_treated_as_duplicate(self):
        existing = [{'id': 101, 'name': '清水寺', 'lat': 34.9948, 'lng': 135.7847}]
        new = [{'id': 999001, 'name': '清水寺', 'lat': 34.9950, 'lng': 135.7850}]
        merged, added, skipped = merge_new_places(new, existing)
        self.assertEqual(added, 0)
        self.assertEqual(skipped, 1)
        self.assertEqual(len(merged), 1)

    def test_nearby_different_name_is_treated_as_duplicate(self):
        # 既存地点からmin_distance_km未満に位置する候補は、別名でも同一地点とみなす
        # (Overpassのタグ表記揺れ等で同じ場所が別名候補として出てくる場合に対応)。
        existing = [{'id': 101, 'name': '清水寺', 'lat': 35.0, 'lng': 135.0}]
        new = [{'id': 999001, 'name': '清水寺(本堂)', 'lat': 35.0005, 'lng': 135.0005}]
        merged, added, skipped = merge_new_places(new, existing, min_distance_km=0.3)
        self.assertEqual(added, 0)
        self.assertEqual(skipped, 1)

    def test_far_enough_different_name_is_added(self):
        existing = [{'id': 101, 'name': '清水寺', 'lat': 35.0, 'lng': 135.0}]
        new = [{'id': 999001, 'name': '伏見稲荷大社', 'lat': 35.05, 'lng': 135.05}]
        merged, added, skipped = merge_new_places(new, existing, min_distance_km=0.3)
        self.assertEqual(added, 1)
        self.assertEqual(skipped, 0)

    def test_id_collision_with_existing_manual_data_is_skipped(self):
        # 既存の手動データ(id 101〜134)とOSMの生idが万一衝突した場合の安全策。
        existing = [{'id': 132, 'name': '熊本城', 'lat': 32.8065, 'lng': 130.7055}]
        new = [{'id': 132, 'name': '別の何か(id衝突)', 'lat': 10.0, 'lng': 10.0}]
        merged, added, skipped = merge_new_places(new, existing)
        self.assertEqual(added, 0)
        self.assertEqual(skipped, 1)
        self.assertEqual(len(merged), 1)


if __name__ == '__main__':
    unittest.main()
