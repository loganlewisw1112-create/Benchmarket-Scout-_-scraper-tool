import dns from "node:dns";
import net, { type LookupFunction } from "node:net";
import { Agent, type Dispatcher } from "undici";

const dnsLookup = dns.promises.lookup;

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

export type PinnedHttpTarget = {
  url: string;
  addresses: readonly ResolvedAddress[];
  dispatcher: Dispatcher;
  /** The exact lookup function installed on the dispatcher. */
  lookup: LookupFunction;
  close: () => Promise<void>;
};

/**
 * Why a URL was refused. `dns_unresolved` (NXDOMAIN / no answers) is a dead
 * domain, not a safety failure; callers map these codes to user-facing text
 * instead of storing raw error strings.
 */
export type UrlSafetyReason =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_in_url"
  | "blocked_port"
  | "blocked_host"
  | "private_address"
  | "dns_unresolved"
  | "dns_error";

export class UrlSafetyError extends Error {
  readonly reason: UrlSafetyReason;

  constructor(message: string, reason: UrlSafetyReason) {
    super(message);
    this.name = "UrlSafetyError";
    this.reason = reason;
  }
}

export type PinnedHttpTargetResult =
  | { ok: true; target: PinnedHttpTarget }
  | { ok: false; reason: UrlSafetyReason };

export type UrlSafetyCheck =
  | { ok: true }
  | { ok: false; reason: UrlSafetyReason };

// Only the default web ports. "" is the scheme default (80 for http, 443 for
// https); an explicit :80 or :443 on either scheme is also accepted.
const ALLOWED_PORTS = new Set(["", "80", "443"]);

// getaddrinfo/c-ares codes meaning "this name does not resolve" rather than
// "the resolver itself failed".
const UNRESOLVED_DNS_CODES = new Set([
  "ENOTFOUND",
  "ENODATA",
  "EAI_NONAME",
  "EAI_NODATA",
]);

// Keep family lists separate: Node's BlockList intentionally maps IPv4
// addresses into IPv6 space, which would make an IPv4-mapped IPv6 rule match
// every ordinary IPv4 address as well.
const blockedIPv4Addresses = new net.BlockList();
const blockedIPv6Addresses = new net.BlockList();

// IPv4 ranges that must never be reachable from a user-controlled URL. This
// includes private, loopback, link-local, carrier-grade NAT, documentation,
// benchmarking, multicast, and reserved address space.
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIPv4Addresses.addSubnet(network, prefix, "ipv4");
}

// IPv6 loopback/unspecified, transition mechanisms that can encode an IPv4
// target (IPv4-compatible ::/96, IPv4-mapped ::ffff:0:0/96, IPv4-translated
// ::ffff:0:0:0/96, NAT64, 6to4, Teredo), documentation/benchmarking,
// private/site-local, link-local, and multicast ranges.
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["::ffff:0:0", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedIPv6Addresses.addSubnet(network, prefix, "ipv6");
}

function stripTrailingDots(hostname: string): string {
  return hostname.replace(/\.+$/, "");
}

export function normalizeHttpUrl(input: string): string {
  let candidate = input.trim();
  if (!candidate) {
    throw new UrlSafetyError("Empty URL", "invalid_url");
  }

  if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new UrlSafetyError("Invalid URL", "invalid_url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlSafetyError(
      `Unsupported protocol: ${url.protocol}`,
      "unsupported_scheme"
    );
  }

  // "example.com." names the same host as "example.com"; normalize it so the
  // name blocklist and the pinned connector compare one canonical form.
  const hostname = stripTrailingDots(url.hostname);
  if (!hostname) {
    throw new UrlSafetyError("Missing hostname", "invalid_url");
  }
  if (hostname !== url.hostname) url.hostname = hostname;

  if (url.username || url.password) {
    throw new UrlSafetyError(
      "Credentials in URL are not allowed",
      "credentials_in_url"
    );
  }

  return url.toString();
}

/** Maps any error thrown by normalizeHttpUrl (or elsewhere) to a reason. */
export function urlSafetyReasonOf(error: unknown): UrlSafetyReason {
  return error instanceof UrlSafetyError ? error.reason : "invalid_url";
}

function dnsFailureReason(error: unknown): UrlSafetyReason {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  return UNRESOLVED_DNS_CODES.has(code) ? "dns_unresolved" : "dns_error";
}

function hostnameWithoutIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function canonicalHostname(hostname: string): string {
  return stripTrailingDots(hostnameWithoutIpv6Brackets(hostname).toLowerCase());
}

