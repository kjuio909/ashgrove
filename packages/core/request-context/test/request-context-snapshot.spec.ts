import { vi } from 'vitest';
import { RequestContextSnapshot } from '../request-context-snapshot.js';

describe('RequestContextSnapshot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and reads metadata while active', () => {
    const snapshot = new RequestContextSnapshot();
    expect(snapshot.isFrozen()).toBe(false);
    expect(snapshot.set('a', 1)).toBe(true);
    expect(snapshot.get('a')).toBe(1);
    expect(snapshot.has('a')).toBe(true);
    expect(snapshot.keys()).toEqual(['a']);
    expect(snapshot.getTerminationReason()).toBeNull();
    expect(snapshot.getTerminationCount()).toBe(0);
  });

  it('freezes on terminate and ignores later writes', () => {
    const snapshot = new RequestContextSnapshot();
    snapshot.set('marker', 'm');
    snapshot.terminate('finish');

    expect(snapshot.isFrozen()).toBe(true);
    expect(snapshot.getTerminationReason()).toBe('finish');
    expect(snapshot.getTerminationCount()).toBe(1);
    expect(snapshot.get('marker')).toBe('m');
    expect(snapshot.set('marker', 'changed')).toBe(false);
    expect(snapshot.set('late', 1)).toBe(false);
    expect(snapshot.get('marker')).toBe('m');
    expect(snapshot.has('late')).toBe(false);
  });

  it('terminates at most once regardless of repeated calls', () => {
    const snapshot = new RequestContextSnapshot();
    snapshot.terminate('finish');
    snapshot.terminate('finish');
    snapshot.terminate('abort');
    expect(snapshot.getTerminationCount()).toBe(1);
    expect(snapshot.getTerminationReason()).toBe('finish');
  });

  it('runs each registered callback exactly once after termination', async () => {
    vi.useFakeTimers();
    const snapshot = new RequestContextSnapshot();
    const seen: string[] = [];

    snapshot.registerAfterTerminated(s => seen.push(`a:${s.get('marker')}`));
    snapshot.registerAfterTerminated(s => seen.push(`b:${s.get('marker')}`));
    snapshot.set('marker', 'm');
    snapshot.terminate('finish');
    // A duplicate terminate must not schedule callbacks again.
    snapshot.terminate('finish');

    await vi.runAllTimersAsync();

    expect(seen).toEqual(['a:m', 'b:m']);
    expect(snapshot.getCallbackRecords().map(r => r.state)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('keeps callbacks registered after termination on the same frozen data', async () => {
    vi.useFakeTimers();
    const snapshot = new RequestContextSnapshot();
    snapshot.set('marker', 'early');
    snapshot.terminate('finish');

    let observed: string | undefined;
    snapshot.registerAfterTerminated(s => {
      observed = s.get('marker');
    });
    await vi.runAllTimersAsync();
    expect(observed).toBe('early');
  });

  it('reports independent entries even for identical callbacks', async () => {
    vi.useFakeTimers();
    const snapshot = new RequestContextSnapshot();
    const cb = (s: RequestContextSnapshot) => s.get('marker');
    const id1 = snapshot.registerAfterTerminated(cb);
    const id2 = snapshot.registerAfterTerminated(cb);
    expect(id1).not.toBe(id2);
    snapshot.terminate('finish');
    await vi.runAllTimersAsync();
    const states = snapshot.getCallbackStates();
    expect(states[id1]).toBe('completed');
    expect(states[id2]).toBe('completed');
  });

  it('captures a throwing callback without affecting sibling callbacks', async () => {
    vi.useFakeTimers();
    const snapshot = new RequestContextSnapshot();
    const order: string[] = [];

    snapshot.registerAfterTerminated(() => {
      order.push('before');
    });
    snapshot.registerAfterTerminated(() => {
      throw new Error('boom');
    });
    snapshot.registerAfterTerminated(() => {
      order.push('after');
    });

    snapshot.terminate('finish');
    await vi.runAllTimersAsync();

    expect(order).toEqual(['before', 'after']);
    const records = snapshot.getCallbackRecords();
    expect(records[0].state).toBe('completed');
    expect(records[1].state).toBe('failed');
    expect((records[1].error as Error).message).toBe('boom');
    expect(records[2].state).toBe('completed');
  });

  it('captures asynchronous callback rejections', async () => {
    vi.useFakeTimers();
    const snapshot = new RequestContextSnapshot();
    snapshot.registerAfterTerminated(async () => {
      await Promise.resolve();
      throw new Error('async boom');
    });
    snapshot.terminate('finish');
    await vi.runAllTimersAsync();
    expect(snapshot.getCallbackRecords()[0].state).toBe('failed');
  });

  it('resolves whenFrozen and whenAllCallbacksSettled', async () => {
    vi.useFakeTimers();
    const snapshot = new RequestContextSnapshot();
    let frozen = false;
    let settled = false;
    snapshot.registerAfterTerminated(() => {});
    void snapshot.whenFrozen().then(() => (frozen = true));
    void snapshot.whenAllCallbacksSettled().then(() => (settled = true));

    snapshot.terminate('abort');
    await vi.runAllTimersAsync();

    expect(frozen).toBe(true);
    expect(settled).toBe(true);
    expect(snapshot.getTerminationReason()).toBe('abort');
  });

  it('gives every instance a unique id', () => {
    const ids = new Set(
      Array.from({ length: 10 }, () => new RequestContextSnapshot().id),
    );
    expect(ids.size).toBe(10);
  });

  it('notifies pending-state transitions and re-arms on late registration', async () => {
    vi.useFakeTimers();
    const snapshot = new RequestContextSnapshot();
    const events: boolean[] = [];
    snapshot.addPendingStateListener(pending => events.push(pending));

    snapshot.registerAfterTerminated(() => {});
    // Pre-freeze registration does not emit: the request is itself pending.
    expect(events).toEqual([]);
    expect(snapshot.hasPendingCallbacks()).toBe(true);

    snapshot.terminate('finish');
    expect(events).toEqual([true]);

    await vi.runAllTimersAsync();
    expect(events).toEqual([true, false]);
    expect(snapshot.hasPendingCallbacks()).toBe(false);

    // A callback registered after settlement re-arms pending state.
    snapshot.registerAfterTerminated(() => {});
    expect(events).toEqual([true, false, true]);
    await vi.runAllTimersAsync();
    expect(events).toEqual([true, false, true, false]);
  });

  it('reports no pending work when frozen without callbacks', () => {
    const snapshot = new RequestContextSnapshot();
    const events: boolean[] = [];
    snapshot.addPendingStateListener(pending => events.push(pending));

    snapshot.terminate('abort');
    expect(events).toEqual([false]);
    expect(snapshot.hasPendingCallbacks()).toBe(false);
  });
});
