import { expect } from "vitest";

import { messagesStreamEvent, type MessagesStreamEvent } from "../schemas/messages";
import {
  completedFunctionCall,
  responsesStreamEvent,
  type ResponsesStreamEvent,
} from "../schemas/responses";
import type { SseFrame } from "./sse";

const DELTA_KIND: Record<string, string> = {
  text_delta: "text",
  input_json_delta: "tool_use",
  thinking_delta: "thinking",
  signature_delta: "thinking",
};

/** Anthropic Messages SSE grammar: start, sequential blocks, then delta+stop or a terminal error. */
export function assertMessagesStreamGrammar(frames: SseFrame[]): MessagesStreamEvent[] {
  const events = frames.map((frame) => {
    expect(frame.event).toBe(frame.data.type);
    return messagesStreamEvent.parse(frame.data);
  });
  expect(events.length).toBeGreaterThan(0);
  expect(events[0].type).toBe("message_start");

  const open = new Map<number, string>();
  const closed = new Set<number>();
  let nextIndex = 0;
  let sawMessageDelta = false;

  events.forEach((event, i) => {
    const isLast = i === events.length - 1;
    switch (event.type) {
      case "message_start":
        expect(i).toBe(0);
        break;
      case "content_block_start":
        expect(sawMessageDelta).toBe(false);
        expect(open.size).toBe(0);
        expect(event.index).toBe(nextIndex++);
        open.set(event.index, event.content_block.type);
        break;
      case "content_block_delta":
        expect(open.get(event.index)).toBe(DELTA_KIND[event.delta.type]);
        break;
      case "content_block_stop":
        expect(open.has(event.index)).toBe(true);
        open.delete(event.index);
        closed.add(event.index);
        break;
      case "message_delta":
        expect(open.size).toBe(0);
        expect(sawMessageDelta).toBe(false);
        sawMessageDelta = true;
        break;
      case "message_stop":
        expect(sawMessageDelta).toBe(true);
        expect(isLast).toBe(true);
        break;
      case "error":
        expect(open.size).toBe(0);
        expect(isLast).toBe(true);
        break;
    }
  });
  const last = events[events.length - 1].type;
  expect(["message_stop", "error"]).toContain(last);
  return events;
}

const TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed"]);

/** OpenAI Responses SSE grammar: contiguous sequence numbers, paired items, one terminal event. */
export function assertResponsesStreamGrammar(frames: SseFrame[]): ResponsesStreamEvent[] {
  const events = frames.map((frame) => {
    expect(frame.event).toBe(frame.data.type);
    return responsesStreamEvent.parse(frame.data);
  });
  expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
  expect(events[0]?.type).toBe("response.created");
  expect(events[1]?.type).toBe("response.in_progress");

  const openItems = new Map<string, number>();
  const doneItems = new Map<number, unknown>();
  let added = 0;

  events.forEach((event, i) => {
    if (TERMINAL.has(event.type)) expect(i).toBe(events.length - 1);
    switch (event.type) {
      case "response.output_item.added":
        expect(event.output_index).toBe(added++);
        openItems.set(event.item.id, event.output_index);
        break;
      case "response.output_item.done":
        expect(doneItems.has(event.output_index)).toBe(false);
        openItems.delete(event.item.id);
        if (event.item.type === "function_call") completedFunctionCall.parse(event.item);
        doneItems.set(event.output_index, event.item);
        break;
      case "response.content_part.added":
      case "response.content_part.done":
      case "response.output_text.delta":
      case "response.output_text.done":
      case "response.refusal.delta":
      case "response.refusal.done":
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
      case "response.reasoning_summary_part.added":
      case "response.reasoning_summary_part.done":
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_text.done":
        expect(openItems.get(event.item_id)).toBe(event.output_index);
        break;
    }
  });

  const terminal = events[events.length - 1];
  expect(TERMINAL.has(terminal.type)).toBe(true);
  if (terminal.type === "response.completed" || terminal.type === "response.incomplete") {
    expect(openItems.size).toBe(0);
    expect(terminal.response.output).toEqual([...doneItems.keys()].sort((a, b) => a - b).map((k) => doneItems.get(k)));
    expect(terminal.response.usage).not.toBeNull();
  }
  return events;
}
