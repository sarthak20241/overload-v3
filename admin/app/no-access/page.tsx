/**
 * Shown to authenticated users who aren't in `admin_users`. The middleware
 * lets them through (any signed-in user can hit any route); the (admin)
 * layout calls `isAdmin()` and redirects here when it returns false.
 */
import { UserButton } from '@clerk/nextjs';
import { Lock } from 'lucide-react';

export default function NoAccessPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md text-center flex flex-col items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-card border border-border flex items-center justify-center">
          <Lock size={22} className="text-muted-fg" />
        </div>
        <h1 className="text-2xl font-semibold text-fg">Admin access required</h1>
        <p className="text-sm text-muted-fg leading-relaxed">
          This dashboard is for project administrators only. If you should
          have access, ask the project owner to add your Clerk user ID to the{' '}
          <code className="px-1 py-0.5 rounded bg-card border border-border text-xs">
            admin_users
          </code>{' '}
          table.
        </p>
        <div className="mt-4">
          <UserButton />
        </div>
      </div>
    </div>
  );
}
