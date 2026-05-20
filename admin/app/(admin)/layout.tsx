/**
 * Admin shell — sidebar nav + content area. Runs the admin gate via
 * `isAdmin()` server-side; non-admins are redirected to /no-access.
 *
 * The sidebar links use Next's <Link> for client-side nav. Active state
 * is computed via a tiny client child that reads usePathname().
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { Inbox, BookOpen, BarChart3, Bot } from 'lucide-react';
import { isAdmin } from '@/lib/admin-check';
import { SidebarLink } from './SidebarLink';

export default async function AdminLayout({
  children,
}: { children: React.ReactNode }) {
  const allowed = await isAdmin();
  if (!allowed) redirect('/no-access');

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-60 border-r border-border bg-bg-elevated flex flex-col">
        <div className="px-5 py-5 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-primary font-bold text-sm tracking-wide">OVERLOAD</span>
            <span className="text-text-muted text-xs uppercase tracking-widest">admin</span>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 flex flex-col gap-0.5">
          <div className="mb-1 px-3 text-[10px] uppercase tracking-widest text-text-muted">
            Research
          </div>
          <SidebarLink href="/queue" icon={<Inbox size={15} />}>Queue</SidebarLink>
          <SidebarLink href="/kb" icon={<BookOpen size={15} />}>Knowledge Base</SidebarLink>
          <SidebarLink href="/agent" icon={<Bot size={15} />}>Agent Activity</SidebarLink>
          <div className="mt-4 mb-1 px-3 text-[10px] uppercase tracking-widest text-text-muted">
            System
          </div>
          <SidebarLink href="/stats" icon={<BarChart3 size={15} />}>Stats</SidebarLink>
        </nav>

        <div className="px-4 py-4 border-t border-border flex items-center gap-3">
          <UserButton appearance={{
            elements: { avatarBox: 'w-8 h-8' },
          }} />
          <div className="text-xs text-muted-fg leading-tight">
            <div className="text-fg">Admin</div>
            <div>Signed in</div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0">
        {children}
      </main>
    </div>
  );
}
