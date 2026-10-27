import { Link } from 'react-router';
import {
  setNextTaskNightshiftPermission,
  useNextTaskNightshiftPermission,
} from '../../shared/lib/nextTaskPermissions.ts';
import styles from './ManagerPage.module.css';

export function NextTaskPermissions() {
  const enabled = useNextTaskNightshiftPermission();
  return (
    <section
      className={styles.permissions}
      aria-labelledby="next-task-permissions-heading"
    >
      <h2 id="next-task-permissions-heading">Next task permissions</h2>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) =>
            setNextTaskNightshiftPermission(event.target.checked)
          }
          aria-describedby="next-task-permissions-help"
        />{' '}
        Allow Nightshift candidate tools for the next admitted task
      </label>
      <p id="next-task-permissions-help" className={styles.note}>
        Off by default. This applies once, when the Manager starts a task;
        ordinary chat replies and lookups keep the setting for later. It does
        not change a saved task&apos;s permissions.
      </p>
      <p className={styles.note}>
        Optional background candidate generation and judging through Nightshift
        is separate from normal model calls. New chains allow cloud providers
        with no cloud spend cap. Automatic successor runs require a separate
        bounded chain grant in <Link to="/nightshift">Nightshift</Link>.
      </p>
    </section>
  );
}
