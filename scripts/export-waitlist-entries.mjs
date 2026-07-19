function normalizedEmail(email) {
  return email.trim().toLowerCase();
}

function nonEmptyMessage(message) {
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function feedbackEventBlock(entry, message) {
  // Keep the event metadata next to the message it describes. Missing fields
  // are explicit rather than silently inheriting the canonical signup values.
  const context = {
    at: entry.at ?? null,
    source: entry.source ?? null,
    reportId: entry.reportId ?? null,
  };
  return `[feedback ${JSON.stringify(context)}]\n${message}`;
}

// Collapse ordered signup events to one row per normalized email. The first
// event remains the canonical signup record. Its `message` field becomes a
// deterministic sequence of feedback blocks, each carrying the at/source/
// reportId values from the event that actually supplied that message.
export function mergeWaitlistEntriesByEmail(entries) {
  const grouped = new Map();

  for (const entry of entries) {
    const key = normalizedEmail(entry.email);
    let group = grouped.get(key);

    if (!group) {
      group = { canonical: { ...entry }, messages: [] };
      grouped.set(key, group);
    }

    const message = nonEmptyMessage(entry.message);
    if (message !== null) {
      group.messages.push(feedbackEventBlock(entry, message));
    }
  }

  return [...grouped.values()].map(({ canonical, messages }) => {
    if (messages.length > 0) {
      canonical.message = messages.join("\n\n");
    } else {
      delete canonical.message;
    }
    return canonical;
  });
}

// Spreadsheet applications may evaluate CSV cells beginning with a formula
// marker, even when the value is quoted. Prefix dangerous values with an
// apostrophe before applying normal CSV quoting. Leading whitespace is
// included so spaces, tabs, or CR characters cannot conceal the marker.
export function csvEscape(value) {
  const raw = value === undefined || value === null ? "" : String(value);
  const safe = /^\s*[\t\r=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
