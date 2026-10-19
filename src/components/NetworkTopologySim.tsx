import React, { useState } from 'react';
import { SystemState } from '../types/terminal';
import { Monitor, Server, Globe, ArrowRight, CheckCircle2, AlertTriangle, RefreshCw, Radio } from 'lucide-react';

interface NetworkTopologySimProps {
  systemState: SystemState;
  onRunPing?: (target: string) => void;
  onRenewDhcp?: () => void;
  onFlushDns?: () => void;
}

export const NetworkTopologySim: React.FC<NetworkTopologySimProps> = ({
  systemState,
  onRunPing,
  onRenewDhcp,
  onFlushDns,
}) => {
  const [pingTarget, setPingTarget] = useState<string | null>(null);
  const [pingStatus, setPingStatus] = useState<string | null>(null);

  const iface = systemState.interfaces[0] || {
    ip: '192.168.1.145',
    netmask: '255.255.255.0',
    mac: '00-50-56-A1-2B-3C',
    gateway: '192.168.1.1',
    dns: ['192.168.1.10', '8.8.8.8'],
  };

  const isApipa = iface.ip.startsWith('169.254.');
  const hasGateway = !!iface.gateway && !isApipa;
  const isDnsWorking = systemState.dnsWorking;

  const simulatePing = (target: string) => {
    setPingTarget(target);
    setPingStatus('Pinging...');
    setTimeout(() => {
      if (isApipa && target !== '127.0.0.1' && !target.startsWith('169.254.')) {
        setPingStatus('Destination host unreachable (APIPA Active)');
      } else {
        setPingStatus(`Reply from ${target}: bytes=32 time=12ms TTL=118 (Success)`);
      }
      onRunPing?.(target);
    }, 500);
  };

  return (
    <div className="flex flex-col h-full bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden shadow-xl text-xs font-sans">
      {/* Title Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-950 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-blue-400" />
          <span className="font-semibold text-slate-200">Interactive Network Topology & OSI Layer 3 Visualizer</span>
        </div>
        <div className="flex items-center gap-2">
          {isApipa ? (
            <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/40">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
              APIPA 169.254 Active (No Gateway)
            </span>
          ) : (
            <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              DHCP Lease Active (192.168.1.0/24)
            </span>
          )}
        </div>
      </div>

      {/* Topology Diagram Container */}
      <div className="flex-1 p-5 flex flex-col justify-between overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-center relative">
          {/* Node 1: Workstation */}
          <div className={`p-4 rounded-xl border text-center transition-all ${
            isApipa ? 'bg-rose-950/30 border-rose-500/50' : 'bg-slate-950 border-blue-500/40'
          }`}>
            <div className="w-10 h-10 mx-auto rounded-lg bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 mb-2">
              <Monitor className="w-5 h-5" />
            </div>
            <div className="font-bold text-slate-100 text-xs">Workstation</div>
            <div className="text-[11px] text-slate-400 font-mono">{systemState.hostname}</div>
            <div className={`text-[11px] font-mono mt-2 px-2 py-0.5 rounded ${
              isApipa ? 'bg-rose-500/20 text-rose-300 font-bold' : 'bg-slate-800 text-cyan-300'
            }`}>
              {iface.ip}
            </div>
            <div className="text-[10px] text-slate-400 mt-1 font-mono">MAC: {iface.mac}</div>
          </div>

          {/* Node 2: Managed Switch & Router Gateway */}
          <div className={`p-4 rounded-xl border text-center transition-all ${
            hasGateway ? 'bg-slate-950 border-emerald-500/40' : 'bg-slate-950/60 border-slate-800'
          }`}>
            <div className="w-10 h-10 mx-auto rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-2">
              <Server className="w-5 h-5" />
            </div>
            <div className="font-bold text-slate-100 text-xs">Default Gateway</div>
            <div className="text-[11px] text-slate-400 font-mono">Router (gw.corp.local)</div>
            <div className="text-[11px] font-mono mt-2 px-2 py-0.5 rounded bg-slate-800 text-emerald-300">
              192.168.1.1
            </div>
            <div className="text-[10px] text-slate-400 mt-1">Status: {hasGateway ? 'Reachable' : 'No Route'}</div>
          </div>

          {/* Node 3: Corporate DNS / DC */}
          <div className={`p-4 rounded-xl border text-center transition-all ${
            isDnsWorking ? 'bg-slate-950 border-cyan-500/40' : 'bg-slate-950/60 border-amber-500/40'
          }`}>
            <div className="w-10 h-10 mx-auto rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mb-2">
              <Server className="w-5 h-5" />
            </div>
            <div className="font-bold text-slate-100 text-xs">DNS / Domain Controller</div>
            <div className="text-[11px] text-slate-400 font-mono">dc01.corp.local</div>
            <div className="text-[11px] font-mono mt-2 px-2 py-0.5 rounded bg-slate-800 text-cyan-300">
              192.168.1.10:53
            </div>
            <div className="text-[10px] text-slate-400 mt-1">Status: {isDnsWorking ? 'Resolving' : 'Cache Stale'}</div>
          </div>

          {/* Node 4: Public Internet */}
          <div className={`p-4 rounded-xl border text-center transition-all ${
            hasGateway ? 'bg-slate-950 border-purple-500/40' : 'bg-slate-950/60 border-slate-800 opacity-60'
          }`}>
            <div className="w-10 h-10 mx-auto rounded-lg bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400 mb-2">
              <Globe className="w-5 h-5" />
            </div>
            <div className="font-bold text-slate-100 text-xs">Public Internet</div>
            <div className="text-[11px] text-slate-400 font-mono">Anycast Cloud</div>
            <div className="text-[11px] font-mono mt-2 px-2 py-0.5 rounded bg-slate-800 text-purple-300">
              8.8.8.8
            </div>
            <div className="text-[10px] text-slate-400 mt-1">Status: {hasGateway ? 'Internet UP' : 'Unreachable'}</div>
          </div>
        </div>

        {/* Live Diagnostics & Action Panel */}
        <div className="mt-6 p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="font-semibold text-slate-200 flex items-center gap-2">
              <span>Interactive Network Prober & Actions</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => simulatePing('192.168.1.1')}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono transition-colors"
              >
                ping 192.168.1.1
              </button>
              <button
                onClick={() => simulatePing('8.8.8.8')}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono transition-colors"
              >
                ping 8.8.8.8
              </button>
              {isApipa && onRenewDhcp && (
                <button
                  onClick={onRenewDhcp}
                  className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs transition-colors flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>ipconfig /renew</span>
                </button>
              )}
              {!isDnsWorking && onFlushDns && (
                <button
                  onClick={onFlushDns}
                  className="px-3 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-xs transition-colors"
                >
                  ipconfig /flushdns
                </button>
              )}
            </div>
          </div>

          {pingStatus && (
            <div className="p-2.5 rounded bg-slate-900 border border-slate-800 font-mono text-[11px] text-slate-300">
              <span className="text-cyan-400">&gt; Test Ping to {pingTarget}:</span> {pingStatus}
            </div>
          )}

          <div className="text-[11px] text-slate-400 leading-relaxed border-t border-slate-800/80 pt-2.5">
            <strong className="text-slate-300">CompTIA Exam Concept:</strong> APIPA addresses (169.254.0.1 to 169.254.255.254) mean the client has zero default gateway and cannot route traffic outside the local link. Once DHCP is renewed, Layer 3 routing to 192.168.1.1 is restored.
          </div>
        </div>
      </div>
    </div>
  );
};
