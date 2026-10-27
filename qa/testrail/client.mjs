// Minimal dependency-free TestRail API v2 client.
//
// Deliberately NOT using an MCP server: TestRail exposes a plain REST API, so a
// direct client works in CI and in a bare shell with nothing but credentials.
//
// Env:
//   TESTRAIL_URL      https://your-instance.testrail.io
//   TESTRAIL_USER     your login email
//   TESTRAIL_API_KEY  My Settings -> API Keys -> Add Key
//                     (admin must also enable Administration -> Site Settings -> API)

export class TestRailError extends Error {
  constructor(status, body, endpoint) {
    super(
      `TestRail ${endpoint} failed with HTTP ${status}: ${
        typeof body === 'string' ? body : JSON.stringify(body)
      }`,
    );
    this.name = 'TestRailError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

export function readCredentials(env = process.env) {
  const url = env.TESTRAIL_URL;
  const user = env.TESTRAIL_USER;
  const key = env.TESTRAIL_API_KEY;
  const missing = [];
  if (!url?.trim()) missing.push('TESTRAIL_URL');
  if (!user?.trim()) missing.push('TESTRAIL_USER');
  if (!key?.trim()) missing.push('TESTRAIL_API_KEY');
  return { url: url?.trim(), user: user?.trim(), key: key?.trim(), missing };
}

/** TestRail statuses. 1 Passed, 2 Blocked, 3 Untested, 4 Retest, 5 Failed. */
export const STATUS = {
  PASSED: 1,
  BLOCKED: 2,
  UNTESTED: 3,
  RETEST: 4,
  FAILED: 5,
};

/** TestRail rejects elapsed "0s"; it wants a positive, human duration. */
export function formatElapsed(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (total < 1) return undefined;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (!minutes) return `${seconds}s`;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export class TestRailClient {
  constructor({
    url,
    user,
    key,
    dryRun = false,
    verbose = false,
    log = () => {},
  } = {}) {
    this.base = url?.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}`;
    this.dryRun = dryRun;
    this.verbose = verbose;
    this.log = log;
    this.writes = [];
  }

  async request(method, endpoint, body, { attempt = 0 } = {}) {
    if (this.dryRun && method === 'POST') {
      this.writes.push({ endpoint, body });
      if (this.verbose) this.log(`    [dry-run] POST ${endpoint}`);
      // Synthetic ids keep the dry-run pipeline flowing end to end.
      return { id: -1 * (this.writes.length + 1000), dry_run: true };
    }
    const target = `${this.base}/index.php?/api/v2/${endpoint}`;
    const response = await fetch(target, {
      method,
      headers: {
        Authorization: this.auth,
        'Content-Type': 'application/json',
        // TestRail returns HTML error pages without this on some instances.
        Accept: 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    // TestRail throttles with 429 + Retry-After on hosted instances.
    if (response.status === 429 && attempt < 4) {
      const wait = Number(response.headers.get('retry-after') ?? 2) * 1000;
      this.log(`    rate limited, retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      return this.request(method, endpoint, body, { attempt: attempt + 1 });
    }

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok)
      throw new TestRailError(response.status, parsed, endpoint);
    return parsed;
  }

  get(endpoint) {
    return this.request('GET', endpoint);
  }
  post(endpoint, body) {
    return this.request('POST', endpoint, body);
  }

  /**
   * Newer TestRail wraps collections as {offset,limit,size,_links,<key>:[...]}
   * while older versions return a bare array. Handle both and follow pages.
   */
  async getAll(endpoint, key) {
    const out = [];
    let offset = 0;
    for (;;) {
      const page = await this.get(
        `${endpoint}${endpoint.includes('&') || endpoint.includes('/') ? '' : ''}&limit=250&offset=${offset}`,
      );
      if (Array.isArray(page)) return page;
      const items = page?.[key] ?? [];
      out.push(...items);
      const size = page?.size ?? items.length;
      const limit = page?.limit ?? 250;
      if (!page?._links?.next && (items.length < limit || size < limit)) break;
      offset += limit;
      if (offset > 20_000) break; // safety stop
    }
    return out;
  }

  // --- reads ---
  projects() {
    return this.getAll('get_projects', 'projects');
  }
  suites(projectId) {
    return this.get(`get_suites/${projectId}`).then((r) =>
      Array.isArray(r) ? r : (r?.suites ?? []),
    );
  }
  sections(projectId, suiteId) {
    return this.getAll(
      `get_sections/${projectId}${suiteId ? `&suite_id=${suiteId}` : ''}`,
      'sections',
    );
  }
  cases(projectId, suiteId) {
    return this.getAll(
      `get_cases/${projectId}${suiteId ? `&suite_id=${suiteId}` : ''}`,
      'cases',
    );
  }
  results(runId) {
    return this.getAll(`get_results_for_run/${runId}`, 'results');
  }

  // --- writes ---
  addSection(projectId, body) {
    return this.post(`add_section/${projectId}`, body);
  }
  addCase(sectionId, body) {
    return this.post(`add_case/${sectionId}`, body);
  }
  updateCase(caseId, body) {
    return this.post(`update_case/${caseId}`, body);
  }
  addRun(projectId, body) {
    return this.post(`add_run/${projectId}`, body);
  }
  /** Bulk result upload — one call instead of N. */
  addResultsForCases(runId, results) {
    return this.post(`add_results_for_cases/${runId}`, { results });
  }
  closeRun(runId) {
    return this.post(`close_run/${runId}`, {});
  }
}
