export interface Outgoing {
  id: number;
  recipient: string;
  body: string;
  segments: number | null;
  status: string | null;
  at: string;
}

export interface Incoming {
  id: number;
  from: string;
  body: string;
  at: string;
}

export interface ThreadMessage {
  key: string;
  direction: 'out' | 'in';
  body: string;
  at: string;
  segments: number | null;
  status: string | null;
}

export interface Thread {
  number: string;
  messages: ThreadMessage[];
  lastAt: string;
}

/** Groups sent SMS and simulated replies by phone number: newest conversation first, oldest message first. */
export function groupThreads(outgoing: Outgoing[], incoming: Incoming[]): Thread[] {
  const byNumber = new Map<string, ThreadMessage[]>();
  const add = (number: string, message: ThreadMessage) =>
    byNumber.set(number, [...(byNumber.get(number) ?? []), message]);
  for (const o of outgoing) {
    add(o.recipient, {
      key: `out-${o.id}`,
      direction: 'out',
      body: o.body,
      at: o.at,
      segments: o.segments,
      status: o.status,
    });
  }
  for (const i of incoming) {
    add(i.from, {
      key: `in-${i.id}`,
      direction: 'in',
      body: i.body,
      at: i.at,
      segments: null,
      status: null,
    });
  }
  return [...byNumber]
    .map(([number, messages]) => {
      const sorted = messages.sort(
        (a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key),
      );
      return { number, messages: sorted, lastAt: sorted[sorted.length - 1]!.at };
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
