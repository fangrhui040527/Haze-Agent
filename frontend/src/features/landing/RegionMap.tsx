import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  GIBS_BASE_MAX_ZOOM,
  GIBS_BASE_TEMPLATE,
  MALAYSIA_BOUNDS,
  REGION_BBOX,
  SATELLITE_LAYERS,
  gibsImageUrl,
  gibsReferenceUrl,
} from '../../shared/data/airQuality.ts';
import { buildMarker } from './markerElement.ts';
import { readToken, type RegionViewProps } from './regionLayers.ts';
import styles from './RegionView.module.css';

const BOUNDS: L.LatLngBoundsExpression = [
  [REGION_BBOX.south, REGION_BBOX.west],
  [REGION_BBOX.north, REGION_BBOX.east],
];
const START_BOUNDS: L.LatLngBoundsExpression = [
  [MALAYSIA_BOUNDS.south, MALAYSIA_BOUNDS.west],
  [MALAYSIA_BOUNDS.north, MALAYSIA_BOUNDS.east],
];

/**
 * Flat 2D fallback (no WebGL needed): same layers and markers as the globe.
 * The EPSG:4326 overlays are stretched onto Web Mercator; within ±12° latitude the
 * distortion is under 2.5%, which is acceptable for this regional view.
 */
export default function RegionMap({
  readings,
  fires,
  layers,
  selectedId,
  onSelect,
  resetKey,
  satelliteTime,
}: RegionViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const groupsRef = useRef<{
    markers: L.LayerGroup;
    fires: L.LayerGroup;
    overlay: L.LayerGroup;
  } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const map = L.map(host, {
      minZoom: 3,
      maxZoom: 8,
      maxBounds: [
        [-30, 70],
        [30, 140],
      ],
      zoomControl: true,
      attributionControl: true,
    });
    map.fitBounds(START_BOUNDS);
    L.tileLayer(GIBS_BASE_TEMPLATE, {
      maxNativeZoom: GIBS_BASE_MAX_ZOOM,
      attribution: 'Imagery: NASA GIBS / EOSDIS',
    }).addTo(map);
    const overlay = L.layerGroup().addTo(map);
    L.imageOverlay(gibsReferenceUrl(), BOUNDS, {
      opacity: 0.8,
      crossOrigin: true,
    }).addTo(map);
    const firesGroup = L.layerGroup().addTo(map);
    const markers = L.layerGroup().addTo(map);
    mapRef.current = map;
    groupsRef.current = { markers, fires: firesGroup, overlay };
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(host);
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
      groupsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (resetKey === 0) return;
    mapRef.current?.fitBounds(START_BOUNDS);
  }, [resetKey]);

  useEffect(() => {
    const groups = groupsRef.current;
    if (!groups) return;
    groups.markers.clearLayers();
    for (const r of readings) {
      const el = buildMarker(r, {
        layer: layers.primary,
        wind: layers.wind,
        selected: r.city.id === selectedId,
        onSelect,
      });
      L.marker([r.city.lat, r.city.lng], {
        icon: L.divIcon({
          html: el,
          className: styles.leafletIcon,
          iconSize: undefined,
        }),
        keyboard: false,
      }).addTo(groups.markers);
    }
  }, [readings, layers.primary, layers.wind, selectedId, onSelect]);

  useEffect(() => {
    const groups = groupsRef.current;
    const host = hostRef.current;
    if (!groups || !host) return;
    groups.fires.clearLayers();
    if (!layers.fires || fires?.status !== 'ok') return;
    const colour = readToken(host, '--fire-color');
    for (const h of fires.hotspots.slice(0, 1500)) {
      L.circleMarker([h.lat, h.lng], {
        radius: 2.5,
        color: colour,
        weight: 1,
        fillOpacity: 0.85,
        interactive: false,
      }).addTo(groups.fires);
    }
  }, [fires, layers.fires]);

  useEffect(() => {
    const groups = groupsRef.current;
    if (!groups) return;
    groups.overlay.clearLayers();
    const sat = SATELLITE_LAYERS.find((l) => l.id === layers.satellite);
    if (sat && satelliteTime) {
      L.imageOverlay(gibsImageUrl(sat, satelliteTime), BOUNDS, {
        opacity: 0.75,
        crossOrigin: true,
      }).addTo(groups.overlay);
    }
  }, [layers.satellite, satelliteTime]);

  return <div ref={hostRef} className={styles.canvasHost} />;
}
