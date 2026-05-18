/**
 * Sign-in page.
 *
 * Two-column landing on desktop: marketing/context on the left, Clerk widget
 * on the right. Single column on mobile.
 *
 * The Clerk `<SignIn />` widget is heavily themed via the `appearance` prop
 * so it matches our lime/dark palette and rounded-button feel, rather than
 * looking like a default Clerk modal stamped in the middle of the page.
 *
 * Catch-all route segment `[[...sign-in]]` is required by Clerk so internal
 * navigation (forgot password, MFA challenge, etc.) stays inside the page.
 */
import { SignIn } from '@clerk/nextjs';
import { dark } from '@clerk/themes';
import { BookOpen, Zap, ShieldCheck } from 'lucide-react';

export default function SignInPage() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Background: subtle radial lime glow at top-right + grid texture */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle at 80% -10%, rgba(200,255,0,0.10), transparent 45%), ' +
            'radial-gradient(circle at 15% 110%, rgba(200,255,0,0.05), transparent 40%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage:
            'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <div className="relative min-h-screen grid lg:grid-cols-2">
        {/* LEFT — brand + context (desktop only) */}
        <aside className="hidden lg:flex flex-col justify-between p-12 border-r border-border">
          <div>
            <div className="inline-flex items-center gap-2">
              <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
                <Zap size={18} className="text-primary-fg" strokeWidth={2.5} />
              </div>
              <span className="text-fg font-bold text-xl tracking-tight">OVERLOAD</span>
              <span className="text-text-muted text-xs uppercase tracking-widest font-semibold pt-1 ml-1">
                Admin
              </span>
            </div>

            <h1 className="text-4xl font-bold text-fg mt-14 leading-tight tracking-tight">
              Curate what the<br />
              coach knows.
            </h1>
            <p className="text-muted-fg mt-4 text-base max-w-md leading-relaxed">
              Review every research paper our nightly cron lands in the queue before
              it reaches the AI Coach. One bad paper polluting the corpus is one
              wrong answer at a thousand users.
            </p>

            <ul className="mt-10 space-y-4 max-w-md">
              <FeatureRow
                icon={<BookOpen size={14} />}
                title="Triage in seconds"
                body="Title, distillation, trust score, and topic tags — read what matters in 10 seconds, approve or reject with one keypress."
              />
              <FeatureRow
                icon={<ShieldCheck size={14} />}
                title="Same account as your app"
                body="Sign in once with your Clerk account. RLS-gated admin access — only the project owner can see this dashboard."
              />
              <FeatureRow
                icon={<Zap size={14} />}
                title="Keyboard-first"
                body="J/K to navigate, A to approve, R to reject, Esc to close. Triage a week of papers in under a minute."
              />
            </ul>
          </div>

          <div className="text-text-muted text-xs">
            Overload v3 · Phase 3 research review · Built for the AI Coach
          </div>
        </aside>

        {/* RIGHT — sign-in card */}
        <main className="flex items-center justify-center p-6 lg:p-12">
          <div className="w-full max-w-md">
            {/* Mobile-only brand (the left column is hidden on small screens) */}
            <div className="lg:hidden flex items-center gap-2 mb-8">
              <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
                <Zap size={15} className="text-primary-fg" strokeWidth={2.5} />
              </div>
              <span className="text-fg font-bold text-lg tracking-tight">OVERLOAD</span>
              <span className="text-text-muted text-[10px] uppercase tracking-widest font-semibold pt-0.5">
                Admin
              </span>
            </div>

            <div className="mb-6">
              <h2 className="text-2xl font-bold text-fg tracking-tight">Welcome back</h2>
              <p className="text-sm text-muted-fg mt-1.5">
                Sign in with the same account you use on the Overload app.
              </p>
            </div>

            {/*
              Heavy Clerk theming so the widget looks part of our app instead
              of a stamped modal. `dark` baseTheme gives us a sensible dark
              starting point; the `elements` overrides tune individual parts.
            */}
            <SignIn
              path="/sign-in"
              routing="path"
              signUpUrl="/sign-up"
              forceRedirectUrl="/queue"
              appearance={{
                baseTheme: dark,
                variables: {
                  colorPrimary: '#c8ff00',
                  colorBackground: '#0a0a0a',
                  colorInputBackground: '#161616',
                  colorInputText: '#ededed',
                  colorText: '#ededed',
                  colorTextSecondary: 'rgba(255,255,255,0.62)',
                  colorTextOnPrimaryBackground: '#0a0a0a',
                  colorNeutral: '#ffffff',
                  colorDanger: '#f87171',
                  colorSuccess: '#4ade80',
                  colorWarning: '#fbbf24',
                  borderRadius: '10px',
                  fontFamily: 'inherit',
                },
                elements: {
                  rootBox: 'w-full',
                  card: 'bg-transparent shadow-none border-0 p-0',
                  headerTitle: 'hidden',
                  headerSubtitle: 'hidden',
                  socialButtonsBlockButton:
                    'bg-card border border-border hover:bg-card-hover hover:border-border-strong rounded-lg',
                  socialButtonsBlockButtonText: 'text-fg font-medium',
                  dividerLine: 'bg-border',
                  dividerText: 'text-text-muted',
                  formFieldLabel: 'text-muted-fg text-xs uppercase tracking-widest font-semibold',
                  formFieldInput:
                    'bg-card border border-border focus:border-primary rounded-lg',
                  formButtonPrimary:
                    'bg-primary hover:bg-primary/90 text-primary-fg font-semibold rounded-lg shadow-none',
                  footer: 'hidden',
                  footerAction: 'hidden',
                  formFieldAction: 'text-primary hover:text-primary/80',
                  identityPreview: 'bg-card border border-border',
                  identityPreviewText: 'text-fg',
                  identityPreviewEditButton: 'text-primary',
                },
              }}
            />

            <div className="mt-8 pt-6 border-t border-border text-xs text-text-muted">
              <p>
                Need access?{' '}
                <span className="text-muted-fg">
                  Admin access is granted via the{' '}
                  <code className="px-1 py-0.5 rounded bg-card border border-border text-[11px]">
                    admin_users
                  </code>{' '}
                  table — ask the project owner.
                </span>
              </p>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function FeatureRow({
  icon, title, body,
}: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <li className="flex gap-3">
      <div className="flex-none w-7 h-7 mt-0.5 rounded-md bg-primary-subtle border border-primary-muted flex items-center justify-center text-primary">
        {icon}
      </div>
      <div>
        <div className="text-fg text-sm font-medium">{title}</div>
        <div className="text-muted-fg text-xs leading-relaxed mt-0.5">{body}</div>
      </div>
    </li>
  );
}
