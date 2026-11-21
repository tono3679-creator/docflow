import { cn } from "@/lib/utils";

/** 通常の画面の幅（確認画面は横幅いっぱいを使うので使わない） */
export function Page({ children, className, wide }: { children: React.ReactNode; className?: string; wide?: boolean }) {
  return <main className={cn("mx-auto w-full px-4 pt-6 pb-10 sm:px-6", wide ? "max-w-[1600px]" : "max-w-[1200px]", className)}>{children}</main>;
}
