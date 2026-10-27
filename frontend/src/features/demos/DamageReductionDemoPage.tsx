import { Link } from 'react-router';
import { ReductionResults } from '../damage-reduction/ReductionResults.tsx';
import snapshot from './data/damage-reduction.json';
import { DemoFrame } from './DemoFrame.tsx';
import { parseReductionDemo, recordedArtifactReader } from './recorded-demo.ts';

const demo = parseReductionDemo(snapshot);
const readArtifact = recordedArtifactReader(demo.artifacts);

export function DamageReductionDemoPage() {
  return (
    <DemoFrame
      title="Damage reduction demo"
      description="A completed preview comparing 1,000 and 880 person-days: a supplied 12% reduction against a target of at least 10%."
      recordedAt={demo.recorded_at}
    >
      <ReductionResults
        view={demo.preview}
        readArtifact={readArtifact}
        recorded
      />
      <p>
        <Link to="/damage-reduction">Create your own planning preview</Link>
      </p>
    </DemoFrame>
  );
}
