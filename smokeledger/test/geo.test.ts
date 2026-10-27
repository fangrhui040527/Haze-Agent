import { test } from "node:test";
import assert from "node:assert/strict";
import { PolygonIndex, areaHa, haversineKm, pointInGeometry, windToUV, type Geometry } from "../src/geo.ts";

test("haversine: one degree of latitude is about 111 km", () => {
  assert.ok(Math.abs(haversineKm(0, 100, 1, 100) - 111.2) < 0.5);
});

test("wind direction is where wind comes FROM", () => {
  const north = windToUV(10, 0); // from north -> blows south
  assert.ok(Math.abs(north.u) < 1e-9 && Math.abs(north.v + 10) < 1e-9);
  const sw = windToUV(10, 225); // from south-west -> blows north-east
  assert.ok(sw.u > 7 && sw.v > 7);
});

const square: Geometry = {
  type: "Polygon",
  coordinates: [
    [[100, 0], [101, 0], [101, 1], [100, 1], [100, 0]],
    [[100.4, 0.4], [100.6, 0.4], [100.6, 0.6], [100.4, 0.6], [100.4, 0.4]],
  ],
};

test("point in polygon respects holes", () => {
  assert.equal(pointInGeometry(100.2, 0.2, square), true);
  assert.equal(pointInGeometry(100.5, 0.5, square), false); // in the hole
  assert.equal(pointInGeometry(102, 0.5, square), false);
});

test("polygon index finds the right feature", () => {
  const idx = new PolygonIndex<string>(0.25);
  idx.add(square, "A");
  idx.add({ type: "Polygon", coordinates: [[[105, 0], [106, 0], [106, 1], [105, 1], [105, 0]]] }, "B");
  assert.equal(idx.find(100.2, 0.2), "A");
  assert.equal(idx.find(105.5, 0.5), "B");
  assert.equal(idx.find(103, 0.5), null);
});

test("area of a 1x1 degree square at the equator is about 1.23 million ha", () => {
  const a = areaHa({ type: "Polygon", coordinates: [[[100, 0], [101, 0], [101, 1], [100, 1], [100, 0]]] });
  assert.ok(Math.abs(a - 1_236_000) / 1_236_000 < 0.02, String(a));
});
