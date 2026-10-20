import React, { useId, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, CodeBlock, SimPanel, SimToolbar, cx, inputClass } from './sims/ui';

// Tighter than the shared header style so the matrix fits a phone-width lab pane
const thClass = 'px-2 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted @md:px-3';

interface PermissionMatrixSimProps {
  initialOctal?: number;
  onApplyChmod?: (octal: number) => void;
}

type Who = 'u' | 'g' | 'o';
type Bits = Record<Who, number>; // 0-7 each

const WHO: { key: Who; label: string; hint: string }[] = [
  { key: 'u', label: 'Owner', hint: 'u' },
  { key: 'g', label: 'Group', hint: 'g' },
  { key: 'o', label: 'Others', hint: 'o' },
];

const PERMS: { bit: number; label: string; letter: string }[] = [
  { bit: 4, label: 'Read', letter: 'r' },
  { bit: 2, label: 'Write', letter: 'w' },
  { bit: 1, label: 'Execute', letter: 'x' },
];

const SPECIAL: { bit: number; label: string; value: string; what: string }[] = [
  { bit: 4, label: 'SUID', value: '4000', what: 'A program runs as its owner, not as you. Example: /usr/bin/passwd.' },
  { bit: 2, label: 'SGID', value: '2000', what: 'On a directory, new files get the directory’s group.' },
  { bit: 1, label: 'Sticky', value: '1000', what: 'On a directory, only a file’s owner can delete it. Example: /tmp.' },
];

const PRESETS: { mode: string; use: string }[] = [
  { mode: '750', use: 'Department folder' },
  { mode: '755', use: 'Program or public directory' },
  { mode: '644', use: 'Ordinary file' },
  { mode: '700', use: 'Private directory, ~/.ssh' },
  { mode: '600', use: 'Private key' },
  { mode: '4755', use: 'SUID program' },
  { mode: '2770', use: 'Shared group directory' },
  { mode: '1777', use: '/tmp' },
];

const parseMode = (mode: string) => {
  const digits = mode.padStart(4, '0');
  return {
    special: parseInt(digits[0], 8) || 0,
    bits: { u: parseInt(digits[1], 8) || 0, g: parseInt(digits[2], 8) || 0, o: parseInt(digits[3], 8) || 0 } as Bits,
  };
};

const symbolic = (bits: Bits, special: number) => {
  const triple = (v: number, specialOn: boolean, on: string, off: string) =>
    `${v & 4 ? 'r' : '-'}${v & 2 ? 'w' : '-'}${specialOn ? (v & 1 ? on : off) : v & 1 ? 'x' : '-'}`;
  return triple(bits.u, !!(special & 4), 's', 'S') + triple(bits.g, !!(special & 2), 's', 'S') + triple(bits.o, !!(special & 1), 't', 'T');
};

