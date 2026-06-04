import { ConfigService } from '@nestjs/config';
import { MeetingOpsClient } from './meeting-ops.client';
import { FederationContext } from './meeting-ops.port';

/**
 * The Meeting-Ops federation client speaks JSON-RPC 2.0 to the Meeting-Ops app's
 * `POST /mcp` read surface. Meeting-Ops is MOCKED here via a fake global.fetch —
 * the app is never running. These pin:
 *   - list_meetings_for_contact → FederatedMeeting mapping + the JSON-RPC body,
 *   - list_summaries_for_contact / list_action_items_for_contact mapping
 *     (incl. surfacing project_ops_task_id WITHOUT writing it),
 *   - getMeetingSignal derives a compact digest from the three reads,
 *   - the workspace is forwarded as the wire address (X-Workspace-Id) + the
 *     service token, but reads carry NO entitlement (viewer-level signal),
 *   - DEGRADE-CLEAN: unset MEETING_OPS_BASE_URL → empty/null, no fetch, no throw,
 *   - transport/HTTP/tool errors → empty/null, never throw (best-effort).
 */
const CTX: FederationContext = { workspaceId: 'ws-aaaa', ucUid: 'uc-uid-1' };

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** A JSON-RPC tools/call success envelope wrapping structuredContent. */
function rpcOk(structured: unknown) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      isError: false,
      structuredContent: structured,
      content: [{ type: 'text', text: JSON.stringify(structured) }],
    },
  };
}

