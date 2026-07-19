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
// target, documentation/benchmarking, private/site-local, link-local, and
// multicast ranges.
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
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

export function normalizeHttpUrl(input: string): string {
  let candidate = input.trim();
  if (!candidate) {
    throw new Error("Empty URL");
  }

  if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  const url = new URL(candidate);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }

  if (!url.hostname) {
    throw new Error("Missing hostname");
  }

  if (url.username || url.password) {
    throw new Error("Credentials in URL are not allowed");
  }

  return url.toString();
}

function hostnameWithoutIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
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

async function resolvePublicTarget(
  input: string,
  resolver: ResolveHostname,
  signal?: AbortSignal
): Promise<{ url: string; hostname: string; addresses: ResolvedAddress[] } | null> {
  try {
    if (signal?.aborted) return null;
    const normalized = normalizeHttpUrl(input);
    const url = new URL(normalized);
    const hostname = hostnameWithoutIpv6Brackets(url.hostname).toLowerCase();

    if (isBlockedHostname(hostname)) return null;

    const literalFamily = net.isIP(hostname);
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await resolver(hostname);

    // A caller may stop waiting while DNS is in flight. Check before creating
    // an Agent so that path cannot leave an orphan dispatcher behind.
    if (signal?.aborted) return null;
    if (addresses.length === 0) return null;
    if (addresses.some(({ address, family }) => isBlockedAddress(address, family))) {
      return null;
    }

    return { url: normalized, hostname, addresses };
  } catch {
    return null;
  }
}

/**
 * Creates a DNS lookup that can return only the already-validated addresses.
 * It never calls the system resolver, closing the DNS-rebinding/TOCTOU gap.
 */
export function createPinnedLookup(
  expectedHostname: string,
  addresses: readonly ResolvedAddress[]
): LookupFunction {
  const expected = hostnameWithoutIpv6Brackets(expectedHostname).toLowerCase();
  const pinned = addresses.map(({ address, family }) => ({ address, family }));

  return (hostname, options, callback) => {
    const actual = hostnameWithoutIpv6Brackets(hostname).toLowerCase();
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
 */
export async function createPinnedHttpTarget(
  input: string,
  signal?: AbortSignal,
  resolver: ResolveHostname = resolveHostname
): Promise<PinnedHttpTarget | null> {
  const target = await resolvePublicTarget(input, resolver, signal);
  if (!target) return null;

  const lookup = createPinnedLookup(target.hostname, target.addresses);
  const dispatcher = new Agent({ connect: { lookup } });

  return {
    url: target.url,
    addresses: target.addresses,
    dispatcher,
    lookup,
    close: () => dispatcher.close(),
  };
}

export async function isSafePublicHttpUrl(
  input: string,
  resolver: ResolveHostname = resolveHostname
): Promise<boolean> {
  return (await resolvePublicTarget(input, resolver)) !== null;
}
