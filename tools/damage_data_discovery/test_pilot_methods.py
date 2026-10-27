import unittest

from pilot_methods import (
    METHODS,
    estimate_attributable_outcomes,
    paired_source_removal,
    population_weighted_exposure,
    value_physical_outcome,
)
from provenance import one_way_sensitivity


class PilotMethodTests(unittest.TestCase):
    def test_paired_source_removal_keeps_signed_differences_and_versions(self):
        result = paired_source_removal(
            [
                {
                    "grid_cell_id": "cell-1",
                    "period_start": "2024-09-01",
                    "period_end": "2024-09-01",
                    "population_stratum": "all_ages",
                    "unit": "ug_m3",
                    "concentration_with_target_source": 20,
                    "concentration_with_target_source_removed": 12,
                },
                {
                    "grid_cell_id": "cell-2",
                    "period_start": "2024-09-01",
                    "period_end": "2024-09-01",
                    "population_stratum": "all_ages",
                    "unit": "ug_m3",
                    "concentration_with_target_source": 10,
                    "concentration_with_target_source_removed": 11,
                },
            ],
            model_name="reviewed-model",
            model_version="2024.1",
            configuration_reference="config-sha256:example",
        )
        self.assertEqual(result["method_id"], "fire.paired-source-removal.v1")
        self.assertEqual(
            [row["paired_source_contribution"] for row in result["records"]],
            [8, -1],
        )
        self.assertIn("not a fire", result["interpretation"])

    def test_paired_source_removal_rejects_duplicates_and_invalid_values(self):
        row = {
            "grid_cell_id": "cell-1",
            "period_start": "2024-09-01",
            "period_end": "2024-09-01",
            "population_stratum": "all_ages",
            "unit": "ug_m3",
            "concentration_with_target_source": 10,
            "concentration_with_target_source_removed": 8,
        }
        kwargs = {
            "model_name": "model",
            "model_version": "1",
            "configuration_reference": "config",
        }
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            paired_source_removal([row, row], **kwargs)
        bad_row = {**row, "concentration_with_target_source": -1}
        with self.assertRaisesRegex(ValueError, "at least 0"):
            paired_source_removal([bad_row], **kwargs)
        mismatched_unit_row = {**row, "grid_cell_id": "cell-2", "unit": "mg_m3"}
        with self.assertRaisesRegex(ValueError, "same unit"):
            paired_source_removal([row, mismatched_unit_row], **kwargs)

    def test_population_weighted_exposure_matches_hand_calculation(self):
        result = population_weighted_exposure(
            [
                {
                    "grid_cell_id": "a",
                    "period_start": "2024-09-01",
                    "period_end": "2024-09-30",
                    "population_stratum": "all_ages",
                    "unit": "ug_m3",
                    "population_count": 100,
                    "historical_concentration": 20,
                    "counterfactual_concentration": 10,
                },
                {
                    "grid_cell_id": "b",
                    "period_start": "2024-09-01",
                    "period_end": "2024-09-30",
                    "population_stratum": "all_ages",
                    "unit": "ug_m3",
                    "population_count": 300,
                    "historical_concentration": 12,
                    "counterfactual_concentration": 8,
                },
            ]
        )
        self.assertEqual(
            result["method_id"], "exposure.population-weighted-mean.v1"
        )
        self.assertEqual(result["historical_population_weighted_mean"], 14)
        self.assertEqual(result["counterfactual_population_weighted_mean"], 8.5)
        self.assertEqual(result["population_weighted_difference"], 5.5)

    def test_population_weighted_exposure_rejects_mismatched_scope(self):
        rows = [
            {
                "grid_cell_id": "a",
                "period_start": "2024-09-01",
                "period_end": "2024-09-30",
                "population_stratum": "all_ages",
                "unit": "ug_m3",
                "population_count": 10,
                "historical_concentration": 1,
                "counterfactual_concentration": 0,
            },
            {
                "grid_cell_id": "b",
                "period_start": "2024-10-01",
                "period_end": "2024-10-31",
                "population_stratum": "all_ages",
                "unit": "ug_m3",
                "population_count": 10,
                "historical_concentration": 1,
                "counterfactual_concentration": 0,
            },
        ]
        with self.assertRaisesRegex(ValueError, "same period"):
            population_weighted_exposure(rows)

    def test_population_weighted_exposure_rejects_zero_population(self):
        with self.assertRaisesRegex(ValueError, "greater than zero"):
            population_weighted_exposure(
                [
                    {
                        "grid_cell_id": "a",
                        "period_start": "2024-09-01",
                        "period_end": "2024-09-30",
                        "population_stratum": "all_ages",
                        "unit": "ug_m3",
                        "population_count": 0,
                        "historical_concentration": 10,
                        "counterfactual_concentration": 8,
                    }
                ]
            )

    def test_health_calculation_uses_declared_baseline_rate_and_relative_risk(self):
        result = estimate_attributable_outcomes(
            endpoint_id="respiratory_admissions",
            population_stratum="adults",
            baseline_rate_per_100k_person_year=100,
            population=100_000,
            duration_days=365.2425,
            relative_risk_event_vs_counterfactual=1.1,
            risk_function_reference="risk-fn-v1",
            baseline_rate_reference="baseline-v1",
        )
        self.assertEqual(result["method_id"], "health.baseline-rate-relative-risk.v1")
        self.assertAlmostEqual(result["baseline_expected_outcomes"], 100)
        self.assertAlmostEqual(result["estimated_excess_outcomes"], 10)
        self.assertEqual(
            result["scientific_review_status"], "not_assessed_by_software"
        )
        prevented = estimate_attributable_outcomes(
            endpoint_id="respiratory_admissions",
            population_stratum="adults",
            baseline_rate_per_100k_person_year=100,
            population=100_000,
            duration_days=365.2425,
            relative_risk_event_vs_counterfactual=0.9,
            risk_function_reference="risk-fn-v1",
            baseline_rate_reference="baseline-v1",
        )
        self.assertAlmostEqual(prevented["estimated_excess_outcomes"], -10)

    def test_health_calculation_rejects_nonpositive_relative_risk(self):
        with self.assertRaisesRegex(ValueError, "greater than zero"):
            estimate_attributable_outcomes(
                endpoint_id="outcome",
                population_stratum="all",
                baseline_rate_per_100k_person_year=1,
                population=1,
                duration_days=1,
                relative_risk_event_vs_counterfactual=0,
                risk_function_reference="risk",
                baseline_rate_reference="baseline",
            )

    def test_unit_value_requires_compatible_unit_and_keeps_price_basis(self):
        result = value_physical_outcome(
            endpoint_id="treatment_cases",
            quantity=7,
            quantity_unit="case",
            unit_value=123.5,
            compatible_unit="case",
            currency="MYR",
            price_year=2024,
            unit_value_reference="local-cost-study-v1",
        )
        self.assertEqual(result["method_id"], "economics.declared-unit-value.v1")
        self.assertEqual(result["valued_amount"], 864.5)
        self.assertEqual(result["currency"], "MYR")
        self.assertEqual(result["price_year"], 2024)
        with self.assertRaisesRegex(ValueError, "Unit mismatch"):
            value_physical_outcome(
                endpoint_id="cases",
                quantity=1,
                quantity_unit="case",
                unit_value=10,
                compatible_unit="person",
                currency="MYR",
                price_year=2024,
                unit_value_reference="ref",
            )

    def test_unit_value_rejects_overflow(self):
        with self.assertRaisesRegex(ValueError, "not finite"):
            value_physical_outcome(
                endpoint_id="cases",
                quantity=1e308,
                quantity_unit="case",
                unit_value=1e308,
                compatible_unit="case",
                currency="MYR",
                price_year=2024,
                unit_value_reference="ref",
            )

    def test_method_registry_is_explicitly_versioned(self):
        self.assertEqual(
            set(METHODS),
            {
                "fire.paired-source-removal.v1",
                "exposure.population-weighted-mean.v1",
                "health.baseline-rate-relative-risk.v1",
                "economics.declared-unit-value.v1",
            },
        )

    def test_one_way_sensitivity_uses_only_explicit_bounds(self):
        result = one_way_sensitivity(
            method_id="example.product.v1",
            central_inputs={"rate": 2.0, "population": 100.0},
            input_ranges={
                "rate": {"lower": 1.0, "upper": 3.0},
                "population": {"lower": 80.0, "upper": 120.0},
            },
            evaluate=lambda values: values["rate"] * values["population"],
        )
        self.assertEqual(result["central_output"], 200)
        self.assertEqual(
            result["results"][0]["output_at_lower"], 100
        )
        self.assertEqual(
            result["results"][0]["output_at_upper"], 300
        )
        self.assertEqual(
            result["results"][1]["output_at_lower"], 160
        )
        self.assertEqual(
            result["results"][1]["output_at_upper"], 240
        )
        self.assertIn("not confidence intervals", result["limitations"])

    def test_one_way_sensitivity_rejects_implicit_or_invalid_ranges(self):
        with self.assertRaisesRegex(ValueError, "exactly one"):
            one_way_sensitivity(
                method_id="method.v1",
                central_inputs={"x": 1.0},
                input_ranges={},
                evaluate=lambda values: values["x"],
            )
        with self.assertRaisesRegex(ValueError, "outside"):
            one_way_sensitivity(
                method_id="method.v1",
                central_inputs={"x": 1.0},
                input_ranges={"x": {"lower": 2.0, "upper": 3.0}},
                evaluate=lambda values: values["x"],
            )


if __name__ == "__main__":
    unittest.main()
