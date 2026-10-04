'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
} from '@assistant-ui/react';

const SUGGESTIONS = ['status', 'drop floor to 150', 'take best offer', 'digest'];

interface Props {
  /** Called after every operator reply so the panels update right away. */
  onReply: () => void;
  mock: boolean;
}

/** Henri steering the agent in plain words. assistant-ui on a local runtime; the model lives in apps/api. */
export function OperatorChat({ onReply, mock }: Props) {
  const onReplyRef = useRef(onReply);
  useEffect(() => {
    onReplyRef.current = onReply;
  }, [onReply]);

  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async run({ messages, abortSignal }) {
        const last = messages[messages.length - 1];
        const text = (last?.content ?? [])
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('\n')
          .trim();

        let reply: string;
        try {
          const res = await fetch(`/api/operator${mock ? '?mock=1' : ''}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
            signal: abortSignal,
          });
          const data = (await res.json().catch(() => null)) as { reply?: string } | null;
          reply = data?.reply || `The board could not get an answer (${res.status}).`;
        } catch (err) {
          if (abortSignal.aborted) throw err;
          reply = 'Could not reach the board server.';
        }
        onReplyRef.current();
        return { content: [{ type: 'text', text: reply }] };
      },
    }),
    [mock],
  );

  const runtime = useLocalRuntime(adapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="thread__viewport">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <div className="thread__empty">
              <p className="thread__lead">Tell Lowball what to do.</p>
              <div className="suggestions">
                {SUGGESTIONS.map((prompt) => (
                  <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send className="suggestion">
                    {prompt}
                  </ThreadPrimitive.Suggestion>
                ))}
              </div>
            </div>
          </AuiIf>
          <ThreadPrimitive.Messages>
            {({ message }) => {
              if (message.role === 'user') return <UserMessage />;
              if (message.content.length === 0) return <PendingMessage />;
              return <AssistantMessage />;
            }}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="composer">
          <ComposerPrimitive.Input className="composer__input" placeholder="drop floor to 150" rows={1} aria-label="Message the agent" />
          <ComposerPrimitive.Send className="composer__send">Send</ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="bubble bubble--user">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="bubble bubble--agent">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function PendingMessage() {
  return (
    <MessagePrimitive.Root className="bubble bubble--agent bubble--pending">
      <span className="dots" aria-label="Working">
        <i />
        <i />
        <i />
      </span>
    </MessagePrimitive.Root>
  );
}