export const PermissionMatrixSim: React.FC<PermissionMatrixSimProps> = ({
  initialOctal = 750,
  onApplyChmod,
}) => {
  const fid = useId();
  // initialOctal is written as a decimal-looking number (750 means mode 0750)
  const init = parseMode(String(initialOctal));
  const [bits, setBits] = useState<Bits>(init.bits);
  const [special, setSpecial] = useState(init.special);
  const [umask, setUmask] = useState('022');
  const [applied, setApplied] = useState<string | null>(null);

  const mode = `${special > 0 ? special : ''}${bits.u}${bits.g}${bits.o}`;
  const sym = symbolic(bits, special);
  const command = `chmod ${mode} /home/student/finance`;

  const toggle = (who: Who, bit: number) => setBits(b => ({ ...b, [who]: b[who] ^ bit }));
  const toggleSpecial = (bit: number) => setSpecial(s => s ^ bit);

  const applyPreset = (preset: string) => {
    const p = parseMode(preset);
    setBits(p.bits);
    setSpecial(p.special);
    if (onApplyChmod) {
      onApplyChmod(parseInt(preset, 10));
      setApplied(preset);
    }
  };

  const applyCurrent = () => {
    onApplyChmod?.(parseInt(mode, 10));
    setApplied(mode);
  };

  // umask: what new files and directories get
  const umaskValid = /^[0-7]{3,4}$/.test(umask);
  const umaskNum = umaskValid ? parseInt(umask, 8) & 0o777 : 0;
  const fileMode = (0o666 & ~umaskNum).toString(8).padStart(3, '0');
  const dirMode = (0o777 & ~umaskNum).toString(8).padStart(3, '0');
  const toSym = (m: string) => symbolic(parseMode(m).bits, 0);

  const worldWritable = (bits.o & 2) !== 0;
  const stickyDir = (special & 1) !== 0;

  return (
    <SimPanel label="File permissions">
      <SimToolbar
        title="File permissions"
        context={<span>Build a mode with the checkboxes, or start from a common one.</span>}
      />

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-2">
          {/* The matrix */}
          <div className="space-y-4">
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Read, write and execute for owner, group and others</caption>
                <thead>
                  <tr className="border-b border-line bg-surface-2">
                    <th scope="col" className={thClass}>Who</th>
                    {PERMS.map(p => (
                      <th key={p.bit} scope="col" className={cx(thClass, 'text-center')}>
                        {p.label} <span className="hidden font-mono normal-case @lg:inline">{p.letter}</span>
                      </th>
                    ))}
                    <th scope="col" className={cx(thClass, 'text-right')}>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {WHO.map(w => (
                    <tr key={w.key} className="border-b border-line last:border-b-0">
                      <th scope="row" className="px-2 py-1 text-left font-medium @md:px-3">
                        {w.label} <span className="hidden font-mono font-normal text-muted @lg:inline">{w.hint}</span>
                      </th>
                      {PERMS.map(p => (
                        <td key={p.bit} className="p-0 text-center">
                          <label className="flex min-h-11 cursor-pointer items-center justify-center sm:min-h-9">
                            <input
                              type="checkbox"
                              checked={(bits[w.key] & p.bit) !== 0}
                              onChange={() => toggle(w.key, p.bit)}
                              aria-label={`${w.label}: ${p.label.toLowerCase()}`}
                              className="h-4 w-4 accent-[var(--accent)]"
                            />
                          </label>
                        </td>
                      ))}
                      <td className="px-2 py-1 text-right font-mono tabular-nums @md:px-3">{bits[w.key]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <fieldset>
              <legend className="text-sm font-semibold">Special bits</legend>
              <div className="mt-2 space-y-1">
                {SPECIAL.map(s => (
                  <label key={s.bit} className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={(special & s.bit) !== 0}
                      onChange={() => toggleSpecial(s.bit)}
                      className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
                    />
                    <span className="text-sm">
                      <span className="font-medium">{s.label}</span>{' '}
                      <span className="font-mono text-muted">{s.value}</span>
                      <span className="block text-muted">{s.what}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          {/* The result */}
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-sm text-muted">Octal</dt>
                <dd className="font-mono text-2xl">{mode}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted">Symbolic</dt>
                <dd className="font-mono text-2xl">{sym}</dd>
              </div>
            </dl>

            <div>
              <div className="text-sm text-muted">Command</div>
              <CodeBlock code={command} className="mt-1" />
            </div>

            {onApplyChmod && (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={applyCurrent}>Run in terminal</Button>
                <span role="status" aria-live="polite" className="text-sm text-muted">
                  {applied && `Ran chmod ${applied}.`}
                </span>
              </div>
            )}

            {worldWritable && (
              <p className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
                <span>
                  Anyone on the system can change or delete {stickyDir ? 'their own files here' : 'this'}.
                  {stickyDir
                    ? ' The sticky bit stops them deleting other people’s files, which is what /tmp needs.'
                    : ' On the exam, 777 and 666 are almost always the wrong answer.'}
                </span>
              </p>
            )}

            <div>
              <h3 className="text-sm font-semibold">Common modes</h3>
              <p className="text-sm text-muted">
                {onApplyChmod ? 'Picking one sets the boxes and runs it.' : 'Picking one sets the boxes.'}
              </p>
              <ul className="mt-2 grid grid-cols-1 gap-1 @md:grid-cols-2">
                {PRESETS.map(p => (
                  <li key={p.mode}>
                    <button
                      type="button"
                      onClick={() => applyPreset(p.mode)}
                      aria-pressed={p.mode === mode}
                      className={cx(
                        'flex min-h-10 w-full items-center gap-3 rounded-md px-2 text-left text-sm sm:min-h-8',
                        p.mode === mode ? 'bg-accent-soft' : 'hover:bg-surface-2',
                      )}
                    >
                      <span className="w-10 font-mono font-medium">{p.mode}</span>
                      <span className="text-muted">{p.use}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="border-t border-line pt-4">
          <h3 className="text-sm font-semibold">
            <label htmlFor={`${fid}-umask`}>umask</label>
          </h3>
          <p className="text-sm text-muted">
            New files start from 666 and new directories from 777. The umask removes bits from both.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <input
              id={`${fid}-umask`}
              value={umask}
              onChange={e => setUmask(e.target.value.trim())}
              inputMode="numeric"
              maxLength={4}
              aria-invalid={!umaskValid || undefined}
              aria-describedby={`${fid}-umask-out`}
              className={cx(inputClass, 'w-24 font-mono')}
            />
            <span id={`${fid}-umask-out`} className={umaskValid ? '' : 'text-danger'}>
              {umaskValid ? (
                <>
                  Files <span className="font-mono">{fileMode} {toSym(fileMode)}</span>
                  <span className="mx-2 text-subtle">·</span>
                  Directories <span className="font-mono">{dirMode} {toSym(dirMode)}</span>
                </>
              ) : (
                'Enter three or four octal digits, like 022 or 0027.'
              )}
            </span>
          </div>
        </div>
      </div>
    </SimPanel>
  );
};
