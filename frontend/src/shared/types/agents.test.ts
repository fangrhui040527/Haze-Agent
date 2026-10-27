import { describe, expect, it } from 'vitest';
import { AGENT_IDS, AGENT_INFO, recordedAgentInfo } from './agents.ts';
import { STATIONS } from '../../features/agent-office/officeLayout.ts';

describe('active and recorded agent identities', () => {
  it('keeps the retired H-MEM out of the active office', () => {
    expect(AGENT_IDS).not.toContain('hmem');
    expect(Object.keys(AGENT_INFO)).not.toContain('hmem');
    expect(Object.keys(STATIONS)).not.toContain('hmem');
  });

  it('labels historical H-MEM records without crashing', () => {
    expect(recordedAgentInfo('hmem').name).toBe('Retired H-MEM');
    expect(recordedAgentInfo('manager').name).toBe('Manager');
    expect(recordedAgentInfo('unknown-agent').name).toBe(
      'Unknown agent (unknown-agent)',
    );
  });
});
