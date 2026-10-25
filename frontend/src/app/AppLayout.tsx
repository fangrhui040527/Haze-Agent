import { useEffect } from 'react';
import {
  NavLink,
  Outlet,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
  Link,
} from 'react-router';
import { Badge } from '../shared/ui/Badge.tsx';
import { buttonClass } from '../shared/ui/Button.tsx';
import { StateMessage } from '../shared/ui/States.tsx';
import { TimeAgo } from '../shared/ui/TimeAgo.tsx';
import styles from './AppLayout.module.css';
import { useLiveData } from './liveDataContext.ts';
import { LiveDataProvider } from './LiveDataProvider.tsx';

const CONNECTION_TEXT = {
  connecting: 'Connecting…',
  live: 'Live',
  offline: 'Offline (showing last data)',
  error: 'Connection problem',
} as const;

function Header() {
  const live = useLiveData();
  const isMock = live.dataSourceLabel.toLowerCase().includes('mock');
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link to="/" className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            ▦
          </span>{' '}
          Haze
        </Link>
        {live.fictional && (
          <Badge
            tone="warn"
            title="Dashboard table items are fictional. Evidence chat uses its separately labeled task API."
          >
            TABLE · fictional sample
          </Badge>
        )}
        <span className={styles.connection} title={live.dataSourceLabel}>
          <span
            className={`${styles.dot} ${styles[live.connection]}`}
            aria-hidden="true"
          />
          {CONNECTION_TEXT[live.connection]}
          {isMock && live.connection === 'live' && ' (mock)'}
          {live.lastUpdatedAt && (
            <span className={styles.updated}>
              {' '}
              · updated <TimeAgo iso={live.lastUpdatedAt} />
            </span>
          )}
        </span>
        <nav className={styles.nav} aria-label="Main">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.active : ''}`
            }
          >
            Dashboard
          </NavLink>
          <NavLink
            to="/demo-data"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.active : ''}`
            }
          >
            Demo Data
          </NavLink>
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className={styles.footer}>
      Not medical advice. Follow your local authorities. Sources are listed on
      each item. Fictional samples are labeled as demo data; evidence answers
      identify their source and execution mode.
    </footer>
  );
}

export function AppLayout() {
  useEffect(() => {
    function updateZoom() {
      if (typeof window === 'undefined') return;
      // In desktop browsers, window.outerWidth / window.innerWidth reflects page zoom level (~0.75 for 75% zoom)
      const zoomRatio = window.outerWidth / window.innerWidth;
      const is75OrLess = zoomRatio <= 0.82;
      document.documentElement.classList.toggle('zoom-75', is75OrLess);
    }
    updateZoom();
    window.addEventListener('resize', updateZoom);
    return () => window.removeEventListener('resize', updateZoom);
  }, []);

  return (
    <LiveDataProvider>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header />
      <div className={styles.pageBody}>
        <main id="main" className={styles.main}>
          <Outlet />
        </main>
        <Footer />
      </div>
      <ScrollRestoration />
    </LiveDataProvider>
  );
}

export function NotFoundPage() {
  return (
    <StateMessage
      kind="empty"
      title="Page not found."
      action={
        <Link to="/" className={buttonClass()}>
          Go to the dashboard
        </Link>
      }
    >
      The address may be mistyped.
    </StateMessage>
  );
}

/** Shown if a page crashes while rendering, instead of a blank screen. */
export function RouteErrorPage() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error);
  return (
    <main id="main" className={styles.main}>
      <StateMessage
        kind="error"
        title="Something went wrong on this page."
        action={
          <a href="/" className={buttonClass()}>
            Reload the dashboard
          </a>
        }
      >
        <code>{detail}</code>
      </StateMessage>
    </main>
  );
}
