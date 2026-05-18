/**
 * Sidebar link with active-state highlight. Client component because
 * `usePathname` is client-only.
 */
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function SidebarLink({
  href, icon, children, disabled = false,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const pathname = usePathname();
  const active = !disabled && (pathname === href || pathname.startsWith(`${href}/`));

  if (disabled) {
    return (
      <div className="px-3 py-2 flex items-center gap-2.5 text-text-muted text-sm cursor-not-allowed opacity-60">
        {icon}
        <span>{children}</span>
      </div>
    );
  }

  return (
    <Link
      href={href}
      className={
        'px-3 py-2 flex items-center gap-2.5 rounded-md text-sm transition-colors ' +
        (active
          ? 'bg-primary-subtle text-primary'
          : 'text-muted-fg hover:bg-card hover:text-fg')
      }
    >
      {icon}
      <span>{children}</span>
    </Link>
  );
}
