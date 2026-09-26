/**
 * Server-sent events, both ends. Pure: no fetch, no timers.
 *
 * The wire format is lines of `field: value` ending in a blank line. `data`
 * lines join with newlines, `event` names the record, a line starting with a
 * colon is a comment (used as a keepalive). Records may straddle chunks, so
 * the parser keeps a tail between calls.
 */

export interface SseEvent {
  event: string;
  data: string;
}

/** Encode one event for the wire. */
export function formatSseEvent(event: string, data: string): string {
  const lines = data.split("\n").map((l) => `data: ${l}`);
  return `event: ${event}\n${lines.join("\n")}\n\n`;
}

/** An incremental parser: feed text, get complete events back. */
export function createSseParser(): (chunk: string) => SseEvent[] {
  let tail = "";
  let event = "message";
  let data: string[] = [];
  return (chunk: string) => {
    const out: SseEvent[] = [];
    tail += chunk;
    let nl = tail.indexOf("\n");
    while (nl !== -1) {
      const line = tail.slice(0, nl).replace(/\r$/, "");
      tail = tail.slice(nl + 1);
      if (line === "") {
        if (data.length > 0) out.push({ event, data: data.join("\n") });
        event = "message";
        data = [];
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        // id and retry are accepted and ignored: reconnection is the hook's.
      }
      nl = tail.indexOf("\n");
    }
    return out;
  };
}
