import { describe, expect, it } from 'vitest';
import { clickAction, noticeFor } from './pushRouting.ts';

const ORIGIN = 'https://q.example';

describe('noticeFor', () => {
  it('shows the dispatcher payload', () => {
    const data = JSON.stringify({ title: 'A012', body: "It's your turn", tag: 'visit' });
    expect(noticeFor(data)).toEqual({
      title: 'A012',
      body: "It's your turn",
      tag: 'visit',
      url: null,
    });
  });

  it('still shows something for an empty or non-JSON push (browsers require it)', () => {
    expect(noticeFor(null)).toEqual({ title: 'QueueThat', body: '', tag: 'visit', url: null });
    expect(noticeFor('plain text')).toMatchObject({ title: 'QueueThat', body: 'plain text' });
  });

  it('keeps a url the dispatcher sends', () => {
    expect(noticeFor(JSON.stringify({ body: 'x', url: '/v/abc' })).url).toBe('/v/abc');
  });
});

describe('clickAction', () => {
  it('opens the status page this browser turned alerts on for', () => {
    expect(clickAction(null, 'tok-1', [], ORIGIN)).toEqual({ open: '/v/tok-1' });
  });

  it('focuses a window already showing that status page instead of opening another', () => {
    const windows = [`${ORIGIN}/q/demo`, `${ORIGIN}/v/tok-1`];
    expect(clickAction(null, 'tok-1', windows, ORIGIN)).toEqual({ focus: 1 });
  });

  it('prefers a same-origin /v/ url from the push over the stored visit', () => {
    expect(clickAction('/v/tok-2', 'tok-1', [], ORIGIN)).toEqual({ open: '/v/tok-2' });
    expect(clickAction(`${ORIGIN}/v/tok-2`, null, [], ORIGIN)).toEqual({ open: '/v/tok-2' });
  });

  it('opens the appointment page a reminder names, and focuses it when already open', () => {
    expect(clickAction('/a/apt-1', 'tok-1', [], ORIGIN)).toEqual({ open: '/a/apt-1' });
    expect(clickAction('/a/apt-1', null, [`${ORIGIN}/a/apt-1`], ORIGIN)).toEqual({ focus: 0 });
    expect(clickAction(null, null, [`${ORIGIN}/a/apt-1`], ORIGIN)).toEqual({ focus: 0 });
  });

  it('ignores push urls that leave the status pages or the origin', () => {
    expect(clickAction('https://evil.example/v/x', 'tok-1', [], ORIGIN)).toEqual({
      open: '/v/tok-1',
    });
    expect(clickAction('/staff', null, [], ORIGIN)).toEqual({ open: '/' });
  });

  it('without a known visit, focuses any open status page, else opens the home page', () => {
    expect(clickAction(null, null, [`${ORIGIN}/`, `${ORIGIN}/v/x`], ORIGIN)).toEqual({ focus: 1 });
    expect(clickAction(null, null, ['https://other.example/v/x'], ORIGIN)).toEqual({ open: '/' });
  });

  it('escapes the stored token into one path segment', () => {
    expect(clickAction(null, 'a/b?c', [], ORIGIN)).toEqual({ open: '/v/a%2Fb%3Fc' });
  });
});
