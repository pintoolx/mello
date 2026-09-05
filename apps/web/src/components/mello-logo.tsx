import Image from "next/image";

export function MelloLogo({ light = true, compact = false }: { light?: boolean; compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5" aria-label="Mello">
      <span className="grid h-12 w-[54px] shrink-0 place-items-center rounded-lg bg-white">
        <Image src="/brand/mello-mark.svg" alt="" width={46} height={40} className="h-10 w-[46px]" priority />
      </span>
      {!compact && (
        <Image
          src="/brand/mello-logotype.svg"
          alt="Mello"
          width={147}
          height={40}
          className={`h-10 w-[147px] object-contain ${light ? "invert" : ""}`}
          priority
        />
      )}
    </div>
  );
}