function isBlockedAddress(address: string, family: number): boolean {
  if (family === 4 && net.isIPv4(address)) {
    return blockedIPv4Addresses.check(address, "ipv4");
  }
  if (family === 6 && net.isIPv6(address)) {
    return blockedIPv6Addresses.check(address, "ipv6");
  }
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

const resolveHostname: ResolveHostname = async (hostname) => {
  const resolved = await dnsLookup(hostname, { all: true, verbatim: true });
  return resolved
    .filter(
      (item): item is ResolvedAddress =>
        (item.family === 4 || item.family === 6) &&
        net.isIP(item.address) === item.family
    )
    .map(({ address, family }) => ({ address, family }));
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

type PublicTarget = {
  url: string;
  hostname: string;
  addresses: ResolvedAddress[];
};

// Throws only when `signal` aborts; every refusal is a typed reason.
async function resolvePublicTarget(
  input: string,
  resolver: ResolveHostname,
  signal?: AbortSignal
): Promise<{ ok: true; target: PublicTarget } | { ok: false; reason: UrlSafetyReason }> {
  throwIfAborted(signal);

  let normalized: string;
  let url: URL;
  try {
    normalized = normalizeHttpUrl(input);
    url = new URL(normalized);
  } catch (error) {
    return { ok: false, reason: urlSafetyReasonOf(error) };
  }

  if (!ALLOWED_PORTS.has(url.port)) return { ok: false, reason: "blocked_port" };

  const hostname = canonicalHostname(url.hostname);
  if (isBlockedHostname(hostname)) return { ok: false, reason: "blocked_host" };

  const literalFamily = net.isIP(hostname);
  let addresses: ResolvedAddress[];
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily as 4 | 6 }];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch (error) {
      throwIfAborted(signal);
      return { ok: false, reason: dnsFailureReason(error) };
    }
  }

  // A caller may stop waiting while DNS is in flight. Check before creating
  // an Agent so that path cannot leave an orphan dispatcher behind.
  throwIfAborted(signal);
  if (addresses.length === 0) return { ok: false, reason: "dns_unresolved" };
  if (addresses.some(({ address, family }) => isBlockedAddress(address, family))) {
    return { ok: false, reason: "private_address" };
  }

  return { ok: true, target: { url: normalized, hostname, addresses } };
}

/**
 * Creates a DNS lookup that can return only the already-validated addresses.
 * It never calls the system resolver, closing the DNS-rebinding/TOCTOU gap.
 */
export function createPinnedLookup(
  expectedHostname: string,
  addresses: readonly ResolvedAddress[]
): LookupFunction {
  const expected = canonicalHostname(expectedHostname);
  const pinned = addresses.map(({ address, family }) => ({ address, family }));

  return (hostname, options, callback) => {
    const actual = canonicalHostname(hostname);
    if (actual !== expected) {
      const error = new Error("Pinned dispatcher hostname mismatch") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "");
      return;
    }

    const requestedFamily =
      options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const eligible =
      requestedFamily === 4 || requestedFamily === 6
        ? pinned.filter((address) => address.family === requestedFamily)
        : pinned;

    if (eligible.length === 0) {
      const error = new Error("No validated address for requested family") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "");
      return;
    }

    if (options.all) {
      callback(null, eligible);
    } else {
      callback(null, eligible[0].address, eligible[0].family);
    }
  };
}

/**
 * Resolves a URL once, rejects it if any answer is non-public, then builds an
 * Undici dispatcher whose connector is pinned to those exact answers. The URL
 * retains its original hostname, so HTTP Host and TLS SNI/certificate checks
 * still use the requested origin.
 *
 * Refusals carry a typed `reason`. If `signal` aborts, this rejects with the
 * signal's reason (like fetch) instead of reporting a safety failure.
 */
export async function createPinnedHttpTargetResult(
  input: string,
  signal?: AbortSignal,
  resolver: ResolveHostname = resolveHostname
): Promise<PinnedHttpTargetResult> {
  const resolved = await resolvePublicTarget(input, resolver, signal);
  if (!resolved.ok) return resolved;

  const { target } = resolved;
  const lookup = createPinnedLookup(target.hostname, target.addresses);
  const dispatcher = new Agent({ connect: { lookup } });

  return {
    ok: true,
    target: {
      url: target.url,
      addresses: target.addresses,
      dispatcher,
      lookup,
      close: () => dispatcher.close(),
    },
  };
}

/** Null-returning form of createPinnedHttpTargetResult (also null on abort). */
export async function createPinnedHttpTarget(
  input: string,
  signal?: AbortSignal,
  resolver: ResolveHostname = resolveHostname
): Promise<PinnedHttpTarget | null> {
  try {
    const result = await createPinnedHttpTargetResult(input, signal, resolver);
    return result.ok ? result.target : null;
  } catch {
    return null;
  }
}

/** Resolves and validates a URL without building a dispatcher. */
export async function checkPublicHttpUrl(
  input: string,
  resolver: ResolveHostname = resolveHostname
): Promise<UrlSafetyCheck> {
  const resolved = await resolvePublicTarget(input, resolver);
  return resolved.ok ? { ok: true } : { ok: false, reason: resolved.reason };
}

export async function isSafePublicHttpUrl(
  input: string,
  resolver: ResolveHostname = resolveHostname
): Promise<boolean> {
  return (await checkPublicHttpUrl(input, resolver)).ok;
}
