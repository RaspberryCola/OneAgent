import { TerminalDisplay } from "../chat/TerminalDisplay";
import type * as Types from "../../lib/backend/types";
import { ErrorMessage } from "./ErrorMessage";
import { MessageBubble } from "./MessageBubble";
import { PlanMessage } from "./PlanMessage";
import { StatusMessage } from "./StatusMessage";

type TimelineMessageProps = {
  message: Types.MessageProjection;
  terminals: Types.TerminalRecord[];
  lastAgentMessageIdsPerTurn: Map<string, string>;
};

export function TimelineMessage({
  message,
  terminals,
  lastAgentMessageIdsPerTurn,
}: TimelineMessageProps) {
  if (message.kind === "plan") {
    return null;
  }

  if (message.kind === "terminal") {
    return (
      <TerminalDisplay
        content={message.content_json?.content || ""}
        stream={message.content_json?.stream || "stdout"}
        event={message.content_json?.event || "running"}
        terminal={terminals.find((item) => item.terminal_id === message.content_json?.terminal_id) ?? null}
      />
    );
  }

  if (message.kind === "status") {
    return <StatusMessage content={message.content_json?.message || message.content_json?.text || ""} />;
  }

  if (message.kind === "error") {
    return <ErrorMessage content={message.content_json?.message || message.content_json?.text || ""} />;
  }

  const isLastAgentInTurn =
    message.role === "agent"
    && message.kind === "text"
    && !!message.turn_id
    && lastAgentMessageIdsPerTurn.get(message.turn_id) === message.id;

  return (
    <MessageBubble
      role={message.role as "user" | "agent" | "assistant" | "tool" | "system"}
      content={message.content_json?.text || message.content_json?.message || ""}
      attachments={Array.isArray(message.content_json?.attachments) ? message.content_json.attachments : []}
      kind={message.kind}
      contentJson={message.content_json}
      messageId={message.id}
      isLastAgentMessage={isLastAgentInTurn}
    />
  );
}
