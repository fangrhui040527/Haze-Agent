import { compass, type CityReading } from '../../shared/data/airQuality.ts';
import {
  describeReading,
  markerValue,
  markerVar,
  type PrimaryLayer,
} from './regionLayers.ts';
import styles from './RegionView.module.css';

/**
 * A focusable city label: swatch + name + value (+ wind arrow). Built as plain DOM because
 * both globe.gl and Leaflet position raw elements. Colour is never the only signal.
 */
export function buildMarker(
  reading: CityReading,
  opts: {
    layer: PrimaryLayer;
    wind: boolean;
    selected: boolean;
    onSelect: (id: string) => void;
  },
): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = styles.marker;
  btn.setAttribute('aria-pressed', String(opts.selected));
  btn.setAttribute('aria-label', describeReading(reading));
  btn.title = describeReading(reading);
  btn.style.setProperty(
    '--marker-color',
    `var(${markerVar(reading, opts.layer)})`,
  );
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onSelect(reading.city.id);
  });
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());

  const dot = document.createElement('span');
  dot.className = styles.markerDot;
  dot.setAttribute('aria-hidden', 'true');
  btn.append(dot);

  const text = document.createElement('span');
  text.className = styles.markerText;
  const name = document.createElement('span');
  name.className = styles.markerName;
  name.textContent = reading.city.name;
  const value = document.createElement('span');
  value.className = styles.markerValue;
  value.textContent = markerValue(reading, opts.layer);
  text.append(name, value);
  btn.append(text);

  if (
    opts.wind &&
    reading.windDirection !== null &&
    reading.windSpeed !== null
  ) {
    // Meteorological direction is where wind comes FROM; the arrow points where smoke goes.
    const arrow = document.createElement('span');
    arrow.className = styles.windArrow;
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↑';
    arrow.style.transform = `rotate(${(reading.windDirection + 180) % 360}deg)`;
    const speed = document.createElement('span');
    speed.className = styles.windSpeed;
    speed.textContent = `${Math.round(reading.windSpeed)} km/h ${compass(reading.windDirection)}`;
    speed.setAttribute('aria-hidden', 'true');
    btn.append(arrow, speed);
  }
  return btn;
}
