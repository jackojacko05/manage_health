from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class LocationSqlContractTests(unittest.TestCase):
    def assert_windowed_view_has_internal_partition_guard(
        self, relative: str, view_name: str, table_name: str
    ) -> None:
        text = (ROOT / relative).read_text(encoding="utf-8")
        match = re.search(
            rf"CREATE OR REPLACE VIEW `__PROJECT__\.health\.{view_name}` AS(.*?)"
            rf"ALTER VIEW `__PROJECT__\.health\.{view_name}`",
            text,
            flags=re.DOTALL,
        )
        self.assertIsNotNone(match, view_name)
        definition = match.group(1)
        self.assertIn(f"health.{table_name}", definition)
        self.assertRegex(
            definition,
            r"WHERE DATE\([^)]*captured_at\) BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'",
        )
        self.assertIn("ROW_NUMBER() OVER", definition)

    def test_location_event_view_has_internal_partition_guard(self) -> None:
        self.assert_windowed_view_has_internal_partition_guard(
            "sql/native-ddl.sql", "location_events_dedup", "location_events"
        )

    def test_location_transition_view_has_internal_partition_guard(self) -> None:
        self.assert_windowed_view_has_internal_partition_guard(
            "sql/location-ddl.sql",
            "location_transitions_dedup",
            "location_transitions",
        )


if __name__ == "__main__":
    unittest.main()
