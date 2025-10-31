// Minimal timing harness for end-to-end, async-aware event logging

type TimingEvent = {
  t: number; // ms since t0
  label: string;
  data?: unknown;
};

function getT0(): number {
  const t0 = (window as any).__WHISPERING_SHORTCUT_T0 as number | undefined;
  return typeof t0 === 'number' ? t0 : performance.now();
}

export function mark(label: string, data?: unknown) {
  const t = performance.now() - getT0();
  const event: TimingEvent = { t, label, data };
  // Structured log for easy scanning
  console.info('[timing]', `${t.toFixed(2)}ms`, label, data ?? '');
  // Keep a rolling buffer on window for later inspection
  const buf = ((window as any).__WHISPERING_TIMINGS ??= [] as TimingEvent[]);
  buf.push(event);
}


