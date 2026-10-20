import React, { useState } from 'react';
import { Lock, Shield, Key, AlertTriangle, CheckCircle2, Sliders } from 'lucide-react';
import { octalToSymbolic, symbolicToOctal } from '../terminal/filesystem';

interface PermissionMatrixSimProps {
  initialOctal?: number;
  onApplyChmod?: (octal: number) => void;
}

export const PermissionMatrixSim: React.FC<PermissionMatrixSimProps> = ({
  initialOctal = 750,
  onApplyChmod,
}) => {
  // Compute initial states from initialOctal
  const initSpecial = initialOctal >= 1000 ? Math.floor(initialOctal / 1000) : 0;
  const initUser = Math.floor((initialOctal % 1000) / 100);
  const initGroup = Math.floor((initialOctal % 100) / 10);
  const initOther = initialOctal % 10;

  const [userR, setUserR] = useState((initUser & 4) !== 0);
  const [userW, setUserW] = useState((initUser & 2) !== 0);
  const [userX, setUserX] = useState((initUser & 1) !== 0);

  const [groupR, setGroupR] = useState((initGroup & 4) !== 0);
  const [groupW, setGroupW] = useState((initGroup & 2) !== 0);
  const [groupX, setGroupX] = useState((initGroup & 1) !== 0);

  const [otherR, setOtherR] = useState((initOther & 4) !== 0);
  const [otherW, setOtherW] = useState((initOther & 2) !== 0);
  const [otherX, setOtherX] = useState((initOther & 1) !== 0);

  const [suid, setSuid] = useState((initSpecial & 4) !== 0);
  const [sgid, setSgid] = useState((initSpecial & 2) !== 0);
  const [sticky, setSticky] = useState((initSpecial & 1) !== 0);

  const [umaskInput, setUmaskInput] = useState('027');

  // Compute octals
  const userVal = (userR ? 4 : 0) + (userW ? 2 : 0) + (userX ? 1 : 0);
  const groupVal = (groupR ? 4 : 0) + (groupW ? 2 : 0) + (groupX ? 1 : 0);
  const otherVal = (otherR ? 4 : 0) + (otherW ? 2 : 0) + (otherX ? 1 : 0);
  const specialVal = (suid ? 4 : 0) + (sgid ? 2 : 0) + (sticky ? 1 : 0);

  const fullOctal = specialVal > 0 
    ? `${specialVal}${userVal}${groupVal}${otherVal}` 
    : `${userVal}${groupVal}${otherVal}`;

  const standardOctalNum = userVal * 100 + groupVal * 10 + otherVal;

  const symbolicStr = `${userR ? 'r' : '-'}${userW ? 'w' : '-'}${suid ? (userX ? 's' : 'S') : userX ? 'x' : '-'}${groupR ? 'r' : '-'}${groupW ? 'w' : '-'}${sgid ? (groupX ? 's' : 'S') : groupX ? 'x' : '-'}${otherR ? 'r' : '-'}${otherW ? 'w' : '-'}${sticky ? (otherX ? 't' : 'T') : otherX ? 'x' : '-'}`;

  const isWorldWritable = otherW;
  const isDangerous = standardOctalNum === 777;

  const applyPreset = (preset: string) => {
    let s = false;
    let sg = false;
    let st = false;
    let u = 0;
    let g = 0;
    let o = 0;

    if (preset.length === 4) {
      const spec = parseInt(preset[0], 10);
      s = (spec & 4) !== 0;
      sg = (spec & 2) !== 0;
      st = (spec & 1) !== 0;
      u = parseInt(preset[1], 10) || 0;
      g = parseInt(preset[2], 10) || 0;
      o = parseInt(preset[3], 10) || 0;
    } else {
      u = parseInt(preset[0], 10) || 0;
      g = parseInt(preset[1], 10) || 0;
      o = parseInt(preset[2], 10) || 0;
    }

    setUserR((u & 4) !== 0);
    setUserW((u & 2) !== 0);
    setUserX((u & 1) !== 0);

    setGroupR((g & 4) !== 0);
    setGroupW((g & 2) !== 0);
    setGroupX((g & 1) !== 0);

    setOtherR((o & 4) !== 0);
    setOtherW((o & 2) !== 0);
    setOtherX((o & 1) !== 0);

    setSuid(s);
    setSgid(sg);
    setSticky(st);

    onApplyChmod?.(parseInt(preset, 10));
  };

  return (
    <div className="flex flex-col h-full bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden shadow-xl text-xs font-sans">
      {/* Title Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-950 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Key className="w-4 h-4 text-amber-400" />
          <span className="font-semibold text-slate-200">POSIX File Permissions Matrix & Umask Calculator</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-slate-400 font-mono text-xs">
            Octal: <strong className="text-amber-400 font-bold text-sm">{fullOctal}</strong>
          </span>
          <span className="text-slate-400 font-mono text-xs">
            Symbolic: <strong className="text-cyan-400 font-bold text-sm">{symbolicStr}</strong>
          </span>
        </div>
      </div>

      <div className="flex-1 p-5 overflow-y-auto space-y-5">
        {/* Presets Bar */}
        <div>
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Common LPI Exam Presets
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => applyPreset('750')}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 font-mono text-xs border border-slate-700"
            >
              750 (rwxr-x---) [Secure Dept]
            </button>
            <button
              onClick={() => applyPreset('755')}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-xs border border-slate-700"
            >
              755 (rwxr-xr-x) [Standard Dir]
            </button>
            <button
              onClick={() => applyPreset('644')}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-xs border border-slate-700"
            >
              644 (rw-r--r--) [Standard File]
            </button>
            <button
              onClick={() => applyPreset('700')}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-xs border border-slate-700"
            >
              700 (rwx------) [SSH Key / Root]
            </button>
            <button
              onClick={() => applyPreset('4755')}
              className="px-2.5 py-1 rounded bg-purple-950/60 hover:bg-purple-900 text-purple-300 font-mono text-xs border border-purple-500/30"
            >
              4755 (rwsr-xr-x) [SUID /usr/bin/passwd]
            </button>
            <button
              onClick={() => applyPreset('2755')}
              className="px-2.5 py-1 rounded bg-purple-950/60 hover:bg-purple-900 text-purple-300 font-mono text-xs border border-purple-500/30"
            >
              2755 (rwxr-sr-x) [SGID Group Inherit]
            </button>
            <button
              onClick={() => applyPreset('1777')}
              className="px-2.5 py-1 rounded bg-emerald-950/60 hover:bg-emerald-900 text-emerald-300 font-mono text-xs border border-emerald-500/30"
            >
              1777 (rwxrwxrwt) [Sticky /tmp]
            </button>
          </div>
        </div>

        {/* 3-Column Permission Matrix */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Column 1: Owner (User) */}
          <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-100 text-xs">Owner / User (u)</span>
              <span className="px-2 py-0.5 rounded bg-slate-800 font-mono font-bold text-amber-400 text-xs">
                {userVal}
              </span>
            </div>
            <div className="space-y-2">
              <label className="flex items-center justify-between p-2 rounded bg-slate-900/80 hover:bg-slate-800 cursor-pointer">
                <span className="text-slate-300">Read (r) = 4</span>
                <input
                  type="checkbox"
                  checked={userR}
                  onChange={(e) => setUserR(e.target.checked)}
                  className="rounded border-slate-700 text-amber-500"
                />
              </label>
              <label className="flex items-center justify-between p-2 rounded bg-slate-900/80 hover:bg-slate-800 cursor-pointer">
                <span className="text-slate-300">Write (w) = 2</span>
                <input
                  type="checkbox"
                  checked={userW}
                  onChange={(e) => setUserW(e.target.checked)}
                  className="rounded border-slate-700 text-amber-500"
                />
              </label>
              <label className="flex items-center justify-between p-2 rounded bg-slate-900/80 hover:bg-slate-800 cursor-pointer">
                <span className="text-slate-300">Execute (x) = 1</span>
                <input
                  type="checkbox"
                  checked={userX}
                  onChange={(e) => setUserX(e.target.checked)}
                  className="rounded border-slate-700 text-amber-500"
                />
              </label>
            </div>
          </div>

          {/* Column 2: Group */}
          <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-100 text-xs">Group (g)</span>
              <span className="px-2 py-0.5 rounded bg-slate-800 font-mono font-bold text-cyan-400 text-xs">
                {groupVal}
              </span>
            </div>
            <div className="space-y-2">
              <label className="flex items-center justify-between p-2 rounded bg-slate-900/80 hover:bg-slate-800 cursor-pointer">
                <span className="text-slate-300">Read (r) = 4</span>
                <input
                  type="checkbox"
                  checked={groupR}
                  onChange={(e) => setGroupR(e.target.checked)}
                  className="rounded border-slate-700 text-cyan-500"
                />
              </label>
              <label className="flex items-center justify-between p-2 rounded bg-slate-900/80 hover:bg-slate-800 cursor-pointer">
                <span className="text-slate-300">Write (w) = 2</span>
                <input
                  type="checkbox"
                  checked={groupW}
                  onChange={(e) => setGroupW(e.target.checked)}
                  className="rounded border-slate-700 text-cyan-500"
                />
              </label>
              <label className="flex items-center justify-between p-2 rounded bg-slate-900/80 hover:bg-slate-800 cursor-pointer">
                <span className="text-slate-300">Execute (x) = 1</span>
                <input
                  type="checkbox"
                  checked={groupX}
                  onChange={(e) => setGroupX(e.target.checked)}
                  className="rounded border-slate-700 text-cyan-500"
                />
              </label>
            </div>
          </div>

          {/* Column 3: Others */}
          <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-100 text-xs">Others (o)</span>
              <span className={`px-2 py-0.5 rounded bg-slate-800 font-mono font-bold text-xs ${
                otherW ? 'text-rose-400' : 'text-slate-300'
              }`}>
                {otherVal}
              </span>
            </div>
            <div className="space-y-2">
              <label className="flex items-center justify-between p-2 rounded bg-slate-900/80 hover:bg-slate-800 cursor-pointer">
                <span className="text-slate-300">Read (r) = 4</span>
                <input
                  type="checkbox"
                  checked={otherR}
                  onChange={(e) => setOtherR(e.target.checked)}
                  className="rounded border-slate-700 text-blue-500"
                />
              </label>
              <label className="flex items-center justify-between p-2 rounded bg-slate-900/80 hover:bg-slate-800 cursor-pointer">
                <span className="text-slate-300">Write (w) = 2</span>
                <input
                  type="checkbox"
                  checked={otherW}
                  onChange={(e) => setOtherW(e.target.checked)}
                  className="rounded border-slate-700 text-rose-500"
                />
              </label>
              <label className="flex items-center justify-between p-2 rounded bg-slate-900/80 hover:bg-slate-800 cursor-pointer">
                <span className="text-slate-300">Execute (x) = 1</span>
                <input
                  type="checkbox"
                  checked={otherX}
                  onChange={(e) => setOtherX(e.target.checked)}
                  className="rounded border-slate-700 text-blue-500"
                />
              </label>
            </div>
          </div>
        </div>

        {/* Special Inode Permission Bits */}
        <div className="p-4 rounded-xl bg-slate-950 border border-slate-800">
          <div className="font-semibold text-slate-200 text-xs mb-2">Special Inode Bits (4000 / 2000 / 1000)</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="flex items-center gap-2.5 p-2 rounded bg-slate-900 hover:bg-slate-850 cursor-pointer">
              <input
                type="checkbox"
                checked={suid}
                onChange={(e) => setSuid(e.target.checked)}
                className="rounded border-slate-700 text-purple-500"
              />
              <div>
                <div className="font-bold text-slate-200">SUID (4000)</div>
                <div className="text-[10px] text-slate-400">Runs binary as owner</div>
              </div>
            </label>
            <label className="flex items-center gap-2.5 p-2 rounded bg-slate-900 hover:bg-slate-850 cursor-pointer">
              <input
                type="checkbox"
                checked={sgid}
                onChange={(e) => setSgid(e.target.checked)}
                className="rounded border-slate-700 text-purple-500"
              />
              <div>
                <div className="font-bold text-slate-200">SGID (2000)</div>
                <div className="text-[10px] text-slate-400">Inherits parent group</div>
              </div>
            </label>
            <label className="flex items-center gap-2.5 p-2 rounded bg-slate-900 hover:bg-slate-850 cursor-pointer">
              <input
                type="checkbox"
                checked={sticky}
                onChange={(e) => setSticky(e.target.checked)}
                className="rounded border-slate-700 text-purple-500"
              />
              <div>
                <div className="font-bold text-slate-200">Sticky Bit (1000)</div>
                <div className="text-[10px] text-slate-400">Owner-only deletion (/tmp)</div>
              </div>
            </label>
          </div>
        </div>

        {/* Security Warning or Nominal Badge */}
        {isWorldWritable ? (
          <div className="p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-xs">Security Risk: World Writable Inode</div>
              <div className="text-[11px] text-rose-300/80 leading-relaxed mt-0.5">
                Any non-privileged local user on the system can modify, overwrite, or truncate this file or directory contents. LPI exams heavily penalize 777 or 666 modes in production environments.
              </div>
            </div>
          </div>
        ) : (
          <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-xs">Least Privilege Compliant</div>
              <div className="text-[11px] text-emerald-300/80 leading-relaxed mt-0.5">
                Others have restricted or zero write access. This meets strict enterprise compliance and LPIC-1 hardening objectives.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
