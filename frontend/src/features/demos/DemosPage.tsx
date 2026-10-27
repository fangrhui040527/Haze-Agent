import { Link } from 'react-router';
import { buttonClass } from '../../shared/ui/Button.tsx';
import { DemoFrame } from './DemoFrame.tsx';
import styles from './Demos.module.css';

export function DemosPage() {
  return (
    <DemoFrame
      title="Demos"
      description="Explore damage accounting and reduction planning with completed examples. Open either demo anytime from this frontend."
    >
      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="account-demo-heading">
          <p className={styles.eyebrow}>Account for harm</p>
          <h2 id="account-demo-heading">Damage account</h2>
          <p>
            Follow physical outcomes, financial incidence and selected social
            welfare through an independently checked account.
          </p>
          <dl className={styles.facts}>
            <div>
              <dt>Selected historical welfare loss</dt>
              <dd>CU21,534,033.40</dd>
            </div>
            <div>
              <dt>Project benefit / cost ratio</dt>
              <dd>4.57</dd>
            </div>
          </dl>
          <p className={styles.meta}>
            Invented quantities and CU currency; 2015 price basis.
          </p>
          <Link to="/demos/damage-account" className={buttonClass('primary')}>
            View damage account demo
          </Link>
        </section>
        <section
          className={styles.card}
          aria-labelledby="reduction-demo-heading"
        >
          <p className={styles.eyebrow}>Compare an intervention</p>
          <h2 id="reduction-demo-heading">Damage reduction</h2>
          <p>
            Compare supplied residual estimates, inspect the target decision,
            and explore a conditional alert-service plan and its prerequisites.
          </p>
          <dl className={styles.facts}>
            <div>
              <dt>Supplied scenario reduction</dt>
              <dd>12%</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>At least 10%</dd>
            </div>
          </dl>
          <p className={styles.meta}>
            Synthetic scenario; conditional plan with no delivered intervention.
          </p>
          <Link to="/demos/damage-reduction" className={buttonClass('primary')}>
            View damage reduction demo
          </Link>
        </section>
      </div>
    </DemoFrame>
  );
}
