// V9 (#38): real sockets against the local Realtime server. pgTAP checks what is sent and the
// policies; this checks that a committed change arrives and that the server enforces the policies.
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, connect, createWorld, join, type Sql, type World } from './db';

const API_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:55321';
/** The local CLI's fixed JWT secret (`supabase status`); never a real project's. */
const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';

function jwt(claims: Record<string, unknown>) {
  const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({
    iss: 'supabase-demo',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  })}`;
  return `${body}.${createHmac('sha256', JWT_SECRET).update(body).digest('base64url')}`;
}
const ANON = jwt({ role: 'anon' });
const staffToken = (userId: string) =>
  jwt({ role: 'authenticated', aud: 'authenticated', sub: userId });

interface Message {
  event: string;
  payload: Record<string, unknown>;
}

/** One Phoenix channel on its own socket, recording every broadcast it receives. */
class Channel {
  readonly received: Message[] = [];
  private ws: WebSocket;
  private readonly joined: Promise<'ok' | 'error'>;

  constructor(
    readonly topic: string,
    token: string,
  ) {
    this.ws = new WebSocket(
      `${API_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${ANON}&vsn=1.0.0`,
    );
    this.joined = new Promise((resolve) => {
      this.ws.onopen = () =>
        this.send('phx_join', {
          config: { broadcast: { self: false }, presence: { key: '' }, private: true },
          access_token: token,
        });
      this.ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.event === 'phx_reply' && msg.ref === '1') resolve(msg.payload.status);
        else if (msg.event === 'phx_error' || msg.event === 'phx_close') resolve('error');
        else if (msg.event === 'broadcast') this.received.push(msg.payload);
      };
    });
  }

  private ref = 0;
  send(event: string, payload: object) {
    this.ws.send(
      JSON.stringify({ topic: `realtime:${this.topic}`, event, payload, ref: String(++this.ref) }),
    );
  }

  join() {
    return this.joined;
  }

  close() {
    this.ws.close();
  }
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
}

let admin: Sql;
let world: World;
let other: World;
let locationTopic: string;
let pulseTopic: string;
const channels: Channel[] = [];

function open(topic: string, token: string) {
  const c = new Channel(topic, token);
  channels.push(c);
  return c;
}

beforeAll(async () => {
  admin = connect(4);
  [world, other] = [await createWorld(admin), await createWorld(admin)];
  const [q] = await admin<{ location_id: string; pulse_id: string }[]>`
    select location_id, pulse_id from app.queues where id = ${world.queueId}`;
  locationTopic = `loc:${q!.location_id}`;
  pulseTopic = `qpulse:${q!.pulse_id}`;
});

afterAll(async () => {
  channels.forEach((c) => c.close());
  await admin.end();
});

describe('realtime signals', () => {
  it('AC2: only staff of the location may join its loc: topic', async () => {
    expect(await open(locationTopic, staffToken(world.staff[0])).join()).toBe('ok');
    expect(await open(locationTopic, staffToken(other.staff[0])).join()).toBe('error');
    expect(await open(locationTopic, ANON).join()).toBe('error');
  });

  it('AC1: a committed change reaches staff and guests; the pulse is only {version, now_serving}', async () => {
    const staff = open(locationTopic, staffToken(world.staff[0]));
    const guest = open(pulseTopic, ANON);
    expect(await staff.join()).toBe('ok');
    expect(await guest.join()).toBe('ok');

    await join(admin, world.queueId);
    await asStaff(
      admin,
      world.staff[0],
      (tx) => tx`select api.call_next(${world.queueId}, ${world.counters[0]}, ${randomUUID()})`,
    );
    await until(() => guest.received.length >= 2 && staff.received.length >= 2);

    expect(guest.received.map((m) => m.event)).toEqual(['pulse', 'pulse']);
    const called = guest.received[1]!.payload;
    expect(Object.keys(called).sort()).toEqual(['id', 'now_serving', 'version']);
    expect(called.now_serving).toBe('R001');
    expect(staff.received.map((m) => m.event)).toEqual(['signal', 'signal']);
    expect(staff.received[1]!.payload.queue_id).toBe(world.queueId);
    expect(staff.received[1]!.payload.version).toBe(called.version);
  });

  it('a guest cannot forge a pulse to other guests', async () => {
    const forger = open(pulseTopic, ANON);
    const victim = open(pulseTopic, ANON);
    expect(await forger.join()).toBe('ok');
    expect(await victim.join()).toBe('ok');

    forger.send('broadcast', { type: 'broadcast', event: 'pulse', payload: { version: 1e9 } });
    await new Promise((r) => setTimeout(r, 1500));
    expect(victim.received).toEqual([]);
  });
});
