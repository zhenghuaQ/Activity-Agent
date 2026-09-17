export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? "run_aborted"));
}

export function linkAbortSignal(parent?: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);

  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });

  return {
    controller,
    dispose: () => parent?.removeEventListener("abort", abort),
  };
}
