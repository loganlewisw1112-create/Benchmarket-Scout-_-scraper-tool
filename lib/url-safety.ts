import dns from "node:dns";

const dnsLookup = dns.promises.lookup;

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

function ipToParts(ip: string): number[] {
  return ip.split(".").map((p) => parseInt(p, 10));
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ipToParts(ip);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;

  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && b === 18) return true; // benchmarking
  if (a >= 224) return true; // multicast/reserved 224.0.0.0+

  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified
  if (normalized.startsWith("fe80")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local
  if (normalized.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 address
    const v4 = normalized.split(":").pop() ?? "";
    if (v4.includes(".")) return isPrivateIPv4(v4);
  }
  if (normalized.startsWith("ff")) return true; // multicast

  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0") return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

export async function isSafePublicHttpUrl(input: string): Promise<boolean> {
  const current = input;

  try {
    for (let redirectHop = 0; redirectHop <= 3; redirectHop++) {
      const normalized = normalizeHttpUrl(current);
      const url = new URL(normalized);

      if (isBlockedHostname(url.hostname)) return false;

      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) {
        if (isPrivateIPv4(url.hostname)) return false;
      } else if (url.hostname.includes(":")) {
        if (isPrivateIPv6(url.hostname)) return false;
      }

      let resolved;
      try {
        resolved = await dnsLookup(url.hostname, { all: true });
      } catch {
        return false;
      }

      if (!resolved || resolved.length === 0) return false;

      for (const addr of resolved) {
        if (addr.family === 4 && isPrivateIPv4(addr.address)) return false;
        if (addr.family === 6 && isPrivateIPv6(addr.address)) return false;
      }

      // We are not following actual network redirects here (no request made
      // yet); this loop exists so callers who re-validate after following a
      // redirect can reuse the same checks on the final URL.
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
