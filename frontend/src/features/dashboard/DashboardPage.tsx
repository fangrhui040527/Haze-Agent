import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { AgentId } from '../../shared/types/agents.ts';
import { Panel } from '../../shared/ui/States.tsx';
import { buttonClass } from '../../shared/ui/Button.tsx';
import { AgentOffice } from '../agent-office/AgentOffice.tsx';
import { ChatPanel, type ChatPrefill } from '../chat/ChatPanel.tsx';
import { LiveTable } from '../live-table/LiveTable.tsx';
import styles from './DashboardPage.module.css';
import { useAgentRun } from './useAgentRun.ts';

/**
 * Main page: live table on top; chat (left) and agent office (right) side by side below,
 * so the Manager's walk from the chat into the office is visible without scrolling.
 */
export function DashboardPage() {
  const run = useAgentRun();
  const location = useLocation();
  const navigate = useNavigate();
  const [prefill, setPrefill] = useState<ChatPrefill | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentId | null>(null);

  // The detail page's "Ask the agents about this" sends a question here via navigation state.
  useEffect(() => {
    const state = location.state as { ask?: ChatPrefill } | null;
    if (state?.ask) {
      setPrefill(state.ask);
      navigate('.', { replace: true, state: null });
      document
        .getElementById('chat-input')
        ?.scrollIntoView({ block: 'center' });
    }
  }, [location.state, navigate]);

  return (
    <div className={styles.grid}>
      <div className={styles.actions}>
        <Link
          to={
            run.task
              ? `/manager/${encodeURIComponent(run.task.id)}`
              : '/manager'
          }
          className={buttonClass('secondary', 'small')}
        >
          Manager workspace
        </Link>
        <Link
          to="/damage-account"
          className={buttonClass('secondary', 'small')}
        >
          Damage accounting
        </Link>
      </div>
      <Panel className={styles.table}>
        <LiveTable />
      </Panel>
      <Panel className={styles.chat}>
        <ChatPanel run={run} prefill={prefill} />
      </Panel>
      <Panel className={styles.office}>
        <AgentOffice
          run={run}
          selected={selectedAgent}
          onSelect={setSelectedAgent}
        />
      </Panel>
    </div>
  );
}
