export function PinDisplay({ pin }: { pin: string }) {
  return (
    <div className="rounded-panel inline-block border border-white/15 bg-navy/80 px-8 py-4">
      <div className="text-6xl font-black tracking-[0.3em] text-white tabular-nums md:text-7xl">
        {pin}
      </div>
    </div>
  );
}
