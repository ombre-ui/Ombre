// A promise queue that runs one task at a time, in order. A task that rejects or resolves with a failure
// never blocks the tasks queued after it. Used only for the signed-in user's own profile/settings requests
// so concurrent saves cannot race a token refresh or reorder.
export function createSerialQueue() {
  let tail = Promise.resolve()
  return function enqueue(task) {
    const run = tail.then(() => task())
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
