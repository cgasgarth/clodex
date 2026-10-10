// src/transport/outbound-proxy.ts — proxy selection for Clodex's own WebSocket
// connections.
//
// Bun's fetch() applies HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY by
// itself. Bun's WebSocket does not, so the native OAuth Responses WebSocket
// transport passes the URL from outboundProxyUrlForTarget() as its `proxy`
// option. These rules follow Bun 1.4.3 fetch(): lowercase names win, ALL_PROXY
// is the fallback, and NO_PROXY accepts domain suffixes, `host:port`, IP
// addresses and CIDR blocks.
//
// Self-loop guard: clodex never sets proxy vars in its OWN process.env — proxy
// bridge mode sets HTTPS_PROXY only in the CHILD's env (buildHttpProxyChildEnv
// works on a copy of process.env).

import ipaddr from 'ipaddr.js';

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name.toLowerCase()]?.trim() || env[name]?.trim() || undefined;
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' || protocol === 'wss:' ? '443' : '80';
}

function splitEntryPort(entry: string) {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed?.[1]) return { host: bracketed[1], port: bracketed[2] };
  const hostPort = /^([^:]+):(\d+)$/.exec(entry);
  if (hostPort?.[1]) return { host: hostPort[1], port: hostPort[2] };
  return { host: entry, port: undefined };
}

function ipMatches(host: string, entry: string): boolean {
  if (!ipaddr.isValid(host)) return false;
  const address = ipaddr.parse(host);
  if (entry.includes('/')) {
    if (!ipaddr.isValidCIDR(entry)) return false;
    const range = ipaddr.parseCIDR(entry);
    return address.kind() === range[0].kind() && address.match(range);
  }
  if (!ipaddr.isValid(entry)) return false;
  const other = ipaddr.parse(entry);
  return address.kind() === other.kind() && address.toNormalizedString() === other.toNormalizedString();
}

/** True when NO_PROXY (or no_proxy) sends the target URL direct. */
function noProxyBypasses(target: URL, env: NodeJS.ProcessEnv): boolean {
  const noProxy = envValue(env, 'NO_PROXY');
  if (!noProxy) return false;
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const port = target.port || defaultPort(target.protocol);
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    if (ipMatches(host, entry)) return true;
    const parsed = splitEntryPort(entry);
    if (parsed.port !== undefined && parsed.port !== port) continue;
    if (ipMatches(host, parsed.host)) return true;
    const domain = parsed.host.replace(/^\*/, '').replace(/^\./, '').replace(/\.$/, '');
    if (domain && (host === domain || host.endsWith(`.${domain}`))) return true;
  }
  return false;
}

/** Proxy URL that applies to a target URL per the env vars, or undefined (none set / NO_PROXY match). */
export function outboundProxyUrlForTarget(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return undefined;
  }
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const proxy = envValue(env, secure ? 'HTTPS_PROXY' : 'HTTP_PROXY') ?? envValue(env, 'ALL_PROXY');
  if (!proxy) return undefined;
  if (noProxyBypasses(parsed, env)) return undefined;
  return proxy;
}
