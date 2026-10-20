import React, { useEffect, useRef, useState } from 'react';
import { SystemState } from '../types/terminal';
import { AlertTriangle, CheckCircle2, Globe, Monitor, Router, Server, XCircle } from 'lucide-react';
import { Button, SimPanel, SimToolbar, StatusText, cx } from './sims/ui';

interface NetworkTopologySimProps {
  systemState: SystemState;
  onRunPing?: (target: string) => void;
  onRenewDhcp?: () => void;
  onFlushDns?: () => void;
}

type Tone = 'ok' | 'warn' | 'danger';
const toneIcon = { ok: CheckCircle2, warn: AlertTriangle, danger: XCircle };
const toneLine = { ok: 'border-ok', warn: 'border-warn border-dashed', danger: 'border-danger border-dashed' };

const GATEWAY = '192.168.1.1';
const DNS_SERVER = '192.168.1.10';
const INTERNET = '8.8.8.8';

const Node: React.FC<{
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  name: string;
  host: string;
  address: string;
  className?: string;
}> = ({ icon: Icon, name, host, address, className }) => (
  <div className={cx('flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5 @3xl:flex-col @3xl:text-center', className)}>
    <Icon className="h-5 w-5 shrink-0 text-muted" aria-hidden />
    <div className="min-w-0">
      <div className="font-medium">{name}</div>
      <div className="truncate font-mono text-sm text-muted">{host}</div>
      <div className="font-mono text-sm">{address}</div>
    </div>
  </div>
);

/** A connection between two nodes: the line, plus its state in words. */
const Link: React.FC<{
  tone: Tone;
  label: string;
  /** Said only in the stacked layout, where the line alone doesn't show which two nodes it joins */
  narrowPrefix?: string;
  horizontalWhenWide?: boolean;
  className?: string;
}> = ({ tone, label, narrowPrefix, horizontalWhenWide = false, className }) => (
  <div
    className={cx(
      'flex items-center gap-3 pl-5',
      horizontalWhenWide && '@3xl:flex-col @3xl:justify-center @3xl:gap-1.5 @3xl:px-2 @3xl:pl-2',
      className,
    )}
  >
    <span
      aria-hidden
      className={cx(
        'block h-10 w-0 border-l-2',
        horizontalWhenWide && '@3xl:h-0 @3xl:w-full @3xl:border-l-0 @3xl:border-t-2',
        toneLine[tone],
      )}
    />
    <StatusText tone={tone} icon={toneIcon[tone]} className={cx('text-sm', horizontalWhenWide && '@3xl:text-center')}>
      {narrowPrefix && <span className="font-normal text-muted @3xl:hidden">{narrowPrefix} </span>}
      {label}
    </StatusText>
  </div>
);

