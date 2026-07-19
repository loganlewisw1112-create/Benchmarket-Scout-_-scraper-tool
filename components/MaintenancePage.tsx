export default function MaintenancePage() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 px-6 py-16 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(99,102,241,0.25),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(14,165,233,0.16),transparent_38%)]" />
      <section className="relative w-full max-w-2xl rounded-3xl border border-white/10 bg-white/[0.06] p-8 shadow-2xl shadow-indigo-950/40 backdrop-blur sm:p-12">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl bg-indigo-500 font-black tracking-tight shadow-lg shadow-indigo-500/25">
            BS
          </div>
          <div>
            <p className="font-semibold tracking-tight">Benchmark Scout</p>
            <p className="text-xs uppercase tracking-[0.18em] text-indigo-200">
              Real-data upgrade
            </p>
          </div>
        </div>

        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-300">
          Maintenance in progress
        </p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
          We are making every report source-verifiable.
        </h1>
        <p className="mt-6 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
          Benchmark Scout is temporarily paused while we remove synthetic data
          paths and add transparent source citations to every live, shared, and
          PDF report.
        </p>

        <div className="mt-8 rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.06] p-5">
          <p className="font-semibold text-emerald-200">
            What to expect when we reopen
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Real public sources only, honest partial results when evidence is
            unavailable, and a complete sources appendix with every report.
          </p>
        </div>

        <p className="mt-8 text-sm text-slate-400">
          Thanks for your patience. Monitoring remains online while the upgrade
          is validated.
        </p>
      </section>
    </main>
  );
}

