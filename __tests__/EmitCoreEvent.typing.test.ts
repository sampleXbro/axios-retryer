import type { AxiosError, AxiosRequestConfig } from 'axios';

import type { CoreRetryEventArgs, EmitCoreEvent } from '../src/types/events';

/**
 * Compile-time-only assertions: this file proves that `EmitCoreEvent` is strict
 * about both event names and payload shapes. The tests at runtime are trivial
 * — the value comes from the type-checker passing this file at all.
 */
describe('EmitCoreEvent typing contract', () => {
  it('accepts well-typed core events at compile time', () => {
    const emit: EmitCoreEvent = jest.fn();

    emit('onRetryProcessStarted');
    emit('onRetryScheduled', 1_000, {} as AxiosRequestConfig);
    emit('onFailure', {} as AxiosRequestConfig);
    emit('afterRetry', {} as AxiosRequestConfig, true);
    emit('afterRetry', {} as AxiosRequestConfig, false, {} as AxiosError);
    emit('onRequestCancelled', 'r-1');

    expect(emit).toHaveBeenCalled();
  });

  it('rejects unknown event names and wrong payloads at compile time', () => {
    const emit: EmitCoreEvent = jest.fn();

    // @ts-expect-error -- not a valid core event name
    emit('thisDoesNotExist');

    // @ts-expect-error -- delay must be a number
    emit('onRetryScheduled', 'not-a-number', {} as AxiosRequestConfig);

    // @ts-expect-error -- requires a config arg
    emit('onFailure');

    expect(emit).toHaveBeenCalled();
  });

  it('exposes per-event arg tuple via CoreRetryEventArgs', () => {
    type Args = CoreRetryEventArgs<'onRetryScheduled'>;
    const args: Args = [1, {} as AxiosRequestConfig];
    expect(args).toHaveLength(2);
  });
});
