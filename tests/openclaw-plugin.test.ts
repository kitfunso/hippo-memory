import { beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.fn();
const existsSyncMock = vi.fn((target: string) => target.includes('.hippo'));

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

type HookHandler = (
  event: { prompt: string; messages: unknown[] },
  ctx: { workspaceDir?: string },
) => { appendSystemContext?: string } | undefined;

type VoidHookHandler<Event = unknown, Ctx = unknown> = (event: Event, ctx: Ctx) => void | Promise<void>;

function makeApi(config: Record<string, unknown>) {
  const toolRegistrations: Array<ToolDef | ((ctx: { workspaceDir?: string }) => ToolDef)> = [];
  const hooks = new Map<string, HookHandler | VoidHookHandler>();

  return {
    api: {
      config,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      registerTool: vi.fn(
        (tool: ToolDef | ((ctx: { workspaceDir?: string }) => ToolDef)) => toolRegistrations.push(tool),
      ),
      on: vi.fn((event: string, handler: HookHandler | VoidHookHandler) => hooks.set(event, handler)),
    },
    getTool(name: string, ctx: { workspaceDir?: string } = {}) {
      for (const registration of toolRegistrations) {
        const tool = typeof registration === 'function' ? registration(ctx) : registration;
        if (tool.name === name) {
          return tool;
        }
      }
      throw new Error(`Tool not found: ${name}`);
    },
    getHook(name: string) {
      const hook = hooks.get(name);
      if (!hook) {
        throw new Error(`Hook not found: ${name}`);
      }
      return hook as HookHandler;
    },
    getVoidHook<Event = unknown, Ctx = unknown>(name: string) {
      const hook = hooks.get(name);
      if (!hook) {
        throw new Error(`Hook not found: ${name}`);
      }
      return hook as VoidHookHandler<Event, Ctx>;
    },
  };
}

function hippoConfig(overrides: Record<string, unknown> = {}) {
  return {
    agents: {
      defaults: {
        workspace: 'C:/Users/skf_s/.openclaw/workspace',
      },
      list: [
        {
          id: 'main',
          default: true,
          workspace: 'C:/Users/skf_s/clawd',
        },
      ],
    },
    plugins: {
      entries: {
        'hippo-memory': {
          config: {
            budget: 1500,
            autoContext: true,
            framing: 'observe',
            ...overrides,
          },
        },
      },
    },
  };
}

describe('openclaw hippo plugin', () => {
  beforeEach(() => {
    vi.resetModules();
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue('Memory context from hippo');
    existsSyncMock.mockClear();
    existsSyncMock.mockImplementation((target: string) => target.includes('.hippo'));
  });

  it('uses workspaceDir for tool execution by default', async () => {
    const { default: register } = await import('../extensions/openclaw-plugin/index.ts');
    const harness = makeApi(hippoConfig());

    register(harness.api);

    const tool = harness.getTool('hippo_recall', { workspaceDir: 'C:\\repo\\clawd' });
    await tool.execute('tool-1', { query: 'cache refresh' });

    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(execSyncMock.mock.calls[0]?.[1]).toMatchObject({ cwd: 'C:\\repo\\clawd' });
  });

  it('uses workspaceDir for prompt hook auto-context', async () => {
    const { default: register } = await import('../extensions/openclaw-plugin/index.ts');
    const harness = makeApi(hippoConfig());

    register(harness.api);

    const hook = harness.getHook('before_prompt_build');
    const result = hook({ prompt: 'help', messages: [] }, { workspaceDir: 'C:\\repo\\clawd' });

    // 2 calls: session_start event + context injection
    expect(execSyncMock).toHaveBeenCalledTimes(2);
    expect(execSyncMock.mock.calls[0]?.[0]).toContain('session log');
    expect(execSyncMock.mock.calls[0]?.[1]).toMatchObject({ cwd: 'C:\\repo\\clawd' });
    expect(execSyncMock.mock.calls[1]?.[0]).toContain('context');
    expect(execSyncMock.mock.calls[1]?.[1]).toMatchObject({ cwd: 'C:\\repo\\clawd' });
    expect(result).toMatchObject({
      appendSystemContext: expect.stringContaining('Project Memory (Hippo)'),
    });
  });

  it('lets config.root override workspaceDir when root points at a .hippo directory', async () => {
    const { default: register } = await import('../extensions/openclaw-plugin/index.ts');
    const harness = makeApi(
      hippoConfig({
        root: 'D:\\shared\\workspace\\.hippo',
      }),
    );

    register(harness.api);

    const tool = harness.getTool('hippo_recall', { workspaceDir: 'C:\\repo\\clawd' });
    await tool.execute('tool-2', { query: 'shared memory' });

    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(execSyncMock.mock.calls[0]?.[1]).toMatchObject({ cwd: 'D:\\shared\\workspace' });
  });

  it('autoLearn stores a Hippo error memory when a tool call fails', async () => {
    const { default: register } = await import('../extensions/openclaw-plugin/index.ts');
    const harness = makeApi(hippoConfig({ autoLearn: true }));

    register(harness.api);

    const hook = harness.getVoidHook<
      { toolName: string; params: Record<string, unknown>; error?: string },
      { agentId?: string; sessionId?: string; toolName: string }
    >('after_tool_call');

    execSyncMock.mockClear();
    await hook(
      {
        toolName: 'browser_open',
        params: { url: 'https://example.com' },
        error: 'navigation timeout after 30000ms',
      },
      {
        agentId: 'main',
        sessionId: 'session-1',
        toolName: 'browser_open',
      },
    );

    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(execSyncMock.mock.calls[0]?.[0]).toContain('remember');
    expect(execSyncMock.mock.calls[0]?.[0]).toContain('--error');
    expect(execSyncMock.mock.calls[0]?.[0]).toContain('browser_open');
    expect(execSyncMock.mock.calls[0]?.[1]).toMatchObject({ cwd: 'C:\\Users\\skf_s\\clawd' });
  });

  it('autoSleep consolidates only after sessions with at least 10 new memories', async () => {
    const { default: register } = await import('../extensions/openclaw-plugin/index.ts');
    const harness = makeApi(hippoConfig({ autoSleep: true }));

    execSyncMock.mockImplementation((command: string) => {
      if (command.startsWith('hippo remember ')) return 'Remembered [mem-123]';
      if (command.startsWith('hippo sleep')) return 'Sleep complete';
      return 'Memory context from hippo';
    });

    register(harness.api);

    const lightSessionTool = harness.getTool('hippo_remember', {
      workspaceDir: 'C:\\repo\\clawd',
      agentId: 'main',
      sessionId: 'session-light',
    });
    const sessionEndHook = harness.getVoidHook<
      { sessionId: string; messageCount: number },
      { agentId?: string; sessionId: string }
    >('session_end');

    execSyncMock.mockClear();

    for (let i = 0; i < 9; i++) {
      await lightSessionTool.execute(`remember-light-${i}`, { text: `lesson ${i}` });
    }

    await sessionEndHook(
      { sessionId: 'session-light', messageCount: 20 },
      { agentId: 'main', sessionId: 'session-light' },
    );

    expect(execSyncMock.mock.calls.some((call) => String(call[0]).includes('sleep'))).toBe(false);

    const heavySessionTool = harness.getTool('hippo_remember', {
      workspaceDir: 'C:\\repo\\clawd',
      agentId: 'main',
      sessionId: 'session-heavy',
    });

    for (let i = 0; i < 10; i++) {
      await heavySessionTool.execute(`remember-heavy-${i}`, { text: `heavy lesson ${i}` });
    }

    await sessionEndHook(
      { sessionId: 'session-heavy', messageCount: 21 },
      { agentId: 'main', sessionId: 'session-heavy' },
    );

    const sleepCalls = execSyncMock.mock.calls.filter((call) => String(call[0]).includes('sleep'));
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]?.[1]).toMatchObject({ cwd: 'C:\\Users\\skf_s\\clawd' });
  });
});
