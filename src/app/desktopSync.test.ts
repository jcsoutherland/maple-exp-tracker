import { describe, expect, it } from 'vitest';
import type { SavedSession } from '../core/session';
import { applySetupBundle, mergeSessions, resolveIdle, setupBundle, type KeyStore } from './desktopSync';

/** an in-memory localStorage */
function memoryStore(init: Record<string, string> = {}): KeyStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    get length() { return data.size; },
    key: i => [...data.keys()][i] ?? null,
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: k => { data.delete(k); },
  };
}
const session = (id: number, start = id) => ({ id, start, end: start + 1000 }) as SavedSession;

describe('setup sync', () => {
  it('sends settings, character and every ratio of boxes, but not sessions', () => {
    const web = memoryStore({ 'met.settings': '{"a":1}', 'met.identity': '{}', 'met.regions': '{}', 'met.regions.ideal': '{}', 'met.sessions': '[]', 'met.active': '{}' });
    expect(Object.keys(setupBundle(web)).sort()).toEqual(['met.identity', 'met.regions', 'met.regions.ideal', 'met.settings']);
  });
  it('leaves the characters\' History pictures behind', () => {
    const web = memoryStore({ 'met.chars': JSON.stringify({ Flynny: { cls: 'Hunter', thumb: 'data:image/png;base64,AAAA' } }) });
    expect(JSON.parse(setupBundle(web)['met.chars'])).toEqual({ Flynny: { cls: 'Hunter' } });
  });
  it('the app ends up with the website\'s setup, including boxes reset there', () => {
    const app = memoryStore({ 'met.settings': '{"old":1}', 'met.regions.ideal': '{"x":1}', 'met.sessions': '[1]' });
    applySetupBundle(app, { 'met.settings': '{"new":1}' });
    expect(Object.fromEntries(app.data)).toEqual({ 'met.settings': '{"new":1}', 'met.sessions': '[1]' });
  });
});

describe('session sync', () => {
  it('adds each of the app\'s sessions to History once, oldest first', () => {
    const { list } = mergeSessions([session(10), session(30)], [session(20), session(30), session(20)]);
    expect(list.map(s => s.id)).toEqual([10, 20, 30]);
  });
  it('reports only the sessions that were new', () => {
    expect(mergeSessions([session(10)], [session(10), session(40)]).added.map(s => s.id)).toEqual([40]);
  });
});

describe('auto-pause sync', () => {
  it('the overlay\'s change carries over when the website kept its own', () => {
    expect(resolveIdle({ value: 60, at: 500 }, 100, 200)).toBe(60);
  });
  it('the website wins when both changed it while apart', () => {
    expect(resolveIdle({ value: 60, at: 500 }, 300, 200)).toBeNull();
  });
  it('nothing changes when the overlay changed nothing', () => {
    expect(resolveIdle(null, 300, 200)).toBeNull();
  });
});