export const NetworkTopologySim: React.FC<NetworkTopologySimProps> = ({
  systemState,
  onRunPing,
  onRenewDhcp,
  onFlushDns,
}) => {
  const [pingOutput, setPingOutput] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const iface = systemState.interfaces[0] || {
    name: 'Ethernet0',
    ip: '192.168.1.145',
    netmask: '255.255.255.0',
    mac: '00-50-56-A1-2B-3C',
    gateway: GATEWAY,
    dns: [DNS_SERVER, INTERNET],
  };

  const isApipa = iface.ip.startsWith('169.254.');
  const hasGateway = !!iface.gateway && !isApipa;
  const isDnsWorking = systemState.dnsWorking;

  const clientLink: { tone: Tone; label: string } = hasGateway
    ? { tone: 'ok', label: 'Connected' }
    : { tone: 'danger', label: 'No gateway' };
  const internetLink: { tone: Tone; label: string } = hasGateway
    ? { tone: 'ok', label: 'Reachable' }
    : { tone: 'danger', label: 'Unreachable' };
  const dnsLink: { tone: Tone; label: string } = !hasGateway
    ? { tone: 'danger', label: 'Unreachable' }
    : isDnsWorking
      ? { tone: 'ok', label: 'Resolving names' }
      : { tone: 'warn', label: 'Stale cache' };

  const simulatePing = (target: string) => {
    setPingOutput(`Pinging ${target} with 32 bytes of data:`);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const ok = !isApipa || target === '127.0.0.1' || target.startsWith('169.254.');
      const line = ok
        ? `Reply from ${target}: bytes=32 time=${target === GATEWAY ? '1' : '12'}ms TTL=${target === GATEWAY ? '64' : '118'}`
        : 'PING: transmit failed. General failure.';
      setPingOutput(
        [
          `Pinging ${target} with 32 bytes of data:`,
          line,
          line,
          '',
          `Ping statistics for ${target}:`,
          ok
            ? '    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss)'
            : '    Packets: Sent = 2, Received = 0, Lost = 2 (100% loss)',
        ].join('\n'),
      );
      onRunPing?.(target);
    }, 500);
  };

  const actions: { label: string; command: string; run?: () => void; hint?: string }[] = [
    { label: 'Ping the gateway', command: `ping ${GATEWAY}`, run: () => simulatePing(GATEWAY) },
    { label: 'Ping the internet', command: `ping ${INTERNET}`, run: () => simulatePing(INTERNET) },
    {
      label: 'Renew DHCP lease',
      command: 'ipconfig /renew',
      run: onRenewDhcp,
      hint: isApipa ? 'Try this first: the client has no lease.' : undefined,
    },
    {
      label: 'Flush DNS cache',
      command: 'ipconfig /flushdns',
      run: onFlushDns,
      hint: hasGateway && !isDnsWorking ? 'Clears the stale entries.' : undefined,
    },
  ];

  return (
    <SimPanel label="Network">
      <SimToolbar
        title="Network"
        context={
          isApipa ? (
            <StatusText tone="danger" icon={XCircle}>No DHCP lease, using an APIPA address</StatusText>
          ) : (
            <StatusText tone="ok" icon={CheckCircle2}>DHCP lease from {GATEWAY}</StatusText>
          )
        }
      />

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {/* Diagram: a column in a narrow pane, a row with DNS hanging off the router when wide */}
        <div
          role="group"
          aria-label="Network diagram"
          className="grid grid-cols-1 @3xl:grid-cols-[minmax(0,1fr)_minmax(7rem,0.8fr)_minmax(0,1fr)_minmax(7rem,0.8fr)_minmax(0,1fr)] @3xl:items-center"
        >
          <Node icon={Monitor} name="This computer" host={systemState.hostname} address={iface.ip} className="@3xl:col-start-1 @3xl:row-start-1" />
          <Link {...clientLink} horizontalWhenWide className="@3xl:col-start-2 @3xl:row-start-1" />
          <Node icon={Router} name="Router" host="gw.corp.local" address={GATEWAY} className="@3xl:col-start-3 @3xl:row-start-1" />
          <Link {...internetLink} horizontalWhenWide className="@3xl:col-start-4 @3xl:row-start-1" />
          <Node icon={Globe} name="Internet" host="dns.google" address={INTERNET} className="@3xl:col-start-5 @3xl:row-start-1" />
          <Link {...dnsLink} narrowPrefix="Router to DNS server:" className="@3xl:col-start-3 @3xl:row-start-2 @3xl:pl-[calc(50%-1px)]" />
          <Node icon={Server} name="DNS server" host="dc01.corp.local" address={DNS_SERVER} className="@3xl:col-start-3 @3xl:row-start-3" />
        </div>

        <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold">IP configuration</h3>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Adapter</dt>
              <dd className="font-mono">{iface.name}</dd>
              <dt className="text-muted">IPv4 address</dt>
              <dd className={cx('font-mono', isApipa && 'text-danger')}>{iface.ip}</dd>
              <dt className="text-muted">Subnet mask</dt>
              <dd className="font-mono">{iface.netmask}</dd>
              <dt className="text-muted">Default gateway</dt>
              <dd className="font-mono">{hasGateway ? iface.gateway : <span className="font-sans text-muted">None</span>}</dd>
              <dt className="text-muted">DNS servers</dt>
              <dd className="font-mono">{iface.dns.join(', ')}</dd>
              <dt className="text-muted">MAC address</dt>
              <dd className="font-mono">{iface.mac}</dd>
            </dl>
          </div>

          <div>
            <h3 className="text-sm font-semibold">Try it</h3>
            <ul className="mt-2 space-y-2">
              {actions.map(a => (
                <li key={a.command} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Button variant="secondary" onClick={a.run} disabled={!a.run} className="w-44 justify-start">
                    {a.label}
                  </Button>
                  <span className="font-mono text-sm text-muted">{a.command}</span>
                  {a.hint && <span className="basis-full text-sm text-warn">{a.hint}</span>}
                </li>
              ))}
            </ul>
            <div role="status" aria-live="polite">
              {pingOutput && (
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-2 px-3 py-2 font-mono text-sm leading-relaxed">{pingOutput}</pre>
              )}
            </div>
          </div>
        </div>

        <p className="max-w-prose border-t border-line pt-4 text-sm text-muted">
          <span className="font-medium text-text">On the exam:</span> an address from 169.254.0.0/16 (APIPA) means the
          client asked for a DHCP lease and got no answer. It has no gateway, so it can only reach hosts on the same
          link. Fix DHCP, then run <code className="rounded-sm bg-surface-2 px-1">ipconfig /renew</code>.
        </p>
      </div>
    </SimPanel>
  );
};
