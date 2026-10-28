// Drive real keyboard input after active prompt headers, never completed history.
// ANSI frames can repeat while navigating; identical questions require submission.
export function terminalInput(child, answers) {
  let raw = '', cursor = 0, answered = 0, previous = '';
  // eslint-disable-next-line no-control-regex -- Match active terminal frames without ANSI cursor sequences.
  const plain = value => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  child.stderr.on('data', chunk => {
    raw += chunk;
    // Our test input is a pipe with a simulated TTY API. Close that producer
    // after the session's failure footer; a real TTY has no open pipe producer.
    if (/└ {2}Setup (?:stopped|complete)/.test(plain(raw))) child.stdin.end();
    if (!answers || answered === answers.length) return;
    const text = plain(raw);
    const [label, answer] = answers[answered];
    let recent = text.slice(cursor);
    if (label === previous && !label.startsWith('error:')) {
      const submitted = recent.lastIndexOf(`◇  ${previous}`);
      if (submitted < 0) return;
      cursor += submitted + previous.length + 3;
      previous = '';
      recent = text.slice(cursor);
    }
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ready = label.startsWith('error:')
      ? recent.includes(label.slice(6))
      : new RegExp(`(?:^|\\n)[◆▲]  ${escaped}(?:\\n|$)`).test(recent);
    if (!ready) return;
    cursor = text.length;
    previous = label;
    answered++;
    if (answer.signal) { child.kill(answer.signal); return; }
    const keys = typeof answer === 'string' ? [answer + '\r'] : answer.keys;
    keys.forEach((key, index) => setTimeout(() => {
      if (child.exitCode === null && !child.stdin.destroyed) child.stdin.write(key);
    }, index * 40));
  });
  return () => answered;
}

export const keys = (...keys) => ({ keys });
export const enter = keys('\r');
export const down = '\x1b[B';
export const up = '\x1b[A';
export const left = '\x1b[D';
export const cancel = keys('\x03');