describe('MeetingOpsClient (Meeting-Ops MOCKED)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('when MEETING_OPS_BASE_URL is unset (dormant)', () => {
    const client = new MeetingOpsClient(makeConfig({}));

    it('isConfigured() is false', () => {
      expect(client.isConfigured()).toBe(false);
    });

    it('listMeetingsForContact returns an empty page without any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.listMeetingsForContact(CTX, 'p1')).resolves.toEqual({
        items: [],
        count: 0,
        nextCursor: null,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('listSummariesForContact / listActionItemsForContact return [] (no fetch)', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.listSummariesForContact(CTX, 'p1')).resolves.toEqual([]);
      await expect(client.listActionItemsForContact(CTX, 'p1')).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('getMeetingSignal returns the all-empty signal (no fetch) so an agent can still run', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.getMeetingSignal(CTX, 'p1')).resolves.toEqual({
        meetingCount: 0,
        lastMeetingAt: null,
        lastMeetingTitle: null,
        openActionItemCount: 0,
        latestSummaryHeadline: null,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('with MEETING_OPS_BASE_URL set', () => {
    const env = {
      MEETING_OPS_BASE_URL: 'https://meetings.example.test/',
      MEETING_OPS_SERVICE_TOKEN: 'svc-token-mo',
    };

    it('isConfigured() is true', () => {
      expect(new MeetingOpsClient(makeConfig(env)).isConfigured()).toBe(true);
    });

    it('list_meetings_for_contact: posts JSON-RPC tools/call and maps Meeting → FederatedMeeting', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            meetings: [
              {
                id: 'mtg-1',
                title: 'Discovery call',
                started_at: '2026-06-01T15:00:00Z',
                ended_at: '2026-06-01T15:45:00Z',
                duration_seconds: 2700,
                status: 'summarized',
                has_summary: true,
                action_item_count: 2,
                participants: [
                  { contact_id: 'contact-42', display_name: 'Jane Lead', email: 'jane@x.com' },
                  { display_name: 'Aaron' },
                ],
              },
            ],
            count: 1,
            next_cursor: 'cur2',
          }),
        ),
      );
      global.fetch = fetchSpy as any;
      const client = new MeetingOpsClient(makeConfig(env));

      const page = await client.listMeetingsForContact(CTX, 'contact-42', { limit: 10 });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://meetings.example.test/mcp');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'list_meetings_for_contact',
          arguments: { workspace_id: 'ws-aaaa', contact_id: 'contact-42', limit: 10 },
        },
      });
      // Workspace forwarded as the wire address (header) + service token. No
      // entitlement header — reads are viewer-level.
      expect(init.headers['X-Workspace-Id']).toBe('ws-aaaa');
      expect(init.headers['Authorization']).toBe('Bearer svc-token-mo');

      expect(page.count).toBe(1);
      expect(page.nextCursor).toBe('cur2');
      expect(page.items[0]).toMatchObject({
        id: 'mtg-1',
        title: 'Discovery call',
        durationSeconds: 2700,
        status: 'summarized',
        hasSummary: true,
        actionItemCount: 2,
      });
      // Participant matched to a Contact-Ops contact carries the federated id.
      expect(page.items[0].participants[0]).toMatchObject({
        contactId: 'contact-42',
        displayName: 'Jane Lead',
      });
      // Unmatched participant has a null contactId (never fabricated).
      expect(page.items[0].participants[1]).toMatchObject({ contactId: null, displayName: 'Aaron' });
    });

    it('list_summaries_for_contact: maps Summary → FederatedMeetingSummary', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            summaries: [
              {
                id: 'sum-1',
                meeting_id: 'mtg-1',
                headline: 'Jane wants the enterprise tier',
                body: 'Discussed pricing and a Q3 rollout…',
                key_points: ['enterprise tier', 'Q3 rollout', 'security review'],
                created_at: '2026-06-01T16:00:00Z',
              },
            ],
          }),
        ),
      ) as any;
      const client = new MeetingOpsClient(makeConfig(env));

      const summaries = await client.listSummariesForContact(CTX, 'contact-42');
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        id: 'sum-1',
        meetingId: 'mtg-1',
        headline: 'Jane wants the enterprise tier',
      });
      expect(summaries[0].keyPoints).toEqual(['enterprise tier', 'Q3 rollout', 'security review']);
    });

    it('list_action_items_for_contact: maps ActionItem → FederatedActionItem and SURFACES project_ops_task_id', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            action_items: [
              {
                id: 'ai-1',
                meeting_id: 'mtg-1',
                text: 'Send the enterprise quote',
                status: 'open',
                assignee_contact_id: null,
                assignee_label: 'Aaron',
                due_at: '2026-06-05',
                project_ops_task_id: 'task-789', // Meeting-Ops bridge already made the task
                created_at: '2026-06-01T16:00:00Z',
              },
              {
                id: 'ai-2',
                meeting_id: 'mtg-1',
                text: 'Schedule the security review',
                status: 'done',
                created_at: '2026-06-01T16:00:00Z',
              },
            ],
          }),
        ),
      ) as any;
      const client = new MeetingOpsClient(makeConfig(env));

      const items = await client.listActionItemsForContact(CTX, 'contact-42');
      expect(items).toHaveLength(2);
      // We SURFACE the Project-Ops task id (a "→ task" indicator); we never write it.
      expect(items[0]).toMatchObject({
        id: 'ai-1',
        text: 'Send the enterprise quote',
        status: 'open',
        projectOpsTaskId: 'task-789',
      });
      // An action item with no bridge task has a null projectOpsTaskId.
      expect(items[1]).toMatchObject({ id: 'ai-2', status: 'done', projectOpsTaskId: null });
    });

    it('getMeetingSignal: derives a compact digest from the three reads', async () => {
      const fetchSpy = jest.fn().mockImplementation((_url: string, init: any) => {
        const body = JSON.parse(init.body);
        const name = body.params.name;
        if (name === 'list_meetings_for_contact') {
          return Promise.resolve(
            jsonResponse(
              rpcOk({
                meetings: [
                  { id: 'mtg-old', title: 'Old', started_at: '2026-05-01T10:00:00Z', status: 'summarized', has_summary: true, action_item_count: 1 },
                  { id: 'mtg-new', title: 'Latest sync', started_at: '2026-06-02T10:00:00Z', status: 'summarized', has_summary: true, action_item_count: 2 },
                ],
                count: 2,
              }),
            ),
          );
        }
        if (name === 'list_summaries_for_contact') {
          return Promise.resolve(
            jsonResponse(
              rpcOk({
                summaries: [
                  { id: 's-old', meeting_id: 'mtg-old', headline: 'old headline', created_at: '2026-05-01T11:00:00Z' },
                  { id: 's-new', meeting_id: 'mtg-new', headline: 'Ready to buy', created_at: '2026-06-02T11:00:00Z' },
                ],
              }),
            ),
          );
        }
        // action items
        return Promise.resolve(
          jsonResponse(
            rpcOk({
              action_items: [
                { id: 'ai-1', meeting_id: 'mtg-new', text: 'a', status: 'open' },
                { id: 'ai-2', meeting_id: 'mtg-new', text: 'b', status: 'in_progress' },
                { id: 'ai-3', meeting_id: 'mtg-old', text: 'c', status: 'done' },
              ],
            }),
          ),
        );
      });
      global.fetch = fetchSpy as any;
      const client = new MeetingOpsClient(makeConfig(env));

      const signal = await client.getMeetingSignal(CTX, 'contact-42');
      expect(signal.meetingCount).toBe(2);
      // Newest meeting wins regardless of array order.
      expect(signal.lastMeetingAt).toBe('2026-06-02T10:00:00Z');
      expect(signal.lastMeetingTitle).toBe('Latest sync');
      // Only open + in_progress count toward the open total (done excluded).
      expect(signal.openActionItemCount).toBe(2);
      // Freshest summary headline.
      expect(signal.latestSummaryHeadline).toBe('Ready to buy');
      // One fan-out call per read tool.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('returns empty (never throws) on a JSON-RPC error envelope', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }),
      ) as any;
      const client = new MeetingOpsClient(makeConfig(env));
      await expect(client.listMeetingsForContact(CTX, 'p1')).resolves.toEqual({
        items: [],
        count: 0,
        nextCursor: null,
      });
    });

    it('returns empty (never throws) when the tool result is isError', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'CONTACT_NOT_FOUND' }] },
        }),
      ) as any;
      const client = new MeetingOpsClient(makeConfig(env));
      await expect(client.listActionItemsForContact(CTX, 'missing')).resolves.toEqual([]);
    });

    it('returns empty (never throws) on a transport error / HTTP 500', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const client = new MeetingOpsClient(makeConfig(env));
      await expect(client.listMeetingsForContact(CTX, 'p1')).resolves.toEqual({
        items: [],
        count: 0,
        nextCursor: null,
      });
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, false, 500)) as any;
      const client2 = new MeetingOpsClient(makeConfig(env));
      await expect(client2.listSummariesForContact(CTX, 'p1')).resolves.toEqual([]);
    });
  });
});
