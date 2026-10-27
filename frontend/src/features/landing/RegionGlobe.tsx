import { useEffect, useRef } from 'react';
import Globe, { type GlobeInstance } from 'globe.gl';
import { MeshBasicMaterial, SRGBColorSpace, TextureLoader } from 'three';
import {
  GIBS_BASE_MAX_ZOOM,
  GIBS_BASE_TILE,
  MALAYSIA_VIEW,
  REGION_BBOX,
  SATELLITE_LAYERS,
  gibsImageUrl,
  gibsReferenceUrl,
  type CityReading,
  type FireHotspot,
} from '../../shared/data/airQuality.ts';
import { buildMarker } from './markerElement.ts';
import { markerVar, readToken, type RegionViewProps } from './regionLayers.ts';
import styles from './RegionView.module.css';

const GLOBE_RADIUS = 100;
const SWAY_DEG = 2.5;
const SWAY_MS = 14_000;

interface OverlayTile {
  id: string;
  url: string;
  altitude: number;
  opacity: number;
}

const BBOX_TILE = {
  lat: (REGION_BBOX.north + REGION_BBOX.south) / 2,
  lng: (REGION_BBOX.east + REGION_BBOX.west) / 2,
  width: REGION_BBOX.east - REGION_BBOX.west,
  height: REGION_BBOX.north - REGION_BBOX.south,
};

const loader = new TextureLoader().setCrossOrigin('anonymous');
const materialCache = new Map<string, MeshBasicMaterial>();

function overlayMaterial(tile: OverlayTile): MeshBasicMaterial {
  const key = `${tile.url}|${tile.opacity}`;
  let mat = materialCache.get(key);
  if (!mat) {
    const texture = loader.load(tile.url);
    texture.colorSpace = SRGBColorSpace;
    mat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: tile.opacity,
      depthWrite: false,
    });
    materialCache.set(key, mat);
  }
  return mat;
}

function withAlpha(hex: string, alpha: number) {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha.toFixed(2)})`;
}

/** Interactive 3D globe framed on Malaysia. Loaded lazily; never imported by the main bundle. */
export default function RegionGlobe({
  readings,
  fires,
  layers,
  selectedId,
  onSelect,
  resetKey,
  satelliteTime,
}: RegionViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeInstance | null>(null);
  const userMovedRef = useRef(false);

  // Create once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const globe = new Globe(host, { animateIn: false })
      .backgroundColor('rgba(0,0,0,0)')
      .globeTileEngineUrl(GIBS_BASE_TILE)
      .globeTileEngineMaxLevel(GIBS_BASE_MAX_ZOOM)
      .showAtmosphere(true)
      .atmosphereColor(readToken(host, '--globe-atmosphere'))
      .atmosphereAltitude(0.18)
      .pointOfView(MALAYSIA_VIEW, 0);
    globeRef.current = globe;

    const controls = globe.controls();
    controls.minDistance = GLOBE_RADIUS * 1.35;
    controls.maxDistance = GLOBE_RADIUS * 4.2;
    controls.enablePan = false;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.6;
    controls.addEventListener('start', () => {
      userMovedRef.current = true;
    });

    const resize = new ResizeObserver(([entry]) => {
      globe.width(entry.contentRect.width).height(entry.contentRect.height);
    });
    resize.observe(host);

    // Gentle sway around the region instead of a full spin; off for reduced motion.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let dir = 1;
    const sway = window.setInterval(() => {
      if (reduced.matches || userMovedRef.current) return;
      dir = -dir;
      globe.pointOfView(
        { ...MALAYSIA_VIEW, lng: MALAYSIA_VIEW.lng + dir * SWAY_DEG },
        SWAY_MS,
      );
    }, SWAY_MS);

    return () => {
      window.clearInterval(sway);
      resize.disconnect();
      globe._destructor();
      host.replaceChildren();
      globeRef.current = null;
    };
  }, []);

  // Reset to Malaysia.
  useEffect(() => {
    if (resetKey === 0) return;
    userMovedRef.current = false;
    globeRef.current?.pointOfView(MALAYSIA_VIEW, 1200);
  }, [resetKey]);

  // City points and labelled, focusable markers.
  useEffect(() => {
    const globe = globeRef.current;
    const host = hostRef.current;
    if (!globe || !host) return;
    const colour = (r: CityReading) =>
      readToken(host, markerVar(r, layers.primary));
    globe
      .pointsData(readings)
      .pointLat((d) => (d as CityReading).city.lat)
      .pointLng((d) => (d as CityReading).city.lng)
      .pointColor((d) => colour(d as CityReading))
      .pointAltitude(0.012)
      .pointRadius(0.32)
      .pointsMerge(false)
      .htmlElementsData(readings)
      .htmlLat((d) => (d as CityReading).city.lat)
      .htmlLng((d) => (d as CityReading).city.lng)
      .htmlAltitude(0.015)
      .htmlElement((d) =>
        buildMarker(d as CityReading, {
          layer: layers.primary,
          wind: layers.wind,
          selected: (d as CityReading).city.id === selectedId,
          onSelect,
        }),
      );
  }, [readings, layers.primary, layers.wind, selectedId, onSelect]);

  // Fire hotspots: ember dots with a pulsing ring.
  useEffect(() => {
    const globe = globeRef.current;
    const host = hostRef.current;
    if (!globe || !host) return;
    const hotspots =
      layers.fires && fires?.status === 'ok'
        ? fires.hotspots.slice(0, 1500)
        : [];
    const fire = readToken(host, '--fire-color');
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    globe
      .ringsData(
        reduced ? [] : hotspots.filter((h) => (h.frp ?? 0) >= 20).slice(0, 120),
      )
      .ringLat((d) => (d as FireHotspot).lat)
      .ringLng((d) => (d as FireHotspot).lng)
      .ringColor(() => (t: number) => withAlpha(fire, 1 - t))
      .ringMaxRadius(1.2)
      .ringPropagationSpeed(0.8)
      .ringRepeatPeriod(1600)
      .labelsData(hotspots)
      .labelLat((d) => (d as FireHotspot).lat)
      .labelLng((d) => (d as FireHotspot).lng)
      .labelText(() => '')
      .labelDotRadius(0.12)
      .labelColor(() => fire)
      .labelAltitude(0.004);
  }, [fires, layers.fires]);

  // Region overlays: borders/coastlines always, plus the chosen satellite layer.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    const tiles: OverlayTile[] = [];
    const sat = SATELLITE_LAYERS.find((l) => l.id === layers.satellite);
    if (sat && satelliteTime) {
      tiles.push({
        id: sat.id,
        url: gibsImageUrl(sat, satelliteTime),
        altitude: 0.003,
        opacity: sat.id === 'himawari' ? 0.7 : 0.8,
      });
    }
    tiles.push({
      id: 'ref',
      url: gibsReferenceUrl(),
      altitude: 0.005,
      opacity: 0.75,
    });
    globe
      .tilesData(tiles)
      .tileLat(() => BBOX_TILE.lat)
      .tileLng(() => BBOX_TILE.lng)
      .tileWidth(() => BBOX_TILE.width)
      .tileHeight(() => BBOX_TILE.height)
      .tileAltitude((d) => (d as OverlayTile).altitude)
      .tileCurvatureResolution(1)
      .tileMaterial((d) => overlayMaterial(d as OverlayTile));
  }, [layers.satellite, satelliteTime]);

  return <div ref={hostRef} className={styles.canvasHost} />;
}
