'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { Badge, Button, Card, CardBody, CardHeader } from '@/components/ui';
import { API_BASE } from '@/lib/api';
import {
  CONNECT_TABS,
  type ConnectTabId,
  claudeCodeOauthCommand,
  claudeCodeTokenCommand,
  mcpJsonSnippet,
  TOKEN_PLACEHOLDER,
} from '@/lib/connectSnippets';
import { mcpUrlFromApiBase } from '@/lib/mcpPublicUrl';

/**
 * Settings → Connect your AI.
 *
 * The panel contains instructions only. OAuth is initiated by the client
 * command; PATs are minted and revealed exactly once by ApiTokensCard below.
 * This component never receives or stores a real token.
 */
export function ConnectYourAiPanel() {
  const configured = /^https?:\/\//i.test(API_BASE.trim());
  const [url, setUrl] = useState(() => mcpUrlFromApiBase(API_BASE));
  const [ready, setReady] = useState(configured);
  const [tab, setTab] = useState<ConnectTabId>('claude-code');

  useEffect(() => {
    setUrl(mcpUrlFromApiBase(API_BASE, window.location.origin));
    setReady(true);
    // API_BASE is a build-time public constant; the browser origin is the only
    // runtime input needed for the same-origin fallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card id="connect-your-ai">
      <CardHeader className="flex-col items-stretch gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <Badge variant="accent">Bring your own AI</Badge>
          <h2 className="mt-2 text-base font-semibold tracking-tight text-primary">Connect your AI</h2>
          <p className="mt-1 text-sm leading-6 text-tertiary">
            Your AI gets your permissions and nothing more; revoke any time below.
          </p>
        </div>
      </CardHeader>

      <CardBody className="space-y-4">
        <div role="tablist" aria-label="Connect your AI clients" className="flex flex-wrap gap-1.5">
          {CONNECT_TABS.map((item) => {
            const selected = item.id === tab;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`connect-your-ai-tab-${item.id}`}
                aria-selected={selected}
                aria-controls={`connect-your-ai-panel-${item.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => moveTab(event, tab, setTab)}
                className={
                  selected
                    ? 'min-h-[44px] rounded-token border border-accent bg-accent/10 px-2.5 py-1.5 text-left text-xs font-medium text-primary sm:min-h-8'
                    : 'min-h-[44px] rounded-token border border-subtle bg-surface-base px-2.5 py-1.5 text-left text-xs font-medium text-secondary hover:bg-surface-overlay hover:text-primary sm:min-h-8'
                }
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {!ready ? (
          <p className="text-sm text-tertiary">Reading this site&rsquo;s address…</p>
        ) : (
          <div
            role="tabpanel"
            id={`connect-your-ai-panel-${tab}`}
            aria-labelledby={`connect-your-ai-tab-${tab}`}
            className="space-y-4"
          >
            {tab === 'claude-code' && <ClaudeCodeTab url={url} />}
            {tab === 'claude-desktop' && <UrlStepsTab url={url} steps={CLAUDE_DESKTOP_STEPS} />}
            {tab === 'chatgpt' && <UrlStepsTab url={url} steps={CHATGPT_STEPS} />}
            {tab === 'other' && <OtherClientsTab url={url} />}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

const CLAUDE_DESKTOP_STEPS = [
  'Settings',
  'Connectors',
  'Add custom connector',
  'URL',
] as const;

const CHATGPT_STEPS = [
  'Settings',
  'Connectors',
  'Developer mode',
  'New connector',
  'URL',
] as const;

function ClaudeCodeTab({ url }: { url: string }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm leading-6 text-secondary">
          Run this command. A browser window asks you to sign in, then Claude Code can use
          Customer-Ops with your account permissions.
        </p>
        <Snippet text={claudeCodeOauthCommand(url)} label="Copy sign-in command" />
      </div>
      <div>
        <p className="text-sm leading-6 text-secondary">
          Or paste a token. Replace <span className="font-mono text-[0.92em]">{TOKEN_PLACEHOLDER}</span>{' '}
          with the token shown once below.
        </p>
        <Snippet text={claudeCodeTokenCommand(url)} label="Copy token command" />
      </div>
    </div>
  );
}

function UrlStepsTab({ url, steps }: { url: string; steps: readonly string[] }) {
  return (
    <div className="space-y-3">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-secondary">
        {steps.map((step, index) => (
          <li key={step} className="flex items-center gap-2">
            {index > 0 && <span aria-hidden className="text-tertiary">→</span>}
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm leading-6 text-tertiary">A sign-in window appears for your account.</p>
      <Snippet text={url} label="Copy URL" />
    </div>
  );
}

function OtherClientsTab({ url }: { url: string }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm leading-6 text-secondary">
          Cursor, Codex, and other clients take an <span className="font-mono text-[0.92em]">mcp.json</span>{' '}
          entry. Sign-in uses the URL alone.
        </p>
        <Snippet text={mcpJsonSnippet(url, false)} label="Copy mcp.json" />
      </div>
      <div>
        <p className="text-sm leading-6 text-secondary">
          Or send a token in the <span className="font-mono text-[0.92em]">Authorization</span> header.
          Replace the placeholder with the token shown once below.
        </p>
        <Snippet text={mcpJsonSnippet(url, true)} label="Copy token mcp.json" />
      </div>
    </div>
  );
}

function Snippet({ text, label }: { text: string; label: string }) {
  return (
    <div className="mt-2">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-token bg-surface-base p-3 font-mono text-[11px] leading-5 text-secondary">
        <code>{text}</code>
      </pre>
      <div className="mt-2">
        <CopyButton value={text} label={label} />
      </div>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [note, setNote] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function handleCopy() {
    const writer = navigator.clipboard?.writeText;
    if (!writer) {
      setNote('failed');
      return;
    }

    try {
      await writer.call(navigator.clipboard, value);
      setNote('copied');
      window.setTimeout(() => setNote('idle'), 2000);
    } catch {
      setNote('failed');
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={() => void handleCopy()}
      aria-label={note === 'copied' ? `${label} copied` : label}
    >
      {note === 'copied' ? 'Copied' : note === 'failed' ? 'Copy failed' : label}
    </Button>
  );
}

function moveTab(
  event: KeyboardEvent<HTMLButtonElement>,
  current: ConnectTabId,
  setTab: (id: ConnectTabId) => void,
) {
  const index = CONNECT_TABS.findIndex((item) => item.id === current);
  if (index < 0) return;

  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % CONNECT_TABS.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + CONNECT_TABS.length) % CONNECT_TABS.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = CONNECT_TABS.length - 1;
  else return;

  event.preventDefault();
  const id = CONNECT_TABS[next].id;
  setTab(id);
  const target = document.getElementById(`connect-your-ai-tab-${id}`);
  if (target instanceof HTMLButtonElement) target.focus();
}
